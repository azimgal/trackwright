import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configPath, initConfig, loadConfig } from '../src/config/loader.js';
import { TicketStore } from '../src/tickets/store.js';
import { newTicket } from '../src/tickets/template.js';
import { runBatch, partitionForSafeConcurrency } from '../src/workflow/batch.js';
import { DependencyCycleError } from '../src/dependencies/dag.js';
import type { Ticket } from '../src/tickets/schema.js';

const execFileAsync = promisify(execFile);
let projectRoot: string;
let ticketStore: TicketStore;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'trackwright-batch-'));
  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
  await git(['init', '-q', '-b', 'dev']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['commit', '--allow-empty', '-m', 'initial', '-q']);

  const config = await initConfig(projectRoot, 'TW');
  ticketStore = new TicketStore(path.join(projectRoot, config.ticketsDir));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

async function createReadyTicket(id: string, overrides: Partial<Parameters<typeof newTicket>[0]> = {}) {
  const t = newTicket({ id, title: id, discipline: 'development', specialization: 'backend', context: 'c', ...overrides });
  // Pre-fill planning/ready-required content so a --dry-run batch can sail through without
  // needing to depend on the planner's mock output matching isPlanningComplete's exact rules.
  await ticketStore.save({
    ...t,
    sections: {
      Context: 'c',
      Requirements: 'req',
      'Acceptance Criteria': 'ac',
      'Definition of Done': 'dod',
    },
  });
}

describe('partitionForSafeConcurrency', () => {
  function withScope(id: string, scope: string[]): Ticket {
    const t = newTicket({ id, title: id, discipline: 'development', context: 'c', scope });
    return t;
  }

  it('maxParallel <= 1 always returns singleton groups, regardless of scope', () => {
    const tickets = [withScope('A', ['src/a/']), withScope('B', ['src/b/'])];
    expect(partitionForSafeConcurrency(tickets, 1)).toEqual([[tickets[0]], [tickets[1]]]);
  });

  it('groups non-overlapping declared scopes together up to maxParallel', () => {
    const tickets = [withScope('A', ['src/a/']), withScope('B', ['src/b/'])];
    const groups = partitionForSafeConcurrency(tickets, 2);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('never groups tickets with empty (unknown) scope — always serializes them', () => {
    const tickets = [withScope('A', []), withScope('B', [])];
    const groups = partitionForSafeConcurrency(tickets, 4);
    expect(groups).toEqual([[tickets[0]], [tickets[1]]]);
  });

  it('never groups overlapping declared scopes', () => {
    const tickets = [withScope('A', ['src/shared/']), withScope('B', ['src/shared/sub/'])];
    const groups = partitionForSafeConcurrency(tickets, 4);
    expect(groups).toEqual([[tickets[0]], [tickets[1]]]);
  });

  it('respects the maxParallel ceiling even when everything could otherwise group together', () => {
    const tickets = [withScope('A', ['a/']), withScope('B', ['b/']), withScope('C', ['c/'])];
    const groups = partitionForSafeConcurrency(tickets, 2);
    expect(groups.map((g) => g.length).sort()).toEqual([1, 2]);
  });
});

/**
 * Dedicated coverage for workflow/batch.ts's serial path and cycle handling — the dependency
 * dogfood scenario (A, B independent; C depends on A+B) is exercised for real with real Claude
 * separately; this covers the deterministic scheduling logic itself with MockClaudeRunner/
 * --dry-run, which is what batch.ts actually spawns when dryRun is set.
 */
describe('runBatch', () => {
  it('runs independent tickets each in their own wave-0 group, serially by default', async () => {
    await createReadyTicket('TW-0001');
    await createReadyTicket('TW-0002');

    const result = await runBatch(projectRoot, ['TW-0001', 'TW-0002'], { dryRun: true, maxSteps: 15 });

    expect(result.waves).toEqual([['TW-0001', 'TW-0002']]);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.outcome === 'completed')).toBe(true);
    expect(result.results.every((r) => !r.ranConcurrently)).toBe(true); // config.maxParallel defaults to 1
  });

  it('a dependent ticket is placed in a later wave than its dependencies', async () => {
    await createReadyTicket('TW-0001');
    await createReadyTicket('TW-0002');
    await createReadyTicket('TW-0003', { dependencies: ['TW-0001', 'TW-0002'] });
    // This fixture has no package.json, so the default npm-based checks would (correctly) fail;
    // give it checks that pass so the run can genuinely reach Done.
    const pass = 'node -e "process.exit(0)"';
    const config = await loadConfig(projectRoot);
    await writeFile(configPath(projectRoot), yaml.dump({ ...config, checks: { fast: [pass], test: [pass], premerge: [pass] } }), 'utf8');

    const result = await runBatch(projectRoot, ['TW-0001', 'TW-0002', 'TW-0003'], { dryRun: true, maxSteps: 15 });

    expect(result.waves).toEqual([['TW-0001', 'TW-0002'], ['TW-0003']]);
    // End to end, not just ordering: once its dependencies reach Done, the dependent ticket must
    // actually clear the Ready gate and finish too. Regression: the engine used to leave a
    // finished ticket's status at "draft", so a dependent stayed BLOCKED at Ready forever.
    for (const r of result.results) expect(r.result?.stopReason).toBe('done');
    for (const id of ['TW-0001', 'TW-0002', 'TW-0003']) {
      const t = await ticketStore.getOrThrow(id);
      expect(t.frontmatter.stage).toBe('done');
      expect(t.frontmatter.status).toBe('done');
    }
  });

  it('throws DependencyCycleError up front and runs nothing when the requested set has a cycle', async () => {
    await createReadyTicket('TW-0001', { dependencies: ['TW-0002'] });
    await createReadyTicket('TW-0002', { dependencies: ['TW-0001'] });

    await expect(runBatch(projectRoot, ['TW-0001', 'TW-0002'], { dryRun: true })).rejects.toThrow(DependencyCycleError);

    // Nothing should have run at all — no evidence, no stage advancement.
    const t1 = await ticketStore.getOrThrow('TW-0001');
    expect(t1.frontmatter.stage).toBe('planning');
  });

  it('config.maxParallel > 1 with non-overlapping scope runs tickets concurrently in worktrees', async () => {
    const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
    await git(['checkout', '-b', 'trunk', '-q']); // non-protected base branch for worktrees to branch from

    await createReadyTicket('TW-0001', { scope: ['area-a/'] });
    await createReadyTicket('TW-0002', { scope: ['area-b/'] });

    const result = await runBatch(projectRoot, ['TW-0001', 'TW-0002'], { dryRun: true, maxSteps: 15, maxParallel: 2 });

    expect(result.results.every((r) => r.outcome === 'completed')).toBe(true);
    expect(result.results.filter((r) => r.ranConcurrently)).toHaveLength(2);

    // Worktrees must be cleaned up afterward — no trace left behind.
    const config = await loadConfig(projectRoot);
    void config;
    const worktreeList = await git(['worktree', 'list']);
    expect(worktreeList.stdout).not.toContain('TW-0001'.toLowerCase());
  });
});
