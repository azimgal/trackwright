import { describe, expect, it } from 'vitest';
import { getAgent } from '../src/agents/registry.js';

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
