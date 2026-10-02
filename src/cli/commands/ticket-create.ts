import path from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { TicketStore } from '../../tickets/store.js';
import { newTicket } from '../../tickets/template.js';
import type { Discipline, FlowMode, Specialization } from '../../workflow/stages.js';
import { DISCIPLINES, FLOW_MODES, SPECIALIZATIONS } from '../../workflow/stages.js';
import { commitBookkeeping } from './init.js';

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

/**
 * `--specialization` is documented (CLI --help) as "development only." Found during the
 * release-readiness audit: it was previously accepted for any discipline and silently ignored by
 * the routing table's fallback (policies/routing.ts, `lookup`'s discipline-only fallback) for
 * anything other than development — no crash, but a ticket file left with a specialization field
 * that looks meaningful and never was, misleading anyone who reads it later. Now enforced instead
 * of silently dropped.
 */
function assertSpecialization(value: string | undefined, discipline: Discipline): Specialization | null {
  if (!value) return null;
  if (!(SPECIALIZATIONS as readonly string[]).includes(value)) {
    throw new InvalidTicketCreateOptionsError(`--specialization must be one of ${SPECIALIZATIONS.join(', ')}, got "${value}"`);
  }
  if (discipline !== 'development') {
    throw new InvalidTicketCreateOptionsError(
      `--specialization only applies to --discipline development, got discipline "${discipline}"`,
    );
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

  const discipline = assertDiscipline(options.discipline);
  const ticket = newTicket({
    id,
    title: options.title,
    context: options.context,
    discipline,
    specialization: assertSpecialization(options.specialization, discipline),
    flow: assertFlow(options.flow),
  });

  const saved = await store.save(ticket);
  // store.save() always returns filePath set (it defaults to a computed path internally when
  // absent), but the Ticket type itself declares it optional for parsed-from-string cases —
  // fail loudly rather than silently skipping the bookkeeping commit if that ever stops holding.
  if (!saved.filePath) throw new Error('TicketStore.save() did not return a filePath');
  const relativePath = path.relative(projectRoot, saved.filePath).split(path.sep).join('/');
  await commitBookkeeping(projectRoot, [relativePath], `chore(trackwright): create ticket ${saved.frontmatter.id}`);
  return `Created ${saved.frontmatter.id} at ${saved.filePath}`;
}
