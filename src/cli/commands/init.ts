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
  const gitignoreChanged = await ensureGitignoreEntries(projectRoot);
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
 * `.trackwright/.worktrees/` (workflow/batch.ts's temporary git worktrees — always removed on
 * success, but a crash mid-batch could leave one behind) belongs in the same category: transient
 * Trackwright-internal state, never meant to be committed. This repo's own `.gitignore` already
 * excludes both of its own equivalents by hand; new projects should get the same exclusions
 * automatically. Idempotent (checks for an exact existing line before appending each) and
 * best-effort — a write failure here never blocks `init` itself.
 */
async function ensureGitignoreEntries(projectRoot: string): Promise<boolean> {
  const entries = ['.trackwright/evidence/', '.trackwright/.worktrees/'];
  const gitignorePath = path.join(projectRoot, '.gitignore');
  try {
    let content = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf8') : '';
    const existingLines = new Set(content.split(/\r?\n/).map((l) => l.trim()));
    let changed = false;
    for (const entry of entries) {
      if (existingLines.has(entry)) continue;
      const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
      content = `${content}${separator}${entry}\n`;
      changed = true;
    }
    if (changed) await writeFile(gitignorePath, content, 'utf8');
    return changed;
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
