import path from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { TicketStore } from '../../tickets/store.js';
import { newTicket } from '../../tickets/template.js';
import type { Discipline, FlowMode, Specialization } from '../../workflow/stages.js';
import { DISCIPLINES, FLOW_MODES, SPECIALIZATIONS } from '../../workflow/stages.js';
import { buildDependencyGraph, detectCycle } from '../../dependencies/dag.js';
import { commitBookkeeping } from './init.js';

export interface TicketCreateOptions {
  title: string;
  context: string;
  discipline: string;
  specialization?: string;
  flow?: string;
  /** Comma-separated ticket ids, e.g. "TW-0001,TW-0002". */
  dependsOn?: string;
  /** Comma-separated declared path prefixes, e.g. "src/routes/,docs/" — see
   * tickets/schema.ts's `scope` field doc comment. */
  scope?: string;
  /** Comma-separated additional disciplines/specializations, e.g. "backend" or "design,backend". */
  secondary?: string;
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

/**
 * `--secondary` items: a discipline (design | development | infrastructure) or a development
 * specialization (frontend | backend | mobile). Each adds its own route to the ticket: another
 * implementer in Development's fan-out, and its review/design/merge requirements unioned in.
 */
function parseSecondary(
  value: string | undefined,
  primary: { discipline: Discipline; specialization: Specialization | null },
): { disciplines: Discipline[]; specializations: Specialization[] } {
  const disciplines: Discipline[] = [];
  const specializations: Specialization[] = [];
  for (const item of parseCommaList(value)) {
    if ((SPECIALIZATIONS as readonly string[]).includes(item)) {
      if (primary.discipline === 'development' && primary.specialization === item) {
        throw new InvalidTicketCreateOptionsError(`--secondary "${item}" is already the primary specialization`);
      }
      if (!specializations.includes(item as Specialization)) specializations.push(item as Specialization);
    } else if ((DISCIPLINES as readonly string[]).includes(item)) {
      if (item === primary.discipline) {
        throw new InvalidTicketCreateOptionsError(`--secondary "${item}" is already the primary discipline`);
      }
      if (!disciplines.includes(item as Discipline)) disciplines.push(item as Discipline);
    } else {
      throw new InvalidTicketCreateOptionsError(
        `--secondary items must be one of ${[...DISCIPLINES, ...SPECIALIZATIONS].join(', ')}, got "${item}"`,
      );
    }
  }
  return { disciplines, specializations };
}

function parseCommaList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function runTicketCreate(projectRoot: string, options: TicketCreateOptions): Promise<string> {
  const config = await loadConfig(projectRoot);
  const store = new TicketStore(path.join(projectRoot, config.ticketsDir));
  const id = await store.nextId(config.ticketPrefix);

  const discipline = assertDiscipline(options.discipline);
  const dependencies = parseCommaList(options.dependsOn);

  if (dependencies.length > 0) {
    const existing = await store.list();
    const unknown = dependencies.filter((d) => !existing.some((t) => t.frontmatter.id === d));
    if (unknown.length > 0) {
      throw new InvalidTicketCreateOptionsError(
        `--depends-on references ticket id(s) that don't exist yet: ${unknown.join(', ')}`,
      );
    }
    // A brand-new ticket can only ever be the *target* of a cycle its own dependencies create,
    // never a link already inside one — but check anyway via the real cycle detector, on the
    // full would-be graph, rather than re-deriving "could this possibly cycle" by hand.
    const wouldBeGraph = buildDependencyGraph([
      ...existing.map((t) => ({ id: t.frontmatter.id, dependencies: t.frontmatter.dependencies })),
      { id, dependencies },
    ]);
    const cycle = detectCycle(wouldBeGraph);
    if (cycle && cycle.includes(id)) {
      throw new InvalidTicketCreateOptionsError(`--depends-on would create a dependency cycle: ${cycle.join(' -> ')} -> ${cycle[0]}`);
    }
  }

  const specialization = assertSpecialization(options.specialization, discipline);
  const secondary = parseSecondary(options.secondary, { discipline, specialization });
  const ticket = newTicket({
    id,
    title: options.title,
    context: options.context,
    discipline,
    specialization,
    secondaryDisciplines: secondary.disciplines,
    secondarySpecializations: secondary.specializations,
    flow: assertFlow(options.flow),
    dependencies,
    scope: parseCommaList(options.scope),
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
