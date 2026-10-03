import path from 'node:path';
import { CONFIG_DIR, loadConfig } from '../../config/loader.js';
import { TicketStore } from '../../tickets/store.js';
import { EvidenceStore } from '../../evidence/store.js';
import { GitRepo } from '../../git/repo.js';
import { assertCurrentBranchIsSafeToRunOn, ensureWorkBranch } from '../../git/safety.js';
import { ClaudeCliRunner } from '../../claude/runner.js';
import { MockClaudeRunner } from '../../claude/mock-runner.js';
import type { ClaudeRunner } from '../../claude/types.js';
import { WorkflowEngine, type RunResult, type StepResult } from '../../workflow/engine.js';

export interface RunOptions {
  dryRun?: boolean;
  maxSteps?: number;
  skipBranch?: boolean;
  onStep?: (step: StepResult) => void;
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

  // Unknown ticket id: fail before touching git at all (it used to create trackwright/<typo>).
  await ticketStore.getOrThrow(ticketId);

  if (await gitRepo.isGitRepository()) {
    // The branch agents execute on is always checked, with or without --skip-branch: see the
    // doc comment on assertCurrentBranchIsSafeToRunOn for why this must never be skippable.
    // ensureWorkBranch performs it on the ticket branch it switches to.
    const extraProtected = config.targetBranch ? [config.targetBranch] : [];
    if (options.skipBranch) {
      await assertCurrentBranchIsSafeToRunOn(gitRepo, extraProtected);
    } else {
      // Everything under .trackwright/ (config, tickets, evidence) is Trackwright's own
      // bookkeeping — a ticket just created by `ticket create` is normal, expected uncommitted
      // content at this point. Only *unrelated* uncommitted work should trip
      // UncommittedChangesError.
      await ensureWorkBranch(gitRepo, ticketId, [CONFIG_DIR], extraProtected);
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

  return engine.run(ticketId, { maxSteps: options.maxSteps, onStep: options.onStep });
}
