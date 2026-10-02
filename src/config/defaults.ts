import type { ProjectConfig } from './schema.js';

export function defaultConfig(ticketPrefix: string): ProjectConfig {
  return {
    ticketPrefix,
    ticketsDir: '.trackwright/tickets',
    evidenceDir: '.trackwright/evidence',
    checks: {
      fast: ['npm run lint --if-present', 'npm run typecheck --if-present'],
      test: ['npm test --if-present'],
      premerge: ['npm run build --if-present'],
    },
    retryCeiling: 3,
    claude: {
      binary: 'claude',
      defaultTimeoutMs: 600_000,
    },
    maxParallel: 1,
    autoMerge: false,
    targetBranch: null,
  };
}
