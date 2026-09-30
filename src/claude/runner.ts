import { spawn } from 'node:child_process';
import type { AgentInvocation, AgentResult, ClaudeRunner } from './types.js';

/**
 * Shape of the JSON envelope `claude -p --output-format json` prints to stdout. This is
 * Claude Code's own response format, not something we invented — verified against a real
 * invocation during development (see docs/roadmap.md). We only rely on the handful of fields
 * used below; everything else is kept as `raw` for evidence, never parsed further.
 */
interface ClaudeJsonEnvelope {
  result: string;
  is_error: boolean;
  duration_ms: number;
  total_cost_usd?: number;
  session_id: string;
  subtype?: string;
  permission_denials?: unknown[];
}

/**
 * Real ClaudeRunner: spawns a fresh, isolated `claude -p` process per invocation (no persistent
 * conversation, no shared context between stages — see docs/architecture.md, "Claude Runner").
 * The task prompt is sent over stdin. The system prompt is passed via `--system-prompt`, which
 * *fully replaces* Claude Code's own default system prompt (not `--append-system-prompt`) — see
 * `buildArgs()` below and docs/architecture.md's "learned empirically" note for why: appending to
 * the default interactive-assistant framing was not reliably strict enough to stop the model
 * asking a clarifying question instead of returning bare JSON. This does not weaken tool
 * permissions: `--allowedTools`/`--disallowedTools` are enforced independently of system-prompt
 * text.
 */
export class ClaudeCliRunner implements ClaudeRunner {
  constructor(private readonly binary: string = 'claude') {}

  async invoke(invocation: AgentInvocation): Promise<AgentResult> {
    const args = this.buildArgs(invocation);
    const start = Date.now();

    let stdout: string;
    let stderr: string;
    let timedOut = false;
    try {
      const result = await this.runProcess(args, invocation);
      stdout = result.stdout;
      stderr = result.stderr;
      timedOut = result.timedOut;
    } catch (err) {
      return this.systemError(`failed to spawn claude: ${(err as Error).message}`, Date.now() - start);
    }

    if (timedOut) {
      return this.systemError(
        `claude invocation exceeded timeout of ${invocation.timeoutMs}ms and was killed`,
        Date.now() - start,
      );
    }

    let envelope: ClaudeJsonEnvelope;
    try {
      envelope = JSON.parse(stdout) as ClaudeJsonEnvelope;
    } catch {
      return this.systemError(
        `claude did not return valid JSON on stdout (stderr: ${stderr.slice(0, 500)})`,
        Date.now() - start,
        stdout,
      );
    }

    if (envelope.is_error) {
      return this.systemError(
        `claude reported is_error=true: ${envelope.result?.slice(0, 500) ?? '(no result text)'}`,
        Date.now() - start,
        envelope,
      );
    }

    return this.parseAgentPayload(envelope, Date.now() - start);
  }

  /**
   * The agent's actual answer (outcome/summary/data/failureReason) is instructed to be the
   * *only* thing in `envelope.result`, as a single JSON object — see agents/registry.ts for the
   * exact instruction every agent prompt ends with. This double-JSON layering (Claude Code's own
   * envelope, then the agent's structured answer inside `result`) is the standard way to get
   * structured output through `-p --output-format json`.
   */
  private parseAgentPayload(envelope: ClaudeJsonEnvelope, durationMs: number): AgentResult {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(this.extractJson(envelope.result)) as Record<string, unknown>;
    } catch {
      return this.systemError(
        `agent response was not parseable JSON: ${envelope.result.slice(0, 500)}`,
        durationMs,
        envelope,
      );
    }

    const outcome = typeof payload.outcome === 'string' ? payload.outcome : undefined;
    if (!outcome) {
      return this.systemError('agent response missing required "outcome" field', durationMs, envelope);
    }

    return {
      outcome: outcome as AgentResult['outcome'],
      summary: typeof payload.summary === 'string' ? payload.summary : '(no summary provided)',
      data: (payload.data as Record<string, unknown>) ?? {},
      failureReason: typeof payload.failureReason === 'string' ? payload.failureReason : undefined,
      durationMs,
      costUsd: envelope.total_cost_usd,
      raw: envelope,
    };
  }

  /** Agents are instructed to answer with only JSON, but strip incidental code-fence wrapping defensively. */
  private extractJson(text: string): string {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    return fenced ? fenced[1]!.trim() : trimmed;
  }

  private systemError(reason: string, durationMs: number, raw?: unknown): AgentResult {
    return {
      outcome: 'SYSTEM_ERROR',
      summary: reason,
      data: {},
      failureReason: reason,
      durationMs,
      raw,
    };
  }

  private buildArgs(invocation: AgentInvocation): string[] {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      invocation.model,
      '--permission-mode',
      invocation.permissionMode,
      '--add-dir',
      invocation.cwd,
      // Full replacement, not --append-system-prompt: verified empirically (see
      // docs/roadmap.md / the real Claude smoke test) that appending to Claude Code's default
      // interactive-assistant system prompt is not reliably strong enough to make it skip asking
      // a clarifying question instead of returning bare JSON — these are one-shot, non-interactive
      // structured-output agent calls, not an interactive coding session, so the default framing
      // is actively counterproductive here. This does not weaken tool-permission enforcement:
      // --allowedTools/--disallowedTools are a separate, independently-enforced mechanism, not
      // part of the system prompt text.
      '--system-prompt',
      invocation.systemPrompt,
    ];
    if (invocation.allowedTools.length > 0) {
      args.push('--allowedTools', ...invocation.allowedTools);
    }
    if (invocation.disallowedTools.length > 0) {
      args.push('--disallowedTools', ...invocation.disallowedTools);
    }
    return args;
  }

  private runProcess(
    args: string[],
    invocation: AgentInvocation,
  ): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        cwd: invocation.cwd,
        timeout: invocation.timeoutMs,
        windowsHide: true,
        // Windows-first-class requirement: a global npm binary like `claude` resolves to a
        // `.cmd` shim, which Node's spawn() cannot exec directly without a shell (ENOENT
        // otherwise, even though the same name resolves fine from an interactive shell). Node
        // itself warns that args are not fully escaped under shell:true — the trust boundary
        // that makes this acceptable here is that every argv entry passed to buildArgs() is
        // either this process's own hardcoded template text (model name, agent system prompt)
        // or a filesystem path (cwd) never ticket/ user content. Ticket and diff content only
        // ever travels over stdin (see the prompt write below), never as an argv element.
        shell: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') timedOut = true;
        resolve({ stdout, stderr: stderr + (code !== 0 && !timedOut ? `\n(exit code ${code})` : ''), timedOut });
      });

      // Empirically, an instruction to "respond with only JSON" placed solely in the system
      // prompt is not reliably followed — observed real invocations sometimes asked a
      // clarifying question instead (see the real-Claude smoke test in scripts/, and the final
      // report's verification notes). Repeating a short, concrete reminder at the very end of
      // the task prompt itself (closest to where generation starts) measurably improves
      // compliance. This is additive to, not a replacement for, the system prompt's contract.
      const finalPrompt = `${invocation.prompt}\n\nRespond now with ONLY the JSON object described above. No questions, no markdown fences, no other text.`;
      child.stdin.write(finalPrompt);
      child.stdin.end();
    });
  }
}
