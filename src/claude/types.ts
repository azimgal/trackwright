import type { RunOutcome } from '../workflow/outcomes.js';

/**
 * The stage input/output contract every ClaudeRunner implementation must satisfy. This is the
 * seam mentioned in docs/architecture.md: it is intentionally not Claude-specific in shape (just
 * "structured request in, structured result out"), even though the only implementation today
 * (ClaudeRunner in runner.ts) is Claude-specific in how it fulfils that contract.
 */
export interface AgentInvocation {
  /** Human-readable agent name, e.g. "planner", "implementer.backend". Used for logging/evidence. */
  agentName: string;
  /** System-level framing for the agent's role, forbidden actions, and output contract. */
  systemPrompt: string;
  /** The actual task: ticket content, diff, whatever this stage needs to act on. */
  prompt: string;
  /** Tool names this invocation may use. An empty array means "no tools, text-only response". */
  allowedTools: string[];
  /** Tool names explicitly denied, even if broader patterns in allowedTools would match them. */
  disallowedTools: string[];
  /** Directory this invocation is allowed to operate in. */
  cwd: string;
  /** Model alias, e.g. "sonnet", "haiku", "opus". */
  model: string;
  /** Milliseconds before the invocation is killed and treated as SYSTEM_ERROR. */
  timeoutMs: number;
  /**
   * Claude Code permission mode for this invocation. Read-only agents should use a mode that
   * cannot silently accept destructive actions; write-capable agents use "acceptEdits" so a
   * headless run does not hang waiting for interactive approval it can never receive.
   */
  permissionMode: 'acceptEdits' | 'bypassPermissions' | 'dontAsk';
}

export interface AgentResult {
  outcome: RunOutcome;
  /** One-line human-readable summary, always present even on failure. */
  summary: string;
  /** Agent-specific structured payload; validated against that agent's own output schema. */
  data: Record<string, unknown>;
  /** Present when outcome is a failure outcome other than SUCCESS. */
  failureReason?: string;
  durationMs: number;
  costUsd?: number;
  /** Raw underlying response, kept for evidence — never parsed by callers, only archived. */
  raw?: unknown;
}

export interface ClaudeRunner {
  invoke(invocation: AgentInvocation): Promise<AgentResult>;
}
