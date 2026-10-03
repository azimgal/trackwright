import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
 * The task prompt is sent over stdin. The system prompt is passed via `--system-prompt-file`, which
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
    const start = Date.now();

    let stdout: string;
    let stderr: string;
    let timedOut = false;
    // The system prompt travels via a temp file (--system-prompt-file), never as an argv element:
    // it is multi-line text, and on Windows a newline cannot survive a cmd.exe command line at
    // all (it terminates the command). See runProcess for the rest of the Windows argv contract.
    const promptDir = await mkdtemp(path.join(tmpdir(), 'trackwright-sp-'));
    try {
      const systemPromptFile = path.join(promptDir, 'system-prompt.txt');
      await writeFile(systemPromptFile, invocation.systemPrompt, 'utf8');
      const result = await this.runProcess(this.buildArgs(invocation, systemPromptFile), invocation);
      stdout = result.stdout;
      stderr = result.stderr;
      timedOut = result.timedOut;
    } catch (err) {
      return this.systemError(`failed to spawn claude: ${(err as Error).message}`, Date.now() - start);
    } finally {
      await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
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
      payload = parseAgentJson(envelope.result);
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

  /** Exposed for tests (argv contract); not part of the public ClaudeRunner interface. */
  buildArgs(invocation: AgentInvocation, systemPromptFile: string): string[] {
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
      // part of the system prompt text. Passed as a file path, not inline text: see invoke().
      '--system-prompt-file',
      systemPromptFile,
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
      const { command, spawnArgs, useShell } = resolveSpawn(this.binary, args);
      const child = spawn(command, spawnArgs, {
        cwd: invocation.cwd,
        timeout: invocation.timeoutMs,
        windowsHide: true,
        // Windows-first-class requirement: a global npm binary like `claude` resolves to a `.cmd`
        // shim, which Node's spawn() cannot exec without a shell. Node does NOT escape argv under
        // shell:true (it only space-joins), so a tool pattern like `Bash(git add*)` or a project
        // path containing spaces/`&`/`%` used to be split or reinterpreted by cmd.exe — see
        // resolveSpawn/quoteForCmd below, which escape every argument explicitly instead.
        // Ticket and diff content never travels as argv at all — only over stdin (see below).
        shell: useShell,
        windowsVerbatimArguments: useShell,
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

// cmd.exe metacharacters (the same set cross-spawn escapes). Inside a batch shim's `%*` the
// command line is parsed by cmd a second time, so arguments bound for a .cmd/.bat are
// caret-escaped twice — verified empirically against an npm-style shim (spaces, quotes, `&`, `|`,
// `<`, `>`, `%VAR%`, `!`, `^`, parentheses, trailing backslashes, non-ASCII all round-trip).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** MSVCRT-style quoting, then cmd.exe caret-escaping (twice for a batch-file target). */
export function quoteForCmd(arg: string, isBatchFile: boolean): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`.replace(CMD_META, '^$1');
  return isBatchFile ? quoted.replace(CMD_META, '^$1') : quoted;
}

/** Resolve a bare command name against PATH/PATHEXT the way cmd.exe would (Windows only). */
function resolveWindowsCommand(binary: string): string | null {
  if (path.extname(binary) && existsSync(binary)) return binary;
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasDir = binary.includes('/') || binary.includes('\\');
  const dirs = hasDir ? [''] : (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of path.extname(binary) ? [''] : exts) {
      const candidate = path.join(dir, binary + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * How to spawn `binary` with `args` safely on this platform. POSIX: direct exec, no shell, argv
 * passed as-is. Windows: a real executable (.exe/.com) is also exec'd directly with no shell;
 * anything else (an npm .cmd shim, or an unresolvable name left for cmd.exe to report) goes
 * through cmd.exe with every argument explicitly escaped — never Node's unescaped shell join.
 */
export function resolveSpawn(
  binary: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; spawnArgs: string[]; useShell: boolean } {
  if (platform !== 'win32') return { command: binary, spawnArgs: [...args], useShell: false };
  const resolved = resolveWindowsCommand(binary);
  if (resolved && /\.(exe|com)$/i.test(resolved)) {
    return { command: resolved, spawnArgs: [...args], useShell: false };
  }
  const target = resolved ?? binary;
  const isBatchFile = /\.(cmd|bat)$/i.test(target);
  const commandLine = [target.replace(CMD_META, '^$1'), ...args.map((a) => quoteForCmd(a, isBatchFile))].join(' ');
  return { command: commandLine, spawnArgs: [], useShell: true };
}

/**
 * Agents are told to answer with only a JSON object, but real responses sometimes wrap it — found
 * in a real dogfood run: one sentence of prose, then the object in a ```json fence, which cost a
 * whole planning re-invocation as SYSTEM_ERROR. Tries, in order: the whole text, a whole-text
 * fence, the last fenced block anywhere, then the outermost {...} span. Only a plain JSON object
 * is accepted; the outcome inside is still validated against the agent's own contract upstream.
 */
export function parseAgentJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const whole = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (whole) candidates.push(whole[1]!);
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fences.length > 0) candidates.push(fences[fences.length - 1]![1]!);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  throw new SyntaxError('no JSON object found in agent response');
}
