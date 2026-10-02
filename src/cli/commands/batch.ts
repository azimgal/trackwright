import { runBatch, type BatchOptions, type BatchResult } from '../../workflow/batch.js';
import { DependencyCycleError } from '../../dependencies/dag.js';

/** CLI-facing entry point for `trackwright batch` — a thin passthrough to workflow/batch.ts.
 * Re-exports DependencyCycleError so the CLI layer can render a clear "fix your ticket graph"
 * message instead of a raw stack trace. */
export async function runTicketBatch(
  projectRoot: string,
  ticketIds: readonly string[],
  options: BatchOptions = {},
): Promise<BatchResult> {
  return runBatch(projectRoot, ticketIds, options);
}

export { DependencyCycleError };
