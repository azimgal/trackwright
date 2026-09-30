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
});
