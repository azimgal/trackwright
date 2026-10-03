import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadConfig } from '../config/loader.js';
import { TicketStore } from '../tickets/store.js';
import { EvidenceStore } from '../evidence/store.js';
import { GitRepo } from '../git/repo.js';
import { assertCurrentBranchIsSafeToRunOn, ensureWorkBranch, workBranchName } from '../git/safety.js';
import { ClaudeCliRunner } from '../claude/runner.js';
import { MockClaudeRunner } from '../claude/mock-runner.js';
import type { ClaudeRunner } from '../claude/types.js';
import { WorkflowEngine, type RunResult } from './engine.js';
import { buildDependencyGraph, topologicalWaves, DependencyCycleError } from '../dependencies/dag.js';
import type { Ticket } from '../tickets/schema.js';
import { CONFIG_DIR } from '../config/loader.js';

export interface BatchOptions {
  dryRun?: boolean;
  maxSteps?: number;
  /** Overrides config.maxParallel for this run. */
  maxParallel?: number;
  onWaveStart?: (waveIndex: number, ticketIds: readonly string[]) => void;
  onTicketDone?: (result: BatchTicketResult) => void;
}

export interface BatchTicketResult {
  ticketId: string;
  wave: number;
  ranConcurrently: boolean;
  outcome: 'completed' | 'error';
  result?: RunResult;
  error?: string;
}

export interface BatchConflict {
  ticketIds: readonly string[];
  files: readonly string[];
}

export interface BatchResult {
  waves: readonly (readonly string[])[];
  results: BatchTicketResult[];
  conflicts: BatchConflict[];
}

/**
 * `trackwright batch` — runs several tickets, in dependency order, within a single invocation.
 * Found missing entirely before this: `trackwright run` only ever drives one ticket, so there was
 * no way to express "these are independent, those depend on them" and have Trackwright itself
 * respect that ordering across more than one ticket, nor any way to safely run more than one
 * ticket's agents at the same time (two tickets can never share one working tree — git refuses to
 * check out the same branch twice, and even if it didn't, two implementers writing to the same
 * files would be exactly the blind-parallel race this function exists to avoid).
 *
 * Per-wave scheduling (see partitionForSafeConcurrency): within a wave, tickets with declared,
 * non-overlapping `scope` run concurrently, each in its own git worktree (genuine OS-level
 * isolation — never a single shared working tree); anything with unknown (empty) or overlapping
 * scope runs serially, in the main working tree, exactly like `trackwright run`. After any
 * concurrent group finishes, the *actual* diffs are compared (never trusting the declared scope
 * as proof) — any real file overlap is reported as a BatchConflict, loudly, never silently merged
 * or ignored.
 */
export async function runBatch(projectRoot: string, ticketIds: readonly string[], options: BatchOptions = {}): Promise<BatchResult> {
  const config = await loadConfig(projectRoot);
  const ticketStore = new TicketStore(path.join(projectRoot, config.ticketsDir));
  const tickets = await Promise.all(ticketIds.map((id) => ticketStore.getOrThrow(id)));
  const byId = new Map(tickets.map((t) => [t.frontmatter.id, t]));

  const graph = buildDependencyGraph(tickets.map((t) => ({ id: t.frontmatter.id, dependencies: t.frontmatter.dependencies })));
  let waves: string[][];
  try {
    waves = topologicalWaves(graph);
  } catch (err) {
    if (err instanceof DependencyCycleError) {
      throw new DependencyCycleError(err.cycle); // re-thrown as-is; caller (CLI) renders it
    }
    throw err;
  }

  const maxParallel = options.maxParallel ?? config.maxParallel;
  const results: BatchTicketResult[] = [];
  const conflicts: BatchConflict[] = [];

  for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
    const waveTickets = waves[waveIndex]!.map((id) => byId.get(id)!);
    options.onWaveStart?.(waveIndex, waves[waveIndex]!);
    const groups = partitionForSafeConcurrency(waveTickets, maxParallel);

    for (const group of groups) {
      if (group.length === 1) {
        const r = await runOneSerial(projectRoot, group[0]!.frontmatter.id, waveIndex, options);
        results.push(r);
        options.onTicketDone?.(r);
      } else {
        const settled = await Promise.all(group.map((t) => runOneConcurrent(projectRoot, t.frontmatter.id, waveIndex, options)));
        for (const r of settled) {
          results.push(r);
          options.onTicketDone?.(r);
        }
        const conflict = await checkActualOverlap(projectRoot, group.map((t) => t.frontmatter.id));
        if (conflict) conflicts.push(conflict);
      }
    }
  }

  return { waves, results, conflicts };
}

/** Two tickets may run concurrently only if BOTH declared a non-empty `scope` and no prefix of
 * one is a prefix of the other (or equal) — empty scope means "unknown," treated as overlapping
 * everything, never assumed safe. */
function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((pa) => b.some((pb) => pa === pb || pa.startsWith(pb) || pb.startsWith(pa)));
}

/** Greedily packs tickets into concurrency groups of at most `maxParallel`, each member
 * pairwise non-overlapping with every other member already in its group. `maxParallel <= 1`
 * always returns singleton groups — the safest possible default, matching config.maxParallel's
 * own default of 1. */
export function partitionForSafeConcurrency(tickets: readonly Ticket[], maxParallel: number): Ticket[][] {
  if (maxParallel <= 1) return tickets.map((t) => [t]);
  const groups: Ticket[][] = [];
  for (const ticket of tickets) {
    const group = groups.find(
      (g) => g.length < maxParallel && g.every((other) => !scopesOverlap(ticket.frontmatter.scope, other.frontmatter.scope)),
    );
    if (group) group.push(ticket);
    else groups.push([ticket]);
  }
  return groups;
}

async function runOneSerial(
  projectRoot: string,
  ticketId: string,
  wave: number,
  options: BatchOptions,
): Promise<BatchTicketResult> {
  try {
    const result = await runEngineAt(projectRoot, projectRoot, ticketId, options, { createBranch: true });
    return { ticketId, wave, ranConcurrently: false, outcome: 'completed', result };
  } catch (err) {
    return { ticketId, wave, ranConcurrently: false, outcome: 'error', error: (err as Error).message };
  }
}

async function runOneConcurrent(
  projectRoot: string,
  ticketId: string,
  wave: number,
  options: BatchOptions,
): Promise<BatchTicketResult> {
  const worktreePath = path.join(projectRoot, CONFIG_DIR, '.worktrees', ticketId.toLowerCase());
  const mainRepo = new GitRepo(projectRoot);
  const branch = workBranchName(ticketId);

  try {
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const base = await mainRepo.currentBranch();
    await mainRepo.addWorktree(worktreePath, branch, base);
  } catch (err) {
    // Could not get an isolated worktree (branch already checked out elsewhere, git too old,
    // etc.) — fall back to the safe default (serial, in the main tree) rather than fail the
    // whole batch over a parallelism optimization that didn't pan out.
    const fallback = await runOneSerial(projectRoot, ticketId, wave, options);
    return { ...fallback, error: fallback.error ?? `(ran serially — could not create an isolated worktree: ${(err as Error).message})` };
  }

  try {
    const result = await runEngineAt(projectRoot, worktreePath, ticketId, options, { createBranch: false });
    return { ticketId, wave, ranConcurrently: true, outcome: 'completed', result };
  } catch (err) {
    return { ticketId, wave, ranConcurrently: true, outcome: 'error', error: (err as Error).message };
  } finally {
    try {
      await mainRepo.removeWorktree(worktreePath);
    } catch {
      // Best-effort cleanup only — a worktree that can't be removed (real uncommitted changes
      // git itself refuses to discard) is left in place rather than force-removed; it will show
      // up in `git worktree list` for a human to look at, which is safer than silently losing
      // whatever it was protecting.
    }
  }
}

/**
 * Shared engine construction for both serial (main repo) and concurrent (worktree) execution.
 * `ticketStore`/`evidenceStore` always point at the *main* project root's `.trackwright/` —
 * tickets and evidence are the single source of truth regardless of which working tree executed
 * the work; only `gitRepo`'s `cwd` differs, so git operations land in the right tree.
 */
async function runEngineAt(
  projectRoot: string,
  gitCwd: string,
  ticketId: string,
  options: BatchOptions,
  branchOpts: { createBranch: boolean },
): Promise<RunResult> {
  const config = await loadConfig(projectRoot);
  const ticketStore = new TicketStore(path.join(projectRoot, config.ticketsDir));
  const evidenceStore = new EvidenceStore(path.join(projectRoot, config.evidenceDir));
  const gitRepo = new GitRepo(gitCwd);

  if (await gitRepo.isGitRepository()) {
    const extraProtected = config.targetBranch ? [config.targetBranch] : [];
    if (branchOpts.createBranch) {
      await ensureWorkBranch(gitRepo, ticketId, [CONFIG_DIR], extraProtected); // asserts the branch it lands on
    } else {
      await assertCurrentBranchIsSafeToRunOn(gitRepo, extraProtected);
    }
    // Worktree case: addWorktree already checked out the ticket's own branch directly into this
    // tree — nothing further to do, and ensureWorkBranch's own clean-tree guard would be
    // pointless here (this worktree has never had anything else in it).
  }

  const claudeRunner: ClaudeRunner = options.dryRun ? new MockClaudeRunner() : new ClaudeCliRunner(config.claude.binary);
  const engine = new WorkflowEngine({ ticketStore, evidenceStore, claudeRunner, config, gitRepo, cwd: gitCwd });
  return engine.run(ticketId, { maxSteps: options.maxSteps });
}

/**
 * Post-hoc safety net: after a concurrent group finishes, compare each ticket's *actual* diff
 * (never the declared `scope`, which is advisory only) against every other ticket in the same
 * group. Any real overlap is reported, loudly — this function never serializes retroactively
 * (the work already happened) and never merges anything; it only makes the conflict visible so a
 * human reviews before either branch gets merged.
 */
async function checkActualOverlap(projectRoot: string, ticketIds: readonly string[]): Promise<BatchConflict | null> {
  const repo = new GitRepo(projectRoot);
  const filesByTicket = new Map<string, Set<string>>();
  for (const id of ticketIds) {
    const files = await repo.changedFilesOn(workBranchName(id), undefined, [CONFIG_DIR]);
    filesByTicket.set(id, new Set(files));
  }

  const overlapping = new Set<string>();
  const ids = [...filesByTicket.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = filesByTicket.get(ids[i]!)!;
      const b = filesByTicket.get(ids[j]!)!;
      for (const f of a) if (b.has(f)) overlapping.add(f);
    }
  }
  if (overlapping.size === 0) return null;
  return { ticketIds, files: [...overlapping].sort() };
}
