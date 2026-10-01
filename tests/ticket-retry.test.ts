import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { initConfig, configPath } from '../src/config/loader.js';
import { TicketStore } from '../src/tickets/store.js';
import { EvidenceStore } from '../src/evidence/store.js';
import { newTicket } from '../src/tickets/template.js';
import { hasExceededCeiling } from '../src/policies/retry.js';
import { runTicketRetry, RetryNotAllowedError } from '../src/cli/commands/ticket-retry.js';
import { runTicketRun } from '../src/cli/commands/run.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'trackwright-ticket-retry-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

async function recordSystemErrors(evidenceStore: EvidenceStore, ticketId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await evidenceStore.record({
      runId: evidenceStore.newRunId(),
      ticketId,
      stage: 'development',
      agent: 'implementer',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      outcome: 'SYSTEM_ERROR',
      attempt: i + 1,
      artifacts: [],
      gitSha: null,
      failureReason: 'claude reported is_error=true: You\'ve hit your session limit',
      summary: 'session limit',
    });
  }
}

/**
 * Regression coverage for a real gap found during the DF-0007 dogfood run: a stage BLOCKED by a
 * purely transient SYSTEM_ERROR (a Claude session rate limit) had no automatic or CLI-assisted
 * way to recover once the limit reset — the retry ceiling is counted from the full, all-time
 * evidence log (evidence/store.ts), so `trackwright run` re-synthesized the same BLOCKED outcome
 * forever without ever invoking Claude again. `trackwright ticket retry` is the fix: a human-only,
 * reasoned, auditable way to move the ceiling's counting window forward.
 */
describe('runTicketRetry', () => {
  it('refuses without a reason', async () => {
    await initConfig(projectRoot, 'TW');
    await expect(runTicketRetry(projectRoot, 'TW-0001', '')).rejects.toThrow(RetryNotAllowedError);
  });

  it('refuses when the ticket has not exceeded its retry ceiling', async () => {
    const config = await initConfig(projectRoot, 'TW');
    const store = new TicketStore(path.join(projectRoot, config.ticketsDir));
    await store.save(newTicket({ id: 'TW-0001', title: 'x', discipline: 'development', context: 'c' }));

    await expect(runTicketRetry(projectRoot, 'TW-0001', 'limit reset')).rejects.toThrow(RetryNotAllowedError);
  });

  it('refuses for a ticket that does not exist', async () => {
    await initConfig(projectRoot, 'TW');
    await expect(runTicketRetry(projectRoot, 'TW-9999', 'limit reset')).rejects.toThrow();
  });

  it('resets the ceiling once genuinely exceeded, recording an auditable RETRY_RESET', async () => {
    const config = await initConfig(projectRoot, 'TW');
    const store = new TicketStore(path.join(projectRoot, config.ticketsDir));
    const evidenceStore = new EvidenceStore(path.join(projectRoot, config.evidenceDir));

    const ticket = newTicket({ id: 'TW-0001', title: 'x', discipline: 'development', context: 'c' });
    await store.save({ ...ticket, frontmatter: { ...ticket.frontmatter, stage: 'development' } });
    await recordSystemErrors(evidenceStore, 'TW-0001', 3);

    expect(await hasExceededCeiling(evidenceStore, 'TW-0001', 'development', config.retryCeiling)).toBe(true);

    const message = await runTicketRetry(projectRoot, 'TW-0001', 'session limit has since reset');
    expect(message).toContain('reset');
    expect(message).toContain('session limit has since reset');

    expect(await hasExceededCeiling(evidenceStore, 'TW-0001', 'development', config.retryCeiling)).toBe(false);

    const history = await evidenceStore.historyForStage('TW-0001', 'development');
    const resetRecord = history[history.length - 1]!;
    expect(resetRecord.outcome).toBe('RETRY_RESET');
    expect(resetRecord.agent).toBe('human');
    expect(resetRecord.summary).toContain('session limit has since reset');
    // Nothing is deleted — the full failure history stays in the log, auditable.
    expect(history.filter((r) => r.outcome === 'SYSTEM_ERROR')).toHaveLength(3);
  });

  it('lets a real run resume past a stage that was BLOCKED purely by a now-reset ceiling', async () => {
    let config = await initConfig(projectRoot, 'TW');
    // Drop the default checks.fast (real `npm run lint`/`typecheck`) — this test's tmpdir has no
    // package.json, so those would fail for reasons unrelated to what's under test here.
    config = { ...config, checks: { ...config.checks, fast: [] } };
    await writeFile(configPath(projectRoot), yaml.dump(config, { noRefs: true }), 'utf8');

    const store = new TicketStore(path.join(projectRoot, config.ticketsDir));
    const evidenceStore = new EvidenceStore(path.join(projectRoot, config.evidenceDir));

    const ticket = newTicket({ id: 'TW-0001', title: 'x', discipline: 'development', context: 'c' });
    await store.save({ ...ticket, frontmatter: { ...ticket.frontmatter, stage: 'development' } });
    await recordSystemErrors(evidenceStore, 'TW-0001', 3);

    // Before reset: run() must not advance past development (fails closed, as designed).
    const blockedRun = await runTicketRun(projectRoot, 'TW-0001', { dryRun: true, skipBranch: true, maxSteps: 1 });
    expect(blockedRun.stopReason).toBe('awaiting-human');
    expect(blockedRun.ticket.frontmatter.stage).toBe('development');

    await runTicketRetry(projectRoot, 'TW-0001', 'session limit has since reset');

    // After reset: the implementer agent is invoked again (mock defaults to SUCCESS) and the
    // ticket actually advances past development instead of re-synthesizing the same BLOCKED.
    const resumedRun = await runTicketRun(projectRoot, 'TW-0001', { dryRun: true, skipBranch: true, maxSteps: 1 });
    expect(resumedRun.steps[0]!.outcome).toBe('SUCCESS');
    expect(resumedRun.ticket.frontmatter.stage).toBe('code-review');
  });
});
