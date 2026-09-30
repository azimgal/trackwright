import type { DesignArtifact } from './types.js';

export interface DesignCreateRequest {
  ticketId: string;
  /**
   * A neutral brief: what the design needs to accomplish, never how it should look (no
   * layout/size/colour prescriptions). Mirrors the design-poc precedent this module was informed
   * by (see docs/architecture.md) — the brief stays neutral so design decisions come only from
   * whatever actually makes them, human or provider, not from the ticket author's own guess.
   */
  brief: string;
  constraints: string[];
  /** Hash of the ticket's Requirements text at sync time — see DesignArtifact.requirementsHash. */
  requirementsHash: string | null;
}

/**
 * Trackwright's core (engine.ts, design/gate.ts) depends only on this interface, never on a
 * specific design tool. This is the seam docs/roadmap.md calls out: a real Claude Design (or any
 * other) integration is a second implementation of this same interface, not a change to core.
 */
export interface DesignProvider {
  readonly name: string;
  createOrUpdateDesign(request: DesignCreateRequest): Promise<DesignArtifact>;
  getDesign(designId: string): Promise<DesignArtifact | null>;
  getLatestForTicket(ticketId: string): Promise<DesignArtifact | null>;
  /** Record a human approval — the only way an artifact's status becomes "approved". */
  approve(designId: string): Promise<DesignArtifact>;
  /** Mark an artifact stale — see design/staleness.ts. */
  markStale(designId: string): Promise<DesignArtifact>;
  /** Record the git SHA an artifact was last synced/approved against. */
  setReferenceSha(designId: string, sha: string): Promise<DesignArtifact>;
  /** Append a visual-check result, keeping prior checks in history. */
  recordVisualCheck(designId: string, check: DesignArtifact['visualChecks'][number]): Promise<DesignArtifact>;
}

export class DesignNotFoundError extends Error {
  constructor(readonly designId: string) {
    super(`no design artifact found with id "${designId}"`);
    this.name = 'DesignNotFoundError';
  }
}
