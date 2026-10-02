import type { Ticket } from '../tickets/schema.js';

export type DependencyReadiness =
  | { ready: true }
  | { ready: false; reason: 'unmet'; pending: readonly string[] }
  /** At least one dependency is `cancelled` — this ticket cannot become ready through the normal
   * flow at all; it needs a human to either un-cancel the dependency or remove/replace it. */
  | { ready: false; reason: 'blocked-by-cancelled-dependency'; cancelled: readonly string[] };

/**
 * Per-ticket dependency readiness, distinguishing "still waiting, might resolve on its own" from
 * "blocked by a dependency that will never become done through normal means" — the Ready gate
 * (workflow/engine.ts, executeReadyGate) previously treated every non-"done" dependency status
 * identically, giving a human no way to tell "this is just not finished yet" apart from "this is
 * never going to finish, go fix the ticket graph" from the BLOCKED summary alone.
 */
export function dependencyReadiness(ticket: Ticket, byId: ReadonlyMap<string, Ticket>): DependencyReadiness {
  const cancelled: string[] = [];
  const pending: string[] = [];
  for (const depId of ticket.frontmatter.dependencies) {
    const dep = byId.get(depId);
    if (!dep) {
      pending.push(depId); // unknown/not-yet-created — may still show up later
      continue;
    }
    if (dep.frontmatter.status === 'cancelled') cancelled.push(depId);
    else if (dep.frontmatter.status !== 'done') pending.push(depId);
  }
  if (cancelled.length > 0) return { ready: false, reason: 'blocked-by-cancelled-dependency', cancelled };
  if (pending.length > 0) return { ready: false, reason: 'unmet', pending };
  return { ready: true };
}
