import type { Stage } from './stages.js';
import type { FailureOutcome, RunOutcome } from './outcomes.js';

/** Which runner executes a given stage. `none` means the stage is a pure gate/check, no agent call. */
export type RunnerKind =
  | 'planner'
  | 'architecture-review'
  | 'design-gate'
  | 'implementer'
  | 'code-reviewer'
  | 'gate-runner'
  | 'verification-agent'
  | 'awaiting-merge-check'
  | 'none';

export interface StageDefinition {
  readonly stage: Stage;
  readonly runner: RunnerKind;
  /**
   * Next stage for each outcome this stage can legitimately produce. CANCELLED and SYSTEM_ERROR
   * are handled uniformly by the engine (engine.ts) and are never listed here — every other
   * outcome a stage can produce MUST have an entry, or the engine rejects the transition.
   */
  readonly onOutcome: Partial<Record<RunOutcome, Stage>>;
}

/**
 * The declarative transition table. This is the ONLY place that decides what stage follows what
 * outcome — the workflow engine consults it and refuses any transition not listed here (see
 * `nextStage`). Every one of the ten stages from stages.ts appears, even ones the MVP's runner
 * mostly auto-skips (design, architecture) — the state machine has to *know about* every stage
 * regardless of how much of its logic is implemented yet.
 */
export const STAGE_DEFINITIONS: Readonly<Record<Stage, StageDefinition>> = {
  planning: {
    stage: 'planning',
    runner: 'planner',
    onOutcome: {
      SUCCESS: 'architecture',
      NEEDS_CLARIFICATION: 'planning',
      BLOCKED: 'planning',
    },
  },
  architecture: {
    stage: 'architecture',
    runner: 'architecture-review',
    onOutcome: {
      SUCCESS: 'design',
      NEEDS_CLARIFICATION: 'planning',
      BLOCKED: 'architecture',
    },
  },
  design: {
    stage: 'design',
    runner: 'design-gate',
    onOutcome: {
      SUCCESS: 'ready',
      NEEDS_REPLAN: 'planning',
      BLOCKED: 'design',
    },
  },
  ready: {
    stage: 'ready',
    runner: 'none',
    onOutcome: {
      SUCCESS: 'development',
      BLOCKED: 'ready',
    },
  },
  development: {
    stage: 'development',
    runner: 'implementer',
    onOutcome: {
      SUCCESS: 'code-review',
      RETRYABLE_FAILURE: 'development',
      BLOCKED: 'development',
      NEEDS_REPLAN: 'planning',
    },
  },
  'code-review': {
    stage: 'code-review',
    runner: 'code-reviewer',
    onOutcome: {
      SUCCESS: 'testing',
      // Blocking review findings are fixed in Development, not by re-running review in place.
      RETRYABLE_FAILURE: 'development',
    },
  },
  testing: {
    stage: 'testing',
    runner: 'gate-runner',
    onOutcome: {
      SUCCESS: 'verification',
      // A genuine test failure needs a code change; re-running the same command won't help.
      RETRYABLE_FAILURE: 'development',
    },
  },
  verification: {
    stage: 'verification',
    runner: 'verification-agent',
    onOutcome: {
      SUCCESS: 'awaiting-merge', // PASS or a human-recorded WAIVED, see engine.ts
      VERIFICATION_FAILED: 'development',
      // CONCERNS never auto-advances; it stays here until a human resolves it (see engine.ts).
      CONCERNS: 'verification',
    },
  },
  'awaiting-merge': {
    stage: 'awaiting-merge',
    runner: 'awaiting-merge-check',
    onOutcome: {
      SUCCESS: 'done',
      RETRYABLE_FAILURE: 'awaiting-merge', // a failing premerge check, re-checked after a fix
      // Needs a human: a moved/conflicting target branch, a regressed dependency, an unsynced design.
      BLOCKED: 'awaiting-merge',
      // A regression only the heavy suite catches is a Testing-level finding, not a Development one.
      VERIFICATION_FAILED: 'testing',
    },
  },
  done: {
    stage: 'done',
    runner: 'none',
    onOutcome: {},
  },
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly stage: Stage,
    readonly outcome: RunOutcome,
  ) {
    super(`illegal transition: stage "${stage}" has no defined next stage for outcome "${outcome}"`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Resolve the next stage for a (stage, outcome) pair, or throw IllegalTransitionError if the
 * table does not define one. No stage's table defines CANCELLED or SYSTEM_ERROR — the engine
 * (workflow/engine.ts, resolveNextStage) catches the resulting IllegalTransitionError for exactly
 * those two outcomes and self-loops, since they are cross-cutting safety fallbacks, not
 * stage-specific semantics any table author should have to declare by hand everywhere.
 */
export function nextStage(stage: Stage, outcome: RunOutcome): Stage {
  const definition = STAGE_DEFINITIONS[stage];
  const next = definition.onOutcome[outcome];
  if (!next) {
    throw new IllegalTransitionError(stage, outcome);
  }
  return next;
}

export function runnerFor(stage: Stage): RunnerKind {
  return STAGE_DEFINITIONS[stage].runner;
}

export function isTerminal(stage: Stage): boolean {
  return Object.keys(STAGE_DEFINITIONS[stage].onOutcome).length === 0;
}

/** All outcomes this stage's table treats as forward/self-loop progress (used for validation). */
export function legalOutcomesFor(stage: Stage): FailureOutcome[] | 'any' {
  return Object.keys(STAGE_DEFINITIONS[stage].onOutcome).filter((o) => o !== 'SUCCESS') as FailureOutcome[];
}
