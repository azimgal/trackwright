import type { Discipline, Specialization } from '../workflow/stages.js';
import type { Ticket } from '../tickets/schema.js';

export interface RoutingEntry {
  readonly discipline: Discipline;
  readonly specialization: Specialization | null;
  /** Agent name (matches an entry in agents/registry.ts) that runs the Development stage. */
  readonly implementerAgent: string;
  readonly requiresCodeReview: boolean;
  readonly requiresDesignGateByDefault: boolean;
  readonly allowsAutoMergeEligibility: boolean;
}

/**
 * The routing matrix from docs/architecture.md, made concrete. Only the three disciplines with
 * real evidence behind them today (design, development, infrastructure) are populated — see
 * roadmap.md for why data/qa/security/platform are deliberately not here yet.
 */
export const ROUTING_TABLE: readonly RoutingEntry[] = [
  {
    discipline: 'design',
    specialization: null,
    implementerAgent: 'design-gate', // design tickets produce/sync an artifact, not application code
    requiresCodeReview: false,
    requiresDesignGateByDefault: true,
    allowsAutoMergeEligibility: false,
  },
  {
    discipline: 'development',
    specialization: 'frontend',
    implementerAgent: 'implementer.frontend',
    requiresCodeReview: true,
    requiresDesignGateByDefault: false, // resolved per-ticket by the design-gate stage, not assumed
    allowsAutoMergeEligibility: true,
  },
  {
    discipline: 'development',
    specialization: 'backend',
    implementerAgent: 'implementer.backend',
    requiresCodeReview: true,
    requiresDesignGateByDefault: false,
    allowsAutoMergeEligibility: true,
  },
  {
    discipline: 'development',
    specialization: 'mobile',
    implementerAgent: 'implementer.mobile',
    requiresCodeReview: true,
    requiresDesignGateByDefault: false,
    allowsAutoMergeEligibility: true,
  },
  {
    discipline: 'development',
    specialization: null,
    implementerAgent: 'implementer.generic',
    requiresCodeReview: true,
    requiresDesignGateByDefault: false,
    allowsAutoMergeEligibility: true,
  },
  {
    discipline: 'infrastructure',
    specialization: null,
    implementerAgent: 'implementer.infrastructure',
    requiresCodeReview: true,
    requiresDesignGateByDefault: false,
    // Infrastructure changes are treated as always touching a CODEOWNER-equivalent path in the
    // MVP's default policy — narrow this per-project via config, not by editing this table.
    allowsAutoMergeEligibility: false,
  },
];

export class RoutingError extends Error {}

function lookup(discipline: Discipline, specialization: Specialization | null): RoutingEntry {
  const entry = ROUTING_TABLE.find(
    (e) => e.discipline === discipline && e.specialization === specialization,
  );
  if (entry) return entry;
  const fallback = ROUTING_TABLE.find((e) => e.discipline === discipline && e.specialization === null);
  if (fallback) return fallback;
  throw new RoutingError(`no routing entry for discipline "${discipline}" (specialization "${specialization}")`);
}

/**
 * Resolve the primary routing entry for a ticket, i.e. the one that decides which agent runs
 * Development. Primary is always `frontmatter.discipline`/`specialization`.
 */
export function primaryRouting(ticket: Ticket): RoutingEntry {
  return lookup(ticket.frontmatter.discipline, ticket.frontmatter.specialization);
}

/**
 * Secondary routing entries for a multi-discipline ticket (fan-out targets within Development,
 * see docs/architecture.md "Multi-discipline strategy"). Requirements from these are unioned with
 * the primary's, never intersected: a frontend+design ticket needs code review from the frontend
 * side AND the design gate, even though design is not primary.
 */
export function secondaryRoutings(ticket: Ticket): RoutingEntry[] {
  return ticket.frontmatter.secondary_disciplines.map((d) => lookup(d, null));
}

/** Union of implementer agents that must run in Development's fan-out for this ticket. */
export function implementerAgentsFor(ticket: Ticket): string[] {
  const primary = primaryRouting(ticket);
  const secondary = secondaryRoutings(ticket);
  const names = new Set([primary.implementerAgent, ...secondary.map((r) => r.implementerAgent)]);
  return [...names];
}

/**
 * `design_status` is only an authoritative override once something has actually set it past its
 * initial value (see tickets/template.ts, every new ticket starts at "not-required"). "required",
 * "synced", and "stale" all mean a design gate applies (an explicit decision was made, or the
 * gate previously ran); the default "not-required" is not itself a decision — it falls through to
 * the routing table so a secondary "design" discipline still forces the gate even though no one
 * has explicitly flipped design_status yet.
 */
export function requiresDesignGate(ticket: Ticket): boolean {
  if (ticket.frontmatter.design_status !== 'not-required') return true;
  const primary = primaryRouting(ticket);
  const secondary = secondaryRoutings(ticket);
  return primary.requiresDesignGateByDefault || secondary.some((r) => r.requiresDesignGateByDefault);
}

export function allowsAutoMergeEligibility(ticket: Ticket): boolean {
  const primary = primaryRouting(ticket);
  const secondary = secondaryRoutings(ticket);
  return primary.allowsAutoMergeEligibility && secondary.every((r) => r.allowsAutoMergeEligibility);
}
