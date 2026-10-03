import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TicketStore } from '../src/tickets/store.js';
import { EvidenceStore } from '../src/evidence/store.js';
import { GitRepo } from '../src/git/repo.js';
import { MockClaudeRunner } from '../src/claude/mock-runner.js';
import { WorkflowEngine } from '../src/workflow/engine.js';
import { newTicket } from '../src/tickets/template.js';
import { initConfig } from '../src/config/loader.js';
import type { Ticket } from '../src/tickets/schema.js';

/**
 * Awaiting Merge as a real machine stage: beyond premerge checks and verification staleness, it
 * re-checks dependencies, design sync, and target-branch compatibility, and records
 * merge_eligible + reasons in evidence. It never merges, rebases, or fetches anything itself.
 */
const execFileAsync = promisify(execFile);
const PASS = 'node -e "process.exit(0)"';
let root: string;
let ticketStore: TicketStore;
let evidenceStore: EvidenceStore;

const git = (args: string[]) => execFileAsync('git', args, { cwd: root });

async function commitFile(rel: string, content: string, message: string) {
  await writeFile(path.join(root, rel), content, 'utf8');
  await git(['add', '--', rel]);
  await git(['commit', '-q', '-m', message]);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'trackwright-am-'));
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await commitFile('app.txt', 'line 1\n', 'initial');
  const config = await initConfig(root, 'TW');
  ticketStore = new TicketStore(path.join(root, config.ticketsDir));
  evidenceStore = new EvidenceStore(path.join(root, config.evidenceDir));
  await git(['checkout', '-q', '-b', 'trackwright/tw-0001']);
  await commitFile('feature.txt', 'feature\n', 'feature work');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function engine(overrides: Record<string, unknown> = {}) {
  const base = await initConfig(root, 'TW');
  const config = { ...base, checks: { fast: [], test: [PASS], premerge: [PASS] }, ...overrides };
  return new WorkflowEngine({ ticketStore, evidenceStore, claudeRunner: new MockClaudeRunner(), config, gitRepo: new GitRepo(root), cwd: root });
}

async function ticketAtAwaitingMerge(id: string, patch: Partial<Ticket['frontmatter']> = {}) {
  const t = newTicket({ id, title: id, discipline: 'development', specialization: 'backend', context: 'c' });
  await ticketStore.save({ ...t, frontmatter: { ...t.frontmatter, stage: 'awaiting-merge', status: 'in-progress', ...patch } });
}

describe('Awaiting Merge machine checks', () => {
  it('up to date with main and premerge green: done, merge_eligible=true recorded in evidence', async () => {
    await ticketAtAwaitingMerge('TW-0001');
    const step = await (await engine()).step('TW-0001');
    expect(step.outcome).toBe('SUCCESS');
    expect(step.toStage).toBe('done');
    const ev = await evidenceStore.latestForStage('TW-0001', 'awaiting-merge');
    expect(ev?.mergeEligible).toBe(true);
    expect(ev?.mergeReasons).toEqual([]);
  });

  it('target branch advanced (clean merge): BLOCKED, merge_eligible=false, never merges or rebases itself', async () => {
    await ticketAtAwaitingMerge('TW-0001');
    await git(['checkout', '-q', 'main']);
    await commitFile('other.txt', 'other\n', 'someone else landed on main');
    await git(['checkout', '-q', 'trackwright/tw-0001']);
    const { stdout: before } = await git(['rev-parse', 'HEAD']);

    const step = await (await engine()).step('TW-0001');

    expect(step.outcome).toBe('BLOCKED');
    expect(step.toStage).toBe('awaiting-merge');
    expect(step.summary).toContain('merge_eligible=false');
    expect(step.summary).toContain('merges cleanly');
    const ev = await evidenceStore.latestForStage('TW-0001', 'awaiting-merge');
    expect(ev?.mergeEligible).toBe(false);
    expect(ev?.mergeReasons?.[0]).toContain('"main" has advanced');
    // read-only: the branch tip only moved by Trackwright's own ticket-state bookkeeping commit
    const { stdout: changed } = await git(['diff', '--name-only', before.trim(), 'HEAD']);
    expect(changed.split('\n').filter(Boolean).every((f) => f.startsWith('.trackwright/'))).toBe(true);
  });

  it('target branch would conflict: BLOCKED and names the conflicting file', async () => {
    await ticketAtAwaitingMerge('TW-0001');
    await commitFile('app.txt', 'line 1 — ticket version\n', 'ticket edits app.txt');
    await git(['checkout', '-q', 'main']);
    await commitFile('app.txt', 'line 1 — main version\n', 'main edits app.txt');
    await git(['checkout', '-q', 'trackwright/tw-0001']);

    const step = await (await engine()).step('TW-0001');
    expect(step.outcome).toBe('BLOCKED');
    expect(step.summary).toContain('conflict in: app.txt');
  });

  it('a configured targetBranch that does not exist blocks instead of silently passing', async () => {
    await ticketAtAwaitingMerge('TW-0001');
    const step = await (await engine({ targetBranch: 'release' })).step('TW-0001');
    expect(step.outcome).toBe('BLOCKED');
    expect(step.summary).toContain('"release" does not exist');
  });

  it('a dependency cancelled after Ready is caught at Awaiting Merge', async () => {
    const dep = newTicket({ id: 'TW-0002', title: 'dep', discipline: 'development', context: 'c' });
    await ticketStore.save({ ...dep, frontmatter: { ...dep.frontmatter, status: 'cancelled' } });
    await ticketAtAwaitingMerge('TW-0001', { dependencies: ['TW-0002'] });

    const step = await (await engine()).step('TW-0001');
    expect(step.outcome).toBe('BLOCKED');
    expect(step.summary).toContain('dependency cancelled since Ready: TW-0002');
  });

  it('a design-gated ticket whose design is not synced is not merge eligible', async () => {
    await ticketAtAwaitingMerge('TW-0001', { design_status: 'stale' });
    const step = await (await engine()).step('TW-0001');
    expect(step.outcome).toBe('BLOCKED');
    expect(step.summary).toContain('design_status is "stale"');
  });

  it('a "synced" design_status with no approved design artifact on record is not trusted', async () => {
    const t = newTicket({ id: 'TW-0003', title: 'design', discipline: 'design', context: 'c' });
    await ticketStore.save({ ...t, frontmatter: { ...t.frontmatter, stage: 'awaiting-merge', design_status: 'synced' } });
    // design_status synced but no approved artifact on record: must not be trusted blindly
    const step = await (await engine()).step('TW-0003');
    expect(step.outcome).toBe('BLOCKED');
    expect(step.summary).toContain('no longer approved');
  });
});
