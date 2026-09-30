# Contributing to Trackwright

Thanks for considering a contribution. This is a young project — process is intentionally light.

## Getting started

```bash
git clone <this repo>
cd trackwright
npm install
npm run build
npm test
```

## Before opening a PR

- `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` should all pass.
- Add or update tests for behavior you change — see `tests/`. `tests/engine.test.ts` is the most
  thorough example of testing the workflow engine with `MockClaudeRunner`.
- If you touch `docs/architecture.md`-level decisions (the state machine, the Claude Runner
  contract, discipline routing, the failure model), update that doc in the same PR — it should
  never fall behind the code it describes.
- Keep commits small and meaningful; squash noisy WIP history before opening the PR.

## Design principles to keep in mind

These aren't arbitrary — see `docs/architecture.md` for the reasoning behind each:

1. **Claude-first.** Don't add a generic "AI provider" abstraction as a load-bearing part of the
   architecture. The stage input/output contract (`claude/types.ts`) is the seam left for that;
   the current implementation (`claude/runner.ts`) is deliberately Claude-specific.
2. **One ticket, not four files.** Requirements/Acceptance Criteria/Plan/Tasks/Verification
   evidence all live in the same ticket file, as sections. Don't reintroduce a
   proposal/spec/design/tasks split.
3. **Verification stays isolated.** The verification agent's prompt (`agents/registry.ts`,
   `VERIFICATION_AGENT.buildTaskPrompt`) must never include the implementer's Plan or notes — only
   Requirements/Acceptance Criteria/Definition of Done and the final diff. If you're tempted to pass
   it more context "to help it decide," don't — that's the whole point of the isolation.
4. **Fail closed.** When in doubt about whether an outcome should let a ticket proceed or stop it,
   stop it. The retry ceiling, the state machine's illegal-transition rejection, and `WAIVED` being
   unreachable by any agent are all instances of this — new code should follow the same instinct.
5. **`WAIVED` is human-only.** No agent's `validOutcomes` in `agents/registry.ts` should ever include
   `WAIVED`. The only writer of a `WAIVED` evidence record is `cli/commands/waive.ts`.

## Reporting security issues

See [SECURITY.md](SECURITY.md) — please do not open a public issue for a security vulnerability.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
