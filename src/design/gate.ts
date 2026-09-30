import type { Ticket } from '../tickets/schema.js';

export type DesignGateDecision = 'required' | 'not-required' | 'ambiguous';

/**
 * Deterministic rules only — no Claude call. Returns 'ambiguous' when none of these rules give a
 * confident answer, which is the ONLY case design/gate-agent.ts should escalate to a Claude
 * judgment call. This mirrors docs/architecture.md's instruction: "не полагайся только на
 * filename heuristic... Claude judgment только там, где правила не дают однозначного ответа."
 */
export function deterministicDesignGate(ticket: Ticket): DesignGateDecision {
  // An explicit, already-resolved decision always wins — this is what lets a human or a prior
  // gate run pin the answer, and what makes requiresDesignGate (policies/routing.ts) and this
  // function agree with each other rather than each guessing independently.
  if (ticket.frontmatter.design_status === 'required') return 'required';
  if (ticket.frontmatter.design_status === 'synced') return 'not-required'; // already satisfied
  if (ticket.frontmatter.design_status === 'stale') return 'required'; // needs re-sync

  if (ticket.frontmatter.discipline === 'design') return 'required';
  if (ticket.frontmatter.secondary_disciplines.includes('design')) return 'required';
  if (ticket.frontmatter.specialization === 'frontend') return 'required';

  // Backend/infrastructure/mobile-with-no-UI-surface tickets are confidently not design work.
  if (ticket.frontmatter.discipline === 'infrastructure') return 'not-required';
  if (ticket.frontmatter.specialization === 'backend') return 'not-required';

  // development with specialization null (generic) or 'mobile': genuinely ambiguous by these
  // rules alone — a generic development ticket could easily touch UI or not, and MVP has no
  // mobile-specific signal yet (see policies/routing.ts, isMobileGap).
  return 'ambiguous';
}
