import type { AgentInvocation, AgentResult, ClaudeRunner } from './types.js';

export type MockResponder = (invocation: AgentInvocation, callIndex: number) => AgentResult | Promise<AgentResult>;

/**
 * The planner's default mock response must actually satisfy `isPlanningComplete` (see
 * tickets/schema.ts and workflow/engine.ts's executePlanning), or an unconfigured `--dry-run`
 * would get stuck in planning forever instead of demonstrating the full pipeline — which is the
 * entire documented point of `--dry-run` (README.md, "exercise the whole pipeline"). Every other
 * agent's default stays a bland, contentless success.
 */
function defaultSuccess(agentName: string): AgentResult {
  if (agentName === 'planner') {
    return {
      outcome: 'SUCCESS',
      summary: 'mock: default planning draft',
      data: {
        requirements: '(mock) WHEN the ticket runs THE SYSTEM SHALL complete this stage.',
        acceptanceCriteria: '(mock) the pipeline reaches Done.',
        definitionOfDone: '(mock) all stages report SUCCESS.',
        plan: '(mock) no real plan — this is a --dry-run default.',
        tasks: '(mock) none — this is a --dry-run default.',
      },
      durationMs: 1,
    };
  }
  return {
    outcome: 'SUCCESS',
    summary: 'mock: default success',
    data: {},
    durationMs: 1,
  };
}

/**
 * A scriptable ClaudeRunner for tests and for `trackwright run --dry-run`/dogfood runs where no
 * real Claude credentials are configured. Responses are queued either globally (consumed in
 * order, across any agent) or per agent name (consumed in order, for that agent only); per-agent
 * queues are checked first. If nothing is queued, it returns a bland SUCCESS so tests that don't
 * care about a particular stage's output don't need to configure one.
 *
 * This never asserts anything about the real Claude CLI's behavior — it only exercises the
 * boundary contract (AgentInvocation in, AgentResult out) so the rest of the workflow engine can
 * be tested deterministically. Real invocation is covered separately (see tests/claude-runner
 * integration boundary and the dogfood smoke test).
 */
export class MockClaudeRunner implements ClaudeRunner {
  private readonly globalQueue: MockResponder[] = [];
  private readonly perAgentQueue = new Map<string, MockResponder[]>();
  private readonly _invocations: AgentInvocation[] = [];
  private callIndex = 0;

  enqueue(responder: MockResponder | AgentResult): this {
    this.globalQueue.push(typeof responder === 'function' ? responder : () => responder);
    return this;
  }

  enqueueFor(agentName: string, responder: MockResponder | AgentResult): this {
    const fn = typeof responder === 'function' ? responder : () => responder;
    const queue = this.perAgentQueue.get(agentName) ?? [];
    queue.push(fn);
    this.perAgentQueue.set(agentName, queue);
    return this;
  }

  get invocations(): readonly AgentInvocation[] {
    return this._invocations;
  }

  get callCount(): number {
    return this._invocations.length;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResult> {
    this._invocations.push(invocation);
    const index = this.callIndex++;

    const agentQueue = this.perAgentQueue.get(invocation.agentName);
    if (agentQueue && agentQueue.length > 0) {
      const responder = agentQueue.shift()!;
      return responder(invocation, index);
    }
    if (this.globalQueue.length > 0) {
      const responder = this.globalQueue.shift()!;
      return responder(invocation, index);
    }
    return defaultSuccess(invocation.agentName);
  }
}
