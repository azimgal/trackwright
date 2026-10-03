import { describe, expect, it } from 'vitest';
import { newTicket } from '../src/tickets/template.js';
import { AGENTS } from '../src/agents/registry.js';
import {
  allowsAutoMergeEligibility,
  implementerAgentsFor,
  primaryRouting,
  requiresCodeReview,
  ROUTING_TABLE,
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

  it('routes development.mobile to a real, dedicated mobile implementer — no longer a gap', () => {
    const ticket = newTicket({ id: 'TW-0004', title: 'x', discipline: 'development', specialization: 'mobile', context: 'c' });
    expect(primaryRouting(ticket).implementerAgent).toBe('implementer.mobile');
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
    // design contributes no code implementer (its deliverable is the approved design artifact);
    // it used to contribute 'design-gate', which is not a registered agent -> SYSTEM_ERROR forever.
    expect(implementerAgentsFor(ticket)).toEqual(['implementer.frontend']);
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

  it('frontend + backend: both specialized implementers fan out, review/merge requirements unioned', () => {
    const ticket = newTicket({
      id: 'TW-0008',
      title: 'x',
      discipline: 'development',
      specialization: 'frontend',
      secondarySpecializations: ['backend'],
      context: 'c',
    });
    expect(implementerAgentsFor(ticket)).toEqual(['implementer.frontend', 'implementer.backend']);
    expect(requiresCodeReview(ticket)).toBe(true);
    expect(allowsAutoMergeEligibility(ticket)).toBe(true);
  });

  it('a design-only ticket has no code implementer and needs no code review', () => {
    const ticket = newTicket({ id: 'TW-0009', title: 'x', discipline: 'design', context: 'c' });
    expect(implementerAgentsFor(ticket)).toEqual([]);
    expect(requiresCodeReview(ticket)).toBe(false);
    expect(requiresDesignGate(ticket)).toBe(true);
  });

  it('every implementer any route can produce is a registered agent', () => {
    for (const entry of ROUTING_TABLE) {
      if (entry.implementerAgent !== null) expect(Object.keys(AGENTS)).toContain(entry.implementerAgent);
    }
  });
});
