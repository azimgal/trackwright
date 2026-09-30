import { describe, expect, it } from 'vitest';
import { nextStage, IllegalTransitionError, isTerminal, runnerFor } from '../src/workflow/state-machine.js';
import { STAGES } from '../src/workflow/stages.js';

describe('state machine', () => {
  it('knows about every declared stage', () => {
    for (const stage of STAGES) {
      expect(() => runnerFor(stage)).not.toThrow();
    }
  });

  it('allows the documented happy-path transitions', () => {
    expect(nextStage('planning', 'SUCCESS')).toBe('architecture');
    expect(nextStage('architecture', 'SUCCESS')).toBe('design');
    expect(nextStage('design', 'SUCCESS')).toBe('ready');
    expect(nextStage('ready', 'SUCCESS')).toBe('development');
    expect(nextStage('development', 'SUCCESS')).toBe('code-review');
    expect(nextStage('code-review', 'SUCCESS')).toBe('testing');
    expect(nextStage('testing', 'SUCCESS')).toBe('verification');
    expect(nextStage('verification', 'SUCCESS')).toBe('awaiting-merge');
    expect(nextStage('awaiting-merge', 'SUCCESS')).toBe('done');
  });

  it('routes code-review and testing retryable failures back to development', () => {
    expect(nextStage('code-review', 'RETRYABLE_FAILURE')).toBe('development');
    expect(nextStage('testing', 'RETRYABLE_FAILURE')).toBe('development');
  });

  it('routes verification failure back to development, and awaiting-merge staleness back to testing', () => {
    expect(nextStage('verification', 'VERIFICATION_FAILED')).toBe('development');
    expect(nextStage('awaiting-merge', 'VERIFICATION_FAILED')).toBe('testing');
  });

  it('keeps CONCERNS at verification (never auto-advances)', () => {
    expect(nextStage('verification', 'CONCERNS')).toBe('verification');
  });

  it('rejects a transition not defined for a given (stage, outcome) pair', () => {
    expect(() => nextStage('ready', 'VERIFICATION_FAILED')).toThrow(IllegalTransitionError);
    expect(() => nextStage('done', 'SUCCESS')).toThrow(IllegalTransitionError);
  });

  it('treats "done" as the only terminal stage', () => {
    expect(isTerminal('done')).toBe(true);
    for (const stage of STAGES) {
      if (stage !== 'done') expect(isTerminal(stage)).toBe(false);
    }
  });
});
