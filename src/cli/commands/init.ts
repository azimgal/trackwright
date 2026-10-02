import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initConfig, isInitialized } from '../../config/loader.js';
import { GitRepo } from '../../git/repo.js';

export interface InitOptions {
  prefix: string;
}

export async function runInit(projectRoot: string, options: InitOptions): Promise<string> {
  const alreadyInitialized = isInitialized(projectRoot);
  const config = await initConfig(projectRoot, options.prefix);
  const gitignoreChanged = await ensureEvidenceGitignored(projectRoot);
  const pathsToCommit = ['.trackwright/config.yaml', ...(gitignoreChanged ? ['.gitignore'] : [])];
  if (!alreadyInitialized || gitignoreChanged) {
    await commitBookkeeping(projectRoot, pathsToCommit, 'chore(trackwright): initialize config');
  }
  return alreadyInitialized
    ? `Already initialized (.trackwright/config.yaml exists) — left it untouched. Ticket prefix: ${config.ticketPrefix}`
    : `Initialized .trackwright/config.yaml with ticket prefix "${config.ticketPrefix}".`;
}

/**
 * Found during the release-readiness audit's clean-install test: `init` never touched the target
 * project's own `.gitignore`, so `.trackwright/evidence/*.jsonl` showed up as untracked noise in
 * `git status` forever on a brand-new project — and risked being swept into a commit by a future
 * `git add -A`, the exact thing evidence (cost data, raw agent response excerpts) should never be.
 * This repo's own `.gitignore` already excludes its own `/.trackwright/evidence/`; new projects
 * should get the same exclusion automatically, not only if a human remembers to add it by hand.
 * Idempotent (checks for an exact existing line before appending) and best-effort — a write
 * failure here never blocks `init` itself.
 */
async function ensureEvidenceGitignored(projectRoot: string): Promise<boolean> {
  const entry = '.trackwright/evidence/';
  const gitignorePath = path.join(projectRoot, '.gitignore');
  try {
    const existing = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf8') : '';
    if (existing.split(/\r?\n/).some((line) => line.trim() === entry)) return false;
    const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    await writeFile(gitignorePath, `${existing}${separator}${entry}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort: commits only Trackwright's own bookkeeping files (never `addAll`, which would
 * sweep up unrelated in-progress project changes). Found necessary via real dogfooding — config
 * and ticket files were otherwise only ever written to the working tree, never committed, so a
 * routine `git stash` or branch switch silently made them disappear. Never lets a git failure
 * (not a repo, nothing changed, etc.) block the primary init/create operation.
 */
export async function commitBookkeeping(projectRoot: string, relativePaths: string[], message: string): Promise<void> {
  const repo = new GitRepo(projectRoot);
  try {
    if (!(await repo.isGitRepository())) return;
    if (!(await repo.hasChangesIn(relativePaths))) return;
    await repo.addPaths(relativePaths);
    await repo.commit(message);
  } catch {
    // best-effort bookkeeping only — never block init/ticket-create on a git failure here
  }
}
