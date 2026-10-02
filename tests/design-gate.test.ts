import { describe, expect, it } from 'vitest';
import { deterministicDesignGate } from '../src/design/gate.js';
import { newTicket } from '../src/tickets/template.js';

/**
 * Dedicated unit coverage for design/gate.ts — found during the final release-hardening pass to
 * have zero direct test coverage despite being the deterministic core of Design Sync's
 * required/not-required/ambiguous decision.
 */
function ticket(overrides: Partial<Parameters<typeof newTicket>[0]> = {}) {
  return newTicket({ id: 'TW-0001', title: 'x', discipline: 'development', context: 'c', ...overrides });
}

describe('deterministicDesignGate', () => {
  it('an already-synced ticket is not-required (already satisfied)', () => {
    const t = ticket();
    t.frontmatter.design_status = 'synced';
    expect(deterministicDesignGate(t)).toBe('not-required');
  });

  it('an explicitly-stale ticket is required (needs re-sync)', () => {
    const t = ticket();
    t.frontmatter.design_status = 'stale';
    expect(deterministicDesignGate(t)).toBe('required');
  });

  it('an explicitly-required ticket stays required regardless of discipline', () => {
    const t = ticket({ discipline: 'infrastructure' });
    t.frontmatter.design_status = 'required';
    expect(deterministicDesignGate(t)).toBe('required');
  });

  it('discipline "design" is always required', () => {
    expect(deterministicDesignGate(ticket({ discipline: 'design' }))).toBe('required');
  });

  it('a secondary "design" discipline is required even if primary is not', () => {
    const t = ticket({ discipline: 'development', specialization: 'backend', secondaryDisciplines: ['design'] });
    expect(deterministicDesignGate(t)).toBe('required');
  });

  it('development.frontend is always required', () => {
    expect(deterministicDesignGate(ticket({ discipline: 'development', specialization: 'frontend' }))).toBe(
      'required',
    );
  });

  it('infrastructure is confidently not-required', () => {
    expect(deterministicDesignGate(ticket({ discipline: 'infrastructure' }))).toBe('not-required');
  });

  it('development.backend is confidently not-required', () => {
    expect(deterministicDesignGate(ticket({ discipline: 'development', specialization: 'backend' }))).toBe(
      'not-required',
    );
  });

  it('development with no specialization is genuinely ambiguous', () => {
    expect(deterministicDesignGate(ticket({ discipline: 'development' }))).toBe('ambiguous');
  });

  it('development.mobile is genuinely ambiguous (no mobile-specific signal yet)', () => {
    expect(deterministicDesignGate(ticket({ discipline: 'development', specialization: 'mobile' }))).toBe(
      'ambiguous',
    );
  });
});
