import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { projectConfigSchema, type ProjectConfig } from './schema.js';
import { defaultConfig } from './defaults.js';

export const CONFIG_DIR = '.trackwright';
export const CONFIG_FILE = 'config.yaml';

export class ConfigNotFoundError extends Error {
  constructor(readonly projectRoot: string) {
    super(`no ${CONFIG_DIR}/${CONFIG_FILE} found under ${projectRoot} — run \`trackwright init\` first`);
    this.name = 'ConfigNotFoundError';
  }
}

export function configPath(projectRoot: string): string {
  return path.join(projectRoot, CONFIG_DIR, CONFIG_FILE);
}

export async function loadConfig(projectRoot: string): Promise<ProjectConfig> {
  const filePath = configPath(projectRoot);
  if (!existsSync(filePath)) {
    throw new ConfigNotFoundError(projectRoot);
  }
  const raw = await readFile(filePath, 'utf8');
  const parsed = yaml.load(raw);
  return projectConfigSchema.parse(parsed);
}

export async function initConfig(projectRoot: string, ticketPrefix: string): Promise<ProjectConfig> {
  const config = defaultConfig(ticketPrefix);
  const dir = path.join(projectRoot, CONFIG_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = configPath(projectRoot);
  if (existsSync(filePath)) {
    // init is idempotent by design — re-running it should not clobber an already-customized
    // config. Callers that want a fresh config should remove the file themselves first.
    return loadConfig(projectRoot);
  }
  await writeFile(filePath, yaml.dump(config, { noRefs: true }), 'utf8');
  return config;
}

export function isInitialized(projectRoot: string): boolean {
  return existsSync(configPath(projectRoot));
}
