import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInit } from '../src/cli/commands/init.js';
import { runTicketCreate } from '../src/cli/commands/ticket-create.js';
import { runTicketRun } from '../src/cli/commands/run.js';
import { runTicketShow } from '../src/cli/commands/ticket-list.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'example-repo');

let projectRoot: string;

beforeAll(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'trackwright-dogfood-'));
  await cp(FIXTURE, projectRoot, { recursive: true });
  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectRoot });
  // -b dev: Trackwright's git safety refuses to start work directly on a protected branch
  // (main/master, see git/safety.ts) — same as it would on a real project, where development
  // happens off a non-protected default branch, not directly on master.
  await git(['init', '-q', '-b', 'dev']);
  await git(['config', 'user.email', 'dogfood@example.com']);
  await git(['config', 'user.name', 'Dogfood']);
  await git(['add', '-A']);
  await git(['commit', '-m', 'initial fixture', '-q']);
});

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

/**
 * End-to-end proof (see docs/roadmap.md, "MVP"): a ticket moves through several stages, driven
 * by several independently-invoked (mocked, via --dry-run) agents, through the actual CLI
 * command functions — not just internal library calls. Real Claude invocation is exercised
 * separately (see the "real Claude smoke test" section of the final report) since it costs real
 * API usage and should not run on every `npm test`.
 */
describe('dogfood: init -> ticket create -> run', () => {
  it('initializes the project', async () => {
    const message = await runInit(projectRoot, { prefix: 'EX' });
    expect(message).toContain('Initialized');
  });

  it('creates a ticket', async () => {
    const message = await runTicketCreate(projectRoot, {
      title: 'Add a hello endpoint',
      context: 'The fixture app needs a trivial hello endpoint for this dogfood run.',
      discipline: 'development',
      specialization: 'backend',
    });
    expect(message).toContain('Created EX-0001');
  });

  it('drives the ticket through several stages automatically, without a human re-invoking each step', async () => {
    const result = await runTicketRun(projectRoot, 'EX-0001', { dryRun: true, maxSteps: 15 });

    // The mock runner defaults every unconfigured agent call to SUCCESS, and this fixture's
    // package.json scripts always exit 0, so an unconfigured dry run should sail all the way to
    // Done — proving the full ten-stage pipeline executes without a human touching it between
    // stages.
    expect(result.steps.length).toBeGreaterThan(1);
    expect(result.ticket.frontmatter.stage).toBe('done');
    expect(result.stopReason).toBe('done');
  });

  it('ticket show reflects the final state', async () => {
    const output = await runTicketShow(projectRoot, 'EX-0001');
    expect(output).toContain('EX-0001');
    expect(output).toContain('stage=done');
  });
});
