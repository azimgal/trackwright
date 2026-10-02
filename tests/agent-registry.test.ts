import { describe, expect, it } from 'vitest';
import { getAgent, AGENTS } from '../src/agents/registry.js';

/**
 * Regression coverage for a real gap found twice during the DF-0007 dogfood run: the
 * verification-agent's system prompt introduced "PASS"/"FAIL" as mnemonic glosses for the real
 * "SUCCESS"/"VERIFICATION_FAILED" contract values (matching docs/architecture.md's own
 * conceptual vocabulary), and the model copied the mnemonic into the JSON "outcome" field itself
 * (as "FAILURE") instead of the real enum value — twice, in two independent real invocations.
 * Engine.ts correctly rejected the non-conforming outcome as SYSTEM_ERROR and the existing
 * previousFailureNote retry mechanism self-corrected it, but each occurrence still burns a real
 * Opus call and a retry-ceiling attempt. This test guards against reintroducing the standalone
 * mnemonics that caused it.
 */
describe('verification-agent system prompt', () => {
  it('names every valid outcome by its exact contract value', () => {
    const prompt = getAgent('verification-agent').buildSystemPrompt();
    for (const outcome of ['SUCCESS', 'VERIFICATION_FAILED', 'CONCERNS', 'SYSTEM_ERROR']) {
      expect(prompt).toContain(outcome);
    }
  });

  it('explicitly warns against the exact paraphrases the model used in practice, as invalid', () => {
    // Found via real dogfooding: PASS/FAIL were previously presented as if they were the real
    // contract vocabulary (mirroring docs/architecture.md's own conceptual PASS/CONCERNS/FAIL/
    // WAIVED naming), and the model echoed "FAILURE" into the JSON outcome field instead of
    // "VERIFICATION_FAILED" — twice, in two independent invocations. They may still appear, but
    // only inside an explicit "these are not valid values" warning, never as presented vocabulary.
    const prompt = getAgent('verification-agent').buildSystemPrompt();
    expect(prompt).toMatch(/paraphrase.*"PASS".*"FAIL".*"FAILURE".*not valid/s);
  });
});

/**
 * Regression coverage for a real gap found three times during the DF-0007 dogfood run: the
 * "don't prefix a scoped Bash command with `cd ... &&`" warning (see noCdPrefixWarning in
 * registry.ts) previously existed only in the implementer's system prompt. code-reviewer and
 * verification-agent — which also run scoped `Bash(git diff*)`/`Bash(git log*)` commands — did
 * not have it, and real evidence from the DF-0007 run (.trackwright/evidence/DF-0007.jsonl)
 * recorded permission_denials for exactly this `cd "..." && git ...` pattern on both agents, each
 * still returning SUCCESS (the model noticed and disclosed the gap in its own summary each time,
 * but that is not a guarantee). Every Bash-using agent's prompt must carry this warning.
 */
describe('Bash-using agents all warn against a leading "cd"', () => {
  it.each(['implementer.backend', 'code-reviewer', 'verification-agent'])(
    '%s system prompt warns against prefixing commands with "cd ... &&"',
    (agentName) => {
      const prompt = getAgent(agentName).buildSystemPrompt();
      expect(prompt).toMatch(/never prefixed with `cd \.\.\. &&`/);
      expect(prompt).toContain('silently blocked');
    },
  );

  it('design-gate-agent has no Bash access, so needs no such warning', () => {
    const agent = getAgent('design-gate-agent');
    expect(agent.allowedTools.some((t) => t.startsWith('Bash'))).toBe(false);
    expect(agent.disallowedTools).toContain('Bash');
  });
});

/**
 * Regression coverage for a real, 100%-reproducible gap found on DF-0008 and again on DF-0009:
 * Claude Code offers Bash AND PowerShell as independent shell tools on Windows, and a scoped
 * allowedTools pattern like `Bash(git add*)` does not also cover `PowerShell(git add*)` — they
 * are matched separately. The model, having had an earlier Bash attempt denied (e.g. for a `cd
 * ...` prefix or an out-of-scope compound command), reliably retried the *same* git command via
 * PowerShell next — which no agent here had ever allow-listed, since every one only ever listed
 * Bash patterns. Confirmed via a standalone `claude -p` repro against this exact ticket's working
 * tree: identical `PowerShell(git add ...)`/`PowerShell(git commit ...)` calls were denied every
 * time with only the Bash patterns present, and succeeded with zero denials once the matching
 * PowerShell(...) patterns were added — exactly the fix below.
 */
describe('every Bash-scoped git permission has a matching PowerShell one', () => {
  function bashPatterns(tools: readonly string[]): string[] {
    return tools.filter((t) => t.startsWith('Bash(')).map((t) => t.slice('Bash('.length));
  }
  function powerShellPatterns(tools: readonly string[]): string[] {
    return tools.filter((t) => t.startsWith('PowerShell(')).map((t) => t.slice('PowerShell('.length));
  }

  it.each(['implementer.backend', 'code-reviewer', 'verification-agent'])(
    '%s: every allowed Bash(...) git pattern has a PowerShell(...) twin',
    (agentName) => {
      const agent = getAgent(agentName);
      expect(powerShellPatterns(agent.allowedTools).sort()).toEqual(bashPatterns(agent.allowedTools).sort());
      expect(powerShellPatterns(agent.disallowedTools).sort()).toEqual(bashPatterns(agent.disallowedTools).sort());
    },
  );

  it('implementer can actually stage and commit (the exact real-world failure)', () => {
    const agent = getAgent('implementer.backend');
    expect(agent.allowedTools).toContain('Bash(git add*)');
    expect(agent.allowedTools).toContain('PowerShell(git add*)');
    expect(agent.allowedTools).toContain('Bash(git commit*)');
    expect(agent.allowedTools).toContain('PowerShell(git commit*)');
  });
});

/**
 * Symmetry coverage from the release-readiness audit's agent-contract pass: the "write the
 * outcome value exactly, never a paraphrase" treatment was previously verification-agent-only,
 * even though the implementer independently hit the exact same "FAILURE" paraphrase on DF-0009.
 * Every agent's system prompt must now list every one of its own validOutcomes by exact value —
 * this test fails if a future agent (or a future validOutcomes change) ever drifts out of sync
 * with its own prompt.
 */
describe('every agent documents every one of its valid outcomes in its own prompt', () => {
  it.each(Object.keys(AGENTS))('%s prompt mentions every value in its validOutcomes', (agentName) => {
    const agent = getAgent(agentName);
    const prompt = agent.buildSystemPrompt();
    for (const outcome of agent.validOutcomes) {
      expect(prompt).toContain(`"${outcome}"`);
    }
  });
});
