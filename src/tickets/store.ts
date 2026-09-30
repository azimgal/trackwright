import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseTicket } from './parser.js';
import { serializeTicket } from './serializer.js';
import type { Ticket, TicketFrontmatter } from './schema.js';

export class TicketNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`no ticket found with id "${id}"`);
    this.name = 'TicketNotFoundError';
  }
}

/**
 * File-backed ticket storage: one markdown file per ticket under `ticketsDir`. This is the only
 * concrete backend in the MVP. It is deliberately kept behind this class (not accessed via raw
 * fs calls from the workflow engine) so a different backend could be substituted later without
 * touching orchestration code — the same seam the reference architecture calls a TicketStore.
 */
export class TicketStore {
  constructor(private readonly ticketsDir: string) {}

  async ensureDir(): Promise<void> {
    await mkdir(this.ticketsDir, { recursive: true });
  }

  private slugify(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60);
  }

  private filePathFor(id: string, title: string): string {
    return path.join(this.ticketsDir, `${id}-${this.slugify(title)}.md`);
  }

  async list(): Promise<Ticket[]> {
    if (!existsSync(this.ticketsDir)) return [];
    const entries = await readdir(this.ticketsDir);
    const tickets: Ticket[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const filePath = path.join(this.ticketsDir, entry);
      const raw = await readFile(filePath, 'utf8');
      tickets.push(parseTicket(raw, filePath));
    }
    return tickets.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  }

  async get(id: string): Promise<Ticket | null> {
    const tickets = await this.list();
    return tickets.find((t) => t.frontmatter.id === id) ?? null;
  }

  async getOrThrow(id: string): Promise<Ticket> {
    const ticket = await this.get(id);
    if (!ticket) throw new TicketNotFoundError(id);
    return ticket;
  }

  /** Allocate the next unused numeric id for a given prefix, e.g. "TW" -> "TW-0007". */
  async nextId(prefix: string): Promise<string> {
    const tickets = await this.list();
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escapedPrefix}-(\\d+)$`);
    let max = 0;
    for (const ticket of tickets) {
      const match = pattern.exec(ticket.frontmatter.id);
      if (match && match[1]) max = Math.max(max, parseInt(match[1], 10));
    }
    const next = max + 1;
    return `${prefix}-${String(next).padStart(4, '0')}`;
  }

  async save(ticket: Ticket): Promise<Ticket> {
    await this.ensureDir();
    const filePath = ticket.filePath ?? this.filePathFor(ticket.frontmatter.id, ticket.frontmatter.title);
    await writeFile(filePath, serializeTicket(ticket), 'utf8');
    return { ...ticket, filePath };
  }

  async create(frontmatter: TicketFrontmatter, sections: Record<string, string> = {}): Promise<Ticket> {
    const ticket: Ticket = { frontmatter, sections };
    return this.save(ticket);
  }
}
