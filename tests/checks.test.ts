import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runChecks } from '../src/policies/checks.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'trackwright-checks-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runChecks', () => {
  it('passes when every command exits 0', async () => {
    const summary = await runChecks(['node -e "process.exit(0)"', 'node -e "process.exit(0)"'], dir);
    expect(summary.passed).toBe(true);
    expect(summary.results).toHaveLength(2);
  });

  it('stops at the first failing command', async () => {
    const summary = await runChecks(
      ['node -e "process.exit(0)"', 'node -e "process.exit(1)"', 'node -e "process.exit(0)"'],
      dir,
    );
    expect(summary.passed).toBe(false);
    expect(summary.results).toHaveLength(2); // never runs the third command
    expect(summary.results[1]!.exitCode).toBe(1);
  });

  it('captures output tail for a failing command', async () => {
    const summary = await runChecks(['node -e "console.error(\'boom\'); process.exit(1)"'], dir);
    expect(summary.passed).toBe(false);
    expect(summary.results[0]!.outputTail).toContain('boom');
  });
});
