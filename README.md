# Trackwright

A Claude-first orchestration wrapper for ticket-driven development. Trackwright moves a ticket
through a declarative lifecycle — Planning, Architecture, Design, Ready, Development, Code Review,
Testing, Verification, Awaiting Merge, Done — invoking isolated Claude Code agents at each stage,
with independent verification and machine-enforced gates.

> **Status: early MVP.** This proves the core concept end-to-end (a ticket really does move through
> several stages, driven by several independently-invoked Claude agents, without a human re-typing
> a command at each step). It is not a production platform yet. See [Known limitations](#known-limitations) and
> [Roadmap](docs/roadmap.md) below before relying on it for anything that matters.

## What this is

```
Project / Repository
        |
   Trackwright   (specs, lifecycle, routing, policy, evidence)
        |
   Claude Code    (the execution engine)
        |
Git / CI / Repository
```

One ticket = one markdown file = the source of truth for a piece of work: its requirements,
acceptance criteria, plan, tasks, and (once it's been through verification) the evidence that it
was actually checked, independently, against what it asked for.

## Why not just use OpenSpec / Spec Kit / Kiro / BMAD?

Trackwright isn't trying to replace these — it takes a different, narrower bet:

- **One ticket, not four files.** OpenSpec's proposal/spec/design/tasks split is real and useful for
  some teams, but it's also a source of drift: four files that all need to stay in sync as a change
  evolves. Trackwright keeps one ticket file that grows sections as it moves through stages.
- **Claude-first, not provider-agnostic.** GitHub Spec Kit, Kiro, and BMAD all support or aim at
  multiple agentic backends. Trackwright deliberately does not build that abstraction yet — it talks
  to Claude Code directly, because building a good enough multi-provider abstraction is a harder
  problem than the one this project is trying to solve first. See
  [docs/architecture.md](docs/architecture.md#claude-first-not-provider-agnostic).
- **Verification is structurally independent, not just a persona.** Trackwright's verification agent
  never sees the implementer's plan or reasoning — only the ticket's Requirements/Acceptance
  Criteria/Definition of Done and the final diff. This is enforced in code (see
  `agents/registry.ts`), not just convention.
- **"Awaiting Merge" is a real stage**, not a status. Heavy, repo-wide checks run there, off the
  tight Development/Review/Testing loop, so the fast loop stays fast.

If none of that distinction matters for your use case, the other tools are more mature and better
resourced — use them.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full picture: the state machine, discipline
routing, the Claude Runner's isolation guarantees, evidence, and the failure model.

## Prerequisites

- **Node.js >= 20** (see `engines` in `package.json`).
- **A git repository.** Every project Trackwright runs against must already be a git repo —
  `trackwright init` does not create one for you.
- **The `claude` CLI, installed and authenticated**, for anything other than `--dry-run`.
  Trackwright spawns it as a subprocess (`claude -p --output-format json ...`) once per stage; it
  does not call any API directly and has no API key configuration of its own. `--dry-run` uses a
  built-in mock runner instead and needs no `claude` installation at all.
- **Windows, macOS, and Linux** are all supported. See [Windows notes](#windows-notes) below —
  there is one Windows-specific permission detail worth knowing about.

## Installation

Not yet published to npm. Until then, build and install from a local tarball or via `npm link`:

```bash
git clone <this repo>
cd trackwright
npm install
npm run build
npm pack                      # produces trackwright-<version>.tgz

cd your-project
npm install /path/to/trackwright-<version>.tgz
npx trackwright --help        # or `npx tw --help` — both binaries are installed
```

Or, for iterating on Trackwright itself without repacking on every change:

```bash
cd trackwright && npm link
cd your-project && npm link trackwright
```

## Quick start

```bash
cd your-project                  # must already be a git repository
trackwright init --prefix TW

trackwright ticket create \
  --title "Add a hello endpoint" \
  --context "Users need a trivial health-check endpoint." \
  --discipline development --specialization backend

trackwright run TW-0001
```

`trackwright run` drives the ticket through the pipeline automatically, invoking a fresh, isolated
Claude Code process per stage, until it reaches `done` or hits a stage that genuinely needs a human
(an unresolved `CONCERNS` verification outcome, a blocked dependency, an architecture decision
awaiting approval, or a retry ceiling exceeded). Use `--dry-run` to exercise the whole pipeline with
a scripted mock runner instead of real Claude Code — useful for CI or trying the tool out without
spending API usage.

### Local development (working on Trackwright itself)

```bash
git clone <this repo>
cd trackwright
npm install
npm run build
node dist/cli/index.js --help
```

To verify the real (non-mock) Claude Code integration on your machine — requires `claude` installed
and authenticated:

```bash
node scripts/real-claude-smoketest.mjs
```

## CLI command reference

| Command | What it does |
|---|---|
| `trackwright init [-p/--prefix <prefix>]` | Creates `.trackwright/config.yaml` in the current (or `-C`) project. Idempotent — running it again on an already-initialized project leaves the config untouched and tells you so. Commits the config file itself if the project is a git repo. |
| `trackwright ticket create -t <title> -c <context> -d <discipline> [-s <specialization>] [-f <flow>]` | Creates a new ticket at `planning` stage. `discipline` is `design`\|`development`\|`infrastructure`; `specialization` (`frontend`\|`backend`\|`mobile`) is only valid with `-d development`. Commits the new ticket file. |
| `trackwright ticket list` | Lists every ticket with its id, status/stage, and title. |
| `trackwright ticket show <id>` | Prints a ticket in full (frontmatter + all sections). Exits non-zero if the id doesn't exist. |
| `trackwright ticket waive <id> -r <reason>` | **Human-only.** The only way to move a ticket stuck at `verification` with an unresolved `CONCERNS` outcome into `awaiting-merge`. Refuses unless that's genuinely the ticket's current state. |
| `trackwright ticket retry <id> -r <reason>` | **Human-only.** Resets a stage's retry-ceiling counter so `run` can attempt it again — for when the underlying cause (a rate limit, a misconfiguration you've since fixed) is no longer true. Refuses unless the ceiling has genuinely been exceeded. Never re-runs anything itself; just clears the way for the next `run`. |
| `trackwright run <ticketId> [--dry-run] [--max-steps <n>] [--skip-branch]` | Drives a ticket forward, one real stage transition per step, until `done`, a stage that needs a human, or `--max-steps` (default 20) is reached. Safe to re-run at any time — it always resumes from the ticket's current stage. |
| `trackwright design approve <designId>` | **Human-only.** Approves a design artifact, which flips the owning ticket's `design_status` to `synced` so the Ready gate and staleness checks see it. |
| `trackwright design show <designId>` | Prints a design artifact as JSON. Exits non-zero if it doesn't exist. |
| `trackwright design list <ticketId>` | Prints the latest design artifact for a ticket, or a plain "none yet" message (exit 0 — most tickets have no design artifact, that's normal). |

Every command accepts `-C/--cwd <dir>` to target a project other than the current directory, and
`-h/--help` for its own usage text.

## Lifecycle

```
planning → architecture → design → ready → development → code-review → testing
  → verification → awaiting-merge → done
```

Each stage is either a real Claude Code agent call (planning, development, code-review,
verification) or a deterministic, no-agent check (architecture review, the design gate's rule set,
the ready gate, testing, awaiting-merge). A stage's outcome is always one of a small fixed set of
values (`SUCCESS`, `RETRYABLE_FAILURE`, `BLOCKED`, `CONCERNS`, ...) — never free text — and the
*only* place that decides what stage follows which outcome is the declarative table in
`src/workflow/state-machine.ts`. See [docs/architecture.md](docs/architecture.md) for the full
picture, including which outcomes retry automatically (bounded by the retry ceiling) versus which
always stop and wait for a human.

## Recovery: retry, resume, and what happens when something goes wrong

- **A stage can self-loop.** `RETRYABLE_FAILURE` and `SYSTEM_ERROR` retry automatically, up to
  `retryCeiling` (default 3) non-success attempts — counted from the durable evidence log, not
  memory, so it survives a process restart.
- **Past the ceiling, or on `BLOCKED`/`CONCERNS`, `run` stops and tells you why.** It never
  retries forever and never silently proceeds.
- **If the cause was transient** (a session limit that's since reset, a misconfiguration you've
  fixed), run `trackwright ticket retry <id> -r "<why it's safe now>"` and then `trackwright run
  <id>` again. `ticket retry` refuses if the ceiling hasn't actually been exceeded — it is not a
  way to skip a stage, only to give it another real attempt.
- **`run` is always safe to re-invoke.** It re-reads the ticket's current stage from disk every
  time, so a crashed or interrupted `run` resumes exactly where it left off — it does not
  re-process stages that already completed, and does not need to be told where to pick up.
- **Trackwright commits its own bookkeeping as it goes**, one small commit per real stage
  transition, containing *only* that ticket's own markdown file — never your project's files, and
  never via `git add -A`. This is what makes `run` resumable even after an interrupted process:
  the ticket's stage is durably committed, not just sitting in an uncommitted working tree.
  `.trackwright/evidence/` (the full audit log — every attempt, outcome, cost, and failure reason)
  is deliberately *not* committed; it's local, append-only, and per-machine.
- **A ticket's own branch.** `run` checks out (creating if needed) a dedicated `trackwright/<id>`
  branch before doing anything — it refuses outright to run on a protected branch (`main`/
  `master`), and refuses to switch *onto* a different branch while the working tree has real,
  unrelated uncommitted changes. It never touches a branch it didn't create for anything
  destructive: there is no `push`, `force-push`, or destructive `reset`/`clean` capability
  anywhere in this codebase, for any branch.

## Evidence and the human merge checkpoint

Every stage attempt — success or failure — is appended to
`.trackwright/evidence/<ticketId>.jsonl`: the agent, outcome, attempt number, git SHA, cost, and
(on failure) why. This is the audit trail a human reads to understand what actually happened,
independent of what the ticket file's current stage says.

**Trackwright never pushes, and never merges.** `awaiting-merge` runs your project's premerge
checks and computes `merge_eligible: true/false` — that's it. Taking a `done`, `merge_eligible:
true` ticket and actually merging/pushing it is always a deliberate step a human takes themselves,
on purpose, outside Trackwright. This is a stated design choice, not a missing feature: see
`docs/architecture.md`'s git-safety section.

## Windows notes

Trackwright is developed and dogfooded primarily on Windows (including project paths containing
spaces and non-ASCII characters) and works correctly there. One thing worth knowing: Claude Code
offers both a Bash tool and a PowerShell tool on Windows, and the model can pick either one when
running the git commands its system prompt instructs it to use. Every agent's `allowedTools` lists
matching `Bash(...)` and `PowerShell(...)` permission patterns for exactly this reason — if you
ever extend an agent's permitted git commands, add both, or the agent will hit a confusing,
silent permission denial the moment the model happens to choose the other shell.

## Current MVP capabilities

- The full CLI surface in the [command reference](#cli-command-reference) above.
- A declarative ten-stage state machine that rejects illegal transitions.
- A real `ClaudeCliRunner` that spawns isolated `claude -p --output-format json` processes per
  stage, plus a `MockClaudeRunner` for deterministic tests and `--dry-run`.
- Agents: `planner`, `implementer.{generic,frontend,backend,mobile,infrastructure}`, `code-reviewer`,
  `verification-agent`, `design-gate-agent` — each with an explicit tool-permission profile and a
  symmetric "write your outcome exactly, never a paraphrase" contract.
- Discipline/specialization routing (`design` | `development.{frontend,backend,mobile}` |
  `infrastructure`), including multi-discipline fan-out inside the Development stage.
- `code-review` and `verification` both judge an engine-provided, bounded diff (project files
  only — Trackwright's own bookkeeping is excluded) rather than depending on the agent's own live
  `git diff` call succeeding.
- A real "Awaiting Merge" stage: runs project-configured premerge checks, checks evidence
  staleness against the most recent *project-relevant* commit (Trackwright's own bookkeeping
  commits never count as "the project changed"), and computes `merge_eligible` — it does not
  perform a real `git merge`.
- Evidence recording (`.trackwright/evidence/<ticket>.jsonl`) with SHA-based staleness detection,
  and a human-auditable, reasoned escape hatch (`ticket retry`) for a ceiling exceeded by a
  transient cause.
- A bounded retry ceiling (default 3) with fail-closed behavior beyond it.
- Git safety: dedicated work branches, refusal to run on `main`/`master`, and no push/force-push/
  destructive-reset capability at all anywhere in the codebase — not just disallowed by policy,
  but structurally absent.

## Known limitations

Read this before trusting the tool with anything real. Split by kind, so "intentional for now" and
"not yet built" aren't confused with each other:

**Design limitations (deliberate, not bugs):**
- Trackwright never pushes and never merges — see [above](#evidence-and-the-human-merge-checkpoint).
  This is permanent, not a gap to be filled later.
- `config.yaml`'s `checks.*` commands and `claude.binary` run with the same trust level as a
  `package.json` script — anyone who can edit your repo's config can already run arbitrary shell
  commands via it, the same as they could via `package.json`. This is accepted, not hardened
  against, because hardening it alone wouldn't change the actual trust boundary.

**MVP scope limitations (will likely be filled in, not built yet):**
- **No real Design Sync.** The `design` stage is a deterministic rule set plus a human-approval
  gate (`trackwright design approve`); there is no agent-driven visual design workflow.
- **No real auto-merge execution.** `awaiting-merge` computes `merge_eligible`; nothing executes
  the merge. (Also a design choice, see above — but the mechanical "execute it" part specifically
  could be added as an explicit, human-invoked command later without changing the human-checkpoint
  principle.)
- **No multi-provider support.** Only Claude Code. See
  [docs/architecture.md](docs/architecture.md#claude-first-not-provider-agnostic).
- **No parallel execution across tickets.** The dependency graph (`dependencies` field) is read for
  readiness, but there is no scheduler running multiple tickets concurrently yet.
- **Mobile support is a routing + configuration contract, not a bundled toolchain.**
  `development.mobile` tickets route to a dedicated `implementer.mobile` agent, and a project can
  give mobile (or frontend/backend) its own `fast`/`test`/`premerge` commands via
  `checksBySpecialization` in `config.yaml`. Trackwright does not ship or assume any Android/iOS
  SDK, emulator, or simulator — your configured commands decide what "mobile tests pass" means.
- **Architecture review is a stub.** It's a deterministic check for unresolved clarification
  markers in a ticket's "Architecture decisions" section, not a real review agent.

**Platform limitations:**
- Windows is fully supported; see [Windows notes](#windows-notes).
- Paths containing spaces or non-ASCII characters are supported and exercised in this project's own
  dogfooding, on both Windows and the underlying git/Claude CLI invocations.

**Claude/model limitations (inherent to an LLM agent in the loop, mitigated but not eliminated):**
- An agent occasionally writes an outcome value that isn't in its own contract (observed: "FAILURE"
  instead of a real enum value). The engine always rejects this deterministically (never silently
  accepted) and retries with a note about what went wrong — but it costs a wasted invocation each
  time it happens.
- An implementer that reports `SUCCESS` without actually committing its work is caught
  deterministically (a real `git status` check, not trust in the agent's word) — but an
  implementer that reports `SUCCESS` having made *no* real change at all, committed or not, is not
  currently caught before Code Review/Verification would eventually notice.
- Resuming a ticket whose implementer work is already correct relies on the next implementer
  invocation recognizing that and not redoing it — validated empirically across multiple real
  dogfood runs, but not a mechanically-enforced guarantee the way the commit check above is.

**Known non-blocking issues:**
- None currently open as of this audit — all issues found during the release-readiness pass were
  fixed and covered by regression tests (see commit history).

## Roadmap

See [docs/roadmap.md](docs/roadmap.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and
[SECURITY.md](SECURITY.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).
