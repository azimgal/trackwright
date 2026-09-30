import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { defaultConfig } from '../src/config/defaults.js';
import { runTicketWaive } from '../src/cli/commands/waive.js';
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
  await git(['commit', '--allow-empty', '-m', 'initial', '-q']);
}

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'trackwright-engine-'));
  await initGitRepo();
  const config = await initConfig(projectRoot, 'TW');
  ticketStore = new TicketStore(path.join(projectRoot, config.ticketsDir));
  evidenceStore = new EvidenceStore(path.join(projectRoot, config.evidenceDir));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
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

    // Simulate code changing after verification approved it.
    const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
    await git(['commit', '--allow-empty', '-m', 'a change that happened after verification', '-q']);

    const staleStep = await engine.step('TW-0044');
    expect(staleStep.outcome).toBe('VERIFICATION_FAILED');
    expect(staleStep.toStage).toBe('testing');
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
