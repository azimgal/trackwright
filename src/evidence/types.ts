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
  summary: string;
  costUsd?: number;
}
