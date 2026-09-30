import { z } from 'zod';
import { DISCIPLINES, FLOW_MODES, SPECIALIZATIONS, STAGES, STATUSES } from '../workflow/stages.js';

/**
 * Canonical section headings for a ticket body, in the order they are expected to appear.
 * A ticket is one file — this is deliberately NOT split across proposal/spec/design/tasks files.
 * Not every section needs content at creation time; several are filled in as the ticket moves
 * through stages (Plan/Tasks by planning, Verification evidence by verification).
 */
export const TICKET_SECTIONS = [
  'Context',
  'Requirements',
  'Acceptance Criteria',
  'Clarifications',
  'Architecture decisions',
  'Design requirements',
  'Plan',
  'Tasks',
  'Risk',
  'Definition of Done',
  'How to verify',
  'Verification evidence',
] as const;
export type TicketSection = (typeof TICKET_SECTIONS)[number];

/** Sections that must have non-empty content before a ticket can leave `planning`. */
export const REQUIRED_AT_PLANNING: readonly TicketSection[] = [
  'Context',
  'Requirements',
  'Acceptance Criteria',
  'Definition of Done',
];

const TICKET_ID_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;

export const ticketIdSchema = z
  .string()
  .regex(TICKET_ID_PATTERN, 'Ticket id must look like TW-0001 (prefix-number)');

export const ticketFrontmatterSchema = z
  .object({
    id: ticketIdSchema,
    title: z.string().min(1, 'title cannot be empty'),
    // z.enum() accepts a readonly string-literal tuple directly and infers the exact literal
    // union — casting these to `[string, ...string[]]` (as an earlier version of this file did)
    // would silently widen the inferred TypeScript type to plain `string` everywhere downstream.
    status: z.enum(STATUSES),
    stage: z.union([z.enum(STAGES), z.null()]).default(null),
    flow: z.enum(FLOW_MODES).default('standard'),
    discipline: z.enum(DISCIPLINES),
    specialization: z.union([z.enum(SPECIALIZATIONS), z.null()]).default(null),
    secondary_disciplines: z.array(z.enum(DISCIPLINES)).default([]),
    dependencies: z.array(ticketIdSchema).default([]),
    design_status: z
      .enum(['not-required', 'required', 'synced', 'stale'])
      .default('not-required'),
  })
  .strict();

export type TicketFrontmatter = z.infer<typeof ticketFrontmatterSchema>;

export const ticketSchema = z.object({
  frontmatter: ticketFrontmatterSchema,
  /** Section heading -> raw markdown body (without the leading `## Heading` line). */
  sections: z.record(z.string()),
  /** Absolute path this ticket was loaded from, if any. */
  filePath: z.string().optional(),
});

export type Ticket = z.infer<typeof ticketSchema>;

/**
 * Validate that a raw parsed object matches the ticket shape. Throws a ZodError with a readable
 * path on failure — callers should catch and translate to a user-facing message, not let this
 * leak as an unhandled exception during `ticket create`/`run`.
 */
export function parseTicketFrontmatter(raw: unknown): TicketFrontmatter {
  return ticketFrontmatterSchema.parse(raw);
}

/** Find `[NEEDS CLARIFICATION: ...]` markers anywhere in a ticket's sections. */
export function findClarificationMarkers(ticket: Ticket): string[] {
  const markers: string[] = [];
  const pattern = /\[NEEDS CLARIFICATION:[^\]]*\]/g;
  for (const body of Object.values(ticket.sections)) {
    const found = body.match(pattern);
    if (found) markers.push(...found);
  }
  return markers;
}

/** True if every section required to leave `planning` has non-whitespace content. */
export function isPlanningComplete(ticket: Ticket): boolean {
  return REQUIRED_AT_PLANNING.every((section) => (ticket.sections[section] ?? '').trim().length > 0);
}
