import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EvidenceStore } from '../src/evidence/store.js';
import { hasExceededCeiling } from '../src/policies/retry.js';

let dir: string;
let store: EvidenceStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'trackwright-evidence-'));
  store = new EvidenceStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function record(overrides: Partial<Parameters<EvidenceStore['record']>[0]> = {}) {
  return store.record({
    runId: store.newRunId(),
    ticketId: 'TW-0001',
    stage: 'development',
    agent: 'implementer.backend',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    outcome: 'SUCCESS',
    attempt: 1,
    artifacts: [],
    gitSha: 'abc123',
    summary: 'ok',
    ...overrides,
  });
}

describe('EvidenceStore', () => {
  it('returns an empty history for a ticket that has never run', async () => {
    expect(await store.history('TW-9999')).toEqual([]);
  });

  it('records and reads back evidence in order', async () => {
    await record({ summary: 'first' });
    await record({ summary: 'second' });
    const history = await store.history('TW-0001');
    expect(history.map((r) => r.summary)).toEqual(['first', 'second']);
  });

  it('counts only non-SUCCESS attempts for the ceiling', async () => {
    await record({ outcome: 'SUCCESS' });
    await record({ outcome: 'RETRYABLE_FAILURE' });
    await record({ outcome: 'RETRYABLE_FAILURE' });
    expect(await store.attemptCount('TW-0001', 'development')).toBe(2);
  });

  it('only counts attempts since the most recent RETRY_RESET', async () => {
    await record({ outcome: 'SYSTEM_ERROR' });
    await record({ outcome: 'SYSTEM_ERROR' });
    await record({ outcome: 'SYSTEM_ERROR' });
    expect(await store.attemptCount('TW-0001', 'development')).toBe(3);

    await record({ outcome: 'RETRY_RESET', agent: 'human', summary: 'reset by human: limit cleared' });
    expect(await store.attemptCount('TW-0001', 'development')).toBe(0);

    await record({ outcome: 'SYSTEM_ERROR' });
    expect(await store.attemptCount('TW-0001', 'development')).toBe(1);
  });

  it('RETRY_RESET does not affect a different stage for the same ticket', async () => {
    await record({ stage: 'development', outcome: 'SYSTEM_ERROR' });
    await record({ stage: 'development', outcome: 'RETRY_RESET', agent: 'human', summary: 'reset' });
    await record({ stage: 'testing', outcome: 'RETRYABLE_FAILURE' });
    expect(await store.attemptCount('TW-0001', 'development')).toBe(0);
    expect(await store.attemptCount('TW-0001', 'testing')).toBe(1);
  });

  it('detects staleness against the last SUCCESS git SHA', async () => {
    await record({ outcome: 'SUCCESS', gitSha: 'sha-a' });
    expect(await store.isStale('TW-0001', 'development', 'sha-a')).toBe(false);
    expect(await store.isStale('TW-0001', 'development', 'sha-b')).toBe(true);
  });

  it('is not stale when there is no prior successful record', async () => {
    expect(await store.isStale('TW-0001', 'development', 'sha-anything')).toBe(false);
  });
});

describe('hasExceededCeiling', () => {
  it('is false below the ceiling and true at/above it', async () => {
    await record({ outcome: 'RETRYABLE_FAILURE' });
    await record({ outcome: 'RETRYABLE_FAILURE' });
    expect(await hasExceededCeiling(store, 'TW-0001', 'development', 3)).toBe(false);
    await record({ outcome: 'RETRYABLE_FAILURE' });
    expect(await hasExceededCeiling(store, 'TW-0001', 'development', 3)).toBe(true);
  });

  it('returns to false after a human RETRY_RESET', async () => {
    await record({ outcome: 'SYSTEM_ERROR' });
    await record({ outcome: 'SYSTEM_ERROR' });
    await record({ outcome: 'SYSTEM_ERROR' });
    expect(await hasExceededCeiling(store, 'TW-0001', 'development', 3)).toBe(true);

    await record({ outcome: 'RETRY_RESET', agent: 'human', summary: 'reset' });
    expect(await hasExceededCeiling(store, 'TW-0001', 'development', 3)).toBe(false);
  });
});
