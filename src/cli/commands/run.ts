import path from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { TicketStore } from '../../tickets/store.js';
import { EvidenceStore } from '../../evidence/store.js';
import { GitRepo } from '../../git/repo.js';
import { assertCurrentBranchIsSafeToRunOn, ensureWorkBranch } from '../../git/safety.js';
import { ClaudeCliRunner } from '../../claude/runner.js';
import { MockClaudeRunner } from '../../claude/mock-runner.js';
import type { ClaudeRunner } from '../../claude/types.js';
import { WorkflowEngine, type RunResult } from '../../workflow/engine.js';

export interface RunOptions {
  dryRun?: boolean;
  maxSteps?: number;
  skipBranch?: boolean;
}

export async function runTicketRun(
  projectRoot: string,
  ticketId: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const config = await loadConfig(projectRoot);
  const ticketStore = new TicketStore(path.join(projectRoot, config.ticketsDir));
  const evidenceStore = new EvidenceStore(path.join(projectRoot, config.evidenceDir));
  const gitRepo = new GitRepo(projectRoot);

  if (await gitRepo.isCleanRepo()) {
    // Always enforced, even with --skip-branch: see the doc comment on
    // assertCurrentBranchIsSafeToRunOn for why this specific check must never be skippable.
    await assertCurrentBranchIsSafeToRunOn(gitRepo);
    if (!options.skipBranch) {
      await ensureWorkBranch(gitRepo, ticketId);
    }
  }

  const claudeRunner: ClaudeRunner = options.dryRun
    ? new MockClaudeRunner()
    : new ClaudeCliRunner(config.claude.binary);

  const engine = new WorkflowEngine({
    ticketStore,
    evidenceStore,
    claudeRunner,
    config,
    gitRepo,
    cwd: projectRoot,
  });

  return engine.run(ticketId, { maxSteps: options.maxSteps });
}
