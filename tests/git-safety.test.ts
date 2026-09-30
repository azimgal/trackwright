import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  assertCurrentBranchIsSafeToRunOn,
  assertPushIsSafe,
  isProtectedBranch,
  ProtectedBranchError,
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
