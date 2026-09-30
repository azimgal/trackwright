import path from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { TicketStore } from '../../tickets/store.js';
import { newTicket } from '../../tickets/template.js';
import type { Discipline, FlowMode, Specialization } from '../../workflow/stages.js';
import { DISCIPLINES, FLOW_MODES, SPECIALIZATIONS } from '../../workflow/stages.js';

export interface TicketCreateOptions {
  title: string;
  context: string;
  discipline: string;
  specialization?: string;
  flow?: string;
}

export class InvalidTicketCreateOptionsError extends Error {}

function assertDiscipline(value: string): Discipline {
  if (!(DISCIPLINES as readonly string[]).includes(value)) {
    throw new InvalidTicketCreateOptionsError(`--discipline must be one of ${DISCIPLINES.join(', ')}, got "${value}"`);
  }
  return value as Discipline;
}

function assertSpecialization(value: string | undefined): Specialization | null {
  if (!value) return null;
  if (!(SPECIALIZATIONS as readonly string[]).includes(value)) {
    throw new InvalidTicketCreateOptionsError(`--specialization must be one of ${SPECIALIZATIONS.join(', ')}, got "${value}"`);
  }
  return value as Specialization;
}

function assertFlow(value: string | undefined): FlowMode {
  if (!value) return 'standard';
  if (!(FLOW_MODES as readonly string[]).includes(value)) {
    throw new InvalidTicketCreateOptionsError(`--flow must be one of ${FLOW_MODES.join(', ')}, got "${value}"`);
  }
  return value as FlowMode;
}

export async function runTicketCreate(projectRoot: string, options: TicketCreateOptions): Promise<string> {
  const config = await loadConfig(projectRoot);
  const store = new TicketStore(path.join(projectRoot, config.ticketsDir));
  const id = await store.nextId(config.ticketPrefix);

  const ticket = newTicket({
    id,
    title: options.title,
    context: options.context,
    discipline: assertDiscipline(options.discipline),
    specialization: assertSpecialization(options.specialization),
    flow: assertFlow(options.flow),
  });

  const saved = await store.save(ticket);
  return `Created ${saved.frontmatter.id} at ${saved.filePath}`;
}
