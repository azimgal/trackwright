import yaml from 'js-yaml';
import { TICKET_SECTIONS, ticketFrontmatterSchema, type Ticket } from './schema.js';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export class TicketParseError extends Error {
  constructor(
    message: string,
    readonly filePath?: string,
  ) {
    super(filePath ? `${filePath}: ${message}` : message);
    this.name = 'TicketParseError';
  }
}

/**
 * Parse a ticket file's raw text into a Ticket. Deliberately hand-rolled rather than pulling in
 * a general-purpose frontmatter library with its own opinions about section parsing — the only
 * structure we need is "YAML frontmatter block, then `## Heading` sections," and keeping that
 * narrow makes the format easy to reason about and to hand-edit.
 */
export function parseTicket(raw: string, filePath?: string): Ticket {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) {
    throw new TicketParseError('missing YAML frontmatter block (expected leading `---` ... `---`)', filePath);
  }
  const [, frontmatterBlock, body] = match;

  let parsedYaml: unknown;
  try {
    parsedYaml = yaml.load(frontmatterBlock ?? '');
  } catch (err) {
    throw new TicketParseError(`invalid YAML frontmatter: ${(err as Error).message}`, filePath);
  }

  const frontmatterResult = ticketFrontmatterSchema.safeParse(parsedYaml);
  if (!frontmatterResult.success) {
    const issues = frontmatterResult.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new TicketParseError(`invalid frontmatter: ${issues}`, filePath);
  }

  const sections = parseSections(body ?? '');

  return {
    frontmatter: frontmatterResult.data,
    sections,
    filePath,
  };
}

function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  let currentHeading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentHeading !== null) {
      sections[currentHeading] = buffer.join('\n').trim();
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headingMatch && headingMatch[1] && (TICKET_SECTIONS as readonly string[]).includes(headingMatch[1])) {
      flush();
      currentHeading = headingMatch[1];
      continue;
    }
    buffer.push(line);
  }
  flush();

  return sections;
}
