import { describe, expect, it } from 'vitest';
import { assertPushIsSafe, isProtectedBranch, ProtectedBranchError, workBranchName } from '../src/git/safety.js';

describe('git safety', () => {
  it('flags main and master as protected', () => {
    expect(isProtectedBranch('main')).toBe(true);
    expect(isProtectedBranch('master')).toBe(true);
    expect(isProtectedBranch('trackwright/tw-0001')).toBe(false);
  });

  it('refuses to push to a protected branch', () => {
    expect(() => assertPushIsSafe('main', false)).toThrow(ProtectedBranchError);
  });

  it('refuses a force push even on a non-protected branch', () => {
    expect(() => assertPushIsSafe('trackwright/tw-0001', true)).toThrow(/force-push/);
  });

  it('allows a plain push to a non-protected branch', () => {
    expect(() => assertPushIsSafe('trackwright/tw-0001', false)).not.toThrow();
  });

  it('derives a deterministic, collision-free branch name from the ticket id', () => {
    expect(workBranchName('TW-0001')).toBe('trackwright/tw-0001');
  });
});
