import { describe, expect, it } from 'vitest';
import { newTicket } from '../src/tickets/template.js';
import {
  allowsAutoMergeEligibility,
  implementerAgentsFor,
  isMobileGap,
  primaryRouting,
  requiresDesignGate,
  secondaryRoutings,
} from '../src/policies/routing.js';

describe('discipline/specialization routing', () => {
  it('routes development.backend to the backend implementer', () => {
    const ticket = newTicket({ id: 'TW-0001', title: 'x', discipline: 'development', specialization: 'backend', context: 'c' });
    expect(primaryRouting(ticket).implementerAgent).toBe('implementer.backend');
  });

  it('routes development.frontend to the frontend implementer', () => {
    const ticket = newTicket({ id: 'TW-0002', title: 'x', discipline: 'development', specialization: 'frontend', context: 'c' });
    expect(primaryRouting(ticket).implementerAgent).toBe('implementer.frontend');
  });

  it('falls back to implementer.generic for development with no specialization', () => {
    const ticket = newTicket({ id: 'TW-0003', title: 'x', discipline: 'development', context: 'c' });
    expect(primaryRouting(ticket).implementerAgent).toBe('implementer.generic');
  });

  it('flags mobile as a known implementer gap rather than silently pretending it is covered', () => {
    const ticket = newTicket({ id: 'TW-0004', title: 'x', discipline: 'development', specialization: 'mobile', context: 'c' });
    expect(isMobileGap(primaryRouting(ticket))).toBe(true);
  });

  it('unions requirements across primary and secondary disciplines', () => {
    const ticket = newTicket({
      id: 'TW-0005',
      title: 'x',
      discipline: 'development',
      specialization: 'frontend',
      secondaryDisciplines: ['design'],
      context: 'c',
    });
    expect(secondaryRoutings(ticket)).toHaveLength(1);
    expect(implementerAgentsFor(ticket)).toContain('implementer.frontend');
    expect(implementerAgentsFor(ticket)).toContain('design-gate');
    // design is secondary but still forces the design gate — union, not intersection
    expect(requiresDesignGate(ticket)).toBe(true);
  });

  it('infrastructure tickets never allow auto-merge eligibility', () => {
    const ticket = newTicket({ id: 'TW-0006', title: 'x', discipline: 'infrastructure', context: 'c' });
    expect(allowsAutoMergeEligibility(ticket)).toBe(false);
  });

  it('a development ticket with an infrastructure secondary loses auto-merge eligibility too', () => {
    const ticket = newTicket({
      id: 'TW-0007',
      title: 'x',
      discipline: 'development',
      specialization: 'backend',
      secondaryDisciplines: ['infrastructure'],
      context: 'c',
    });
    expect(allowsAutoMergeEligibility(ticket)).toBe(false);
  });
});
