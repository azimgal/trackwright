# Trackwright — Roadmap

## MVP (this repository, current state)

Goal: prove that a ticket can move through several lifecycle stages, driven by several
independently-invoked Claude agents, automatically, without a human re-typing a command at each
stage — while staying honest about what is real and what is a documented stub.

In scope:

- `trackwright init` — bootstrap `.trackwright/` config in a target repository.
- `trackwright ticket create` — create a ticket file from the schema/template.
- `trackwright run <ticket>` — drive a ticket through the state machine, stage by stage.
- Declarative state machine covering all ten stages (`planning` through `done`), including
  `awaiting-merge` as a real, checked stage.
- `ClaudeRunner` with real headless Claude Code invocation, plus a `MockRunner` used by the test
  suite and available for CI/dogfood runs where no Claude credentials are configured.
- Agents: `planner`, `implementer.{generic,frontend,backend,mobile,infrastructure}`,
  `code-reviewer`, `verification-agent`, `design-gate-agent`. Each with an explicit permission profile
  (allowed/forbidden tools, read vs write).
- Discipline/specialization routing table driving agent selection and required checks.
- Evidence recording with SHA-based staleness detection.
- Failure model with a bounded retry ceiling and fail-closed behavior beyond it.
- Git safety helpers (dedicated branch, no force-push, no direct push to protected branches).
- Automated tests for parsing, state transitions (legal and illegal), routing, retry ceiling,
  evidence, verification-outcome handling, Awaiting Merge eligibility, config, and `init`.
- A fixture/example repository and one end-to-end dogfood run through the pipeline.

Not in scope (explicitly deferred, see below):

- Multi-provider `ModelProvider` abstraction.
- Full Design Sync (Claude Design integration, live visual diffing).
- Real auto-merge execution.
- Distributed scheduling. (`trackwright batch` does run dependency waves locally, with optional
  scope-gated concurrency in git worktrees — but nothing beyond one machine and one invocation.)
- A hosted/service deployment of any kind. This is a CLI you run in your own repository.

## After MVP (indicative, not committed)

1. **Design Sync** — wire `src/design/` to a real design-artifact source and a visual-diff check,
   behind the same `design-gate`/`design-sync` stage boundary already reserved in the state machine.
2. **Parallel fan-out inside Development** — run a multi-route ticket's implementers concurrently
   (dependency waves across tickets already exist via `trackwright batch`).
3. **Policy-engine-gated auto-merge** — a narrowly-scoped, opt-in path to real automated merging for
   low-risk ticket classes only, with the same fail-closed defaults as everything else in this
   project.
4. **A second Claude Runner backend** (e.g. a different invocation mode, or — only if there is real
   demand — a second agentic CLI) implemented against the existing stage I/O contract, without
   changing that contract.

## Non-goals

Trackwright is not trying to replace code review judgment, become a CI system, or make merge/deploy
decisions that carry real production risk without a human in the loop. Gates that current tooling
cannot safely automate (see `docs/architecture.md`) stay human by design, not by omission.
