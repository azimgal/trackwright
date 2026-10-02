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
    /** `trackwright batch` only — how many tickets within one dependency wave may run
     * concurrently, each in its own git worktree. 1 (the default) means always serial, even
     * within a wave — the safest possible default. See workflow/batch.ts. */
    maxParallel: z.number().int().positive().default(1),
    /**
     * Default: false. `trackwright run` NEVER merges regardless of this setting — only an
     * explicit, separate `trackwright ticket merge <id>` invocation ever does, and only when this
     * is true AND every one of that command's own guards passes (see cli/commands/ticket-merge.ts).
     * This is an opt-in switch for whether that command is even allowed to run at all, not a
     * switch that makes merging happen automatically on its own.
     */
    autoMerge: z.boolean().default(false),
    /** Branch `ticket merge` merges into. Defaults to null, meaning "the first of main/master
     * that exists" (the same candidates GitRepo.diffAgainstBase already uses) — set this
     * explicitly for a project whose trunk isn't main/master (e.g. "dev"). */
    targetBranch: z.string().nullable().default(null),
  })
  .strict();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
