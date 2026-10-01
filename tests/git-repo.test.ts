import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitRepo } from '../src/git/repo.js';

const execFileAsync = promisify(execFile);
let projectRoot: string;
let repo: GitRepo;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'trackwright-git-repo-'));
  repo = new GitRepo(projectRoot);
  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(path.join(projectRoot, 'README.md'), 'initial\n', 'utf8');
  await git(['add', '-A']);
  await git(['commit', '-m', 'initial', '-q']);
  // Diverge onto a dedicated branch, same as a real ticket run would (ensureWorkBranch) — staying
  // on 'main' itself would make `main...HEAD` trivially empty (merge-base(main, main) === main).
  await git(['checkout', '-q', '-b', 'trackwright/tw-0001']);
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

async function commitChange(relPath: string, content: string, message: string) {
  const full = path.join(projectRoot, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
  await git(['add', '-A']);
  await git(['commit', '-m', message, '-q']);
}

/**
 * Regression coverage for a real gap found during the DF-0007 dogfood run: the verification
 * agent's diff (workflow/engine.ts, executeVerification) is bounded to 20k chars, and
 * Trackwright's own `.trackwright/` bookkeeping (ticket markdown, evidence) was included in that
 * budget alongside the project's actual code change. When the combined diff crossed the cap, the
 * real code change — alphabetically after `.trackwright/...` — was silently cut out of the prompt
 * entirely, and the agent correctly (from its own perspective) reported the change as missing.
 */
describe('GitRepo.diffAgainstBase exclude paths', () => {
  it('includes everything when no exclude prefixes are given', async () => {
    await commitChange('.trackwright/tickets/TW-0001.md', 'bookkeeping\n', 'ticket bookkeeping');
    await commitChange('routes.mjs', 'export const real = true;\n', 'real change');

    const diff = await repo.diffAgainstBase();
    expect(diff).toContain('.trackwright/tickets/TW-0001.md');
    expect(diff).toContain('routes.mjs');
  });

  it('drops excluded path prefixes from the diff entirely', async () => {
    await commitChange('.trackwright/tickets/TW-0001.md', 'bookkeeping\n', 'ticket bookkeeping');
    await commitChange('routes.mjs', 'export const real = true;\n', 'real change');

    const diff = await repo.diffAgainstBase(undefined, ['.trackwright']);
    expect(diff).not.toContain('.trackwright');
    expect(diff).toContain('routes.mjs');
    expect(diff).toContain('real = true');
  });

  it('excludes bookkeeping on the HEAD~1..HEAD fallback too (no main/master branch)', async () => {
    // Re-init without a 'main'/'master' candidate branch so diffAgainstBase takes the HEAD~1
    // fallback path, which must apply the same exclusion. Both changes land in the same commit so
    // the single HEAD~1..HEAD diff actually contains both — a real test of the exclusion, not just
    // of which commits happen to be in range.
    const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
    await git(['branch', '-m', 'main', 'archived-main']);

    await mkdir(path.join(projectRoot, '.trackwright/tickets'), { recursive: true });
    await writeFile(path.join(projectRoot, '.trackwright/tickets/TW-0001.md'), 'more bookkeeping\n', 'utf8');
    await writeFile(path.join(projectRoot, 'routes.mjs'), 'export const real = true;\n', 'utf8');
    await git(['add', '-A']);
    await git(['commit', '-m', 'bookkeeping + real change together', '-q']);

    const diff = await repo.diffAgainstBase(undefined, ['.trackwright']);
    expect(diff).not.toContain('.trackwright');
    expect(diff).toContain('routes.mjs');
  });
});
