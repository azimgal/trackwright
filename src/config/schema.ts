import { z } from 'zod';
import { SPECIALIZATIONS } from '../workflow/stages.js';

const checksTierSchema = z.object({
  fast: z.array(z.string()).default([]),
  test: z.array(z.string()).default([]),
  premerge: z.array(z.string()).default([]),
});

export const projectConfigSchema = z
  .object({
    /** Ticket id prefix, e.g. "TW" -> TW-0001. */
    ticketPrefix: z.string().min(1).max(10),
    /** Directory (relative to project root) tickets are stored in. */
    ticketsDir: z.string().default('.trackwright/tickets'),
    evidenceDir: z.string().default('.trackwright/evidence'),
    checks: checksTierSchema,
    /**
     * Per-specialization overrides for `checks.*`, keyed by "frontend"/"backend"/"mobile" — a
     * project with, say, a React Native app alongside a Node backend needs genuinely different
     * test/build commands for each, not one global set that happens to work for neither. Any
     * tier left unset for a given specialization falls back to the global `checks.*` value (see
     * workflow/engine.ts, checksFor). Entirely optional — a single-stack project never needs
     * this at all. Keys are restricted to the known specializations so a typo (e.g. "mobil")
     * fails config load loudly instead of silently never applying.
     */
    checksBySpecialization: z.record(z.enum(SPECIALIZATIONS), checksTierSchema.partial().strict()).default({}),
    retryCeiling: z.number().int().positive().default(3),
    claude: z.object({
      binary: z.string().default('claude'),
      defaultTimeoutMs: z.number().int().positive().default(600_000),
    }),
    /** `trackwright batch` only — how many tickets within one dependency wave may run
     * concurrently, each in its own git worktree. 1 (the default) means always serial, even
     * within a wave — the safest possible default. See workflow/batch.ts. */
    maxParallel: z.number().int().positive().default(1),
    /**
     * Reserved, and inert in this version: Trackwright has no merge command and never merges or
     * pushes, whatever this is set to. Kept in the schema (default false) only so config files
     * written by earlier `trackwright init` runs keep loading under the strict schema.
     */
    autoMerge: z.boolean().default(false),
    /** The branch tickets are meant to be merged into. null (default) means "the first of
     * main/master that exists". Used as the diff base for code review/verification, as the
     * Awaiting Merge target-branch compatibility check, and protected like main/master (run/batch
     * refuse to execute on it). Set it for a project whose trunk is e.g. "dev". */
    targetBranch: z.string().nullable().default(null),
  })
  .strict();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
