import { DEFAULT_RETRY_CEILING } from '../workflow/outcomes.js';
import type { Stage } from '../workflow/stages.js';
import type { EvidenceStore } from '../evidence/store.js';

/**
 * Has this (ticket, stage) pair already exhausted its retry ceiling? Ceiling is counted from
 * durable evidence (see EvidenceStore.attemptCount), not an in-memory counter, so it survives a
 * process restart. When this returns true, the workflow engine must fail closed (BLOCKED) rather
 * than attempt again, regardless of what the stage's own outcome table would otherwise allow.
 */
export async function hasExceededCeiling(
  evidence: EvidenceStore,
  ticketId: string,
  stage: Stage,
  ceiling: number = DEFAULT_RETRY_CEILING,
): Promise<boolean> {
  const attempts = await evidence.attemptCount(ticketId, stage);
  return attempts >= ceiling;
}
