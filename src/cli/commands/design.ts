import path from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { TicketStore } from '../../tickets/store.js';
import { LocalDesignArtifactProvider } from '../../design/local-provider.js';
import { DesignNotFoundError } from '../../design/provider.js';
import { GitRepo } from '../../git/repo.js';
import { hashText } from '../../design/staleness.js';

export class DesignApproveNotAllowedError extends Error {}

async function providerFor(projectRoot: string) {
  await loadConfig(projectRoot); // throws ConfigNotFoundError if `trackwright init` was never run
  return new LocalDesignArtifactProvider(path.join(projectRoot, '.trackwright', 'design'));
}

/**
 * Human-only, like `trackwright ticket waive` — the only code path that can move a design
 * artifact's status to "approved". Also records the current git SHA and the ticket's current
 * Requirements hash onto the artifact and flips the ticket's own `design_status` to "synced", so
 * the Ready gate (engine.ts, executeReadyGate) and future staleness checks both see it.
 */
export async function runDesignApprove(projectRoot: string, designId: string): Promise<string> {
  const provider = await providerFor(projectRoot);
  const artifact = await provider.getDesign(designId);
  if (!artifact) {
    throw new DesignApproveNotAllowedError(`no design artifact found with id "${designId}"`);
  }

  const config = await loadConfig(projectRoot);
  const ticketStore = new TicketStore(path.join(projectRoot, config.ticketsDir));
  const ticket = await ticketStore.getOrThrow(artifact.ticketId);

  const gitRepo = new GitRepo(projectRoot);
  let currentSha: string | null = null;
  try {
    currentSha = await gitRepo.currentSha();
  } catch {
    // no commits yet — reference SHA stays null, staleness-by-SHA simply won't trigger until one exists
  }

  await provider.approve(designId);
  if (currentSha) await provider.setReferenceSha(designId, currentSha);

  const updated = {
    ...ticket,
    frontmatter: {
      ...ticket.frontmatter,
      design_status: 'synced' as const,
    },
  };
  await ticketStore.save(updated);

  return `${designId}: approved for ${artifact.ticketId}. Ticket design_status set to "synced".`;
}

/**
 * Throws (exit 1) when `designId` doesn't exist at all — found inconsistent during the
 * release-readiness audit against `ticket show <id>`, which already exits 1 on an unknown id.
 * `design list <ticketId>` deliberately stays soft (exit 0, "no design artifact for ticket X"):
 * most tickets legitimately have no design yet, the same way an empty `ticket list` is not an
 * error — but asking for one *specific* design id that was never created is a user-facing
 * not-found, the same shape as `ticket show` on a typo'd id.
 */
export async function runDesignShow(projectRoot: string, designId: string): Promise<string> {
  const provider = await providerFor(projectRoot);
  const artifact = await provider.getDesign(designId);
  if (!artifact) throw new DesignNotFoundError(designId);
  return JSON.stringify(artifact, null, 2);
}

export async function runDesignList(projectRoot: string, ticketId: string): Promise<string> {
  const provider = await providerFor(projectRoot);
  const artifact = await provider.getLatestForTicket(ticketId);
  if (!artifact) return `(no design artifact for ticket ${ticketId})`;
  return `${artifact.designId}  v${artifact.version}  [${artifact.status}]  ${artifact.artifactPath ?? '(no path)'}`;
}

// Re-exported so callers can compute a requirements hash the same way engine.ts does, e.g. for
// scripting/debugging — not required for normal CLI use.
export { hashText };
