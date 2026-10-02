import { describe, expect, it } from 'vitest';
import { dependencyReadiness } from '../src/dependencies/readiness.js';
import { newTicket } from '../src/tickets/template.js';
import type { Ticket } from '../src/tickets/schema.js';

function ticketWithStatus(id: string, status: Ticket['frontmatter']['status']): Ticket {
  const t = newTicket({ id, title: id, discipline: 'development', context: 'c' });
  return { ...t, frontmatter: { ...t.frontmatter, status } };
}

describe('dependencyReadiness', () => {
  it('ready with no dependencies at all', () => {
    const t = newTicket({ id: 'TW-0001', title: 'x', discipline: 'development', context: 'c' });
    expect(dependencyReadiness(t, new Map())).toEqual({ ready: true });
  });

  it('ready when every dependency is done', () => {
    const a = ticketWithStatus('TW-0001', 'done');
    const b = newTicket({ id: 'TW-0002', title: 'x', discipline: 'development', context: 'c', dependencies: ['TW-0001'] });
    const byId = new Map([['TW-0001', a]]);
    expect(dependencyReadiness(b, byId)).toEqual({ ready: true });
  });

  it('unmet when a dependency exists but is not done yet', () => {
    const a = ticketWithStatus('TW-0001', 'in-progress');
    const b = newTicket({ id: 'TW-0002', title: 'x', discipline: 'development', context: 'c', dependencies: ['TW-0001'] });
    const byId = new Map([['TW-0001', a]]);
    expect(dependencyReadiness(b, byId)).toEqual({ ready: false, reason: 'unmet', pending: ['TW-0001'] });
  });

  it('unmet when a dependency does not exist (yet)', () => {
    const b = newTicket({ id: 'TW-0002', title: 'x', discipline: 'development', context: 'c', dependencies: ['TW-0001'] });
    expect(dependencyReadiness(b, new Map())).toEqual({ ready: false, reason: 'unmet', pending: ['TW-0001'] });
  });

  it('blocked-by-cancelled-dependency when a dependency is cancelled — distinct from merely unmet', () => {
    const a = ticketWithStatus('TW-0001', 'cancelled');
    const b = newTicket({ id: 'TW-0002', title: 'x', discipline: 'development', context: 'c', dependencies: ['TW-0001'] });
    const byId = new Map([['TW-0001', a]]);
    expect(dependencyReadiness(b, byId)).toEqual({
      ready: false,
      reason: 'blocked-by-cancelled-dependency',
      cancelled: ['TW-0001'],
    });
  });

  it('a cancelled dependency takes priority over an also-unmet one in the report', () => {
    const a = ticketWithStatus('TW-0001', 'cancelled');
    const c = ticketWithStatus('TW-0003', 'draft');
    const b = newTicket({
      id: 'TW-0002',
      title: 'x',
      discipline: 'development',
      context: 'c',
      dependencies: ['TW-0001', 'TW-0003'],
    });
    const byId = new Map([
      ['TW-0001', a],
      ['TW-0003', c],
    ]);
    const result = dependencyReadiness(b, byId);
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.reason).toBe('blocked-by-cancelled-dependency');
  });
});
