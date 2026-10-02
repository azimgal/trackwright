import { describe, expect, it } from 'vitest';
import { hashText, isDesignStale } from '../src/design/staleness.js';
import type { DesignArtifact } from '../src/design/types.js';

function artifact(overrides: Partial<DesignArtifact> = {}): DesignArtifact {
  return {
    designId: 'd1',
    ticketId: 'TW-0001',
    source: 'local',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'approved',
    artifactPath: null,
    artifactUrl: null,
    referenceSha: 'sha-a',
    requirementsHash: hashText('req v1'),
    constraints: [],
    visualChecks: [],
    ...overrides,
  };
}

describe('hashText', () => {
  it('is deterministic for identical content', () => {
    expect(hashText('same')).toBe(hashText('same'));
  });

  it('differs for different content', () => {
    expect(hashText('a')).not.toBe(hashText('b'));
  });
});

/**
 * Dedicated unit coverage for design/staleness.ts — found during the final release-hardening
 * pass to have zero direct test coverage (only exercised indirectly through engine.test.ts's
 * design-gate routing scenarios).
 */
describe('isDesignStale', () => {
  it('a draft artifact is never stale — staleness is about trust that was earned, then lost', () => {
    const a = artifact({ status: 'draft', requirementsHash: hashText('old') });
    expect(isDesignStale({ artifact: a, currentRequirementsHash: hashText('new'), currentGitSha: 'sha-b' })).toBe(
      false,
    );
  });

  it('an artifact already marked stale stays stale regardless of current hashes', () => {
    const a = artifact({ status: 'stale' });
    expect(
      isDesignStale({ artifact: a, currentRequirementsHash: a.requirementsHash, currentGitSha: a.referenceSha }),
    ).toBe(true);
  });

  it('an approved artifact is fresh when nothing has changed', () => {
    const a = artifact();
    expect(isDesignStale({ artifact: a, currentRequirementsHash: a.requirementsHash, currentGitSha: a.referenceSha })).toBe(
      false,
    );
  });

  it('goes stale when the requirements hash changed since approval', () => {
    const a = artifact();
    expect(isDesignStale({ artifact: a, currentRequirementsHash: hashText('changed req'), currentGitSha: a.referenceSha })).toBe(
      true,
    );
  });

  it('goes stale when the git SHA moved since approval (code changed)', () => {
    const a = artifact();
    expect(isDesignStale({ artifact: a, currentRequirementsHash: a.requirementsHash, currentGitSha: 'sha-new' })).toBe(
      true,
    );
  });

  it('is not stale when the artifact never recorded a requirements hash or SHA (nothing to compare against)', () => {
    const a = artifact({ requirementsHash: null, referenceSha: null });
    expect(isDesignStale({ artifact: a, currentRequirementsHash: hashText('anything'), currentGitSha: 'sha-anything' })).toBe(
      false,
    );
  });
});
