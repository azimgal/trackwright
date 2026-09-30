import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Stage } from '../workflow/stages.js';
import type { EvidenceRecord } from './types.js';

/**
 * Append-only, per-ticket JSONL evidence log under `<evidenceDir>/<ticketId>.jsonl`. Append-only
 * on purpose: the audit trail is the log itself, not a mutable "latest state" row — this mirrors
 * the reference architecture's "git history is the audit trail" principle, just applied to a
 * dedicated evidence file instead of relying on ticket-file git history alone.
 */
export class EvidenceStore {
  constructor(private readonly evidenceDir: string) {}

  private filePathFor(ticketId: string): string {
    return path.join(this.evidenceDir, `${ticketId}.jsonl`);
  }

  newRunId(): string {
    return randomUUID();
  }

  async record(record: EvidenceRecord): Promise<void> {
    await mkdir(this.evidenceDir, { recursive: true });
    await appendFile(this.filePathFor(record.ticketId), JSON.stringify(record) + '\n', 'utf8');
  }

  async history(ticketId: string): Promise<EvidenceRecord[]> {
    const filePath = this.filePathFor(ticketId);
    if (!existsSync(filePath)) return [];
    const raw = await readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EvidenceRecord);
  }

  async historyForStage(ticketId: string, stage: Stage): Promise<EvidenceRecord[]> {
    const all = await this.history(ticketId);
    return all.filter((r) => r.stage === stage);
  }

  /**
   * Count of non-SUCCESS attempts recorded for (ticketId, stage) — the input to the retry
   * ceiling (see policies/retry.ts). Counting from durable evidence rather than an in-memory
   * counter means the ceiling survives a process restart, which matters for the crash-recovery
   * story described in docs/architecture.md.
   */
  async attemptCount(ticketId: string, stage: Stage): Promise<number> {
    const records = await this.historyForStage(ticketId, stage);
    return records.filter((r) => r.outcome !== 'SUCCESS').length;
  }

  /** Most recent record for (ticketId, stage), or null if the stage has never run. */
  async latestForStage(ticketId: string, stage: Stage): Promise<EvidenceRecord | null> {
    const records = await this.historyForStage(ticketId, stage);
    return records.length > 0 ? records[records.length - 1]! : null;
  }

  /**
   * Staleness check: has the working tree moved past the SHA a given stage's most recent SUCCESS
   * was recorded against? Returns true if there is no successful record yet (nothing to be stale
   * relative to) is treated as "not stale" — staleness only applies once something has actually
   * been recorded and the code has since moved on.
   */
  async isStale(ticketId: string, stage: Stage, currentSha: string): Promise<boolean> {
    const records = await this.historyForStage(ticketId, stage);
    const lastSuccess = [...records].reverse().find((r) => r.outcome === 'SUCCESS');
    if (!lastSuccess || !lastSuccess.gitSha) return false;
    return lastSuccess.gitSha !== currentSha;
  }
}
