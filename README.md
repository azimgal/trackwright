# Trackwright

A Claude-first orchestration wrapper for ticket-driven development. Trackwright moves a ticket
through a declarative lifecycle — Planning, Architecture, Design, Ready, Development, Code Review,
Testing, Verification, Awaiting Merge, Done — invoking isolated Claude Code agents at each stage,
with independent verification and machine-enforced gates.

> **Status: early MVP.** This proves the core concept end-to-end (a ticket really does move through
> several stages, driven by several independently-invoked Claude agents, without a human re-typing
> a command at each step). It is not a production platform yet. See [Limitations](#limitations) and
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

## Quick start

```bash
npm install -g trackwright   # once published; for now, see "Local development" below

cd your-project
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
awaiting approval). Use `--dry-run` to exercise the whole pipeline with a scripted mock runner
instead of real Claude Code — useful for CI or trying the tool out without spending API usage.

### Local development

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

## Current MVP capabilities

- `trackwright init`, `ticket create`, `ticket list`, `ticket show`, `ticket waive`, `run`.
- A declarative ten-stage state machine that rejects illegal transitions.
- A real `ClaudeCliRunner` that spawns isolated `claude -p --output-format json` processes per
  stage, plus a `MockClaudeRunner` for deterministic tests and `--dry-run`.
- Agents: `planner`, `implementer.{generic,frontend,backend,infrastructure}`, `code-reviewer`,
  `verification-agent` — each with an explicit tool-permission profile.
- Discipline/specialization routing (`design` | `development.{frontend,backend,mobile}` |
  `infrastructure`), including multi-discipline fan-out inside the Development stage.
- A real "Awaiting Merge" stage: runs project-configured premerge checks, checks evidence
  staleness by git SHA, and computes `merge_eligible` — it does not perform a real `git merge`.
- Evidence recording (`.trackwright/evidence/<ticket>.jsonl`) with SHA-based staleness detection.
- A bounded retry ceiling (default 3) with fail-closed behavior beyond it.
- Git safety: dedicated work branches, refusal to push/commit directly to `main`/`master`, refusal
  to force-push.

## Limitations

Read this before trusting the tool with anything real:

- **No Design Sync yet.** The `design` stage is a deterministic stub: it blocks until a human sets
  `design_status: synced` by hand. See [docs/roadmap.md](docs/roadmap.md).
- **No real auto-merge.** "Awaiting Merge" computes eligibility; nothing in this repository executes
  a merge.
- **No multi-provider support.** Only Claude Code. See
  [docs/architecture.md](docs/architecture.md#claude-first-not-provider-agnostic).
- **No parallel execution across tickets.** The dependency graph (`dependencies` field) is read for
  readiness, but there is no scheduler running multiple tickets concurrently yet.
- **`architecture` and `mobile` implementation are stubs/gaps.** Architecture review is a
  deterministic check for unresolved clarification markers, not a real review agent. There is no
  dedicated mobile implementer agent yet — mobile-specialization tickets currently route to the
  generic implementer (`policies/routing.ts` flags this explicitly via `isMobileGap`).
- **This is young software.** It has automated tests and one independent review pass (see below),
  not months of production use.

## Roadmap

See [docs/roadmap.md](docs/roadmap.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and
[SECURITY.md](SECURITY.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).
