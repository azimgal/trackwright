import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalDesignArtifactProvider } from '../src/design/local-provider.js';
import { DesignNotFoundError } from '../src/design/provider.js';

let dir: string;
let provider: LocalDesignArtifactProvider;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'trackwright-design-provider-'));
  provider = new LocalDesignArtifactProvider(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Dedicated unit coverage for design/local-provider.ts — found during the final
 * release-hardening pass to have zero direct test coverage despite being the only DesignProvider
 * Trackwright ships, and the thing that makes Design Sync actually work standalone (no external
 * design tool required).
 */
describe('LocalDesignArtifactProvider', () => {
  it('creates a draft artifact at version 1', async () => {
    const artifact = await provider.createOrUpdateDesign({
      ticketId: 'TW-0001',
      brief: 'needs a settings page',
      constraints: ['must fit existing nav'],
      requirementsHash: 'hash1',
    });
    expect(artifact.version).toBe(1);
    expect(artifact.status).toBe('draft');
    expect(artifact.ticketId).toBe('TW-0001');
    expect(artifact.source).toBe('local');
  });

  it('getDesign returns null for an unknown id, not a throw', async () => {
    expect(await provider.getDesign('does-not-exist')).toBeNull();
  });

  it('getLatestForTicket returns null when the ticket has no design yet', async () => {
    expect(await provider.getLatestForTicket('TW-9999')).toBeNull();
  });

  it('a second createOrUpdateDesign for the same ticket mints version 2, never mutating version 1', async () => {
    const v1 = await provider.createOrUpdateDesign({
      ticketId: 'TW-0001',
      brief: 'v1 brief',
      constraints: [],
      requirementsHash: 'h1',
    });
    const v2 = await provider.createOrUpdateDesign({
      ticketId: 'TW-0001',
      brief: 'v2 brief',
      constraints: [],
      requirementsHash: 'h2',
    });
    expect(v2.version).toBe(2);
    expect(v2.designId).not.toBe(v1.designId);

    // v1 itself is untouched — "a newer version exists" is a structural fact (compare versions),
    // not a mutation of the old one.
    const reloadedV1 = await provider.getDesign(v1.designId);
    expect(reloadedV1?.version).toBe(1);
    expect(reloadedV1?.status).toBe('draft');

    const latest = await provider.getLatestForTicket('TW-0001');
    expect(latest?.designId).toBe(v2.designId);
  });

  it('approve flips status to approved and bumps updatedAt', async () => {
    const created = await provider.createOrUpdateDesign({
      ticketId: 'TW-0001',
      brief: 'b',
      constraints: [],
      requirementsHash: null,
    });
    const approved = await provider.approve(created.designId);
    expect(approved.status).toBe('approved');
    expect(approved.updatedAt).not.toBe(created.updatedAt);
  });

  it('approve throws DesignNotFoundError for an unknown id', async () => {
    await expect(provider.approve('nope')).rejects.toThrow(DesignNotFoundError);
  });

  it('markStale throws DesignNotFoundError for an unknown id', async () => {
    await expect(provider.markStale('nope')).rejects.toThrow(DesignNotFoundError);
  });

  it('markStale flips status to stale', async () => {
    const created = await provider.createOrUpdateDesign({
      ticketId: 'TW-0001',
      brief: 'b',
      constraints: [],
      requirementsHash: null,
    });
    const stale = await provider.markStale(created.designId);
    expect(stale.status).toBe('stale');
  });

  it('setReferenceSha records the SHA without touching other fields', async () => {
    const created = await provider.createOrUpdateDesign({
      ticketId: 'TW-0001',
      brief: 'b',
      constraints: ['c1'],
      requirementsHash: 'h',
    });
    const updated = await provider.setReferenceSha(created.designId, 'sha-123');
    expect(updated.referenceSha).toBe('sha-123');
    expect(updated.constraints).toEqual(['c1']);
  });

  it('recordVisualCheck appends to history rather than replacing it', async () => {
    const created = await provider.createOrUpdateDesign({
      ticketId: 'TW-0001',
      brief: 'b',
      constraints: [],
      requirementsHash: null,
    });
    const check1 = { checkedAt: '2026-01-01T00:00:00.000Z', outcome: 'DESIGN_CONCERNS' as const, summary: 'first', reportPath: null };
    const check2 = { checkedAt: '2026-01-02T00:00:00.000Z', outcome: 'DESIGN_PASS' as const, summary: 'second', reportPath: null };

    const afterFirst = await provider.recordVisualCheck(created.designId, check1);
    expect(afterFirst.visualChecks).toEqual([check1]);

    const afterSecond = await provider.recordVisualCheck(created.designId, check2);
    expect(afterSecond.visualChecks).toEqual([check1, check2]);
  });
});
