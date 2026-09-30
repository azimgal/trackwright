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
    const pathspecs = ignorePathPrefixes.map((p) => `:(exclude)${p}`);
    const status = await this.git(['status', '--porcelain', '--', '.', ...pathspecs]);
    return status.length > 0;
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

  async commit(message: string): Promise<void> {
    await this.git(['commit', '-m', message]);
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

  /** Diff against the first existing candidate base branch, falling back to the last commit. */
  async diffAgainstBase(candidates: readonly string[] = ['main', 'master']): Promise<string> {
    for (const base of candidates) {
      if (await this.branchExists(base)) {
        try {
          return await this.git(['diff', `${base}...HEAD`]);
        } catch {
          // fall through to the next candidate or the HEAD~1 fallback below
        }
      }
    }
    try {
      return await this.git(['diff', 'HEAD~1', 'HEAD']);
    } catch {
      return '';
    }
  }
}
