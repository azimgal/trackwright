import { describe, expect, it } from 'vitest';
import { parseTicket, TicketParseError } from '../src/tickets/parser.js';
import { serializeTicket } from '../src/tickets/serializer.js';
import { findClarificationMarkers, isPlanningComplete } from '../src/tickets/schema.js';
import { newTicket } from '../src/tickets/template.js';

const VALID_TICKET = `---
id: TW-0001
title: Add password policy
status: draft
stage: planning
flow: standard
discipline: development
specialization: backend
secondary_disciplines: []
dependencies: []
design_status: not-required
---

## Context

We need a configurable password policy.

## Requirements

WHEN a user submits a password THE SYSTEM SHALL reject it if it is shorter than 12 characters.
`;

describe('parseTicket', () => {
  it('parses valid frontmatter and sections', () => {
    const ticket = parseTicket(VALID_TICKET);
    expect(ticket.frontmatter.id).toBe('TW-0001');
    expect(ticket.frontmatter.discipline).toBe('development');
    expect(ticket.frontmatter.specialization).toBe('backend');
    expect(ticket.sections['Context']).toContain('configurable password policy');
    expect(ticket.sections['Requirements']).toContain('12 characters');
  });

  it('throws TicketParseError when frontmatter block is missing', () => {
    expect(() => parseTicket('## Context\nno frontmatter here\n')).toThrow(TicketParseError);
  });

  it('throws TicketParseError on invalid discipline', () => {
    const bad = VALID_TICKET.replace('discipline: development', 'discipline: marketing');
    expect(() => parseTicket(bad)).toThrow(TicketParseError);
  });

  it('throws TicketParseError on malformed id', () => {
    const bad = VALID_TICKET.replace('id: TW-0001', 'id: not-a-valid-id');
    expect(() => parseTicket(bad)).toThrow(TicketParseError);
  });

  it('round-trips through serializeTicket', () => {
    const ticket = parseTicket(VALID_TICKET);
    const reparsed = parseTicket(serializeTicket(ticket));
    expect(reparsed.frontmatter).toEqual(ticket.frontmatter);
    expect(reparsed.sections['Context']).toBe(ticket.sections['Context']);
  });
});

describe('findClarificationMarkers', () => {
  it('finds NEEDS CLARIFICATION markers anywhere in sections', () => {
    const ticket = newTicket({
      id: 'TW-0002',
      title: 'x',
      discipline: 'development',
      context: 'Something [NEEDS CLARIFICATION: which timezone?] happens here.',
    });
    expect(findClarificationMarkers(ticket)).toHaveLength(1);
  });

  it('returns empty array when there are no markers', () => {
    const ticket = newTicket({ id: 'TW-0003', title: 'x', discipline: 'development', context: 'All clear.' });
    expect(findClarificationMarkers(ticket)).toHaveLength(0);
  });
});

describe('isPlanningComplete', () => {
  it('is false when required sections are missing', () => {
    const ticket = newTicket({ id: 'TW-0004', title: 'x', discipline: 'development', context: 'ctx' });
    expect(isPlanningComplete(ticket)).toBe(false);
  });

  it('is true once all required sections have content', () => {
    const ticket = newTicket({ id: 'TW-0005', title: 'x', discipline: 'development', context: 'ctx' });
    ticket.sections['Requirements'] = 'req';
    ticket.sections['Acceptance Criteria'] = 'ac';
    ticket.sections['Definition of Done'] = 'dod';
    expect(isPlanningComplete(ticket)).toBe(true);
  });
});
