# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security vulnerability. Instead, report it
privately via GitHub's ["Report a vulnerability"](../../security/advisories/new) flow on this
repository, or by opening a private security advisory. Include reproduction steps and the version
you're using. We'll acknowledge reports as soon as we can.

## What Trackwright does that has real security surface

Being upfront about this, since it's relevant to anyone deciding whether to run this against a real
repository:

- **It spawns Claude Code processes with tool access** (`Read`/`Write`/`Edit`/`Bash`, scoped per
  agent — see `agents/registry.ts`) against your project directory. Implementer agents can read,
  write, and edit files within `--add-dir <your project>`; their only pre-approved shell commands
  are `git add`/`git commit` (`git push`, `git reset --hard`, `git clean` are explicitly denied).
  Review/verification agents are read-only plus `git diff`/`git log`. Ticket, repository, and diff
  content is passed to agents only as task data over stdin, never as arguments or system prompt.
- **`policies/checks.ts` runs shell commands from your project's `.trackwright/config.yaml`** with
  `shell: true`. This is intentional and trusted the same way `npm run <script>` trusts
  `package.json` — but it means anyone who can edit your project's Trackwright config can run
  arbitrary commands when a ticket reaches Testing/Awaiting Merge. Treat `.trackwright/config.yaml`
  with the same review scrutiny as `package.json` scripts or a CI workflow file.
- **It never pushes, force-pushes, or merges, and never lets an agent execute on `main`/`master`/`targetBranch`** in
  the current MVP — see `git/safety.ts`. These are enforced in code, not just documented as a
  convention, but they are still worth verifying yourself before trusting a new version.
- **No agent can set a `WAIVED` verification outcome.** Only the `trackwright ticket waive` CLI
  command (a human, at a terminal) can — see `cli/commands/waive.ts`.

## What we ask contributors to keep true

- Never widen an agent's `allowedTools` in `agents/registry.ts` without a corresponding update to
  its `forbiddenActions` documentation and, if relevant, a test.
- Never make `git/safety.ts`'s protected-branch or force-push guards conditional/bypassable by
  ticket content — only by explicit, reviewed code changes.
- Never let a retryable failure loop unboundedly — respect `DEFAULT_RETRY_CEILING` (see
  `workflow/outcomes.ts`) and the fail-closed behavior in `workflow/engine.ts`.

## Supported versions

This project is pre-1.0. Only the latest published version receives fixes.
