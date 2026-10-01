import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Thin, argv-array (never shell-string) wrapper around git — avoids any injection surface from
 * ticket content or branch names ending up concatenated into a shell command. */
export class GitRepo {
  constructor(private readonly cwd: string) {}

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: this.cwd });
    return stdout.trim();
  }

  async currentSha(): Promise<string> {
    return this.git(['rev-parse', 'HEAD']);
  }

  async currentBranch(): Promise<string> {
    return this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  /**
   * `ignorePathPrefixes` excludes paths from the check via git pathspec `:(exclude)` — used so a
   * just-created, not-yet-committed ticket file (normal, expected between `ticket create` and
   * `run`) doesn't itself trip the "unrelated uncommitted work" guard in git/safety.ts. Only
   * Trackwright's own bookkeeping paths should ever be passed here, never anything from the
   * project being worked on.
   */
  async hasUncommittedChanges(ignorePathPrefixes: readonly string[] = []): Promise<boolean> {
    return (await this.uncommittedStatus(ignorePathPrefixes)).length > 0;
  }

  /** The raw `git status --porcelain` text for everything outside `ignorePathPrefixes` — empty
   * string if clean. Same exclusion mechanism as hasUncommittedChanges, which now delegates here;
   * split out so a caller (e.g. workflow/engine.ts's post-implementer check) can report exactly
   * which paths are uncommitted, not just a yes/no. */
  async uncommittedStatus(ignorePathPrefixes: readonly string[] = []): Promise<string> {
    const pathspecs = ignorePathPrefixes.map((p) => `:(exclude)${p}`);
    return this.git(['status', '--porcelain', '--', '.', ...pathspecs]);
  }

  async createBranch(name: string): Promise<void> {
    await this.git(['checkout', '-b', name]);
  }

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', name]);
      return true;
    } catch {
      return false;
    }
  }

  async checkout(name: string): Promise<void> {
    await this.git(['checkout', name]);
  }

  async addAll(): Promise<void> {
    await this.git(['add', '-A']);
  }

  /** Stages only the given paths — unlike addAll(), never pulls in unrelated working-tree changes
   * a developer may have in progress. Used for Trackwright's own bookkeeping commits (config,
   * ticket files), which must never sweep up project content that isn't theirs to commit. */
  async addPaths(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.git(['add', '--', ...paths]);
  }

  async commit(message: string): Promise<void> {
    await this.git(['commit', '-m', message]);
  }

  /** True if any of the given paths have staged or unstaged changes (including being untracked). */
  async hasChangesIn(paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return false;
    const status = await this.git(['status', '--porcelain', '--', ...paths]);
    return status.length > 0;
  }

  /** Is `cwd` actually inside a git working tree at all? Not to be confused with "no uncommitted
   * changes" — that's `hasUncommittedChanges()` above, a deliberately different question. */
  async isGitRepository(): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Diff against the first existing candidate base branch, falling back to the last commit.
   * `excludePathPrefixes` drops the given paths from the diff entirely (same `:(exclude)`
   * pathspec mechanism as `hasUncommittedChanges`) — callers that feed this diff to a Claude
   * agent with a bounded prompt size (see workflow/engine.ts, executeVerification) should always
   * exclude Trackwright's own bookkeeping paths (tickets/evidence/config), or that content can
   * silently crowd out the actual project diff the agent is meant to review. Found via real
   * dogfooding: a ticket whose cumulative `.trackwright/tickets/*.md` + evidence content pushed
   * the combined diff just past the 20k-char cap meant the real code change (alphabetically last)
   * never reached the verification agent at all, producing a false VERIFICATION_FAILED.
   */
  async diffAgainstBase(
    candidates: readonly string[] = ['main', 'master'],
    excludePathPrefixes: readonly string[] = [],
  ): Promise<string> {
    const pathspecs = excludePathPrefixes.map((p) => `:(exclude)${p}`);
    const pathArgs = pathspecs.length > 0 ? ['--', '.', ...pathspecs] : [];
    for (const base of candidates) {
      if (await this.branchExists(base)) {
        try {
          return await this.git(['diff', `${base}...HEAD`, ...pathArgs]);
        } catch {
          // fall through to the next candidate or the HEAD~1 fallback below
        }
      }
    }
    try {
      return await this.git(['diff', 'HEAD~1', 'HEAD', ...pathArgs]);
    } catch {
      return '';
    }
  }
}
