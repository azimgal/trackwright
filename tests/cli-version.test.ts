import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression coverage for a real gap found during the release-readiness audit: `--version`
 * previously reported a hardcoded string literal in src/cli/index.ts, completely disconnected
 * from package.json's actual `version` field — it had already drifted (still printing "0.1.0"
 * after package.json was bumped to "0.2.0") before anyone noticed. Rather than asserting the
 * computed value (which would need a built dist/cli/index.js to spawn), this checks the source
 * itself never regresses back to a hardcoded literal: `.version(` must be called with an
 * identifier/expression, not a quoted string.
 */
describe('CLI --version stays wired to package.json', () => {
  it('src/cli/index.ts does not hardcode a version string literal', () => {
    const source = readFileSync(path.join(__dirname, '..', 'src', 'cli', 'index.ts'), 'utf8');
    expect(source).not.toMatch(/\.version\(\s*['"]/);
    expect(source).toMatch(/\.version\(\s*packageJson\.version\s*\)/);
  });

  it('package.json has a real semver-shaped version', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
