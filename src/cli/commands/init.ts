import { initConfig, isInitialized } from '../../config/loader.js';
import { GitRepo } from '../../git/repo.js';

export interface InitOptions {
  prefix: string;
}

export async function runInit(projectRoot: string, options: InitOptions): Promise<string> {
  const alreadyInitialized = isInitialized(projectRoot);
  const config = await initConfig(projectRoot, options.prefix);
  if (!alreadyInitialized) {
    await commitBookkeeping(projectRoot, ['.trackwright/config.yaml'], 'chore(trackwright): initialize config');
  }
  return alreadyInitialized
    ? `Already initialized (.trackwright/config.yaml exists) — left it untouched. Ticket prefix: ${config.ticketPrefix}`
    : `Initialized .trackwright/config.yaml with ticket prefix "${config.ticketPrefix}".`;
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
