/**
 * Design artifact model (docs/architecture.md, "Design Sync"). A design artifact is the record of
 * a design decision for a ticket — where it lives, whether it's still trusted, and what to check
 * an implementation against. Trackwright's core never depends on a specific design tool to
 * produce one; it depends only on this shape, via DesignProvider (provider.ts).
 */
export interface DesignArtifact {
  designId: string;
  ticketId: string;
  /** Name of the DesignProvider that produced this artifact, e.g. "local". */
  source: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /**
   * "draft": produced, not yet human-approved. "approved": a human signed off — see
   * docs/architecture.md, Design Sync never auto-approves. "stale": see staleness.ts.
   */
  status: 'draft' | 'approved' | 'stale';
  /** Local file path to the artifact (markdown/json/reference image), if any. */
  artifactPath: string | null;
  /** Remote URL to the artifact (e.g. a design tool's own link), if any. */
  artifactUrl: string | null;
  /** git SHA the implementation was checked against the last time this was synced. */
  referenceSha: string | null;
  /** Hash of the ticket's Requirements section text at the time this design was synced — used
   * to detect "requirements changed since this design was made" staleness (staleness.ts). */
  requirementsHash: string | null;
  /** Free-text constraints a visual check should hold the implementation to. */
  constraints: string[];
  visualChecks: VisualCheckResult[];
}

export interface VisualCheckResult {
  checkedAt: string;
  outcome: 'DESIGN_PASS' | 'DESIGN_CONCERNS' | 'DESIGN_FAIL';
  summary: string;
  /** Path to a comparison artifact (screenshot diff, report), if the verifier produced one. */
  reportPath: string | null;
}

/**
 * The five design-stage outcomes (docs/architecture.md). DESIGN_NOT_REQUIRED and DESIGN_STALE are
 * gate-level states; DESIGN_PASS/DESIGN_CONCERNS/DESIGN_FAIL are visual-verification outcomes.
 * Kept as a separate vocabulary from RunOutcome (workflow/outcomes.ts) because they're a distinct
 * concern (design-specific judgment) surfaced in evidence and CLI output, even though the engine
 * still maps each one to a RunOutcome for state-machine routing (see design/gate.ts).
 */
export const DESIGN_OUTCOMES = [
  'DESIGN_PASS',
  'DESIGN_CONCERNS',
  'DESIGN_FAIL',
  'DESIGN_STALE',
  'DESIGN_NOT_REQUIRED',
] as const;
export type DesignOutcome = (typeof DESIGN_OUTCOMES)[number];
