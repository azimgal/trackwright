import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initConfig } from '../src/config/loader.js';
import { TicketStore } from '../src/tickets/store.js';
import { newTicket } from '../src/tickets/template.js';
import { runTicketRun } from '../src/cli/commands/run.js';
import { ProtectedBranchError } from '../src/git/safety.js';

const execFileAsync = promisify(execFile);
let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'trackwright-run-cmd-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

async function initRepoOnBranch(branch: string) {
  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
  await git(['init', '-q', '-b', branch]);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['commit', '--allow-empty', '-m', 'initial', '-q']);
}

/**
 * Regression test for a real gap found during verification: `--skip-branch` must skip only
 * *creating* a dedicated branch, never the "refuse to run on a protected branch at all" check —
 * otherwise `trackwright run <ticket> --skip-branch` while checked out on main/master would let
 * an implementer agent's own tool calls operate directly on a protected branch. See
 * src/git/safety.ts, assertCurrentBranchIsSafeToRunOn.
 */
describe('runTicketRun branch safety', () => {
  it('refuses to run on a protected branch even with --skip-branch', async () => {
    await initRepoOnBranch('main');
    const config = await initConfig(projectRoot, 'TW');
    const store = new TicketStore(path.join(projectRoot, config.ticketsDir));
    await store.save(newTicket({ id: 'TW-0001', title: 'x', discipline: 'development', context: 'c' }));

    await expect(
      runTicketRun(projectRoot, 'TW-0001', { dryRun: true, skipBranch: true }),
    ).rejects.toThrow(ProtectedBranchError);
  });

  it('runs normally with --skip-branch on a non-protected branch', async () => {
    await initRepoOnBranch('dev');
    const config = await initConfig(projectRoot, 'TW');
    const store = new TicketStore(path.join(projectRoot, config.ticketsDir));
    await store.save(newTicket({ id: 'TW-0001', title: 'x', discipline: 'development', context: 'c' }));

    const result = await runTicketRun(projectRoot, 'TW-0001', { dryRun: true, skipBranch: true, maxSteps: 3 });
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('a fresh repo on main works out of the box: run creates the ticket branch, main is never written to', async () => {
    await initRepoOnBranch('main');
    const config = await initConfig(projectRoot, 'TW');
    const store = new TicketStore(path.join(projectRoot, config.ticketsDir));
    await store.save(newTicket({ id: 'TW-0001', title: 'x', discipline: 'development', specialization: 'backend', context: 'c' }));
    const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
    const mainBefore = (await git(['rev-parse', 'main'])).stdout;

    const result = await runTicketRun(projectRoot, 'TW-0001', { dryRun: true, maxSteps: 3 });

    expect(result.steps.length).toBeGreaterThan(0);
    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('trackwright/tw-0001');
    expect((await git(['rev-parse', 'main'])).stdout).toBe(mainBefore);
  });

  it('an unknown ticket id fails before any git side effect (no stray branch)', async () => {
    await initRepoOnBranch('main');
    await initConfig(projectRoot, 'TW');
    await expect(runTicketRun(projectRoot, 'TW-0404', { dryRun: true })).rejects.toThrow(/no ticket found/);
    const { stdout } = await execFileAsync('git', ['branch', '--list'], { cwd: projectRoot });
    expect(stdout).not.toContain('tw-0404');
    expect(stdout).toContain('* main');
  });
});
