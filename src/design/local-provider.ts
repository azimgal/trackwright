import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DesignArtifact } from './types.js';
import { DesignNotFoundError, type DesignCreateRequest, type DesignProvider } from './provider.js';

/**
 * MVP DesignProvider: stores each design artifact as a JSON record plus a companion markdown
 * reference file a human is expected to fill in (or replace with a link to wherever the real
 * design lives). This is deliberately the only provider Trackwright ships today — the design-poc
 * PTY-orchestrator mechanism this module was informed by (see docs/architecture.md) is not
 * available as a library dependency here, so rather than fake an integration that doesn't exist,
 * this provider is real, local, and honest about what it is: a placeholder a human fills in, not
 * an automated design generator. A future ClaudeDesignProvider would implement the same
 * DesignProvider interface without touching engine.ts or design/gate.ts.
 */
export class LocalDesignArtifactProvider implements DesignProvider {
  readonly name = 'local';

  constructor(private readonly designDir: string) {}

  private jsonPath(designId: string): string {
    return path.join(this.designDir, `${designId}.json`);
  }

  private referencePath(designId: string): string {
    return path.join(this.designDir, `${designId}.md`);
  }

  async createOrUpdateDesign(request: DesignCreateRequest): Promise<DesignArtifact> {
    await mkdir(this.designDir, { recursive: true });
    const previous = await this.getLatestForTicket(request.ticketId);
    const now = new Date().toISOString();
    const designId = randomUUID();

    const artifact: DesignArtifact = {
      designId,
      ticketId: request.ticketId,
      source: this.name,
      version: (previous?.version ?? 0) + 1,
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      artifactPath: this.referencePath(designId),
      artifactUrl: null,
      referenceSha: null,
      requirementsHash: request.requirementsHash,
      constraints: request.constraints,
      visualChecks: [],
    };

    await writeFile(this.jsonPath(designId), JSON.stringify(artifact, null, 2), 'utf8');
    await writeFile(
      this.referencePath(designId),
      `# Design reference for ${request.ticketId} (v${artifact.version})\n\n` +
        `## Brief (neutral — no layout/colour prescriptions)\n\n${request.brief}\n\n` +
        `## Constraints\n\n${request.constraints.map((c) => `- ${c}`).join('\n') || '(none declared)'}\n\n` +
        `## Reference\n\n_Fill in or link the real design artifact here (screenshot, Figma link, etc), ` +
        `then approve with \`trackwright design approve ${designId}\`._\n`,
      'utf8',
    );

    return artifact;
  }

  async getDesign(designId: string): Promise<DesignArtifact | null> {
    const file = this.jsonPath(designId);
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as DesignArtifact;
  }

  async getLatestForTicket(ticketId: string): Promise<DesignArtifact | null> {
    if (!existsSync(this.designDir)) return null;
    const entries = await readdir(this.designDir);
    let latest: DesignArtifact | null = null;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const raw = await readFile(path.join(this.designDir, entry), 'utf8');
      const artifact = JSON.parse(raw) as DesignArtifact;
      if (artifact.ticketId !== ticketId) continue;
      if (!latest || artifact.version > latest.version) latest = artifact;
    }
    return latest;
  }

  async approve(designId: string): Promise<DesignArtifact> {
    const artifact = await this.getDesign(designId);
    if (!artifact) throw new DesignNotFoundError(designId);
    const updated: DesignArtifact = { ...artifact, status: 'approved', updatedAt: new Date().toISOString() };
    await writeFile(this.jsonPath(designId), JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  }

  /** Record a fresh visual-check result against the artifact, keeping prior checks in history. */
  async recordVisualCheck(designId: string, check: DesignArtifact['visualChecks'][number]): Promise<DesignArtifact> {
    const artifact = await this.getDesign(designId);
    if (!artifact) throw new DesignNotFoundError(designId);
    const updated: DesignArtifact = {
      ...artifact,
      visualChecks: [...artifact.visualChecks, check],
      updatedAt: new Date().toISOString(),
    };
    await writeFile(this.jsonPath(designId), JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  }

  /** Mark stale — used by staleness.ts when it detects drift. */
  async markStale(designId: string): Promise<DesignArtifact> {
    const artifact = await this.getDesign(designId);
    if (!artifact) throw new DesignNotFoundError(designId);
    const updated: DesignArtifact = { ...artifact, status: 'stale', updatedAt: new Date().toISOString() };
    await writeFile(this.jsonPath(designId), JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  }

  async setReferenceSha(designId: string, sha: string): Promise<DesignArtifact> {
    const artifact = await this.getDesign(designId);
    if (!artifact) throw new DesignNotFoundError(designId);
    const updated: DesignArtifact = { ...artifact, referenceSha: sha, updatedAt: new Date().toISOString() };
    await writeFile(this.jsonPath(designId), JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  }
}
