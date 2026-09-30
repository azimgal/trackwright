/**
 * The ten lifecycle stages a ticket can occupy. This list is the single source of truth for
 * "what stages exist" — the state machine (state-machine.ts) is the single source of truth for
 * "what transitions between them are legal."
 */
export const STAGES = [
  'planning',
  'architecture',
  'design',
  'ready',
  'development',
  'code-review',
  'testing',
  'verification',
  'awaiting-merge',
  'done',
] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/**
 * Coarse ticket status, separate from `stage`. `status` is a human-facing declaration
 * ("what we decided about this ticket"); `stage` is machine-computed ("where the workflow
 * engine currently has it"). This mirrors the status-vs-stage split documented in
 * docs/architecture.md: keeping them distinct means a ticket can be re-triaged (status) without
 * that being confused with pipeline progress (stage), and vice versa.
 */
export const STATUSES = ['draft', 'ready', 'in-progress', 'review', 'done', 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export const FLOW_MODES = ['quick', 'standard', 'full'] as const;
export type FlowMode = (typeof FLOW_MODES)[number];

export const DISCIPLINES = ['design', 'development', 'infrastructure'] as const;
export type Discipline = (typeof DISCIPLINES)[number];

export const SPECIALIZATIONS = ['frontend', 'backend', 'mobile'] as const;
export type Specialization = (typeof SPECIALIZATIONS)[number];
