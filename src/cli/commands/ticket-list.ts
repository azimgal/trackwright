import path from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { TicketStore } from '../../tickets/store.js';

export async function runTicketList(projectRoot: string): Promise<string> {
  const config = await loadConfig(projectRoot);
  const store = new TicketStore(path.join(projectRoot, config.ticketsDir));
  const tickets = await store.list();
  if (tickets.length === 0) return '(no tickets yet — try `trackwright ticket create`)';
  return tickets
    .map((t) => `${t.frontmatter.id}  [${t.frontmatter.status}/${t.frontmatter.stage ?? '-'}]  ${t.frontmatter.title}`)
    .join('\n');
}

export async function runTicketShow(projectRoot: string, ticketId: string): Promise<string> {
  const config = await loadConfig(projectRoot);
  const store = new TicketStore(path.join(projectRoot, config.ticketsDir));
  const ticket = await store.getOrThrow(ticketId);
  const lines = [
    `${ticket.frontmatter.id}: ${ticket.frontmatter.title}`,
    `status=${ticket.frontmatter.status} stage=${ticket.frontmatter.stage ?? '-'} flow=${ticket.frontmatter.flow}`,
    `discipline=${ticket.frontmatter.discipline}${ticket.frontmatter.specialization ? '.' + ticket.frontmatter.specialization : ''}`,
    ...(ticket.frontmatter.secondary_disciplines.length
      ? [`secondary=${ticket.frontmatter.secondary_disciplines.join(',')}`]
      : []),
    ...(ticket.frontmatter.dependencies.length ? [`depends_on=${ticket.frontmatter.dependencies.join(',')}`] : []),
    '',
    ...Object.entries(ticket.sections).map(([heading, body]) => `## ${heading}\n${body}\n`),
  ];
  return lines.join('\n');
}
