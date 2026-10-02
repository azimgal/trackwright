import { GitRepo } from './repo.js';

export const PROTECTED_BRANCHES = ['main', 'master'] as const;

export class ProtectedBranchError extends Error {
  constructor(branch: string, action: string) {
    // `action` carries its own trailing preposition (e.g. "run on", "push to") so the message
    // reads correctly for every caller — a bare "refusing to run against on protected branch"
    // (double preposition) was a real, user-facing wording bug found during the release-readiness
    // audit, from `assertNotProtectedBranch(current, 'run against')` plus a hardcoded " on" here.
    super(`refusing to ${action} protected branch "${branch}" — Trackwright never does this automatically`);
    this.name = 'ProtectedBranchError';
  }
}

export class UncommittedChangesError extends Error {
  constructor() {
    super(
      'refusing to switch branches: the repository has uncommitted changes. Commit, stash, or ' +
        'discard them yourself first — Trackwright never discards work it did not create, and ' +
        'never wants to silently carry unrelated changes onto a ticket\'s dedicated branch.',
    );
    this.name = 'UncommittedChangesError';
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
  assertNotProtectedBranch(current, 'run on');
}

/**
 * Ensure a dedicated branch exists and is checked out for this ticket's work, never touching a
 * protected branch directly. Refuses outright if the repo has uncommitted changes *and* a branch
 * switch is actually about to happen — a `checkout` to an *existing* branch can silently carry
 * unrelated uncommitted work onto it (git only refuses that checkout when there's an actual file
 * conflict, not always), and this function has no way to know whether uncommitted changes belong
 * to this ticket or to something else the caller was in the middle of. See docs/architecture.md,
 * "Git safety": never discard, and never silently relocate, work this run did not itself create.
 *
 * Already on the ticket's own branch? Return immediately, before any uncommitted-changes check.
 * Found necessary via real dogfooding: `trackwright run` calls this at the start of every single
 * step, not just the first — once Development has genuinely started, the working tree legitimately
 * carries real in-progress changes (including, as found separately, an implementer that forgot to
 * commit). Checking out the branch you're already on is a pure no-op for git, so there is nothing
 * for the uncommitted-changes guard to protect against in that case; applying it anyway meant a
 * ticket resumed mid-run could never get past this check at all.
 */
export async function ensureWorkBranch(
  repo: GitRepo,
  ticketId: string,
  ignorePathPrefixes: readonly string[] = [],
): Promise<string> {
  const branch = workBranchName(ticketId);
  await assertCurrentBranchIsSafeToRunOn(repo);

  if ((await repo.currentBranch()) === branch) {
    return branch;
  }

  if (await repo.hasUncommittedChanges(ignorePathPrefixes)) {
    throw new UncommittedChangesError();
  }

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
  assertNotProtectedBranch(branch, 'push to');
  if (force) {
    throw new Error('refusing to force-push — Trackwright never force-pushes automatically');
  }
}
