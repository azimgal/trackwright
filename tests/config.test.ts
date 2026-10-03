import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initConfig, isInitialized, loadConfig, ConfigNotFoundError, configPath } from '../src/config/loader.js';
import { runInit } from '../src/cli/commands/init.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'trackwright-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('config init/load', () => {
  it('is not initialized in a fresh directory', () => {
    expect(isInitialized(dir)).toBe(false);
  });

  it('throws ConfigNotFoundError when loading before init', async () => {
    await expect(loadConfig(dir)).rejects.toThrow(ConfigNotFoundError);
  });

  it('creates a config with the given prefix on init', async () => {
    const config = await initConfig(dir, 'TW');
    expect(config.ticketPrefix).toBe('TW');
    expect(isInitialized(dir)).toBe(true);
  });

  it('init is idempotent and does not clobber a customized config', async () => {
    await initConfig(dir, 'TW');
    const loaded = await loadConfig(dir);
    const customized = { ...loaded, retryCeiling: 7 };
    const yaml = await import('js-yaml');
    await writeFile(configPath(dir), yaml.default.dump(customized), 'utf8');

    await initConfig(dir, 'TW'); // re-running init should not reset retryCeiling
    const after = await loadConfig(dir);
    expect(after.retryCeiling).toBe(7);
  });
});

describe('runInit (CLI command)', () => {
  it('reports success message on first run', async () => {
    const message = await runInit(dir, { prefix: 'TW' });
    expect(message).toContain('Initialized');
    expect(message).toContain('TW');
  });

  it('reports already-initialized on second run', async () => {
    await runInit(dir, { prefix: 'TW' });
    const message = await runInit(dir, { prefix: 'TW' });
    expect(message).toContain('Already initialized');
  });

  /**
   * Found during the release-readiness audit's clean-install test: a brand-new project had
   * `.trackwright/evidence/*.jsonl` show up as untracked noise in `git status` forever, since
   * `init` never touched the target project's own `.gitignore` — risking evidence (cost data, raw
   * agent response excerpts) being swept into a commit by a future `git add -A`.
   */
  it('appends .trackwright/evidence/ and .trackwright/.worktrees/ to a project with no .gitignore yet', async () => {
    await runInit(dir, { prefix: 'TW' });
    const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.trackwright/evidence/');
    // .worktrees/: workflow/batch.ts's temporary git worktrees, always removed on success but
    // could be left behind by a crash mid-batch — equally not meant to ever be committed.
    expect(gitignore).toContain('.trackwright/.worktrees/');
  });

  it('appends to an existing .gitignore without disturbing its content', async () => {
    await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
    await runInit(dir, { prefix: 'TW' });
    const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('.trackwright/evidence/');
  });

  it('is idempotent — does not duplicate the entry on repeated init', async () => {
    await runInit(dir, { prefix: 'TW' });
    await runInit(dir, { prefix: 'TW' });
    const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8');
    const occurrences = gitignore.split('\n').filter((line) => line.trim() === '.trackwright/evidence/').length;
    expect(occurrences).toBe(1);
  });
});

describe('checksBySpecialization', () => {
  async function writeConfig(extra: string) {
    await initConfig(dir, 'TW');
    const base = await readFile(configPath(dir), 'utf8');
    await writeFile(configPath(dir), `${base.replace(/^checksBySpecialization:.*$/m, '')}\n${extra}\n`, 'utf8');
  }

  it('defaults to an empty map so a single-stack project needs no change', async () => {
    const config = await initConfig(dir, 'TW');
    expect(config.checksBySpecialization).toEqual({});
  });

  it('accepts a partial per-specialization override (e.g. mobile.test only)', async () => {
    await writeConfig('checksBySpecialization:\n  mobile:\n    test:\n      - "flutter test"');
    const config = await loadConfig(dir);
    expect(config.checksBySpecialization.mobile?.test).toEqual(['flutter test']);
    expect(config.checksBySpecialization.mobile?.premerge).toBeUndefined();
  });

  it('rejects an unknown specialization key instead of silently ignoring a typo', async () => {
    await writeConfig('checksBySpecialization:\n  mobil:\n    test:\n      - "flutter test"');
    await expect(loadConfig(dir)).rejects.toThrow();
  });
});
