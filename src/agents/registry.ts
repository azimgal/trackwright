import type { Ticket } from '../tickets/schema.js';
import type { RunOutcome } from '../workflow/outcomes.js';

/**
 * Claude Code offers both Bash and PowerShell as shell tools on Windows — a scoped allowedTools
 * pattern like `Bash(git add*)` does NOT also cover `PowerShell(git add*)`; they are matched
 * independently. Found via real dogfooding (DF-0008, then reproduced deterministically on
 * DF-0009): once the model tries one git/test command via Bash and it's denied (e.g. because it
 * compounded it with `cd ...` or an out-of-scope command), it tends to retry the *same* command
 * via PowerShell instead — which was never allow-listed at all, since every agent here only ever
 * listed Bash patterns. The result was a 100%-reproducible dead end (confirmed via a standalone
 * `claude -p` repro: identical git commands denied every time through PowerShell, zero denials
 * once PowerShell(...) patterns were added) that cost 2-3 wasted real Claude Opus invocations per
 * occurrence and, in both real runs, exhausted enough of the stage's retry ceiling to reach
 * awaiting-human on a ticket that had, in fact, already been correctly implemented.
 */
function bashAndPowerShell(patterns: readonly string[]): string[] {
  return patterns.flatMap((p) => [`Bash(${p})`, `PowerShell(${p})`]);
}

export interface AgentPromptContext {
  ticket: Ticket;
  cwd: string;
  /** Stage-specific extra material (diff text, evidence, review findings). Never the whole ticket. */
  extra?: Record<string, string>;
}

export interface AgentDefinition {
  readonly name: string;
  readonly role: string;
  readonly model: string;
  readonly allowedTools: string[];
  readonly disallowedTools: string[];
  /** Documented, human-readable — enforced in practice via allowedTools/disallowedTools above. */
  readonly forbiddenActions: string[];
  readonly canWriteCode: boolean;
  readonly canChangeTicketState: boolean;
  readonly permissionMode: 'acceptEdits' | 'bypassPermissions' | 'dontAsk';
  readonly validOutcomes: readonly RunOutcome[];
  buildSystemPrompt(): string;
  buildTaskPrompt(ctx: AgentPromptContext): string;
}

/**
 * General framing in the system prompt. The CONCRETE shape (with "outcome" and "summary" as
 * literal, visible top-level keys next to a real example of this agent's "data") belongs in the
 * task prompt instead — see concreteEnvelopeExample below. Found necessary during real
 * dogfooding: an abstract schema description in the system prompt, separate from a task prompt
 * that only describes the "data" fields in isolation, measurably let the model's attention drift
 * to producing `{"data": {...}}` alone and dropping the "outcome"/"summary" wrapper entirely —
 * observed 3/3 times on a real planner prompt with several substantial `data` fields, even after
 * being told about the previous attempt's failure (see engine.ts, previousFailureNote). One
 * unified, concrete example is measurably stickier than two abstract, separately-stated parts.
 */
/**
 * Shared warning against prefixing a scoped Bash command with `cd ... &&`. Every agent here
 * already runs with its cwd set to the project root (see AgentInvocation.cwd in engine.ts), but
 * found via real dogfooding (DF-0007): the model prefixes shell commands with `cd "<path>" &&`
 * anyway, out of habit. Doing so makes the whole command no longer match a scoped allowedTools
 * pattern like `Bash(git diff*)` (the string no longer starts with `git diff`), so it is silently
 * denied — `permission_denials` shows up in evidence, but nothing tells the agent *why*, and
 * (confirmed via real runs: code-reviewer twice, verification-agent once, all on DF-0007) an
 * agent can still report a clean outcome having silently fallen back to Read-ing files instead of
 * actually running the command it needed. This warning was previously implementer-only — the
 * exact same failure recurring on two other Bash-using agents is why it is now a shared helper
 * every Bash-using agent's prompt calls, instead of being re-derived (or forgotten) per agent.
 */
function noCdPrefixWarning(commandExamples: string): string {
  return (
    `\n\nYour working directory is already this project's root — run ${commandExamples} as ` +
    `standalone commands, never prefixed with \`cd ... &&\`. A leading \`cd\` makes the whole ` +
    `command fail your permission check (it stops matching your pre-approved command patterns), ` +
    `so it will be silently blocked with no error shown to you — any commit you believed you just ` +
    `made, or any content you believed you just inspected, did not actually happen. If a command ` +
    `you needed might have been blocked, say so explicitly rather than reporting as if it ran.`
  );
}

function outputContract(outcomes: readonly RunOutcome[]): string {
  return `
You must respond with ONLY a single JSON object, no markdown fences, no prose before or after it.
The exact shape — including "outcome" and "summary" as literal top-level keys — is given as a
concrete example at the end of your task instructions. Never respond with only the "data" object;
"outcome" and "summary" are required siblings of "data", not optional.

Valid values for "outcome": ${JSON.stringify(outcomes)}.
If you are uncertain, choose the outcome that fails closed (blocks progress) rather than the one
that lets the ticket advance. Never invent an outcome outside this list.`;
}

/**
 * A concrete, fillable JSON template — the exact text every buildTaskPrompt ends with. Agents
 * pass their own example `data` shape; the "outcome"/"summary" wrapper is always shown literally
 * so the model has one single, concrete target to reproduce, not an abstraction to reconstruct
 * from two separate descriptions.
 */
function concreteEnvelopeExample(exampleData: Record<string, string>, alternateOutcome?: RunOutcome): string {
  const example = JSON.stringify({ outcome: 'SUCCESS', summary: '...', data: exampleData }, null, 2);
  const alt = alternateOutcome
    ? `\n\nIf something is genuinely ambiguous, use "outcome": "${alternateOutcome}" instead, and mark ` +
      `the ambiguous part inline using "[NEEDS CLARIFICATION: ...]" within the relevant data field.`
    : '';
  return `\nRespond with exactly this JSON shape (fill in the "..." parts with your real content; keep ` +
    `"outcome" and "summary" as actual top-level keys, not just "data"):\n\n${example}${alt}`;
}

function ticketSection(ticket: Ticket, name: string): string {
  return ticket.sections[name]?.trim() || '(empty)';
}

const PLANNER: AgentDefinition = {
  name: 'planner',
  role: 'Turns a ticket\'s Context into concrete Requirements, Acceptance Criteria, a Definition of Done, a Plan, and Tasks.',
  model: 'sonnet',
  allowedTools: ['Read', 'Grep', 'Glob'],
  disallowedTools: ['Write', 'Edit', 'Bash', 'PowerShell'],
  forbiddenActions: ['Writing or editing any file', 'Running shell commands', 'Deciding architecture on its own for anything touching a protected path'],
  canWriteCode: false,
  canChangeTicketState: false,
  permissionMode: 'dontAsk',
  validOutcomes: ['SUCCESS', 'NEEDS_CLARIFICATION', 'BLOCKED', 'SYSTEM_ERROR'],
  buildSystemPrompt() {
    return `You are the planning agent for a ticket-driven development tool. Your only job is to read
the ticket's Context section and the repository, then propose Requirements (EARS style: "WHEN
<condition> THE SYSTEM SHALL <behavior>"), Acceptance Criteria, a Definition of Done, a short Plan,
and a Tasks list. A ticket cannot leave planning without all of these — an empty or missing
Definition of Done is treated the same as an empty Requirements section, not an optional extra.
You never write or edit files. If something is genuinely ambiguous, write it as
"[NEEDS CLARIFICATION: ...]" inside the relevant section rather than guessing, and set outcome to
NEEDS_CLARIFICATION.` + outputContract(this.validOutcomes);
  },
  buildTaskPrompt(ctx) {
    return `Ticket ${ctx.ticket.frontmatter.id}: ${ctx.ticket.frontmatter.title}

## Context
${ticketSection(ctx.ticket, 'Context')}

Produce Requirements, Acceptance Criteria, a Definition of Done, a Plan, and Tasks for this
ticket. All five fields are required — this ticket cannot leave planning without them.
${concreteEnvelopeExample(
  {
    requirements: 'WHEN ... THE SYSTEM SHALL ... (EARS style, one line per requirement)',
    acceptanceCriteria: 'a testable, observable list of what "done" looks like',
    definitionOfDone: 'the concrete checklist this ticket must satisfy to be accepted',
    plan: 'a short, ordered plan for implementing this',
    tasks: 'a short, ordered task list derived from the plan',
  },
  'NEEDS_CLARIFICATION',
)}`;
  },
};

function implementer(name: string, specializationHint: string, model: string): AgentDefinition {
  return {
    name,
    role: `Writes the ${specializationHint} half of a ticket's implementation.`,
    model,
    // Bare 'Bash' does NOT get pre-approved without a prompt under either 'acceptEdits' or
    // 'dontAsk' in this headless -p invocation (no host to answer a prompt, so it's silently
    // denied) — confirmed empirically via a standalone repro. Only a scoped pattern like
    // 'Bash(git commit*)' is treated as pre-authorized. The implementer's only load-bearing Bash
    // need is committing its own work (see the system prompt below), so that's all it gets;
    // running the project's own tests/build is deliberately not in scope here — the dedicated
    // Testing stage runs those deterministically via Trackwright's own process spawn regardless.
    allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', ...bashAndPowerShell(['git add*', 'git commit*'])],
    disallowedTools: bashAndPowerShell(['git push*', 'git reset --hard*', 'git clean*']),
    forbiddenActions: [
      'Pushing to any remote branch',
      'Force-pushing or discarding history',
      'Merging or approving its own work',
      'Committing to main/master directly',
    ],
    canWriteCode: true,
    canChangeTicketState: false,
    // 'acceptEdits' auto-accepts Write/Edit tool calls by mode-specific behavior; Bash calls are
    // pre-authorized separately via the scoped allowedTools patterns above, not by the mode.
    // Found via real dogfooding: a bare 'Bash' entry under either 'acceptEdits' or 'dontAsk' left
    // the implementer unable to actually run `git commit`, silently defeating the instruction
    // below to commit its work — verified fixed via a standalone repro (scoped patterns +
    // acceptEdits: commit succeeds with zero permission_denials; a disallowed pattern like
    // 'git push' is still correctly denied even chained in a compound command).
    permissionMode: 'acceptEdits',
    validOutcomes: ['SUCCESS', 'RETRYABLE_FAILURE', 'BLOCKED', 'NEEDS_REPLAN', 'SYSTEM_ERROR'],
    buildSystemPrompt() {
      return `You are the ${specializationHint} implementation agent. You implement exactly what this
ticket's Requirements, Acceptance Criteria, and Plan describe — nothing more, nothing less. You may
read, write, and edit files, but you cannot run test or build commands yourself (a dedicated Testing
stage runs those after you); you never push, force-push, or touch git history destructively, and you
never merge or approve anything.

You MUST commit your changes (\`git add\` the specific files you changed, then \`git commit\`) before
you finish, with a commit message referencing this ticket's id. Later stages (code review, testing,
independent verification) read \`git diff\` against the base branch, not your uncommitted working
tree — if you don't commit, they will see an empty diff and the ticket will incorrectly appear to
have no changes at all, even though you did real work.` +
        noCdPrefixWarning('`git add ...` and `git commit ...`') +
        outputContract(this.validOutcomes);
    },
    buildTaskPrompt(ctx) {
      return `Ticket ${ctx.ticket.frontmatter.id}: ${ctx.ticket.frontmatter.title}

## Requirements
${ticketSection(ctx.ticket, 'Requirements')}

## Acceptance Criteria
${ticketSection(ctx.ticket, 'Acceptance Criteria')}

## Plan
${ticketSection(ctx.ticket, 'Plan')}

Implement this.
${concreteEnvelopeExample({
  filesChanged: 'comma-separated list of file paths you changed',
  notes: 'a short note on what you did and any deviations from the plan',
})}`;
    },
  };
}

const CODE_REVIEWER: AgentDefinition = {
  name: 'code-reviewer',
  role: 'Reviews the diff for quality, architecture fit, security, and regressions — never runs tests.',
  model: 'opus',
  allowedTools: ['Read', 'Grep', 'Glob', ...bashAndPowerShell(['git diff*', 'git log*'])],
  disallowedTools: ['Write', 'Edit', ...bashAndPowerShell(['git commit*', 'git push*'])],
  forbiddenActions: ['Editing any file', 'Committing', 'Deciding test correctness (that is Testing\'s job)'],
  canWriteCode: false,
  canChangeTicketState: false,
  permissionMode: 'dontAsk',
  validOutcomes: ['SUCCESS', 'RETRYABLE_FAILURE', 'SYSTEM_ERROR'],
  buildSystemPrompt() {
    return `You are the code review agent. You judge code quality, architectural fit, security, and
regression risk in the diff for this ticket. You do not run tests and you do not judge whether the
ticket's intent was fulfilled (that is a separate, independent verification step you have no
visibility into). If you find blocking issues, outcome is RETRYABLE_FAILURE and they route back to
implementation.

The diff you need to review is already provided below in your task prompt — you do not need to
run \`git diff\` yourself to get it. \`git log\`/\`git diff\` remain available if you want extra
history or context beyond what's given, but they are optional, not your primary source.` +
      noCdPrefixWarning('`git diff ...` and `git log ...`') +
      outputContract(this.validOutcomes);
  },
  buildTaskPrompt(ctx) {
    return `Ticket ${ctx.ticket.frontmatter.id}: ${ctx.ticket.frontmatter.title}

Review this diff for quality, architecture, security, and regressions.

## Diff
${ctx.extra?.diff ?? '(no diff provided)'}
${concreteEnvelopeExample({ findings: 'a short list of findings, or "none" if the diff is clean' })}`;
  },
};

const VERIFICATION_AGENT: AgentDefinition = {
  name: 'verification-agent',
  role: 'Independently judges whether the final diff satisfies this ticket\'s Acceptance Criteria and Definition of Done.',
  model: 'opus',
  allowedTools: ['Read', 'Grep', 'Glob', ...bashAndPowerShell(['git diff*'])],
  disallowedTools: ['Write', 'Edit', ...bashAndPowerShell(['git commit*', 'git push*'])],
  forbiddenActions: [
    'Editing any file',
    'Reading the ticket\'s Plan, Tasks, or implementer notes',
    'Setting outcome to WAIVED (only a human may waive a concern)',
  ],
  canWriteCode: false,
  canChangeTicketState: false,
  permissionMode: 'dontAsk',
  validOutcomes: ['SUCCESS', 'VERIFICATION_FAILED', 'CONCERNS', 'SYSTEM_ERROR'],
  buildSystemPrompt() {
    return `You are the independent verification agent. You answer exactly one question: does the
final diff satisfy this ticket's Acceptance Criteria and Definition of Done? You are NOT told how
the implementer reasoned about the problem, what plan they followed, or what they believed they
were doing — only what was required and what was built. This isolation is intentional: it is what
makes your judgment independent rather than a rubber stamp of the implementer's own framing.

You never set outcome to "WAIVED" — that outcome exists only for a human to record explicitly.
Here is what each of your four possible "outcome" values means — always write the value exactly
as shown (never a paraphrase like "PASS", "FAIL", or "FAILURE"; those are not valid values):
- "SUCCESS" — the diff satisfies every Acceptance Criterion and Definition of Done item.
- "VERIFICATION_FAILED" — it clearly does not.
- "CONCERNS" — real doubt, but not clearly wrong; this blocks automatic progress and needs a human.
- "SYSTEM_ERROR" — you cannot evaluate at all.

The diff and test evidence you need are already provided below in your task prompt — you do not
need to run \`git diff\` yourself to get them.` +
      noCdPrefixWarning('`git diff ...`') +
      outputContract(this.validOutcomes);
  },
  buildTaskPrompt(ctx) {
    // Deliberately whitelist-only: Requirements/Acceptance Criteria/Definition of Done, plus
    // whatever the caller passed as `extra` (diff, test evidence). Never ticket.sections['Plan']
    // or any implementer notes — see docs/architecture.md, "Verification, independent of
    // implementation" and the forbiddenActions entry above.
    return `Ticket ${ctx.ticket.frontmatter.id}: ${ctx.ticket.frontmatter.title}

## Requirements
${ticketSection(ctx.ticket, 'Requirements')}

## Acceptance Criteria
${ticketSection(ctx.ticket, 'Acceptance Criteria')}

## Definition of Done
${ticketSection(ctx.ticket, 'Definition of Done')}

## Final diff
${ctx.extra?.diff ?? '(no diff provided)'}

## Test evidence
${ctx.extra?.testEvidence ?? '(no test evidence provided)'}

Judge only against the above.
${concreteEnvelopeExample({ reasoning: 'your reasoning for the outcome you chose' })}`;
  },
};

const DESIGN_GATE_AGENT: AgentDefinition = {
  name: 'design-gate-agent',
  role: 'Only called when deterministic rules (design/gate.ts) cannot decide — judges whether a ticket is design-sensitive.',
  model: 'haiku',
  allowedTools: ['Read', 'Grep', 'Glob'],
  disallowedTools: ['Write', 'Edit', 'Bash', 'PowerShell'],
  forbiddenActions: ['Editing any file', 'Deciding this for a ticket the deterministic rules already resolved'],
  canWriteCode: false,
  canChangeTicketState: false,
  permissionMode: 'dontAsk',
  validOutcomes: ['SUCCESS', 'SYSTEM_ERROR'],
  buildSystemPrompt() {
    return `You are called only for tickets a deterministic rule set could not classify. Decide
whether this ticket's work is design-sensitive: does it touch anything a user would see or
interact with visually (UI markup, styling, layout, visual components), as opposed to purely
backend/infra/data logic with no visual surface? If you are genuinely unsure, fail closed: say it
IS design-sensitive (data.designRequired: true) rather than risk silently skipping a needed design
review — a false "not required" is worse than an unnecessary design gate.` + outputContract(this.validOutcomes);
  },
  buildTaskPrompt(ctx) {
    return `Ticket ${ctx.ticket.frontmatter.id}: ${ctx.ticket.frontmatter.title}

## Context
${ticketSection(ctx.ticket, 'Context')}

## Requirements
${ticketSection(ctx.ticket, 'Requirements')}

Decide design-sensitivity.
${concreteEnvelopeExample({ designRequired: 'true or false (as a real boolean, not a string)', reasoning: '...' })}`;
  },
};

export const AGENTS: Readonly<Record<string, AgentDefinition>> = {
  planner: PLANNER,
  'implementer.generic': implementer('implementer.generic', 'general', 'sonnet'),
  'implementer.frontend': implementer('implementer.frontend', 'frontend', 'sonnet'),
  'implementer.backend': implementer('implementer.backend', 'backend', 'opus'),
  'implementer.infrastructure': implementer('implementer.infrastructure', 'infrastructure', 'sonnet'),
  'code-reviewer': CODE_REVIEWER,
  'verification-agent': VERIFICATION_AGENT,
  'design-gate-agent': DESIGN_GATE_AGENT,
};

export class UnknownAgentError extends Error {
  constructor(readonly name: string) {
    super(`no agent registered under name "${name}"`);
    this.name = 'UnknownAgentError';
  }
}

export function getAgent(name: string): AgentDefinition {
  const agent = AGENTS[name];
  if (!agent) throw new UnknownAgentError(name);
  return agent;
}
