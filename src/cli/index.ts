#!/usr/bin/env node
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runTicketCreate } from './commands/ticket-create.js';
import { runTicketList, runTicketShow } from './commands/ticket-list.js';
import { runTicketRun } from './commands/run.js';
import { runTicketWaive } from './commands/waive.js';
import { runDesignApprove, runDesignList, runDesignShow } from './commands/design.js';

const program = new Command();

program
  .name('trackwright')
  .description('A Claude-first orchestration wrapper for ticket-driven development.')
  .version('0.1.0');

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
