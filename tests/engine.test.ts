import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TicketStore } from '../src/tickets/store.js';
import { EvidenceStore } from '../src/evidence/store.js';
import { GitRepo } from '../src/git/repo.js';
import { LocalDesignArtifactProvider } from '../src/design/local-provider.js';
import { MockClaudeRunner } from '../src/claude/mock-runner.js';
import { WorkflowEngine } from '../src/workflow/engine.js';
import { newTicket } from '../src/tickets/template.js';
import { defaultConfig } from '../src/config/defaults.js';
import { runTicketWaive } from '../src/cli/commands/waive.js';
import { runDesignApprove } from '../src/cli/commands/design.js';
import { initConfig } from '../src/config/loader.js';

const execFileAsync = promisify(execFile);

let projectRoot: string;
let ticketStore: TicketStore;
let evidenceStore: EvidenceStore;

const PASS_CHECK = 'node -e "process.exit(0)"';
const FAIL_CHECK = 'node -e "process.exit(1)"';

// A planner response that actually satisfies isPlanningComplete (Context/Requirements/Acceptance
// Criteria/Definition of Done) — see engine.ts's executePlanning, which downgrades an
// under-specified SUCCESS to NEEDS_CLARIFICATION rather than trusting the agent blindly.
const COMPLETE_PLAN_DATA = {
  requirements: 'req',
  acceptanceCriteria: 'ac',
  definitionOfDone: 'dod',
  plan: 'plan',
  tasks: 'tasks',
};

async function makeEngine(runner: MockClaudeRunner, checksOverride?: Partial<ReturnType<typeof defaultConfig>['checks']>) {
  const config = { ...(await initConfig(projectRoot, 'TW')), checks: { fast: [], test: [PASS_CHECK], premerge: [PASS_CHECK], ...checksOverride } };
  return new WorkflowEngine({
    ticketStore,
    evidenceStore,
    claudeRunner: runner,
    config,
    gitRepo: new GitRepo(projectRoot),
    cwd: projectRoot,
  });
}

async function initGitRepo() {
  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  // A real tracked file, not --allow-empty: GitRepo.lastRelevantSha (what every staleness check
  // and evidence.gitSha now uses, excluding CONFIG_DIR — see engine.ts's safeSha) walks `git log`
  // filtered to non-bookkeeping paths, and an empty commit matches no pathspec at all. Without a
  // real baseline file, lastRelevantSha stays null until a test's own first real file change,
  // which made every staleness check vacuously "not stale" (see isStale's early return on a
  // falsy gitSha) regardless of what happened afterward — not what any of those tests mean to
  // exercise.
  await writeFile(path.join(projectRoot, 'README.md'), 'placeholder project content\n', 'utf8');
  await git(['add', '-A']);
  await git(['commit', '-m', 'initial', '-q']);
}

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'trackwright-engine-'));
  await initGitRepo();
  const config = await initConfig(projectRoot, 'TW');
  ticketStore = new TicketStore(path.join(projectRoot, config.ticketsDir));
  evidenceStore = new EvidenceStore(path.join(projectRoot, config.evidenceDir));
});

afterEach(async () => {
  // maxRetries/retryDelay: Windows can briefly hold a lock on a just-exited git subprocess's
  // working directory (antivirus/indexing) — this suite now spawns noticeably more git
  // subprocesses per test (ticket-state auto-commit on every real stage transition, not just
  // once), which made this transient EBUSY/EPERM on cleanup show up where it hadn't before.
  await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function createReadyTicket(id: string) {
  const ticket = newTicket({ id, title: 'Test ticket', discipline: 'development', specialization: 'backend', context: 'ctx' });
  return ticketStore.save(ticket);
}

describe('WorkflowEngine happy path', () => {
  it('drives a ticket all the way from planning to done with mocked SUCCESS everywhere', async () => {
    await createReadyTicket('TW-0001');
    const runner = new MockClaudeRunner();
    runner.enqueueFor('planner', {
      outcome: 'SUCCESS',
      summary: 'planned',
      data: COMPLETE_PLAN_DATA,
      durationMs: 1,
    });
    // architecture/design stages are deterministic stubs (empty sections -> auto SUCCESS), no mock needed
    runner.enqueueFor('implementer.backend', { outcome: 'SUCCESS', summary: 'implemented', data: {}, durationMs: 1 });
    runner.enqueueFor('code-reviewer', { outcome: 'SUCCESS', summary: 'clean', data: {}, durationMs: 1 });
    runner.enqueueFor('verification-agent', { outcome: 'SUCCESS', summary: 'matches intent', data: { reasoning: 'looks right' }, durationMs: 1 });

    const engine = await makeEngine(runner);
    const result = await engine.run('TW-0001');

    expect(result.stopReason).toBe('done');
    expect(result.ticket.frontmatter.stage).toBe('done');
    expect(result.ticket.sections['Requirements']).toBe('req');
    expect(result.ticket.sections['Verification evidence']).toBe('looks right');

    const stages = result.steps.map((s) => `${s.fromStage}->${s.toStage}`);
    expect(stages).toEqual([
      'planning->architecture',
      'architecture->design',
      'design->ready',
      'ready->development',
      'development->code-review',
      'code-review->testing',
      'testing->verification',
      'verification->awaiting-merge',
      'awaiting-merge->done',
    ]);
  });
});

describe('WorkflowEngine verification outcomes', () => {
  async function advanceToVerification(runner: MockClaudeRunner) {
    await createReadyTicket('TW-0002');
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });
    runner.enqueueFor('implementer.backend', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    runner.enqueueFor('code-reviewer', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
  }

  it('CONCERNS blocks automatic progress and stops the run', async () => {
    const runner = new MockClaudeRunner();
    await advanceToVerification(runner);
    runner.enqueueFor('verification-agent', { outcome: 'CONCERNS', summary: 'not sure', data: {}, durationMs: 1 });

    const engine = await makeEngine(runner);
    const result = await engine.run('TW-0002');

    expect(result.stopReason).toBe('awaiting-human');
    expect(result.ticket.frontmatter.stage).toBe('verification');
  });

  it('VERIFICATION_FAILED routes back to development', async () => {
    const runner = new MockClaudeRunner();
    await advanceToVerification(runner);
    runner.enqueueFor('verification-agent', { outcome: 'VERIFICATION_FAILED', summary: 'wrong', data: {}, failureReason: 'nope', durationMs: 1 });
    // once back in development it will need another implementer result to keep the test bounded
    runner.enqueueFor('implementer.backend', { outcome: 'BLOCKED', summary: 'needs human input', data: {}, durationMs: 1 });

    const engine = await makeEngine(runner);
    const result = await engine.run('TW-0002', { maxSteps: 10 });

    const failedStep = result.steps.find((s) => s.outcome === 'VERIFICATION_FAILED');
    expect(failedStep?.toStage).toBe('development');
  });

  it('a human waiving CONCERNS unblocks the ticket into awaiting-merge', async () => {
    const runner = new MockClaudeRunner();
    await advanceToVerification(runner);
    runner.enqueueFor('verification-agent', { outcome: 'CONCERNS', summary: 'not sure', data: {}, durationMs: 1 });

    const engine = await makeEngine(runner);
    await engine.run('TW-0002');

    const message = await runTicketWaive(projectRoot, 'TW-0002', 'reviewed manually, acceptable risk');
    expect(message).toContain('CONCERNS waived');

    const ticket = await ticketStore.getOrThrow('TW-0002');
    expect(ticket.frontmatter.stage).toBe('awaiting-merge');
  });
});

/**
 * Regression coverage for a real gap found during the DF-0007 dogfood run: the verification
 * agent's diff was bounded to 20k chars via a bare `.slice()`, with no exclusion of Trackwright's
 * own `.trackwright/` bookkeeping. A ticket whose cumulative ticket-markdown/evidence content
 * pushed the *combined* diff just past the cap meant the real project change — alphabetically
 * after `.trackwright/...` in git's diff output — was silently cut out of the agent's prompt
 * entirely, producing a false VERIFICATION_FAILED ("the diff doesn't show the required change")
 * for a change that was actually present on disk and in git, just never shown to the agent.
 */
describe('WorkflowEngine verification diff scope', () => {
  async function commit(relPath: string, content: string, message: string) {
    const full = path.join(projectRoot, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
    await git(['add', '-A']);
    await git(['commit', '-m', message, '-q']);
  }

  beforeEach(async () => {
    // Diverge onto a dedicated branch, same as a real ticket run would (ensureWorkBranch) —
    // committing directly on initGitRepo's base branch would make `<base>...HEAD` trivially
    // empty (merge-base(base, base) === base === HEAD), masking the very diff this suite tests.
    const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
    await git(['checkout', '-q', '-b', 'trackwright/tw-0003']);
  });

  async function advanceToVerification(runner: MockClaudeRunner) {
    await createReadyTicket('TW-0003');
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });
    runner.enqueueFor('implementer.backend', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    runner.enqueueFor('code-reviewer', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
  }

  it('excludes .trackwright/ bookkeeping from the diff both code-review and verification see', async () => {
    const runner = new MockClaudeRunner();
    // Note: deliberately NOT under .trackwright/tickets — TicketStore.list() parses every file
    // there as a ticket, which would break this test for a reason unrelated to what it covers.
    await commit('.trackwright/evidence-note.md', 'ticket bookkeeping content\n', 'bookkeeping');
    await commit('routes.mjs', 'export const realChange = true;\n', 'the actual project change');
    await advanceToVerification(runner);
    runner.enqueueFor('verification-agent', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });

    const engine = await makeEngine(runner);
    await engine.run('TW-0003');

    const verificationCall = runner.invocations.find((i) => i.agentName === 'verification-agent')!;
    expect(verificationCall.prompt).not.toContain('bookkeeping content');
    expect(verificationCall.prompt).toContain('realChange');

    // Found via real dogfooding: code-review previously got no engine-provided diff at all and
    // had to run its own live `git diff` via a scoped Bash tool call — which was twice silently
    // denied in the real DF-0007 run (see noCdPrefixWarning in registry.ts). It now gets the same
    // engine-computed, excluded diff verification does.
    const codeReviewCall = runner.invocations.find((i) => i.agentName === 'code-reviewer')!;
    expect(codeReviewCall.prompt).not.toContain('bookkeeping content');
    expect(codeReviewCall.prompt).toContain('realChange');
  });

  it('marks the diff as truncated, visibly, instead of silently cutting it, for both stages', async () => {
    const runner = new MockClaudeRunner();
    // A single project file whose own diff alone exceeds the 20k cap — exclusion alone can't help
    // here, so the truncation marker is what keeps this failure mode diagnosable.
    await commit('routes.mjs', `export const big = "${'x'.repeat(21_000)}";\n`, 'a large real change');
    await advanceToVerification(runner);
    runner.enqueueFor('verification-agent', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });

    const engine = await makeEngine(runner);
    await engine.run('TW-0003');

    const verificationCall = runner.invocations.find((i) => i.agentName === 'verification-agent')!;
    expect(verificationCall.prompt).toContain('diff truncated at 20000');
    const codeReviewCall = runner.invocations.find((i) => i.agentName === 'code-reviewer')!;
    expect(codeReviewCall.prompt).toContain('diff truncated at 20000');
  });
});

describe('WorkflowEngine retry ceiling', () => {
  it('fails closed to BLOCKED once a stage exceeds its retry ceiling', async () => {
    await createReadyTicket('TW-0003');
    const runner = new MockClaudeRunner();
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });
    // implementer always fails retryably — never let it succeed
    for (let i = 0; i < 5; i++) {
      runner.enqueueFor('implementer.backend', { outcome: 'RETRYABLE_FAILURE', summary: 'flaky', data: {}, failureReason: 'boom', durationMs: 1 });
    }

    const engine = await makeEngine(runner);
    const result = await engine.run('TW-0003', { maxSteps: 15 });

    expect(result.stopReason).toBe('awaiting-human');
    expect(result.ticket.frontmatter.stage).toBe('development');
    const developmentAttempts = await evidenceStore.historyForStage('TW-0003', 'development');
    // 3 retryable attempts (the configured ceiling) + 1 final BLOCKED synthesized by the ceiling check
    expect(developmentAttempts.filter((r) => r.outcome === 'RETRYABLE_FAILURE')).toHaveLength(3);
    expect(developmentAttempts[developmentAttempts.length - 1]!.outcome).toBe('BLOCKED');
  });

  it('tells the agent what went wrong on the previous attempt, not just a bare retry', async () => {
    // Found during real dogfooding: a bare retry with no feedback lets a non-compliant response
    // repeat identically across attempts. See engine.ts, previousFailureNote.
    await createReadyTicket('TW-0008');
    const runner = new MockClaudeRunner();
    runner.enqueueFor('planner', {
      outcome: 'SYSTEM_ERROR',
      summary: 'malformed',
      data: {},
      failureReason: 'response was not valid JSON',
      durationMs: 1,
    });
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });

    const engine = await makeEngine(runner);
    await engine.step('TW-0008'); // first attempt: fails
    await engine.step('TW-0008'); // second attempt: should see the failure note

    const secondInvocation = runner.invocations[1]!;
    expect(secondInvocation.agentName).toBe('planner');
    expect(secondInvocation.prompt).toContain('your previous attempt at this stage was rejected');
    expect(secondInvocation.prompt).toContain('response was not valid JSON');
  });
});

describe('WorkflowEngine Awaiting Merge', () => {
  it('runs premerge checks and reports merge_eligible in evidence', async () => {
    await createReadyTicket('TW-0004');
    const runner = new MockClaudeRunner();
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });
    runner.enqueueFor('implementer.backend', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    runner.enqueueFor('code-reviewer', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    runner.enqueueFor('verification-agent', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });

    const engine = await makeEngine(runner);
    const result = await engine.run('TW-0004');

    expect(result.ticket.frontmatter.stage).toBe('done');
    const awaitingMergeHistory = await evidenceStore.historyForStage('TW-0004', 'awaiting-merge');
    expect(awaitingMergeHistory).toHaveLength(1);
    expect(awaitingMergeHistory[0]!.outcome).toBe('SUCCESS');
  });

  it('a stale verification (code changed since it was recorded) sends the ticket back to testing', async () => {
    await createReadyTicket('TW-0044');
    const runner = new MockClaudeRunner();
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });
    runner.enqueueFor('implementer.backend', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    runner.enqueueFor('code-reviewer', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    runner.enqueueFor('verification-agent', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });

    const engine = await makeEngine(runner);
    // Drive it stage by stage (not engine.run()) so a commit can be injected between
    // Verification recording its evidence and Awaiting Merge checking staleness against it —
    // this is the real WorkflowEngine, not just EvidenceStore.isStale in isolation.
    let step = await engine.step('TW-0044'); // planning -> architecture
    while (step.toStage !== 'awaiting-merge') {
      step = await engine.step('TW-0044');
    }
    expect(step.fromStage).toBe('verification');

    // Simulate code changing after verification approved it. A real file change, not
    // `--allow-empty`: staleness is now computed from the last commit that touched anything
    // outside .trackwright/ (GitRepo.lastRelevantSha) specifically so Trackwright's own
    // per-step ticket-state commits (commitTicketState) can never themselves look like "the
    // project changed" — an empty commit wouldn't match that pathspec-filtered log at all, so it
    // would no longer exercise what this test is actually about.
    const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
    await writeFile(path.join(projectRoot, 'post-verification-change.txt'), 'real change\n', 'utf8');
    await git(['add', '-A']);
    await git(['commit', '-m', 'a change that happened after verification', '-q']);

    const staleStep = await engine.step('TW-0044');
    expect(staleStep.outcome).toBe('VERIFICATION_FAILED');
    expect(staleStep.toStage).toBe('testing');
  });

  /**
   * Cross-fix interaction regression: found while hardening after DF-0007. Before GitRepo's
   * lastRelevantSha fix, commitTicketState's own per-step ticket-state commit moved raw HEAD
   * between Verification recording its evidence SHA and Awaiting Merge checking staleness
   * against it — so EVERY ticket would appear stale at Awaiting Merge, every time, for no real
   * reason, immediately bouncing back to Testing and eventually exhausting the retry ceiling.
   * This asserts the inverse of the test above: reaching Awaiting Merge at all, through several
   * real per-step bookkeeping commits (one per stage transition driven below), must NOT by
   * itself look stale.
   */
  it('reaching awaiting-merge through several real ticket-state commits is never itself stale', async () => {
    await createReadyTicket('TW-0045');
    const runner = new MockClaudeRunner();
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });
    runner.enqueueFor('implementer.backend', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    runner.enqueueFor('code-reviewer', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    runner.enqueueFor('verification-agent', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });

    const engine = await makeEngine(runner);
    const result = await engine.run('TW-0045', { maxSteps: 10 });

    // Each of these transitions, including development->code-review and verification->
    // awaiting-merge, produced its own real commitTicketState commit (ticket bookkeeping only —
    // no real project file ever changed in this mocked run). None of that should register as
    // project staleness anywhere along the way.
    const awaitingMergeStep = result.steps.find((s) => s.fromStage === 'awaiting-merge');
    expect(awaitingMergeStep?.outcome).toBe('SUCCESS');
    expect(result.ticket.frontmatter.stage).toBe('done');

    const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
    const { stdout: log } = await git(['log', '--oneline']);
    expect(log.split('\n').filter(Boolean).length).toBeGreaterThan(5); // several real bookkeeping commits happened
  });

  it('a failing premerge check keeps the ticket at awaiting-merge with RETRYABLE_FAILURE', async () => {
    await createReadyTicket('TW-0005');
    const runner = new MockClaudeRunner();
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });
    runner.enqueueFor('implementer.backend', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    runner.enqueueFor('code-reviewer', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    runner.enqueueFor('verification-agent', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });

    const engine = await makeEngine(runner, { premerge: [FAIL_CHECK] });
    const result = await engine.run('TW-0005', { maxSteps: 12 });

    // RETRYABLE_FAILURE self-loops at awaiting-merge until the ceiling, then BLOCKED (awaiting-human)
    expect(result.stopReason).toBe('awaiting-human');
    expect(result.ticket.frontmatter.stage).toBe('awaiting-merge');
  });
});

describe('WorkflowEngine ready gate', () => {
  it('blocks development until all dependencies are done', async () => {
    const dep = newTicket({ id: 'TW-0006', title: 'dep', discipline: 'development', context: 'c' });
    await ticketStore.save({ ...dep, frontmatter: { ...dep.frontmatter, status: 'in-progress', stage: 'development' } });

    const ticket = newTicket({ id: 'TW-0007', title: 'depends on 0006', discipline: 'development', context: 'c' });
    await ticketStore.save({
      ...ticket,
      frontmatter: { ...ticket.frontmatter, dependencies: ['TW-0006'] },
    });

    const runner = new MockClaudeRunner();
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });
    // discipline: 'development' with no specialization is deterministically ambiguous (see
    // design/gate.ts), so it escalates to the design-gate-agent; without this the ticket fails
    // closed to "design required" and gets stuck at the design stage instead of ever reaching
    // the dependency check this test is actually about.
    runner.enqueueFor('design-gate-agent', {
      outcome: 'SUCCESS',
      summary: 'backend-only change, no design required',
      data: { designRequired: false, reasoning: 'backend-only change' },
      durationMs: 1,
    });
    const engine = await makeEngine(runner);
    const result = await engine.run('TW-0007', { maxSteps: 5 });

    expect(result.stopReason).toBe('awaiting-human');
    expect(result.ticket.frontmatter.stage).toBe('ready');
  });
});

/**
 * Regression coverage for a real gap found during the DF-0007 dogfood run: the implementer's
 * system prompt explicitly instructs it to `git commit` before finishing, but it twice reported
 * SUCCESS while leaving a real edit uncommitted — invisible to every git-diff-based stage
 * downstream (Verification), even though Testing (which runs against the live filesystem) still
 * passed. See workflow/engine.ts, uncommittedProjectChanges.
 */
describe('WorkflowEngine post-implementer commit check', () => {
  async function createReadyDevTicket(id: string) {
    const ticket = newTicket({ id, title: 'Test ticket', discipline: 'development', specialization: 'backend', context: 'ctx' });
    await ticketStore.save({ ...ticket, frontmatter: { ...ticket.frontmatter, stage: 'development' } });
  }

  it('treats an uncommitted change left by a "SUCCESS" implementer as RETRYABLE_FAILURE', async () => {
    await createReadyDevTicket('TW-0010');
    // Simulate the implementer editing a real file but never committing it — MockClaudeRunner
    // itself never touches disk, so this stands in for "the agent reported SUCCESS but skipped
    // its own commit instruction."
    await writeFile(path.join(projectRoot, 'left-uncommitted.txt'), 'oops\n', 'utf8');

    const runner = new MockClaudeRunner();
    runner.enqueueFor('implementer.backend', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    // Self-loops back to development per the state machine — give it a second, terminal result
    // so the test run is bounded.
    runner.enqueueFor('implementer.backend', { outcome: 'BLOCKED', summary: 'needs human input', data: {}, durationMs: 1 });

    const engine = await makeEngine(runner);
    const result = await engine.run('TW-0010', { maxSteps: 3 });

    const uncommittedStep = result.steps[0]!;
    expect(uncommittedStep.outcome).toBe('RETRYABLE_FAILURE');
    expect(uncommittedStep.toStage).toBe('development');
    expect(uncommittedStep.summary).toContain('uncommitted');
  });

  it('catches a mix of a tracked modification and an untracked new file left uncommitted', async () => {
    await createReadyDevTicket('TW-0012');
    // `git status --porcelain` reports tracked-modified (" M") and untracked ("??") files with
    // different status codes — this confirms uncommittedStatus/hasUncommittedChanges catches
    // both kinds together, not just the untracked-new-file case the other test covers.
    const tracked = path.join(projectRoot, 'tracked.txt');
    await writeFile(tracked, 'original\n', 'utf8');
    const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
    await git(['add', '-A']);
    await git(['commit', '-m', 'add tracked.txt', '-q']);

    await writeFile(tracked, 'original\nmodified\n', 'utf8');
    await writeFile(path.join(projectRoot, 'left-untracked.txt'), 'oops\n', 'utf8');

    const runner = new MockClaudeRunner();
    runner.enqueueFor('implementer.backend', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    runner.enqueueFor('implementer.backend', { outcome: 'BLOCKED', summary: 'needs human input', data: {}, durationMs: 1 });

    const engine = await makeEngine(runner);
    const result = await engine.run('TW-0012', { maxSteps: 3 });

    const uncommittedStep = result.steps[0]!;
    expect(uncommittedStep.outcome).toBe('RETRYABLE_FAILURE');
    const [firstAttempt] = await evidenceStore.historyForStage('TW-0012', 'development');
    expect(firstAttempt?.failureReason).toContain('tracked.txt');
    expect(firstAttempt?.failureReason).toContain('left-untracked.txt');
  });

  it('does not flag Trackwright\'s own bookkeeping as uncommitted implementer work', async () => {
    await createReadyDevTicket('TW-0011');
    // Trackwright's own bookkeeping (evidence, in this case) is normal, expected uncommitted
    // content — only *project* files are the implementer's concern. Deliberately not under
    // .trackwright/tickets: TicketStore.list() parses every file there as a ticket.
    await mkdir(path.join(projectRoot, '.trackwright', 'evidence'), { recursive: true });
    await writeFile(path.join(projectRoot, '.trackwright', 'evidence', 'scratch.jsonl'), '{}\n', 'utf8');

    const runner = new MockClaudeRunner();
    runner.enqueueFor('implementer.backend', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });
    runner.enqueueFor('code-reviewer', { outcome: 'SUCCESS', summary: 'ok', data: {}, durationMs: 1 });

    const engine = await makeEngine(runner);
    const result = await engine.run('TW-0011', { maxSteps: 1 });

    expect(result.steps[0]!.outcome).toBe('SUCCESS');
    expect(result.steps[0]!.toStage).toBe('code-review');
  });
});

/**
 * Crash-window regression coverage from the release-readiness audit. finish() used to record
 * evidence BEFORE saving the ticket's new stage. A crash in the gap between those two writes
 * left an evidence record on disk claiming a stage transition happened, while the ticket itself
 * never actually advanced — a restart would recompute the same `attempt` number from that
 * evidence, call step() again, and invoke a real agent a second time for a transition evidence
 * already says occurred (wasted cost; potentially double-counted retry-ceiling attempts). The
 * ticket save (and its commit) now happen BEFORE evidence is recorded, so that specific window
 * can no longer duplicate agent work — the only possible loss is one evidence record for a
 * transition that did, correctly, happen.
 */
describe('WorkflowEngine crash-window ordering', () => {
  it('persists the ticket\'s new stage even if evidence recording fails right after', async () => {
    await createReadyTicket('TW-0046');
    const runner = new MockClaudeRunner();
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });

    const config = { ...(await initConfig(projectRoot, 'TW')), checks: { fast: [], test: [], premerge: [] } };
    // Object.create(evidenceStore): a new object whose prototype IS the real instance, so every
    // method (newRunId, attemptCount, ...) still works via the prototype chain except the one
    // explicitly shadowed below.
    const explodingEvidenceStore = Object.create(evidenceStore) as EvidenceStore;
    (explodingEvidenceStore as { record: EvidenceStore['record'] }).record = () => {
      throw new Error('simulated crash: disk full while writing evidence');
    };

    const engine = new WorkflowEngine({
      ticketStore,
      evidenceStore: explodingEvidenceStore,
      claudeRunner: runner,
      config,
      gitRepo: new GitRepo(projectRoot),
      cwd: projectRoot,
    });

    await expect(engine.step('TW-0046')).rejects.toThrow('simulated crash');

    // Despite the "crash," the ticket itself must already show the real outcome of this step —
    // not the pre-step stage, which is what the old (evidence-first) ordering would have left it
    // at, setting up a duplicate invocation on the next `run`.
    const ticket = await ticketStore.getOrThrow('TW-0046');
    expect(ticket.frontmatter.stage).toBe('architecture');
  });
});

/**
 * Found during the final release-hardening pass: executeDesignGate's deterministic decision
 * (required/pending/stale/not-required) was computed on every call but never written back onto
 * the ticket's own `design_status` field — only the human-invoked `trackwright design approve`
 * ever touched it (-> 'synced'). `ticket show` could claim `design_status=not-required` on a
 * ticket that was, in fact, BLOCKED waiting on an unapproved design draft. engine.ts now writes
 * design_status via `result.data.design_status`, a stage-agnostic mechanism (like
 * sectionUpdatesFor, but for frontmatter) that applies regardless of outcome — unlike sections,
 * which only persist on SUCCESS, a BLOCKED gate's 'pending'/'stale' decision must still land.
 */
describe('design_status write-back', () => {
  async function createTicket(id: string, overrides: Partial<Parameters<typeof newTicket>[0]> = {}) {
    const ticket = newTicket({ id, title: 'Design thing', discipline: 'design', context: 'needs a design', ...overrides });
    await ticketStore.save({ ...ticket, frontmatter: { ...ticket.frontmatter, stage: 'design' } });
  }

  it('sets design_status to "pending" when a fresh draft is created', async () => {
    await createTicket('TW-0050');
    const engine = await makeEngine(new MockClaudeRunner());

    const step = await engine.step('TW-0050');
    expect(step.outcome).toBe('BLOCKED');

    const ticket = await ticketStore.getOrThrow('TW-0050');
    expect(ticket.frontmatter.design_status).toBe('pending');
  });

  it('stays "pending" on a second gate check against the same unapproved draft', async () => {
    await createTicket('TW-0051');
    const engine = await makeEngine(new MockClaudeRunner());

    await engine.step('TW-0051'); // drafts, BLOCKED, design_status -> pending
    const second = await engine.step('TW-0051'); // same draft, still unapproved

    expect(second.outcome).toBe('BLOCKED');
    const ticket = await ticketStore.getOrThrow('TW-0051');
    expect(ticket.frontmatter.design_status).toBe('pending');
  });

  it('sets design_status to "not-required" for a ticket the gate decides does not need one', async () => {
    await createTicket('TW-0052', { discipline: 'infrastructure' });
    const engine = await makeEngine(new MockClaudeRunner());

    const step = await engine.step('TW-0052');
    expect(step.outcome).toBe('SUCCESS');

    const ticket = await ticketStore.getOrThrow('TW-0052');
    expect(ticket.frontmatter.design_status).toBe('not-required');
  });

  it('sets design_status to "synced" once an approved, fresh design is found', async () => {
    await createTicket('TW-0053');
    const engine = await makeEngine(new MockClaudeRunner());
    await engine.step('TW-0053'); // drafts a design, BLOCKED

    const design = await (async () => {
      const provider = new LocalDesignArtifactProvider(path.join(projectRoot, '.trackwright', 'design'));
      const latest = await provider.getLatestForTicket('TW-0053');
      return provider.approve(latest!.designId);
    })();
    expect(design.status).toBe('approved');

    const second = await engine.step('TW-0053');
    expect(second.outcome).toBe('SUCCESS');
    const ticket = await ticketStore.getOrThrow('TW-0053');
    expect(ticket.frontmatter.design_status).toBe('synced');
  });

  it('the real `design approve` command produces a design the gate accepts, despite bookkeeping commits on HEAD', async () => {
    await createTicket('TW-0055');
    const engine = await makeEngine(new MockClaudeRunner());
    await engine.step('TW-0055'); // drafts a design, BLOCKED — and commits the ticket-state change
    const provider = new LocalDesignArtifactProvider(path.join(projectRoot, '.trackwright', 'design'));
    const latest = await provider.getLatestForTicket('TW-0055');

    await runDesignApprove(projectRoot, latest!.designId);
    const second = await engine.step('TW-0055');

    expect(second.summary).not.toContain('stale');
    expect(second.outcome).toBe('SUCCESS');
    expect((await ticketStore.getOrThrow('TW-0055')).frontmatter.design_status).toBe('synced');
  });

  it('sets design_status to "stale" when an approved design goes stale', async () => {
    await createTicket('TW-0054');
    const engine = await makeEngine(new MockClaudeRunner());
    await engine.step('TW-0054');

    const provider = new LocalDesignArtifactProvider(path.join(projectRoot, '.trackwright', 'design'));
    const latest = await provider.getLatestForTicket('TW-0054');
    await provider.approve(latest!.designId);
    await provider.setReferenceSha(latest!.designId, 'some-old-sha-that-will-not-match');

    const second = await engine.step('TW-0054');
    expect(second.outcome).toBe('BLOCKED');
    const ticket = await ticketStore.getOrThrow('TW-0054');
    expect(ticket.frontmatter.design_status).toBe('stale');
  });
});

describe('per-specialization checks (checksBySpecialization)', () => {
  async function engineWith(runner: MockClaudeRunner, checksBySpecialization: Record<string, unknown>) {
    const base = await initConfig(projectRoot, 'TW');
    const config = {
      ...base,
      checks: { fast: [], test: [FAIL_CHECK], premerge: [FAIL_CHECK] },
      checksBySpecialization: checksBySpecialization as typeof base.checksBySpecialization,
    };
    return new WorkflowEngine({ ticketStore, evidenceStore, claudeRunner: runner, config, gitRepo: new GitRepo(projectRoot), cwd: projectRoot });
  }

  it('a mobile ticket routes to implementer.mobile and runs the mobile test/premerge commands, not the global ones', async () => {
    const ticket = newTicket({ id: 'TW-0020', title: 'mobile', discipline: 'development', specialization: 'mobile', context: 'ctx' });
    await ticketStore.save(ticket);
    const runner = new MockClaudeRunner();
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });
    runner.enqueueFor('design-gate-agent', { outcome: 'SUCCESS', summary: 'no ui', data: { designRequired: false, reasoning: 'logic only' }, durationMs: 1 });

    // Global test/premerge always fail; only the mobile override passes. Reaching Done proves the
    // override (not the global tier) was what Testing and Awaiting Merge actually ran.
    const engine = await engineWith(runner, { mobile: { test: [PASS_CHECK], premerge: [PASS_CHECK] } });
    const result = await engine.run('TW-0020');

    expect(result.stopReason).toBe('done');
    expect(runner.invocations.map((i) => i.agentName)).toContain('implementer.mobile');
    expect(runner.invocations.map((i) => i.agentName)).not.toContain('implementer.generic');
  });

  it('a tier left unset for the specialization falls back to the global checks', async () => {
    const ticket = newTicket({ id: 'TW-0021', title: 'mobile', discipline: 'development', specialization: 'mobile', context: 'ctx' });
    await ticketStore.save(ticket);
    const runner = new MockClaudeRunner();
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });
    runner.enqueueFor('design-gate-agent', { outcome: 'SUCCESS', summary: 'no ui', data: { designRequired: false, reasoning: 'logic only' }, durationMs: 1 });

    // mobile overrides only `test`; premerge falls back to the global FAIL_CHECK.
    const engine = await engineWith(runner, { mobile: { test: [PASS_CHECK] } });
    const result = await engine.run('TW-0021', { maxSteps: 14 });

    expect(result.ticket.frontmatter.stage).toBe('awaiting-merge');
    expect(result.stopReason).not.toBe('done');
  });
});

describe('cancelled tickets', () => {
  it('run() never drives a cancelled ticket — no agent invocation, no stage change', async () => {
    const t = newTicket({ id: 'TW-0030', title: 'cancelled', discipline: 'development', specialization: 'backend', context: 'c' });
    await ticketStore.save({ ...t, frontmatter: { ...t.frontmatter, status: 'cancelled' } });
    const runner = new MockClaudeRunner();
    const engine = await makeEngine(runner);

    const result = await engine.run('TW-0030');

    expect(result.stopReason).toBe('cancelled');
    expect(result.steps).toHaveLength(0);
    expect(runner.callCount).toBe(0);
    expect(result.ticket.frontmatter.stage).toBe('planning');
  });

});

describe('ticket status follows the done stage', () => {
  it('reaching done sets status "done", which is what unblocks dependents at Ready', async () => {
    await createReadyTicket('TW-0040');
    const runner = new MockClaudeRunner();
    runner.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });
    const engine = await makeEngine(runner);
    const result = await engine.run('TW-0040');
    expect(result.stopReason).toBe('done');
    expect(result.ticket.frontmatter.status).toBe('done');

    const dependent = newTicket({ id: 'TW-0041', title: 'dep', discipline: 'development', specialization: 'backend', context: 'c', dependencies: ['TW-0040'] });
    await ticketStore.save(dependent);
    const runner2 = new MockClaudeRunner();
    runner2.enqueueFor('planner', { outcome: 'SUCCESS', summary: 'ok', data: COMPLETE_PLAN_DATA, durationMs: 1 });
    const result2 = await (await makeEngine(runner2)).run('TW-0041');
    expect(result2.stopReason).toBe('done');
  });
});
