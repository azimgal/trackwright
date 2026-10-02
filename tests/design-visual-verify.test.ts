import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPlaceholderVisualVerifier } from '../src/design/visual-verify.js';
import type { DesignArtifact } from '../src/design/types.js';

function artifact(): DesignArtifact {
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
    referenceSha: null,
    requirementsHash: null,
    constraints: [],
    visualChecks: [],
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'trackwright-visual-verify-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Dedicated unit coverage for design/visual-verify.ts — found during the final
 * release-hardening pass to have zero direct test coverage. The property under test matters more
 * than usual here: this verifier must NEVER return DESIGN_PASS, because it has no real pixel-level
 * comparison capability — claiming otherwise would be exactly the kind of overclaim the project's
 * own docs explicitly warn against (README "Known limitations", docs/roadmap.md).
 */
describe('LocalPlaceholderVisualVerifier', () => {
  it('returns DESIGN_CONCERNS (never DESIGN_PASS) when no result artifact path is given', async () => {
    const verifier = new LocalPlaceholderVisualVerifier();
    const result = await verifier.verify({ designArtifact: artifact(), resultArtifactPath: null });
    expect(result.outcome).toBe('DESIGN_CONCERNS');
    expect(result.reportPath).toBeNull();
  });

  it('returns DESIGN_CONCERNS when the claimed result artifact path does not actually exist', async () => {
    const verifier = new LocalPlaceholderVisualVerifier();
    const result = await verifier.verify({
      designArtifact: artifact(),
      resultArtifactPath: path.join(dir, 'does-not-exist.png'),
    });
    expect(result.outcome).toBe('DESIGN_CONCERNS');
  });

  it('returns DESIGN_CONCERNS even when a real result artifact exists — presence is not proof of a match', async () => {
    const screenshotPath = path.join(dir, 'result.png');
    await writeFile(screenshotPath, 'fake png bytes', 'utf8');

    const verifier = new LocalPlaceholderVisualVerifier();
    const result = await verifier.verify({ designArtifact: artifact(), resultArtifactPath: screenshotPath });

    expect(result.outcome).toBe('DESIGN_CONCERNS');
    expect(result.reportPath).toBe(screenshotPath);
    expect(result.summary).toContain('no real pixel-level');
  });

  it('never returns DESIGN_PASS or DESIGN_FAIL under any input — it has no basis to claim either', async () => {
    const verifier = new LocalPlaceholderVisualVerifier();
    const withArtifact = await verifier.verify({
      designArtifact: artifact(),
      resultArtifactPath: path.join(dir, 'x.png'),
    });
    const withoutArtifact = await verifier.verify({ designArtifact: artifact(), resultArtifactPath: null });
    for (const result of [withArtifact, withoutArtifact]) {
      expect(result.outcome).not.toBe('DESIGN_PASS');
      expect(result.outcome).not.toBe('DESIGN_FAIL');
    }
  });

  it('exposes its name as "local-placeholder", never implying a real tool', () => {
    expect(new LocalPlaceholderVisualVerifier().name).toBe('local-placeholder');
  });
});
