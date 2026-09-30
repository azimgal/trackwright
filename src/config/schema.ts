import { z } from 'zod';

export const projectConfigSchema = z
  .object({
    /** Ticket id prefix, e.g. "TW" -> TW-0001. */
    ticketPrefix: z.string().min(1).max(10),
    /** Directory (relative to project root) tickets are stored in. */
    ticketsDir: z.string().default('.trackwright/tickets'),
    evidenceDir: z.string().default('.trackwright/evidence'),
    checks: z.object({
      fast: z.array(z.string()).default([]),
      test: z.array(z.string()).default([]),
      premerge: z.array(z.string()).default([]),
    }),
    retryCeiling: z.number().int().positive().default(3),
    claude: z.object({
      binary: z.string().default('claude'),
      defaultTimeoutMs: z.number().int().positive().default(600_000),
    }),
  })
  .strict();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
