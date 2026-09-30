import { GitRepo } from './repo.js';

export const PROTECTED_BRANCHES = ['main', 'master'] as const;

export class ProtectedBranchError extends Error {
  constructor(branch: string, action: string) {
    super(`refusing to ${action} on protected branch "${branch}" — Trackwright never does this automatically`);
    this.name = 'ProtectedBranchError';
  }
}

export function isProtectedBranch(branch: string): boolean {
  return (PROTECTED_BRANCHES as readonly string[]).includes(branch);
}

export function assertNotProtectedBranch(branch: string, action: string): void {
  if (isProtectedBranch(branch)) {
    throw new ProtectedBranchError(branch, action);
  }
}

/**
 * Deterministic, ticket-scoped work-branch name. Collisions are avoided by the ticket id itself
 * being unique (see TicketStore.nextId) — no random suffix needed.
 */
export function workBranchName(ticketId: string): string {
  return `trackwright/${ticketId.toLowerCase()}`;
}

/**
 * Ensure a dedicated branch exists and is checked out for this ticket's work, never touching a
 * protected branch directly. Refuses if the repo has uncommitted changes that are not this run's
 * own — see docs/architecture.md, "Git safety": never discard work this run did not itself
 * create.
 */
export async function ensureWorkBranch(repo: GitRepo, ticketId: string): Promise<string> {
  const branch = workBranchName(ticketId);
  const current = await repo.currentBranch();
  assertNotProtectedBranch(current, 'start work directly on');

  if (await repo.branchExists(branch)) {
    await repo.checkout(branch);
  } else {
    await repo.createBranch(branch);
  }
  return branch;
}

/**
 * The MVP never performs a real `git push`. This function exists as the single choke point a
 * future push implementation MUST go through, so the protected-branch and force-push refusals
 * are enforced in exactly one place rather than re-implemented at every call site.
 */
export function assertPushIsSafe(branch: string, force: boolean): void {
  assertNotProtectedBranch(branch, 'push');
  if (force) {
    throw new Error('refusing to force-push — Trackwright never force-pushes automatically');
  }
}
