import path from 'node:path';
import { CONFIG_DIR, loadConfig } from '../../config/loader.js';
import { TicketStore } from '../../tickets/store.js';
import { EvidenceStore } from '../../evidence/store.js';
import { GitRepo } from '../../git/repo.js';

export class WaiveNotAllowedError extends Error {}

/**
 * The ONLY code path in Trackwright that can produce a WAIVED evidence record. No agent, no
 * automated stage runner can call this — it is a separate CLI command a human runs by hand, and
 * it refuses unless the ticket is genuinely sitting in `verification` with an unresolved
 * CONCERNS outcome (you cannot waive something that was never flagged as a concern). See
 * docs/architecture.md, "Verification, independent of implementation".
 */
export async function runTicketWaive(projectRoot: string, ticketId: string, reason: string): Promise<string> {
  if (!reason || reason.trim().length === 0) {
    throw new WaiveNotAllowedError('a --reason is required to waive a concern');
  }

  const config = await loadConfig(projectRoot);
  const ticketStore = new TicketStore(path.join(projectRoot, config.ticketsDir));
  const evidenceStore = new EvidenceStore(path.join(projectRoot, config.evidenceDir));
  const gitRepo = new GitRepo(projectRoot);

  const ticket = await ticketStore.getOrThrow(ticketId);
  if (ticket.frontmatter.stage !== 'verification') {
    throw new WaiveNotAllowedError(
      `ticket ${ticketId} is at stage "${ticket.frontmatter.stage}", not "verification" — nothing to waive`,
    );
  }
  const latest = await evidenceStore.latestForStage(ticketId, 'verification');
  if (!latest || latest.outcome !== 'CONCERNS') {
    throw new WaiveNotAllowedError(
      `ticket ${ticketId}'s latest verification outcome is "${latest?.outcome ?? '(none)'}", not "CONCERNS" — nothing to waive`,
    );
  }

  const currentSha = await safeSha(gitRepo);
  await evidenceStore.record({
    runId: evidenceStore.newRunId(),
    ticketId,
    stage: 'verification',
    agent: 'human',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    outcome: 'WAIVED',
    attempt: (await evidenceStore.attemptCount(ticketId, 'verification')) + 1,
    artifacts: [],
    gitSha: currentSha,
    summary: `waived by human: ${reason}`,
  });

  const updated = {
    ...ticket,
    frontmatter: { ...ticket.frontmatter, stage: 'awaiting-merge' as const },
  };
  await ticketStore.save(updated);

  return `${ticketId}: CONCERNS waived, moved to "awaiting-merge". Reason recorded: ${reason}`;
}

async function safeSha(repo: GitRepo): Promise<string | null> {
  try {
    return await repo.lastRelevantSha([CONFIG_DIR]); // same SHA basis as the engine's evidence
  } catch {
    return null;
  }
}
