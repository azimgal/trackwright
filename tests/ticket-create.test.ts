import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initConfig } from '../src/config/loader.js';
import { runTicketCreate, InvalidTicketCreateOptionsError } from '../src/cli/commands/ticket-create.js';
import { TicketStore } from '../src/tickets/store.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'trackwright-ticket-create-'));
  await initConfig(projectRoot, 'TW');
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe('runTicketCreate validation', () => {
  it('rejects an invalid discipline', async () => {
    await expect(
      runTicketCreate(projectRoot, { title: 'x', context: 'c', discipline: 'bogus' }),
    ).rejects.toThrow(InvalidTicketCreateOptionsError);
  });

  it('rejects an invalid specialization value', async () => {
    await expect(
      runTicketCreate(projectRoot, { title: 'x', context: 'c', discipline: 'development', specialization: 'bogus' }),
    ).rejects.toThrow(InvalidTicketCreateOptionsError);
  });

  /**
   * Found during the release-readiness audit: --specialization is documented (CLI --help) as
   * "development only," but was previously accepted for any discipline and silently dropped by
   * the routing table's discipline-only fallback (policies/routing.ts) — no crash, but a ticket
   * file left with a specialization field that looked meaningful and never was.
   */
  it('rejects a valid specialization paired with a non-development discipline', async () => {
    await expect(
      runTicketCreate(projectRoot, { title: 'x', context: 'c', discipline: 'infrastructure', specialization: 'backend' }),
    ).rejects.toThrow(/only applies to --discipline development/);
  });

  it('rejects an invalid flow', async () => {
    await expect(
      runTicketCreate(projectRoot, { title: 'x', context: 'c', discipline: 'development', flow: 'bogus' }),
    ).rejects.toThrow(InvalidTicketCreateOptionsError);
  });

  it('accepts a development ticket with a valid specialization', async () => {
    const message = await runTicketCreate(projectRoot, {
      title: 'Add thing',
      context: 'c',
      discipline: 'development',
      specialization: 'backend',
    });
    expect(message).toContain('Created TW-0001');

    const store = new TicketStore(path.join(projectRoot, '.trackwright', 'tickets'));
    const ticket = await store.getOrThrow('TW-0001');
    expect(ticket.frontmatter.specialization).toBe('backend');
  });

  it('accepts an infrastructure ticket with no specialization at all', async () => {
    const message = await runTicketCreate(projectRoot, {
      title: 'Provision thing',
      context: 'c',
      discipline: 'infrastructure',
    });
    expect(message).toContain('Created TW-0001');
  });

  it('accepts --depends-on referencing an already-existing ticket', async () => {
    await runTicketCreate(projectRoot, { title: 'A', context: 'c', discipline: 'development' });
    const message = await runTicketCreate(projectRoot, {
      title: 'B depends on A',
      context: 'c',
      discipline: 'development',
      dependsOn: 'TW-0001',
    });
    expect(message).toContain('Created TW-0002');

    const store = new TicketStore(path.join(projectRoot, '.trackwright', 'tickets'));
    const b = await store.getOrThrow('TW-0002');
    expect(b.frontmatter.dependencies).toEqual(['TW-0001']);
  });

  it('rejects --depends-on referencing a ticket id that does not exist', async () => {
    await expect(
      runTicketCreate(projectRoot, {
        title: 'B',
        context: 'c',
        discipline: 'development',
        dependsOn: 'TW-9999',
      }),
    ).rejects.toThrow(/don't exist yet/);
  });

  it('parses --scope into a path-prefix array on the new ticket', async () => {
    await runTicketCreate(projectRoot, {
      title: 'A',
      context: 'c',
      discipline: 'development',
      scope: 'src/routes/, docs/',
    });
    const store = new TicketStore(path.join(projectRoot, '.trackwright', 'tickets'));
    const a = await store.getOrThrow('TW-0001');
    expect(a.frontmatter.scope).toEqual(['src/routes/', 'docs/']);
  });
});
