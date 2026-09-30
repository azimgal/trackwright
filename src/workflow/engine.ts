import { AGENTS, getAgent, type AgentPromptContext } from '../agents/registry.js';
import { runChecks } from '../policies/checks.js';
import { hasExceededCeiling } from '../policies/retry.js';
import {
  allowsAutoMergeEligibility,
  implementerAgentsFor,
  requiresDesignGate,
} from '../policies/routing.js';
import { findClarificationMarkers, isPlanningComplete, type Ticket } from '../tickets/schema.js';
import type { TicketStore } from '../tickets/store.js';
import type { ClaudeRunner, AgentInvocation, AgentResult } from '../claude/types.js';
import type { EvidenceStore } from '../evidence/store.js';
import type { GitRepo } from '../git/repo.js';
import type { ProjectConfig } from '../config/schema.js';
import { nextStage, runnerFor, IllegalTransitionError } from './state-machine.js';
import type { RunOutcome } from './outcomes.js';
import { RUN_OUTCOMES, type FailureOutcome } from './outcomes.js';
import type { Stage } from './stages.js';

export interface StepResult {
  ticketId: string;
  fromStage: Stage;
  toStage: Stage;
  outcome: RunOutcome;
  summary: string;
  agent: string;
  attempt: number;
  runId: string;
}

export interface RunResult {
  ticket: Ticket;
  steps: StepResult[];
  stopReason: 'done' | 'awaiting-human' | 'max-steps' | 'cancelled';
}

const OUTCOME_SET: ReadonlySet<string> = new Set(RUN_OUTCOMES as readonly string[]);

/** Outcomes that mean "cannot proceed without something outside this run happening" — the loop
 * in run() stops here rather than looping forever on a self-transition. */
const AWAITING_HUMAN_OUTCOMES: ReadonlySet<RunOutcome> = new Set(['BLOCKED', 'CONCERNS', 'NEEDS_CLARIFICATION']);

export interface EngineDeps {
  ticketStore: TicketStore;
  evidenceStore: EvidenceStore;
  claudeRunner: ClaudeRunner;
  config: ProjectConfig;
  gitRepo: GitRepo;
  cwd: string;
}

/**
 * Drives a ticket through the declarative state machine one stage at a time. This is the only
 * place that decides what to actually DO for a given stage (execute an agent, run checks,
 * evaluate a deterministic gate) and how a returned outcome maps to the next stage — the mapping
 * itself always comes from state-machine.ts, never re-decided here.
 */
export class WorkflowEngine {
  constructor(private readonly deps: EngineDeps) {}

  async run(ticketId: string, opts: { maxSteps?: number } = {}): Promise<RunResult> {
    const maxSteps = opts.maxSteps ?? 20;
    const steps: StepResult[] = [];

    for (let i = 0; i < maxSteps; i++) {
      const ticket = await this.deps.ticketStore.getOrThrow(ticketId);
      const currentStage = ticket.frontmatter.stage ?? 'planning';

      if (currentStage === 'done') {
        return { ticket, steps, stopReason: 'done' };
      }

      const step = await this.step(ticketId);
      steps.push(step);

      if (step.toStage === 'done') {
        const finalTicket = await this.deps.ticketStore.getOrThrow(ticketId);
        return { ticket: finalTicket, steps, stopReason: 'done' };
      }

      const madeProgress = step.toStage !== step.fromStage;
      if (!madeProgress && AWAITING_HUMAN_OUTCOMES.has(step.outcome)) {
        const finalTicket = await this.deps.ticketStore.getOrThrow(ticketId);
        return { ticket: finalTicket, steps, stopReason: 'awaiting-human' };
      }
      // Otherwise: either we progressed to a new stage, or this was a bounded retry
      // (RETRYABLE_FAILURE/SYSTEM_ERROR self-loop) — loop again; the ceiling check inside step()
      // will force a BLOCKED outcome once attempts are exhausted, which then falls into the
      // awaiting-human branch above on the next iteration.
    }

    const finalTicket = await this.deps.ticketStore.getOrThrow(ticketId);
    return { ticket: finalTicket, steps, stopReason: 'max-steps' };
  }

  /** Execute exactly the ticket's current stage once and persist the resulting transition. */
  async step(ticketId: string): Promise<StepResult> {
    const ticket = await this.deps.ticketStore.getOrThrow(ticketId);
    const stage = ticket.frontmatter.stage ?? 'planning';
    const runId = this.deps.evidenceStore.newRunId();
    const attempt = (await this.deps.evidenceStore.attemptCount(ticketId, stage)) + 1;

    if (await hasExceededCeiling(this.deps.evidenceStore, ticketId, stage, this.deps.config.retryCeiling)) {
      return this.finish(ticket, stage, runId, attempt, {
        outcome: 'BLOCKED',
        summary: `retry ceiling (${this.deps.config.retryCeiling}) exceeded for stage "${stage}"`,
        data: {},
        durationMs: 0,
      });
    }

    let result: AgentResult;
    try {
      result = await this.execute(ticket, stage);
    } catch (err) {
      result = {
        outcome: 'SYSTEM_ERROR',
        summary: `unhandled error executing stage "${stage}": ${(err as Error).message}`,
        data: {},
        failureReason: (err as Error).stack ?? String(err),
        durationMs: 0,
      };
    }

    return this.finish(ticket, stage, runId, attempt, result);
  }

  private async finish(
    ticket: Ticket,
    stage: Stage,
    runId: string,
    attempt: number,
    result: AgentResult,
  ): Promise<StepResult> {
    if (!OUTCOME_SET.has(result.outcome)) {
      // Defensive: never trust an agent-produced outcome string outside the known vocabulary,
      // even though this should already be unreachable given ClaudeCliRunner's own contract.
      result = { ...result, outcome: 'SYSTEM_ERROR', failureReason: `invalid outcome "${result.outcome}"` };
    }

    const gitSha = await this.safeSha();
    await this.deps.evidenceStore.record({
      runId,
      ticketId: ticket.frontmatter.id,
      stage,
      agent: this.agentNameFor(stage),
      startedAt: new Date(Date.now() - result.durationMs).toISOString(),
      endedAt: new Date().toISOString(),
      outcome: result.outcome,
      attempt,
      artifacts: [],
      gitSha,
      failureReason: result.failureReason,
      summary: result.summary,
      costUsd: result.costUsd,
    });

    const toStage = this.resolveNextStage(stage, result.outcome);

    let sections = ticket.sections;
    for (const [section, content] of Object.entries(this.sectionUpdatesFor(stage, result))) {
      sections = { ...sections, [section]: content };
    }

    const updated: Ticket = {
      ...ticket,
      sections,
      frontmatter: {
        ...ticket.frontmatter,
        stage: toStage,
        status: result.outcome === 'CANCELLED' ? 'cancelled' : ticket.frontmatter.status,
      },
    };
    await this.deps.ticketStore.save(updated);

    return {
      ticketId: ticket.frontmatter.id,
      fromStage: stage,
      toStage,
      outcome: result.outcome,
      summary: result.summary,
      agent: this.agentNameFor(stage),
      attempt,
      runId,
    };
  }

  /**
   * A stage's agent output can populate specific canonical ticket sections (see
   * tickets/schema.ts, TICKET_SECTIONS) — otherwise its structured `data` would be recorded in
   * evidence but silently discarded from the ticket itself, which defeats the point of "one
   * ticket is the source of truth." Only outcome SUCCESS writes sections; a failed run's
   * half-formed `data` is not persisted into the ticket body.
   */
  private sectionUpdatesFor(stage: Stage, result: AgentResult): Record<string, string> {
    // Planning's draft is worth keeping even when downgraded to NEEDS_CLARIFICATION by
    // executePlanning above — a human resolving the markers needs to see what was actually
    // drafted, not an empty ticket. Every other stage only persists on outright SUCCESS.
    const persistable = result.outcome === 'SUCCESS' || (stage === 'planning' && result.outcome === 'NEEDS_CLARIFICATION');
    if (!persistable) return {};
    const data = result.data as Record<string, string | undefined>;
    switch (stage) {
      case 'planning': {
        const updates: Record<string, string> = {};
        if (data.requirements) updates['Requirements'] = data.requirements;
        if (data.acceptanceCriteria) updates['Acceptance Criteria'] = data.acceptanceCriteria;
        if (data.definitionOfDone) updates['Definition of Done'] = data.definitionOfDone;
        if (data.plan) updates['Plan'] = data.plan;
        if (data.tasks) updates['Tasks'] = data.tasks;
        return updates;
      }
      case 'verification':
        return data.reasoning ? { 'Verification evidence': data.reasoning } : {};
      default:
        return {};
    }
  }

  /**
   * CANCELLED and the two safety-fallback outcomes (BLOCKED synthesized by the retry-ceiling
   * check, SYSTEM_ERROR from an unhandled exception or an invalid agent response) must always
   * have *some* legal next stage, even for a stage whose table entry doesn't explicitly declare
   * one — not every stage lists BLOCKED/SYSTEM_ERROR, and it would be wrong to make the engine
   * crash on exactly the outcomes meant to fail things closed. Self-loop is the safe default:
   * stay put, stop advancing, wait for a human (see AWAITING_HUMAN_OUTCOMES in run()).
   */
  private resolveNextStage(stage: Stage, outcome: RunOutcome): Stage {
    if (outcome === 'CANCELLED') return stage;
    try {
      return nextStage(stage, outcome);
    } catch (err) {
      if (err instanceof IllegalTransitionError && (outcome === 'BLOCKED' || outcome === 'SYSTEM_ERROR')) {
        return stage;
      }
      throw err;
    }
  }

  private async safeSha(): Promise<string | null> {
    try {
      return await this.deps.gitRepo.currentSha();
    } catch {
      return null;
    }
  }

  private agentNameFor(stage: Stage): string {
    const kind = runnerFor(stage);
    return kind === 'none' ? 'engine' : kind;
  }

  private async execute(ticket: Ticket, stage: Stage): Promise<AgentResult> {
    const kind = runnerFor(stage);
    switch (kind) {
      case 'none':
        return this.executeReadyGate(ticket);
      case 'planner':
        return this.executePlanning(ticket);
      case 'architecture-review':
        return this.executeArchitectureReview(ticket);
      case 'design-gate':
        return this.executeDesignGate(ticket);
      case 'implementer':
        return this.executeImplementer(ticket);
      case 'code-reviewer':
        return this.executeClaudeAgent('code-reviewer', ticket, {});
      case 'gate-runner':
        return this.executeChecks(this.deps.config.checks.test, 'development'); // routes RETRYABLE_FAILURE -> development
      case 'verification-agent':
        return this.executeVerification(ticket);
      case 'awaiting-merge-check':
        return this.executeAwaitingMerge(ticket);
      default:
        return this.systemError(kind satisfies never);
    }
  }

  private systemError(_never: never): AgentResult {
    return { outcome: 'SYSTEM_ERROR', summary: 'unreachable runner kind', data: {}, durationMs: 0 };
  }

  /**
   * Planning is a hybrid: the planner agent drafts Requirements/Acceptance Criteria/Plan/Tasks,
   * but whether that draft is actually good enough to leave Planning is a deterministic check
   * against the ticket's own rules (tickets/schema.ts: isPlanningComplete,
   * findClarificationMarkers) — not just trust in the agent's self-reported SUCCESS. An agent
   * that reports SUCCESS while leaving `[NEEDS CLARIFICATION: ...]` markers in its draft, or
   * while skipping a required section, is downgraded to NEEDS_CLARIFICATION here.
   */
  private async executePlanning(ticket: Ticket): Promise<AgentResult> {
    const result = await this.executeClaudeAgent('planner', ticket, {});
    if (result.outcome !== 'SUCCESS') return result;

    const draftedSections = this.sectionUpdatesFor('planning', result);
    const draftTicket: Ticket = { ...ticket, sections: { ...ticket.sections, ...draftedSections } };

    const markers = findClarificationMarkers(draftTicket);
    if (markers.length > 0) {
      return {
        ...result,
        outcome: 'NEEDS_CLARIFICATION',
        summary: `planning drafted, but ${markers.length} unresolved clarification marker(s) remain`,
      };
    }
    if (!isPlanningComplete(draftTicket)) {
      return {
        ...result,
        outcome: 'NEEDS_CLARIFICATION',
        summary:
          'planner reported success but did not populate all sections required to leave planning (Context/Requirements/Acceptance Criteria/Definition of Done)',
      };
    }
    return result;
  }

  // ---- deterministic (non-Claude) stage runners ----

  private async executeReadyGate(ticket: Ticket): Promise<AgentResult> {
    const unmet: string[] = [];
    for (const depId of ticket.frontmatter.dependencies) {
      const dep = await this.deps.ticketStore.get(depId);
      if (!dep || dep.frontmatter.status !== 'done') unmet.push(depId);
    }
    if (requiresDesignGate(ticket) && ticket.frontmatter.design_status !== 'synced') {
      unmet.push('design not synced');
    }
    if (unmet.length > 0) {
      return {
        outcome: 'BLOCKED',
        summary: `not ready: ${unmet.join(', ')}`,
        data: { unmet },
        durationMs: 0,
      };
    }
    return { outcome: 'SUCCESS', summary: 'all dependencies satisfied, ready for development', data: {}, durationMs: 0 };
  }

  /**
   * MVP stub, documented as such in docs/architecture.md — no Claude call. A ticket with no
   * "Architecture decisions" content needs no ADR gate. One with unresolved
   * [NEEDS CLARIFICATION] markers in that section blocks for a human, matching the zero-human
   * analysis conclusion that novel architecture stays a human gate.
   */
  private async executeArchitectureReview(ticket: Ticket): Promise<AgentResult> {
    const decisions = ticket.sections['Architecture decisions']?.trim() ?? '';
    if (decisions.length === 0) {
      return { outcome: 'SUCCESS', summary: 'no architecture decision declared, nothing to review', data: {}, durationMs: 0 };
    }
    if (/\[NEEDS CLARIFICATION/.test(decisions)) {
      return {
        outcome: 'BLOCKED',
        summary: 'architecture decision has unresolved clarification markers, needs human ADR approval',
        data: {},
        durationMs: 0,
      };
    }
    return { outcome: 'SUCCESS', summary: 'architecture decision recorded, no open questions', data: {}, durationMs: 0 };
  }

  /**
   * MVP stub — see docs/roadmap.md, Design Sync is not implemented yet. This makes the gate
   * behave honestly (never silently auto-approves a required design) without pretending to run a
   * real design-review agent.
   */
  private async executeDesignGate(ticket: Ticket): Promise<AgentResult> {
    if (!requiresDesignGate(ticket)) {
      return { outcome: 'SUCCESS', summary: 'design not required for this ticket', data: {}, durationMs: 0 };
    }
    if (ticket.frontmatter.design_status === 'synced') {
      return { outcome: 'SUCCESS', summary: 'design already synced', data: {}, durationMs: 0 };
    }
    return {
      outcome: 'BLOCKED',
      summary:
        'design required but not synced — Trackwright MVP has no automated design-sync agent yet; set design_status: synced by hand once a human has approved the design',
      data: {},
      durationMs: 0,
    };
  }

  private async executeChecks(commands: readonly string[], _retryTarget: Stage): Promise<AgentResult> {
    const summary = await runChecks(commands, this.deps.cwd);
    if (summary.passed) {
      return { outcome: 'SUCCESS', summary: `all ${commands.length} check(s) passed`, data: {}, durationMs: 0 };
    }
    const failing = summary.results[summary.results.length - 1]!;
    return {
      outcome: 'RETRYABLE_FAILURE',
      summary: `check failed: ${failing.command}`,
      data: { results: summary.results },
      failureReason: failing.outputTail,
      durationMs: summary.results.reduce((a, r) => a + r.durationMs, 0),
    };
  }

  // ---- Claude-invoking stage runners ----

  private async executeClaudeAgent(
    agentName: string,
    ticket: Ticket,
    extra: Record<string, string>,
  ): Promise<AgentResult> {
    const agent = getAgent(agentName);
    const ctx: AgentPromptContext = { ticket, cwd: this.deps.cwd, extra };
    const invocation: AgentInvocation = {
      agentName: agent.name,
      systemPrompt: agent.buildSystemPrompt(),
      prompt: agent.buildTaskPrompt(ctx),
      allowedTools: agent.allowedTools,
      disallowedTools: agent.disallowedTools,
      cwd: this.deps.cwd,
      model: agent.model,
      timeoutMs: this.deps.config.claude.defaultTimeoutMs,
      permissionMode: agent.permissionMode,
    };
    const result = await this.deps.claudeRunner.invoke(invocation);
    if (!agent.validOutcomes.includes(result.outcome)) {
      return {
        ...result,
        outcome: 'SYSTEM_ERROR',
        failureReason: `agent "${agentName}" returned outcome "${result.outcome}" which is not in its allowed set ${JSON.stringify(agent.validOutcomes)}`,
      };
    }
    return result;
  }

  /**
   * Development fan-out/fan-in (see docs/architecture.md, "Multi-discipline strategy"). The MVP
   * runs implementer agents sequentially, not in parallel — the architecture leaves room for
   * parallel execution later without changing this method's contract with the rest of the
   * engine.
   */
  private async executeImplementer(ticket: Ticket): Promise<AgentResult> {
    const agentNames = implementerAgentsFor(ticket);
    const priority: FailureOutcome[] = ['NEEDS_REPLAN', 'BLOCKED', 'RETRYABLE_FAILURE', 'SYSTEM_ERROR'];
    let worst: AgentResult | null = null;

    for (const agentName of agentNames) {
      const result = await this.executeClaudeAgent(agentName, ticket, {});
      if (result.outcome !== 'SUCCESS') {
        if (!worst) {
          worst = result;
        } else {
          const currentRank = priority.indexOf(result.outcome as FailureOutcome);
          const worstRank = priority.indexOf(worst.outcome as FailureOutcome);
          if (currentRank < worstRank) worst = result;
        }
      }
    }
    if (worst) return worst;

    // Fast feedback loop (docs/architecture.md, "Development"): format/lint/typecheck-style
    // checks run here, narrow and quick, distinct from the full `test` tier (Testing stage) and
    // the heavy `premerge` tier (Awaiting Merge). A failure here is fixed in Development, same as
    // any other implementer failure — it self-loops via the same RETRYABLE_FAILURE routing.
    if (this.deps.config.checks.fast.length > 0) {
      const fastCheck = await this.executeChecks(this.deps.config.checks.fast, 'development');
      if (fastCheck.outcome !== 'SUCCESS') return fastCheck;
    }

    return { outcome: 'SUCCESS', summary: `${agentNames.length} implementer(s) completed`, data: {}, durationMs: 0 };
  }

  private async executeVerification(ticket: Ticket): Promise<AgentResult> {
    const diff = await this.deps.gitRepo.diffAgainstBase();
    const testEvidence = await this.deps.evidenceStore.latestForStage(ticket.frontmatter.id, 'testing');
    return this.executeClaudeAgent('verification-agent', ticket, {
      diff: diff.slice(0, 20_000), // bound prompt size; evidence keeps the full record separately
      testEvidence: testEvidence ? JSON.stringify(testEvidence) : '(no testing evidence recorded)',
    });
  }

  private async executeAwaitingMerge(ticket: Ticket): Promise<AgentResult> {
    const currentSha = await this.safeSha();
    if (currentSha && (await this.deps.evidenceStore.isStale(ticket.frontmatter.id, 'verification', currentSha))) {
      return {
        outcome: 'VERIFICATION_FAILED',
        summary: 'code changed since verification was last recorded — verification is stale',
        data: {},
        durationMs: 0,
      };
    }
    const summary = await runChecks(this.deps.config.checks.premerge, this.deps.cwd);
    if (!summary.passed) {
      const failing = summary.results[summary.results.length - 1]!;
      return {
        outcome: 'RETRYABLE_FAILURE',
        summary: `premerge check failed: ${failing.command}`,
        data: { results: summary.results },
        failureReason: failing.outputTail,
        durationMs: summary.results.reduce((a, r) => a + r.durationMs, 0),
      };
    }
    const mergeEligible = allowsAutoMergeEligibility(ticket);
    return {
      outcome: 'SUCCESS',
      summary: mergeEligible
        ? 'premerge checks green, evidence fresh — merge_eligible=true'
        : 'premerge checks green, but this ticket\'s routing does not allow auto-merge eligibility',
      data: { merge_eligible: mergeEligible },
      durationMs: summary.results.reduce((a, r) => a + r.durationMs, 0),
    };
  }
}

export { AGENTS };
