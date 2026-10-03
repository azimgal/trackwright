# Trackwright — Architecture

## Positioning

Trackwright is a **Claude-first orchestration wrapper** for ticket-driven development. It does not
try to be a general "AI provider" platform. The execution model is:

```
Project / Repository
        |
   Trackwright   (specs, lifecycle, routing, policy, evidence)
        |
   Claude Code    (the execution engine)
        |
Git / CI / Repository / Design tools / Test runners
```

Trackwright owns the *process* (what stage a ticket is in, who runs next, what evidence is
required, what counts as done). Claude Code is the thing that actually reads code, writes code,
reviews code, and judges whether a ticket's acceptance criteria were met. Trackwright never
re-implements what an LLM agent already does well; it constrains, sequences, and audits it.

This project is developed independently. Its design was informed by studying spec-driven-development
tooling in general (OpenSpec, GitHub Spec Kit, Kiro Specs, BMAD Method) and by patterns validated in
a private reference implementation. No code, configuration, or files from any reference system are
copied into this repository, and this project has no runtime dependency on any of them.

## Claude-first, not provider-agnostic

Trackwright talks to Claude Code directly, through its own non-interactive invocation
(`claude -p ... --output-format json`), not through an abstracted "LLM provider" interface. This is
a deliberate MVP decision, not an oversight:

- A `ModelProvider` abstraction good enough to cover materially different agentic CLIs (different
  tool-calling semantics, different permission models, different structured-output guarantees) is a
  non-trivial design problem in its own right. Building it before a single real Claude-only version
  works would be solving a harder problem before the easier one is even validated.
- The **stage input/output contract** (see below) is intentionally provider-shaped-agnostic — it is
  just "structured JSON in, structured JSON out, against a schema." That seam is left in place on
  purpose so a future adapter for another CLI could in principle satisfy the same contract. Nothing
  about *that* contract needs to change to add a second provider later; only `ClaudeRunner`'s
  concrete invocation code is Claude-specific.

## Core concepts

### Ticket (source of truth)

One markdown file per ticket, YAML frontmatter + structured sections. Not split into separate
proposal/spec/design/tasks files — a ticket is one artifact, and it grows sections as it moves
through stages. See `src/tickets/schema.ts` (the canonical section list is `TICKET_SECTIONS`, the
frontmatter shape is `ticketFrontmatterSchema`) for the exact, enforced shape — there is no
separate generated doc to fall out of sync with it.

### State machine

A **declarative** table of stages and legal transitions (`src/workflow/state-machine.ts`), not
scattered `if`/`else`. Stages:

```
planning -> architecture -> design -> ready -> development -> code-review
  -> testing -> verification -> awaiting-merge -> done
```

Each transition has entry conditions, a runner (which agent/check executes), exit conditions, and a
set of legal failure outcomes with their own next-stage routing. Illegal transitions are rejected by
the engine, not by convention.

### Claude Runner

Every stage invocation is a **fresh, isolated `claude -p` process** — not a shared conversation. This
gives context isolation for free: the planning run does not leak into the implementation run, and
critically, the **verification run never sees the implementer's reasoning or plan** — only the
ticket's Requirements/Acceptance Criteria/Definition of Done and the final diff plus test evidence.
`ClaudeRunner` wraps: process spawn, timeout, structured JSON parsing/validation, retry, and failure
classification. See `src/claude/runner.ts`.

**Two implementation details learned empirically, not assumed:**

- On Windows, the global `claude` binary is an npm `.cmd` shim, which Node can only start through
  `cmd.exe` — and Node's `shell: true` does not escape arguments, it only space-joins them (a tool
  pattern like `Bash(git add*)` or a path with a space arrived split, and the multi-line system
  prompt could not cross `cmd.exe` at all). `runner.ts` therefore resolves the binary itself: a
  real `.exe` is started directly with no shell; a `.cmd`/`.bat` shim gets every argument
  explicitly quoted and caret-escaped for `cmd.exe`. The system prompt is passed as a temporary file
  (`--system-prompt-file`), and ticket/diff content only ever travels over stdin.
- Passing the JSON-output contract only in the system prompt is not reliably followed — real
  invocations sometimes answered with a clarifying question instead of JSON. Every agent's task
  prompt (not just its system prompt) restates the exact JSON shape expected, concretely, right
  where generation starts — see `agents/registry.ts`'s `outputContract()` and how each
  `buildTaskPrompt()` uses it, and `runner.ts`'s trailing reminder appended to every prompt. Verify
  this still holds for your own Claude Code version with `node scripts/real-claude-smoketest.mjs`.

### Discipline routing

Tickets are classified by `discipline` (`design` | `development` | `infrastructure`) and, for
`development`, `specialization` (`frontend` | `backend` | `mobile` | `null`). A ticket may also
declare `secondary_disciplines` and `secondary_specializations` (`ticket create --secondary`).
Routing decides: which implementer runs Development (none for `design`, whose deliverable is the
approved design artifact), whether code review applies, whether a design gate applies, and whether
the ticket may ever be claimed merge-eligible (`src/policies/routing.ts`); requirements are unioned
across routes. Per-specialization check commands come from `checksBySpecialization`.
Multi-discipline tickets fan out to multiple implementers **only inside the Development stage**,
then fan back in to a single Code Review / Testing / Verification / Awaiting Merge pass. The
pipeline stays linear; in this version the fan-out runs sequentially in one working tree.

### Awaiting Merge

Not "waiting for a human." A machine stage that runs the expensive, repo-wide checks (full test
suite, e2e, clean-environment build, stale-evidence re-check, "does this still apply cleanly to the
current target branch") **off** the tight iterate-fix-iterate loop of Development/Code
Review/Testing, so that loop stays fast and a ticket sitting in Awaiting Merge does not block the
next ticket from starting Development. Checks are configured per-project as three tiers in
`.trackwright/config.yaml`'s `checks` block — `checks.fast` (run at the end of Development, e.g.
format/lint/typecheck), `checks.test` (run at Testing), `checks.premerge` (run here, at Awaiting
Merge). Awaiting Merge, read-only and in order: re-checks verification staleness (project code
changed -> back to Testing), dependencies (any no longer done -> BLOCKED), design sync (a
design-gated ticket must still be synced to an approved artifact whose Requirements hash matches),
target-branch compatibility (`targetBranch`, else main/master, advanced past this branch's base ->
BLOCKED, with conflicting files from `git merge-tree`), then runs `checks.premerge`. The verdict is
recorded on the evidence record as `mergeEligible` + `mergeReasons`. Trackwright computes
eligibility; it never merges, pushes, fetches, or rebases.

### Verification, independent of implementation

`verification-agent` answers one question: *"does the final diff satisfy this ticket's Acceptance
Criteria and Definition of Done?"* — never *"is this good code"* (that's Code Review) and never
*"does it pass the test suite"* (that's Testing). Outcomes: `PASS`, `CONCERNS`, `FAIL`, `WAIVED`.
`WAIVED` can never be set by an agent — only recorded by a human, and the MVP has no automated path
that produces it.

### Evidence

Every stage run leaves a record: `run_id`, `ticket_id`, `stage`, `agent`, timestamps, `outcome`,
`attempt`, `artifacts`, `git_sha`, `failure_reason`. Evidence enables staleness detection (has the
code changed since this stage's evidence was recorded?) at the SHA level, and gives a human an
auditable trail of "what Claude did, as which agent, on what commit, with what result."

### Failure model

`RETRYABLE_FAILURE`, `BLOCKED`, `NEEDS_CLARIFICATION`, `NEEDS_REPLAN`, `VERIFICATION_FAILED`,
`CONCERNS`, `CANCELLED`, `SYSTEM_ERROR`. A bounded retry ceiling (default 3) applies to retryable
failures; beyond the ceiling the system fails closed (blocks and surfaces the failure) rather than
retrying indefinitely or silently proceeding.

### Git safety

Trackwright never pushes, force-pushes, merges, rebases, fetches, resets, or cleans — `GitRepo` has
no method for any of them (enforced by a test). Agents only ever execute on a dedicated
`trackwright/<id>` branch or batch worktree, never on `main`, `master`, or the configured
`targetBranch`; starting a run from one of those is fine, since only the new branch is written to.
Branch switches are refused over unrelated uncommitted work. There is no PR creation.

## What is explicitly out of MVP scope

- A real `ModelProvider` abstraction for non-Claude backends (seam left, not built).
- An external design provider and real visual diffing. Design Sync ships a local provider
  (drafted artifacts, human approval, Requirements-hash staleness) and a placeholder visual
  verifier that always asks a human; `src/design/` keeps the interfaces for a real one.
- Real auto-merge execution. Awaiting Merge computes `merge_eligible`; a human or a later release
  performs the actual merge.
- Any multi-provider abstraction, distributed scheduler, or production deployment tooling.

See `docs/roadmap.md` for sequencing.
