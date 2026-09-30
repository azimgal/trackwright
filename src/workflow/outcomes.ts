/**
 * Failure/outcome taxonomy. Every stage run ends in exactly one of these. The workflow engine
 * (engine.ts) uses this to decide the next stage; it never infers routing from free-text.
 */
export const FAILURE_OUTCOMES = [
  'RETRYABLE_FAILURE',
  'BLOCKED',
  'NEEDS_CLARIFICATION',
  'NEEDS_REPLAN',
  'VERIFICATION_FAILED',
  'CONCERNS',
  'CANCELLED',
  'SYSTEM_ERROR',
] as const;
export type FailureOutcome = (typeof FAILURE_OUTCOMES)[number];

/** A run either succeeds outright, or ends in one of the named failure outcomes above. */
export const RUN_OUTCOMES = ['SUCCESS', ...FAILURE_OUTCOMES] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * Verification-specific outcome vocabulary (BMAD-inspired, see docs/architecture.md). This is
 * distinct from RunOutcome: a verification run can technically SUCCEED (produce a well-formed
 * answer) while that answer is CONCERNS or FAIL, which then drives ticket routing.
 */
export const VERIFICATION_OUTCOMES = ['PASS', 'CONCERNS', 'FAIL', 'WAIVED'] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

/**
 * Which failure outcomes are safe to retry automatically, and up to what ceiling. Everything
 * else requires routing to a different stage or a human — never a bare retry loop.
 */
export const RETRYABLE: ReadonlySet<FailureOutcome> = new Set(['RETRYABLE_FAILURE', 'SYSTEM_ERROR']);

export const DEFAULT_RETRY_CEILING = 3;

export function isRetryable(outcome: FailureOutcome): boolean {
  return RETRYABLE.has(outcome);
}
