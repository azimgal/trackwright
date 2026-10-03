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

export const DESIGN_STATUSES = ['not-required', 'required', 'pending', 'synced', 'stale', 'failed'] as const;
export type DesignStatus = (typeof DESIGN_STATUSES)[number];

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
    // Additional development specializations this ticket also needs (e.g. a frontend-primary
    // ticket that also changes the backend): each adds its own implementer to Development's
    // fan-out, and its own checks/review requirements are unioned in. See policies/routing.ts.
    secondary_specializations: z.array(z.enum(SPECIALIZATIONS)).default([]),
    dependencies: z.array(ticketIdSchema).default([]),
    // Declared path prefixes this ticket's implementation is expected to touch (e.g.
    // "src/routes/", "docs/"), used only by the batch scheduler (workflow/batch.ts) to decide
    // whether two tickets in the same dependency wave can safely run concurrently in separate git
    // worktrees. Empty (the default) means "unknown/unconstrained" — the scheduler treats that as
    // a potential overlap with everything and serializes, never guesses. This is advisory, not
    // enforced: the scheduler always re-checks the *actual* diff after the fact and never trusts
    // a declared scope as proof of no conflict.
    scope: z.array(z.string()).default([]),
    // 'pending': a design artifact has been drafted and is awaiting human approval (set by
    // engine.ts's executeDesignGate the moment it drafts one — distinct from 'required', which
    // just means "a design is needed" with no artifact yet). 'failed': the post-implementation
    // visual check came back DESIGN_FAIL — distinct from 'stale', which means "code/requirements
    // moved since approval," not "the implementation doesn't match what was approved."
    design_status: z.enum(DESIGN_STATUSES).default('not-required'),
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
