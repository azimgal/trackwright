import path from 'node:path';
import { CONFIG_DIR, loadConfig } from '../../config/loader.js';
import { TicketStore } from '../../tickets/store.js';
import { EvidenceStore } from '../../evidence/store.js';
import { GitRepo } from '../../git/repo.js';
import { hasExceededCeiling } from '../../policies/retry.js';

export class RetryNotAllowedError extends Error {}

/**
 * The ONLY code path in Trackwright that can produce a RETRY_RESET evidence record. No agent, no
 * automated stage runner can call this — it is a separate CLI command a human runs by hand, and
 * it refuses unless the ticket's current stage has genuinely exhausted its retry ceiling (you
 * cannot reset a counter that was never exceeded). See evidence/store.ts (attemptCount) for why
 * this exists: the retry ceiling is counted from durable, all-time evidence, so a stage BLOCKED by
 * a purely transient SYSTEM_ERROR (a Claude session rate limit, a network blip) has no automatic
 * way to recover once the external condition clears. This command is that recovery path — always
 * explicit, always reasoned, always recorded, never silent.
 */
export async function runTicketRetry(projectRoot: string, ticketId: string, reason: string): Promise<string> {
  if (!reason || reason.trim().length === 0) {
    throw new RetryNotAllowedError('a --reason is required to reset a retry ceiling');
  }

  const config = await loadConfig(projectRoot);
  const ticketStore = new TicketStore(path.join(projectRoot, config.ticketsDir));
  const evidenceStore = new EvidenceStore(path.join(projectRoot, config.evidenceDir));
  const gitRepo = new GitRepo(projectRoot);

  const ticket = await ticketStore.getOrThrow(ticketId);
  const stage = ticket.frontmatter.stage;
  if (!stage) {
    throw new RetryNotAllowedError(`ticket ${ticketId} has no current stage — nothing to retry`);
  }

  const exceeded = await hasExceededCeiling(evidenceStore, ticketId, stage, config.retryCeiling);
  if (!exceeded) {
    throw new RetryNotAllowedError(
      `ticket ${ticketId} at stage "${stage}" has not exceeded its retry ceiling (${config.retryCeiling}) — nothing to retry`,
    );
  }

  const currentSha = await safeSha(gitRepo);
  await evidenceStore.record({
    runId: evidenceStore.newRunId(),
    ticketId,
    stage,
    agent: 'human',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    outcome: 'RETRY_RESET',
    attempt: (await evidenceStore.attemptCount(ticketId, stage)) + 1,
    artifacts: [],
    gitSha: currentSha,
    summary: `retry ceiling reset by human: ${reason}`,
  });

  return `${ticketId}: retry ceiling at stage "${stage}" reset. Reason recorded: ${reason}. Run \`trackwright run ${ticketId}\` to resume.`;
}

async function safeSha(repo: GitRepo): Promise<string | null> {
  try {
    return await repo.lastRelevantSha([CONFIG_DIR]); // same SHA basis as the engine's evidence
  } catch {
    return null;
  }
}
