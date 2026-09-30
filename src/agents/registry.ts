import type { Ticket } from '../tickets/schema.js';
import type { RunOutcome } from '../workflow/outcomes.js';

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
 * Every agent prompt ends with this exact instruction, because ClaudeCliRunner parses
 * `envelope.result` as JSON matching this shape (see runner.ts, parseAgentPayload). Keeping the
 * contract text in one place means every agent stays consistent if the contract ever changes.
 */
function outputContract(outcomes: readonly RunOutcome[]): string {
  return `
Respond with ONLY a single JSON object, no markdown fences, no prose before or after it, matching:

{
  "outcome": one of ${JSON.stringify(outcomes)},
  "summary": "one sentence, human-readable",
  "data": { ...agent-specific structured fields... },
  "failureReason": "required if outcome is not SUCCESS, otherwise omit"
}

If you are uncertain, choose the outcome that fails closed (blocks progress) rather than the one
that lets the ticket advance. Never invent an outcome outside the list above.`;
}

function ticketSection(ticket: Ticket, name: string): string {
  return ticket.sections[name]?.trim() || '(empty)';
}

const PLANNER: AgentDefinition = {
  name: 'planner',
  role: 'Turns a ticket\'s Context into concrete Requirements, Acceptance Criteria, a Definition of Done, a Plan, and Tasks.',
  model: 'sonnet',
  allowedTools: ['Read', 'Grep', 'Glob'],
  disallowedTools: ['Write', 'Edit', 'Bash'],
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
ticket. Put the full text of each in "data" as { "requirements": "...", "acceptanceCriteria":
"...", "definitionOfDone": "...", "plan": "...", "tasks": "..." }. All five fields are required —
this ticket cannot leave planning without them.`;
  },
};

function implementer(name: string, specializationHint: string, model: string): AgentDefinition {
  return {
    name,
    role: `Writes the ${specializationHint} half of a ticket's implementation.`,
    model,
    allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
    disallowedTools: ['Bash(git push*)', 'Bash(git reset --hard*)', 'Bash(git clean*)'],
    forbiddenActions: [
      'Pushing to any remote branch',
      'Force-pushing or discarding history',
      'Merging or approving its own work',
      'Committing to main/master directly',
    ],
    canWriteCode: true,
    canChangeTicketState: false,
    permissionMode: 'acceptEdits',
    validOutcomes: ['SUCCESS', 'RETRYABLE_FAILURE', 'BLOCKED', 'NEEDS_REPLAN', 'SYSTEM_ERROR'],
    buildSystemPrompt() {
      return `You are the ${specializationHint} implementation agent. You implement exactly what this
ticket's Requirements, Acceptance Criteria, and Plan describe — nothing more, nothing less. You may
read, write, and edit files, and run build/test commands, but you never push, force-push, or touch
git history destructively, and you never merge or approve anything.` + outputContract(this.validOutcomes);
    },
    buildTaskPrompt(ctx) {
      return `Ticket ${ctx.ticket.frontmatter.id}: ${ctx.ticket.frontmatter.title}

## Requirements
${ticketSection(ctx.ticket, 'Requirements')}

## Acceptance Criteria
${ticketSection(ctx.ticket, 'Acceptance Criteria')}

## Plan
${ticketSection(ctx.ticket, 'Plan')}

Implement this. Report what you changed in "data": { "filesChanged": [...], "notes": "..." }.`;
    },
  };
}

const CODE_REVIEWER: AgentDefinition = {
  name: 'code-reviewer',
  role: 'Reviews the diff for quality, architecture fit, security, and regressions — never runs tests.',
  model: 'opus',
  allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git diff*)', 'Bash(git log*)'],
  disallowedTools: ['Write', 'Edit', 'Bash(git commit*)', 'Bash(git push*)'],
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
implementation.` + outputContract(this.validOutcomes);
  },
  buildTaskPrompt(ctx) {
    return `Ticket ${ctx.ticket.frontmatter.id}: ${ctx.ticket.frontmatter.title}

Review the current diff in this repository (\`git diff\` against the base branch) for quality,
architecture, security, and regressions. Report findings in "data": { "findings": [...] }.`;
  },
};

const VERIFICATION_AGENT: AgentDefinition = {
  name: 'verification-agent',
  role: 'Independently judges whether the final diff satisfies this ticket\'s Acceptance Criteria and Definition of Done.',
  model: 'opus',
  allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git diff*)'],
  disallowedTools: ['Write', 'Edit', 'Bash(git commit*)', 'Bash(git push*)'],
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
Your available outcomes are: PASS ("SUCCESS" in this contract), CONCERNS (real doubt, but not
clearly wrong — this blocks automatic progress and needs a human), FAIL ("VERIFICATION_FAILED" —
clearly does not satisfy the ticket), or SYSTEM_ERROR if you cannot evaluate at all.` +
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

Judge only against the above. Report reasoning in "data": { "reasoning": "..." }.`;
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
