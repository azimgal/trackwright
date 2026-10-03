#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runTicketCreate } from './commands/ticket-create.js';
import { runTicketList, runTicketShow } from './commands/ticket-list.js';
import { runTicketRun } from './commands/run.js';
import { runTicketWaive } from './commands/waive.js';
import { runTicketRetry } from './commands/ticket-retry.js';
import { runDesignApprove, runDesignList, runDesignShow } from './commands/design.js';
import { runTicketBatch, DependencyCycleError } from './commands/batch.js';

// Read the real version from package.json rather than a second, hand-maintained literal —
// found during the release-readiness audit: `--version` previously reported a hardcoded string
// that had already drifted from package.json's actual version on the very next bump. The
// relative path (two levels up from this file) resolves the same way whether this runs as
// compiled dist/cli/index.js or, via tsx, directly from src/cli/index.ts — both sit at
// <package root>/<src|dist>/cli/index.{ts,js}.
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const program = new Command();

program
  .name('trackwright')
  .description('A Claude-first orchestration wrapper for ticket-driven development.')
  .version(packageJson.version);

program
  .command('init')
  .description('Initialize Trackwright in the current (or given) project directory.')
  .option('-p, --prefix <prefix>', 'ticket id prefix, e.g. TW', 'TW')
  .option('-C, --cwd <dir>', 'project root', process.cwd())
  .action(async (opts) => {
    try {
      console.log(await runInit(opts.cwd, { prefix: opts.prefix }));
    } catch (err) {
      fail(err);
    }
  });

const ticket = program.command('ticket').description('Manage tickets.');

ticket
  .command('create')
  .description('Create a new ticket.')
  .requiredOption('-t, --title <title>', 'ticket title')
  .requiredOption('-c, --context <context>', 'Context section content')
  .requiredOption('-d, --discipline <discipline>', 'design | development | infrastructure')
  .option('-s, --specialization <specialization>', 'frontend | backend | mobile (development only)')
  .option('-f, --flow <flow>', 'quick | standard | full', 'standard')
  .option('--secondary <items>', 'comma-separated extra disciplines/specializations this ticket also needs, e.g. "backend" or "design,backend" (multi-discipline fan-out)')
  .option('--depends-on <ids>', 'comma-separated ticket ids this one depends on, e.g. "TW-0001,TW-0002"')
  .option('--scope <paths>', 'comma-separated declared path prefixes this ticket touches, e.g. "src/routes/,docs/" — advisory, used by `trackwright batch` to decide safe concurrency')
  .option('-C, --cwd <dir>', 'project root', process.cwd())
  .action(async (opts) => {
    try {
      console.log(await runTicketCreate(opts.cwd, opts));
    } catch (err) {
      fail(err);
    }
  });

ticket
  .command('list')
  .description('List all tickets.')
  .option('-C, --cwd <dir>', 'project root', process.cwd())
  .action(async (opts) => {
    try {
      console.log(await runTicketList(opts.cwd));
    } catch (err) {
      fail(err);
    }
  });

ticket
  .command('show <id>')
  .description('Show a single ticket in full.')
  .option('-C, --cwd <dir>', 'project root', process.cwd())
  .action(async (id, opts) => {
    try {
      console.log(await runTicketShow(opts.cwd, id));
    } catch (err) {
      fail(err);
    }
  });

ticket
  .command('waive <id>')
  .description('Human-only: record a WAIVED decision for a ticket stuck in verification CONCERNS.')
  .requiredOption('-r, --reason <reason>', 'why this concern is being waived')
  .option('-C, --cwd <dir>', 'project root', process.cwd())
  .action(async (id, opts) => {
    try {
      console.log(await runTicketWaive(opts.cwd, id, opts.reason));
    } catch (err) {
      fail(err);
    }
  });

ticket
  .command('retry <id>')
  .description('Human-only: reset a retry ceiling exceeded by transient failures (e.g. a session limit), so `run` can resume the ticket\'s current stage.')
  .requiredOption('-r, --reason <reason>', 'why it is safe to retry now (e.g. the underlying rate limit has reset)')
  .option('-C, --cwd <dir>', 'project root', process.cwd())
  .action(async (id, opts) => {
    try {
      console.log(await runTicketRetry(opts.cwd, id, opts.reason));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('run <ticketId>')
  .description('Drive a ticket through the workflow, stage by stage, until it reaches Done or needs a human.')
  .option('--dry-run', 'use a mock Claude runner instead of invoking the real CLI')
  .option('--max-steps <n>', 'maximum number of stage transitions before stopping', (v) => parseInt(v, 10), 20)
  .option('--skip-branch', 'do not create/checkout a dedicated work branch')
  .option('-C, --cwd <dir>', 'project root', process.cwd())
  .action(async (ticketId, opts) => {
    try {
      const result = await runTicketRun(opts.cwd, ticketId, {
        dryRun: opts.dryRun,
        maxSteps: opts.maxSteps,
        skipBranch: opts.skipBranch,
        // Printed live as each stage finishes, not buffered to the end — a real run can take
        // minutes (real Claude invocations), and --dry-run runs so fast this makes no visible
        // difference either way.
        onStep: (step) => {
          console.log(`${step.fromStage} -> ${step.toStage}  [${step.outcome}]  ${step.summary}`);
        },
      });
      console.log(`\nStopped: ${result.stopReason}. Ticket ${result.ticket.frontmatter.id} is now at stage "${result.ticket.frontmatter.stage}".`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('batch <ticketIds...>')
  .description(
    'Run several tickets in one invocation, respecting dependencies between them (topological waves). ' +
      'Tickets in the same wave with declared, non-overlapping --scope run concurrently in isolated git ' +
      'worktrees, up to config.maxParallel; everything else runs serially. See docs/architecture.md.',
  )
  .option('--dry-run', 'use a mock Claude runner instead of invoking the real CLI')
  .option('--max-steps <n>', 'maximum stage transitions per ticket before stopping', (v) => parseInt(v, 10), 20)
  .option('--max-parallel <n>', 'override config.maxParallel for this run', (v) => parseInt(v, 10))
  .option('-C, --cwd <dir>', 'project root', process.cwd())
  .action(async (ticketIds, opts) => {
    try {
      const result = await runTicketBatch(opts.cwd, ticketIds, {
        dryRun: opts.dryRun,
        maxSteps: opts.maxSteps,
        maxParallel: opts.maxParallel,
        onWaveStart: (waveIndex, ids) => {
          console.log(`\n=== wave ${waveIndex}: ${ids.join(', ')} ===`);
        },
        onTicketDone: (r) => {
          const mode = r.ranConcurrently ? 'worktree' : 'serial';
          const outcome = r.outcome === 'completed' ? r.result?.stopReason ?? 'completed' : `error: ${r.error}`;
          console.log(`  ${r.ticketId} [${mode}] -> ${outcome}`);
        },
      });
      if (result.conflicts.length > 0) {
        console.log('\nCONFLICTS DETECTED (not merged, not resolved — review before merging either branch):');
        for (const c of result.conflicts) {
          console.log(`  ${c.ticketIds.join(' & ')} both touch: ${c.files.join(', ')}`);
        }
      }
      console.log(`\nWaves: ${result.waves.map((w) => `[${w.join(', ')}]`).join(' -> ')}`);
    } catch (err) {
      if (err instanceof DependencyCycleError) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
      } else {
        fail(err);
      }
    }
  });

const design = program.command('design').description('Manage design artifacts (Design Sync).');

design
  .command('approve <designId>')
  .description('Human-only: approve a design artifact, syncing the ticket it belongs to.')
  .option('-C, --cwd <dir>', 'project root', process.cwd())
  .action(async (designId, opts) => {
    try {
      console.log(await runDesignApprove(opts.cwd, designId));
    } catch (err) {
      fail(err);
    }
  });

design
  .command('show <designId>')
  .description('Show a design artifact in full.')
  .option('-C, --cwd <dir>', 'project root', process.cwd())
  .action(async (designId, opts) => {
    try {
      console.log(await runDesignShow(opts.cwd, designId));
    } catch (err) {
      fail(err);
    }
  });

design
  .command('list <ticketId>')
  .description('Show the latest design artifact for a ticket.')
  .option('-C, --cwd <dir>', 'project root', process.cwd())
  .action(async (ticketId, opts) => {
    try {
      console.log(await runDesignList(opts.cwd, ticketId));
    } catch (err) {
      fail(err);
    }
  });

function fail(err: unknown): void {
  console.error(`Error: ${(err as Error).message}`);
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch(() => {
  process.exitCode = process.exitCode ?? 1;
});
