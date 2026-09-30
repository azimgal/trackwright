import type { RunOutcome } from '../workflow/outcomes.js';
import type { Stage } from '../workflow/stages.js';

export interface EvidenceRecord {
  runId: string;
  ticketId: string;
  stage: Stage;
  agent: string;
  startedAt: string;
  endedAt: string;
  /**
   * WAIVED is deliberately NOT part of RunOutcome/FailureOutcome — it can never be a value an
   * agent or the state machine's nextStage() produces (that function's type signature excludes
   * it). The only writer of a WAIVED evidence record is the explicit `trackwright ticket waive`
   * CLI command, which a human runs by hand. See workflow/engine.ts.
   */
  outcome: RunOutcome | 'WAIVED';
  attempt: number;
  artifacts: string[];
  gitSha: string | null;
  failureReason?: string;
  /**
   * A truncated excerpt of the agent's raw response, recorded only for SYSTEM_ERROR (a parse
   * failure or contract violation). Found necessary during real (non-mock) dogfooding: without
   * this, diagnosing why an agent's response didn't parse required manually reproducing the exact
   * invocation by hand — see docs/architecture.md's dogfood notes. Bounded to a few KB so evidence
   * files stay reasonably sized; the full response is not durably kept anywhere.
   */
  rawExcerpt?: string;
  /**
   * Claude Code's own `permission_denials` from the response envelope, recorded whenever present
   * regardless of outcome — an agent can report SUCCESS while a tool call it needed (e.g. its own
   * `git commit`) was silently denied, leaving work undone with no error surfaced anywhere else.
   * Found necessary via real dogfooding: diagnosing a silently-blocked git commit required a
   * manual standalone repro to even discover permission_denials existed in the envelope at all.
   */
  permissionDenials?: unknown[];
  summary: string;
  costUsd?: number;
}
