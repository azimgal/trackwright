import { existsSync } from 'node:fs';
import type { DesignArtifact, VisualCheckResult } from './types.js';

export interface VisualVerifyRequest {
  designArtifact: DesignArtifact;
  /** A path to a screenshot/rendered-result artifact the implementer or a test run produced, if any. */
  resultArtifactPath: string | null;
}

/**
 * Trackwright's core depends only on this interface — a real pixel-level visual-diff tool is a
 * second implementation of it, not a change to design/gate.ts or engine.ts.
 */
export interface VisualVerifier {
  readonly name: string;
  verify(request: VisualVerifyRequest): Promise<VisualCheckResult>;
}

/**
 * Honest placeholder, not a real visual-diff tool. docs/roadmap.md and README.md are explicit
 * that Trackwright has no pixel-level screenshot comparison yet — this verifier does NOT pretend
 * otherwise. It only checks that a result artifact was actually produced (a file exists at the
 * claimed path) and always returns DESIGN_CONCERNS, never DESIGN_PASS: presence of a screenshot
 * is not evidence it matches the design, so this adapter refuses to claim more confidence than it
 * has. A real VisualVerifier (wired to an actual comparison tool) is the only thing that should
 * ever return DESIGN_PASS.
 */
export class LocalPlaceholderVisualVerifier implements VisualVerifier {
  readonly name = 'local-placeholder';

  async verify(request: VisualVerifyRequest): Promise<VisualCheckResult> {
    const now = new Date().toISOString();

    if (!request.resultArtifactPath || !existsSync(request.resultArtifactPath)) {
      return {
        checkedAt: now,
        outcome: 'DESIGN_CONCERNS',
        summary:
          'no result artifact (screenshot/render) was found — no visual comparison could be attempted; a human must review this manually',
        reportPath: null,
      };
    }

    return {
      checkedAt: now,
      outcome: 'DESIGN_CONCERNS',
      summary:
        `a result artifact exists at ${request.resultArtifactPath}, but Trackwright has no real pixel-level ` +
        'visual-diff tool configured (see docs/roadmap.md) — presence of a screenshot is not evidence it ' +
        'matches the design; a human must review it manually before this can be trusted',
      reportPath: request.resultArtifactPath,
    };
  }
}
