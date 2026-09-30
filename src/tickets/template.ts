import type { Discipline, FlowMode, Specialization } from '../workflow/stages.js';
import type { Ticket } from './schema.js';

export interface NewTicketInput {
  id: string;
  title: string;
  discipline: Discipline;
  specialization?: Specialization | null;
  secondaryDisciplines?: Discipline[];
  flow?: FlowMode;
  context: string;
}

/** Build a freshly-created ticket. Only Context is required content — Requirements/Acceptance
 * Criteria/Plan/Tasks are filled in by the planning stage, not at creation time. */
export function newTicket(input: NewTicketInput): Ticket {
  return {
    frontmatter: {
      id: input.id,
      title: input.title,
      status: 'draft',
      stage: 'planning',
      flow: input.flow ?? 'standard',
      discipline: input.discipline,
      specialization: input.specialization ?? null,
      secondary_disciplines: input.secondaryDisciplines ?? [],
      dependencies: [],
      design_status: 'not-required',
    },
    sections: {
      Context: input.context,
    },
  };
}
