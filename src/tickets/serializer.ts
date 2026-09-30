import yaml from 'js-yaml';
import { TICKET_SECTIONS, type Ticket } from './schema.js';

/**
 * Serialize a Ticket back to the on-disk markdown+frontmatter format. Round-trips with
 * parseTicket: parseTicket(serializeTicket(t)) preserves frontmatter and non-empty sections.
 * Sections are always emitted in canonical TICKET_SECTIONS order, empty ones omitted, so a
 * hand-edited ticket doesn't end up with a dozen empty headings.
 */
export function serializeTicket(ticket: Ticket): string {
  const frontmatterYaml = yaml
    .dump(ticket.frontmatter, { lineWidth: 100, noRefs: true, sortKeys: false })
    .trimEnd();

  const sectionBlocks = TICKET_SECTIONS.filter(
    (heading) => (ticket.sections[heading] ?? '').trim().length > 0,
  ).map((heading) => `## ${heading}\n\n${ticket.sections[heading]!.trim()}\n`);

  return `---\n${frontmatterYaml}\n---\n\n${sectionBlocks.join('\n')}`.trimEnd() + '\n';
}

/** Return a copy of `ticket` with `section` set to `content`, leaving everything else intact. */
export function withSection(ticket: Ticket, section: string, content: string): Ticket {
  return {
    ...ticket,
    sections: { ...ticket.sections, [section]: content },
  };
}
