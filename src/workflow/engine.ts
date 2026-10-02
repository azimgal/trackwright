import { AGENTS, getAgent, type AgentPromptContext } from '../agents/registry.js';
import { runChecks } from '../policies/checks.js';
import { hasExceededCeiling } from '../policies/retry.js';
import {
  allowsAutoMergeEligibility,
  implementerAgentsFor,
  requiresDesignGate,
} from '../policies/routing.js';
import { findClarificationMarkers, isPlanningComplete, DESIGN_STATUSES, type DesignStatus, type Ticket } from '../tickets/schema.js';
import type { TicketStore } from '../tickets/store.js';
import type { ClaudeRunner, AgentInvocation, AgentResult } from '../claude/types.js';
import type { EvidenceStore } from '../evidence/store.js';
import type { GitRepo } from '../git/repo.js';
import type { ProjectConfig } from '../config/schema.js';
import { CONFIG_DIR } from '../config/loader.js';
import { nextStage, runnerFor, IllegalTransitionError } from './state-machine.js';
import type { RunOutcome } from './outcomes.js';
import { RUN_OUTCOMES, type FailureOutcome } from './outcomes.js';
import type { Stage } from './stages.js';
import { deterministicDesignGate } from '../design/gate.js';
import { LocalDesignArtifactProvider } from '../design/local-provider.js';
import type { DesignProvider } from '../design/provider.js';
import { hashText, isDesignStale } from '../design/staleness.js';
import { LocalPlaceholderVisualVerifier, type VisualVerifier } from '../design/visual-verify.js';
import { dependencyReadiness } from '../dependencies/readiness.js';

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
  /** Optional — defaults to LocalDesignArtifactProvider under <evidenceDir>/../design. Callers
   * that don't care about Design Sync (most tests, non-design tickets) never need to set this. */
  designProvider?: DesignProvider;
  /** Optional — defaults to LocalPlaceholderVisualVerifier (see design/visual-verify.ts). */
  visualVerifier?: VisualVerifier;
}

/**
 * Drives a ticket through the declarative state machine one stage at a time. This is the only
 * place that decides what to actually DO for a given stage (execute an agent, run checks,
 * evaluate a deterministic gate) and how a returned outcome maps to the next stage — the mapping
 * itself always comes from state-machine.ts, never re-decided here.
 */
export class WorkflowEngine {
  private readonly designProvider: DesignProvider;
  private readonly visualVerifier: VisualVerifier;

  constructor(private readonly deps: EngineDeps) {
    this.designProvider = deps.designProvider ?? new LocalDesignArtifactProvider(`${deps.cwd}/.trackwright/design`);
    this.visualVerifier = deps.visualVerifier ?? new LocalPlaceholderVisualVerifier();
  }

  /**
   * `onStep` fires immediately after each stage transition, before the loop continues — used by
   * the CLI (`trackwright run`) to print progress live instead of buffering everything until the
   * whole run finishes. Found necessary during real dogfooding: a real run with real Claude
   * invocations takes minutes, and silent buffering until completion gives zero feedback the
   * whole time, which is a bad experience distinct from --dry-run's near-instant runs.
   */
  async run(
    ticketId: string,
    opts: { maxSteps?: number; onStep?: (step: StepResult) => void } = {},
  ): Promise<RunResult> {
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
      opts.onStep?.(step);

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
        design_status: this.designStatusFor(result) ?? ticket.frontmatter.design_status,
      },
    };
    // Ticket state is saved (and committed) BEFORE evidence is recorded — found during the
    // release-readiness audit's crash-window analysis. The previous order (evidence first, then
    // ticket save) meant a crash in the gap between them left a SUCCESS (or any outcome) evidence
    // record on disk for an attempt the ticket itself never actually advanced past — so a restart
    // would recompute the same `attempt` number from evidence, call step() again, and re-invoke a
    // real agent for a stage transition evidence already claims happened: wasted cost at best,
    // double-counted retry-ceiling attempts at worst. This order's own crash window is strictly
    // safer: if evidence recording fails or the process dies right after, the ticket has already
    // (and correctly) advanced — the only loss is one evidence record for a transition that did
    // happen, a pure audit-trail gap, never a duplicate invocation.
    const saved = await this.deps.ticketStore.save(updated);
    await this.commitTicketState(saved, stage, toStage, result.outcome);

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
      rawExcerpt: result.outcome === 'SYSTEM_ERROR' ? this.rawExcerptFor(result.raw) : undefined,
      permissionDenials: this.permissionDenialsFor(result.raw),
      summary: result.summary,
      costUsd: result.costUsd,
    });

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
  /**
   * executeDesignGate (and executeVerification, for DESIGN_FAIL) report their actual
   * design_status decision via `result.data.design_status` — this is the one place that writes
   * it onto the ticket, regardless of which stage produced it, mirroring how sectionUpdatesFor
   * handles ticket *sections*. Before this, the engine only ever wrote design_status via the
   * human-invoked `trackwright design approve` (-> 'synced'); the deterministic gate's own
   * 'required'/'pending'/'stale' decisions were computed every call but never persisted, so
   * `ticket show` could claim `design_status=not-required` on a ticket that was, in fact, sitting
   * BLOCKED on an unapproved design draft.
   */
  private designStatusFor(result: AgentResult): DesignStatus | null {
    const value = (result.data as Record<string, unknown>)?.design_status;
    return typeof value === 'string' && (DESIGN_STATUSES as readonly string[]).includes(value)
      ? (value as DesignStatus)
      : null;
  }

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

  /**
   * Bound prompt size (evidence keeps the full record separately) — but never silently. A bare
   * `.slice()` previously cut mid-hunk with no indication anything was missing, which during real
   * dogfooding produced a verification agent confidently reporting a file's change was absent
   * when it had in fact just been truncated out of its prompt. Surfacing the cut explicitly lets
   * the agent (and a human reading evidence) tell "this file genuinely has no changes" apart from
   * "this file's changes were cut off."
   */
  private boundDiff(diff: string, limit = 20_000): string {
    if (diff.length <= limit) return diff;
    return `${diff.slice(0, limit)}\n\n...[diff truncated at ${limit} of ${diff.length} chars — see evidence for the full record]`;
  }

  /**
   * The SHA every staleness check (design staleness here, verification staleness in
   * executeAwaitingMerge) and every evidence record compares against. Deliberately
   * `lastRelevantSha` (excluding CONFIG_DIR), not raw `currentSha()` — found via a post-DF-0007
   * hardening review's cross-fix interaction check: once commitTicketState (this file) started
   * committing ticket-state on every stage transition, raw HEAD moved on every single step even
   * when no real project file changed, which made both staleness checks fire on Trackwright's own
   * bookkeeping commits — a design or verification that had not actually gone stale would
   * incorrectly bounce back for no real reason, on every ticket, every time. "Has the project
   * changed" must never be answered by "has literally anything been committed."
   */
  private async safeSha(): Promise<string | null> {
    try {
      return await this.deps.gitRepo.lastRelevantSha([CONFIG_DIR]);
    } catch {
      return null;
    }
  }

  private rawExcerptFor(raw: unknown): string | undefined {
    if (raw == null) return undefined;
    try {
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      return text.slice(0, 4000);
    } catch {
      return undefined;
    }
  }

  private permissionDenialsFor(raw: unknown): unknown[] | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const denials = (raw as { permission_denials?: unknown }).permission_denials;
    return Array.isArray(denials) && denials.length > 0 ? denials : undefined;
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
        return this.executeCodeReview(ticket);
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
    const result = await this.executeClaudeAgent('planner', ticket, {}, 'planning');
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
    const allTickets = await this.deps.ticketStore.list();
    const byId = new Map(allTickets.map((t) => [t.frontmatter.id, t]));
    const readiness = dependencyReadiness(ticket, byId);

    const unmet: string[] = [];
    if (!readiness.ready) {
      if (readiness.reason === 'blocked-by-cancelled-dependency') {
        unmet.push(
          `dependenc${readiness.cancelled.length === 1 ? 'y' : 'ies'} cancelled: ${readiness.cancelled.join(', ')} — this ticket cannot proceed automatically; a human must resolve the dependency graph`,
        );
      } else {
        unmet.push(...readiness.pending);
      }
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
   * Design Gate (docs/architecture.md, "Design Sync"). Deterministic rules (design/gate.ts) run
   * first and free; a Claude judgment call only happens for the genuinely ambiguous case, and
   * even then fails closed (uncertain -> required) rather than risk silently skipping a needed
   * design review. A required design that has no artifact yet gets one drafted automatically
   * (via this.designProvider) — but it is never auto-approved; approval is only ever a human,
   * via `trackwright design approve`.
   */
  private async executeDesignGate(ticket: Ticket): Promise<AgentResult> {
    let decision = deterministicDesignGate(ticket);

    if (decision === 'ambiguous') {
      const judged = await this.executeClaudeAgent('design-gate-agent', ticket, {}, 'design');
      if (judged.outcome !== 'SUCCESS' || judged.data.designRequired !== false) {
        decision = 'required'; // fail closed: SYSTEM_ERROR, or the model said true/was unclear
      } else {
        decision = 'not-required';
      }
    }

    if (decision === 'not-required') {
      return {
        outcome: 'SUCCESS',
        summary: 'design not required for this ticket',
        data: { design_status: 'not-required' },
        durationMs: 0,
      };
    }

    const existing = await this.designProvider.getLatestForTicket(ticket.frontmatter.id);
    const currentSha = await this.safeSha();
    const currentRequirementsHash = hashText(ticket.sections['Requirements'] ?? '');

    if (existing?.status === 'approved') {
      const stale = isDesignStale({ artifact: existing, currentRequirementsHash, currentGitSha: currentSha });
      if (!stale) {
        return {
          outcome: 'SUCCESS',
          summary: `design ${existing.designId} approved and fresh`,
          data: { design_status: 'synced' },
          durationMs: 0,
        };
      }
      await this.designProvider.markStale(existing.designId);
      return {
        outcome: 'BLOCKED',
        summary: `design ${existing.designId} is stale (requirements or code changed since approval) — needs re-sync`,
        data: { design_status: 'stale' },
        durationMs: 0,
      };
    }

    if (!existing || existing.status === 'stale') {
      const created = await this.designProvider.createOrUpdateDesign({
        ticketId: ticket.frontmatter.id,
        brief: ticket.sections['Requirements']?.trim() || ticket.sections['Context']?.trim() || '',
        constraints: [],
        requirementsHash: currentRequirementsHash,
      });
      return {
        outcome: 'BLOCKED',
        summary: `design required — drafted ${created.designId} at ${created.artifactPath}, awaiting human approval via \`trackwright design approve ${created.designId}\``,
        data: { design_status: 'pending' },
        durationMs: 0,
      };
    }

    // existing.status === 'draft': already drafted, still awaiting a human.
    return {
      outcome: 'BLOCKED',
      summary: `design ${existing.designId} drafted, awaiting human approval via \`trackwright design approve ${existing.designId}\``,
      data: { design_status: 'pending' },
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

  /**
   * If this stage's most recent attempt for this ticket failed, tells the model what went wrong
   * last time. Found necessary during real dogfooding: a bare retry of the identical prompt gives
   * the model no signal that anything needs to change, so a transient non-compliant response
   * (e.g. prose instead of the required JSON) can repeat identically across all retry attempts
   * instead of self-correcting.
   */
  private async previousFailureNote(ticketId: string, stage: Stage): Promise<string | null> {
    const history = await this.deps.evidenceStore.historyForStage(ticketId, stage);
    const last = history[history.length - 1];
    if (!last || last.outcome === 'SUCCESS') return null;
    return (
      `Note: your previous attempt at this stage was rejected. Reason: ${last.failureReason ?? last.summary}. ` +
      `Do not repeat the same mistake — in particular, if the reason mentions a missing or malformed ` +
      `field in your JSON response, make sure this response includes it correctly.`
    );
  }

  private async executeClaudeAgent(
    agentName: string,
    ticket: Ticket,
    extra: Record<string, string>,
    stage: Stage,
  ): Promise<AgentResult> {
    const agent = getAgent(agentName);
    const note = await this.previousFailureNote(ticket.frontmatter.id, stage);
    const ctx: AgentPromptContext = { ticket, cwd: this.deps.cwd, extra };
    const taskPrompt = agent.buildTaskPrompt(ctx);
    const invocation: AgentInvocation = {
      agentName: agent.name,
      systemPrompt: agent.buildSystemPrompt(),
      prompt: note ? `${note}\n\n${taskPrompt}` : taskPrompt,
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
      const result = await this.executeClaudeAgent(agentName, ticket, {}, 'development');
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

    const uncommitted = await this.uncommittedProjectChanges();
    if (uncommitted) {
      return {
        outcome: 'RETRYABLE_FAILURE',
        summary: 'implementer reported SUCCESS but left uncommitted changes in the working tree',
        data: {},
        failureReason:
          `You must \`git commit\` your changes before finishing — later stages (code review, testing, ` +
          `verification) read \`git diff\` against the base branch, not your uncommitted working tree, ` +
          `so they will not see this work at all. Uncommitted files:\n${uncommitted}`,
        durationMs: 0,
      };
    }

    return { outcome: 'SUCCESS', summary: `${agentNames.length} implementer(s) completed`, data: {}, durationMs: 0 };
  }

  /**
   * Found via real dogfooding (the DF-0007 run): despite the implementer's system prompt
   * explicitly instructing it to commit before finishing, it twice reported SUCCESS while leaving
   * real edits uncommitted — silently invisible to every stage downstream, since Code Review,
   * Testing (via the live filesystem, so it happened to still pass), and Verification (via `git
   * diff`, which did not) all disagree about what "the diff" even is. Catching this
   * deterministically here, rather than trusting the agent's self-report, turns a silent gap into
   * an ordinary RETRYABLE_FAILURE with a concrete instruction, self-correcting via the same
   * previousFailureNote mechanism as any other retried stage. Returns null outside a git repo
   * (nothing to check) or when only Trackwright's own bookkeeping changed (CONFIG_DIR), which is
   * normal and not the implementer's concern.
   */
  private async uncommittedProjectChanges(): Promise<string | null> {
    if (!(await this.deps.gitRepo.isGitRepository())) return null;
    const status = await this.deps.gitRepo.uncommittedStatus([CONFIG_DIR]);
    return status.length > 0 ? status : null;
  }

  /**
   * Same exclusion (Trackwright's own `.trackwright/` bookkeeping) and bound as the diff fed to
   * verification — see executeVerification's doc comment and GitRepo.diffAgainstBase. Shared so
   * neither stage can drift back out of sync with the other, and so a future diff-consuming stage
   * gets this for free rather than needing to rediscover the same fix independently.
   */
  private async projectDiff(): Promise<string> {
    const diff = await this.deps.gitRepo.diffAgainstBase(undefined, [CONFIG_DIR]);
    return this.boundDiff(diff);
  }

  /**
   * Found via real dogfooding (the DF-0007 run): code-reviewer previously got no diff from the
   * engine at all (`extra: {}`) and was expected to run its own live `git diff` via its scoped
   * Bash tool access. Real evidence recorded `permission_denials` for this exact call, twice
   * (the model prefixed it with `cd "..." &&`, same class of bug now warned against in every
   * Bash-using agent's prompt — see noCdPrefixWarning in agents/registry.ts) — and code-reviewer
   * still returned SUCCESS both times, falling back to reading individual files rather than ever
   * seeing an actual diff. It disclosed the limitation honestly in its own summary both times,
   * but that is the model being cooperative, not a guarantee. Providing the diff directly, the
   * same way verification already does, removes code-reviewer's dependency on that Bash call
   * succeeding at all — it is a diff review stage; it should not need a live `git diff` to do its
   * one job.
   */
  private async executeCodeReview(ticket: Ticket): Promise<AgentResult> {
    const diff = await this.projectDiff();
    return this.executeClaudeAgent('code-reviewer', ticket, { diff }, 'code-review');
  }

  /**
   * Architectural decision from a post-DF-0007 hardening review (not applied reflexively just
   * because a gap existed): docs/architecture.md calls the ticket file the project's "source of
   * truth," and `ticket create`/`init` already commit their own bookkeeping output for exactly
   * that reason — via GitRepo.addPaths, built specifically to stage Trackwright's own files
   * without ever sweeping up unrelated project work. But every per-stage ticket-state write `run`
   * itself makes (ticketStore.save above) was never wired to that same mechanism, leaving
   * in-flight stage progress sitting only in the working tree for as long as a ticket takes to
   * finish. After the ensureWorkBranch fix elsewhere in this file, that is a durability/audit gap,
   * not a correctness one — nothing is lost on crash, since the next `run` re-reads the ticket
   * file from disk regardless of git state — but it conflicts with the ticket-as-source-of-truth
   * principle, and the fix is narrow enough (one already-existing, narrowly-scoped mechanism,
   * wired to one additional call site) to be worth closing rather than leaving open.
   *
   * Deliberately NOT extended to evidence: `.trackwright/evidence/` is gitignored by design (see
   * this repo's own dogfood target's .gitignore) — evidence is local/ephemeral audit data, never
   * meant to be a shared, committed artifact, unlike a ticket's Requirements/Acceptance
   * Criteria/Plan/Tasks. Deliberately NOT a separate state ref/branch either — no real-usage
   * evidence suggests ticket files need to live outside the normal project history, and a second
   * ref would be meaningfully more MVP scope than this warrants.
   *
   * Best-effort and narrowly scoped: stages and commits only this one ticket's own file (never
   * -A), and a failure here (no git identity configured, mid-merge, etc.) never fails the step —
   * the ticket's actual state is already safely on disk via ticketStore.save above regardless.
   */
  private async commitTicketState(ticket: Ticket, fromStage: Stage, toStage: Stage, outcome: RunOutcome): Promise<void> {
    if (!ticket.filePath) return;
    try {
      if (!(await this.deps.gitRepo.isGitRepository())) return;
      if (!(await this.deps.gitRepo.hasChangesIn([ticket.filePath]))) return;
      await this.deps.gitRepo.addPaths([ticket.filePath]);
      await this.deps.gitRepo.commit(`chore(trackwright): ${ticket.frontmatter.id} ${fromStage} -> ${toStage} [${outcome}]`);
    } catch {
      // Best-effort — see doc comment above. The ticket's state is already durable on disk.
    }
  }

  private async executeVerification(ticket: Ticket): Promise<AgentResult> {
    const diff = await this.projectDiff();
    const testEvidence = await this.deps.evidenceStore.latestForStage(ticket.frontmatter.id, 'testing');
    const result = await this.executeClaudeAgent(
      'verification-agent',
      ticket,
      {
        diff,
        testEvidence: testEvidence ? JSON.stringify(testEvidence) : '(no testing evidence recorded)',
      },
      'verification',
    );
    if (result.outcome !== 'SUCCESS' || !requiresDesignGate(ticket)) return result;

    // Design-sensitive ticket that otherwise passed verification: also run the visual check
    // (docs/architecture.md, "Post-implementation visual verification"). DESIGN_CONCERNS/FAIL can
    // downgrade an otherwise-passing verification — a design ticket isn't "done" just because the
    // functional verification passed.
    const artifact = await this.designProvider.getLatestForTicket(ticket.frontmatter.id);
    if (!artifact) return result; // nothing to check against — routing already required approval earlier
    const check = await this.visualVerifier.verify({ designArtifact: artifact, resultArtifactPath: null });
    await this.designProvider.recordVisualCheck(artifact.designId, check);

    if (check.outcome === 'DESIGN_FAIL') {
      return {
        ...result,
        outcome: 'VERIFICATION_FAILED',
        summary: `visual check failed: ${check.summary}`,
        data: { ...result.data, design_status: 'failed' },
      };
    }
    if (check.outcome === 'DESIGN_CONCERNS') {
      return { ...result, outcome: 'CONCERNS', summary: `visual check has concerns: ${check.summary}` };
    }
    return result;
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
