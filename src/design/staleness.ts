import { createHash } from 'node:crypto';
import type { DesignArtifact } from './types.js';

/** Deterministic content hash — used to detect "Requirements changed since the design was synced". */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface StalenessInput {
  artifact: DesignArtifact;
  currentRequirementsHash: string | null;
  currentGitSha: string | null;
}

/**
 * Three staleness triggers (docs/architecture.md, "Design staleness"): requirements changed,
 * frontend code changed after sync, or the design artifact itself changed. The third is handled
 * structurally, not by this function — LocalDesignArtifactProvider.createOrUpdateDesign always
 * mints a new version rather than mutating an approved one in place, so "the artifact changed"
 * and "there's a newer version than the one a ticket is pinned to" are the same fact, checked by
 * comparing versions at the call site (design/gate.ts), not here.
 *
 * A 'draft' artifact is never "stale" — staleness is about something that WAS trusted (approved)
 * no longer being trustworthy, not about work that hasn't been approved yet.
 */
export function isDesignStale(input: StalenessInput): boolean {
  if (input.artifact.status === 'stale') return true;
  if (input.artifact.status !== 'approved') return false;

  if (
    input.artifact.requirementsHash &&
    input.currentRequirementsHash &&
    input.artifact.requirementsHash !== input.currentRequirementsHash
  ) {
    return true;
  }

  if (
    input.artifact.referenceSha &&
    input.currentGitSha &&
    input.artifact.referenceSha !== input.currentGitSha
  ) {
    return true;
  }

  return false;
}
