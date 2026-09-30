#!/usr/bin/env node
/**
 * Exercises the REAL ClaudeCliRunner (not MockClaudeRunner) end to end: spawns an actual
 * `claude -p --output-format json` process, sends a trivial agent-style prompt, and verifies the
 * response parses correctly through the same envelope/JSON-in-JSON logic the workflow engine
 * relies on.
 *
 * This is deliberately NOT part of `npm test` — it costs real Claude API usage and requires the
 * `claude` CLI to be installed and authenticated on the machine running it. Run it by hand:
 *
 *   npm run build && node scripts/real-claude-smoketest.mjs
 */
import { ClaudeCliRunner } from '../dist/claude/runner.js';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';

const runner = new ClaudeCliRunner();
const cwd = mkdtempSync(path.join(tmpdir(), 'trackwright-smoketest-'));

// Mirrors how real agents in agents/registry.ts are built: the JSON contract is stated once in
// the system prompt, AND restated concretely in the task prompt itself, tied to the actual data
// being asked for — not left as an abstract schema the model has to remember and reapply. An
// earlier, thinner version of this script (system prompt only) was empirically unreliable; see
// the final report's verification notes for what that looked like and why this shape is better.
const result = await runner.invoke({
  agentName: 'smoketest',
  systemPrompt:
    'You are a smoke test agent for Trackwright. You only ever respond with a single JSON object, no markdown fences, no prose outside it.',
  prompt: `The word given to you is: pineapple

Respond with ONLY this JSON object, with "echo" set to the word above:
{"outcome": "SUCCESS", "summary": "smoke test ok", "data": {"echo": "pineapple"}}`,
  allowedTools: [],
  disallowedTools: [],
  cwd,
  model: 'haiku',
  timeoutMs: 60_000,
  permissionMode: 'dontAsk',
});

console.log(JSON.stringify(result, null, 2));

if (result.outcome !== 'SUCCESS') {
  console.error(`\nFAILED: expected outcome SUCCESS, got ${result.outcome}`);
  process.exit(1);
}
if (result.data.echo !== 'pineapple') {
  console.error(`\nFAILED: expected data.echo === "pineapple", got ${JSON.stringify(result.data.echo)}`);
  process.exit(1);
}

console.log('\nOK: real ClaudeCliRunner invocation round-tripped through the full JSON-in-JSON contract.');
