import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import {
  assertCurrentBranchIsSafeToRunOn,
  assertPushIsSafe,
  ensureWorkBranch,
  isProtectedBranch,
  ProtectedBranchError,
  UncommittedChangesError,
  workBranchName,
} from '../src/git/safety.js';
import { GitRepo } from '../src/git/repo.js';

const execFileAsync = promisify(execFile);

describe('git safety', () => {
  it('flags main and master as protected', () => {
    expect(isProtectedBranch('main')).toBe(true);
    expect(isProtectedBranch('master')).toBe(true);
    expect(isProtectedBranch('trackwright/tw-0001')).toBe(false);
  });

  it('refuses to push to a protected branch', () => {
    expect(() => assertPushIsSafe('main', false)).toThrow(ProtectedBranchError);
  });

  it('refuses a force push even on a non-protected branch', () => {
    expect(() => assertPushIsSafe('trackwright/tw-0001', true)).toThrow(/force-push/);
  });

  it('allows a plain push to a non-protected branch', () => {
    expect(() => assertPushIsSafe('trackwright/tw-0001', false)).not.toThrow();
  });

  it('derives a deterministic, collision-free branch name from the ticket id', () => {
    expect(workBranchName('TW-0001')).toBe('trackwright/tw-0001');
  });
});

describe('assertCurrentBranchIsSafeToRunOn', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'trackwright-branch-guard-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function initRepoOnBranch(branch: string) {
    const git = (args: string[]) => execFileAsync('git', args, { cwd: dir });
    await git(['init', '-q', '-b', branch]);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await git(['commit', '--allow-empty', '-m', 'initial', '-q']);
  }

  it('refuses to run at all on a protected branch, independent of branch creation', async () => {
    await initRepoOnBranch('main');
    const repo = new GitRepo(dir);
    await expect(assertCurrentBranchIsSafeToRunOn(repo)).rejects.toThrow(ProtectedBranchError);
  });

  it('allows running on a non-protected branch', async () => {
    await initRepoOnBranch('dev');
    const repo = new GitRepo(dir);
    await expect(assertCurrentBranchIsSafeToRunOn(repo)).resolves.not.toThrow();
  });
});

describe('ensureWorkBranch uncommitted-changes guard', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'trackwright-uncommitted-guard-'));
    const git = (args: string[]) => execFileAsync('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'dev']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await git(['commit', '--allow-empty', '-m', 'initial', '-q']);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses when there are uncommitted changes outside the ignored prefixes', async () => {
    await writeFile(path.join(dir, 'unrelated-work.txt'), 'oops', 'utf8');
    const repo = new GitRepo(dir);
    await expect(ensureWorkBranch(repo, 'TW-0001', ['.trackwright'])).rejects.toThrow(
      UncommittedChangesError,
    );
  });

  it('ignores uncommitted changes inside an ignored prefix (e.g. a just-created ticket file)', async () => {
    await mkdir(path.join(dir, '.trackwright', 'tickets'), { recursive: true });
    await writeFile(path.join(dir, '.trackwright', 'tickets', 'TW-0001-x.md'), 'draft', 'utf8');
    const repo = new GitRepo(dir);
    await expect(ensureWorkBranch(repo, 'TW-0001', ['.trackwright'])).resolves.toBe('trackwright/tw-0001');
  });

  /**
   * Regression coverage for a real gap found during the DF-0007 dogfood run: `run` calls
   * ensureWorkBranch at the start of every step, not just the first. Once a ticket is mid-run on
   * its own dedicated branch, the working tree can legitimately carry real uncommitted project
   * changes (in-progress work, or an implementer that forgot to commit) — switching to the branch
   * you're already on is a no-op, so the clean-tree guard must not fire in that case, or a ticket
   * could never be resumed past the point an implementer left something uncommitted.
   */
  it('allows resuming on the ticket\'s own branch even with real uncommitted project changes', async () => {
    const repo = new GitRepo(dir);
    await ensureWorkBranch(repo, 'TW-0001', ['.trackwright']); // first call: creates + checks out the branch
    await writeFile(path.join(dir, 'unrelated-work.txt'), 'in-progress edit, not yet committed', 'utf8');

    await expect(ensureWorkBranch(repo, 'TW-0001', ['.trackwright'])).resolves.toBe('trackwright/tw-0001');
    expect(await repo.currentBranch()).toBe('trackwright/tw-0001');
  });
});
