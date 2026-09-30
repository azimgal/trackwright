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
 * Refuse to let a run proceed at all while checked out on a protected branch. This is
 * deliberately separate from — and always called ahead of — the "create a dedicated branch" part
 * of the flow (ensureWorkBranch below), because `trackwright run --skip-branch` skips branch
 * *creation* but must never skip this check: an implementer agent's own Bash/Write/Edit tool
 * calls operate on whatever branch is currently checked out, protected or not, and --skip-branch
 * exists for users who already manage their own branching — not as a way to let an agent commit
 * directly to main/master by passing one extra flag.
 */
export async function assertCurrentBranchIsSafeToRunOn(repo: GitRepo): Promise<void> {
  const current = await repo.currentBranch();
  assertNotProtectedBranch(current, 'run against');
}

/**
 * Ensure a dedicated branch exists and is checked out for this ticket's work, never touching a
 * protected branch directly. Refuses if the repo has uncommitted changes that are not this run's
 * own — see docs/architecture.md, "Git safety": never discard work this run did not itself
 * create.
 */
export async function ensureWorkBranch(repo: GitRepo, ticketId: string): Promise<string> {
  const branch = workBranchName(ticketId);
  await assertCurrentBranchIsSafeToRunOn(repo);

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
