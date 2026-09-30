import { spawn } from 'node:child_process';

export interface CheckResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Only the tail of stdout+stderr is kept — enough to diagnose a failure, not the whole log. */
  outputTail: string;
  durationMs: number;
}

export interface CheckRunSummary {
  passed: boolean;
  results: CheckResult[];
}

const MAX_TAIL_CHARS = 4000;

/**
 * Run a list of shell commands in `cwd`, one at a time, stopping at the first failure (there is
 * no value in running the rest of a check tier once one has already failed the ticket). This is
 * the mechanical "does it pass" runner — deliberately not an agent, not a judgment call, just
 * exit codes. It backs Development's `checks.fast`, Testing's `checks.test`, and Awaiting
 * Merge's `checks.premerge`.
 */
export async function runChecks(
  commands: readonly string[],
  cwd: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<CheckRunSummary> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    const result = await runOne(command, cwd, timeoutMs);
    results.push(result);
    if (result.timedOut || result.exitCode !== 0) {
      return { passed: false, results };
    }
  }
  return { passed: true, results };
}

function runOne(command: string, cwd: string, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    // Commands come from project config (trusted, versioned in the target repo), not from
    // ticket content — shell:true here is intentional and safe under that assumption, the same
    // way `pnpm run <script>` from package.json is trusted.
    const child = spawn(command, { cwd, shell: true, timeout: timeoutMs, windowsHide: true });

    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    child.on('close', (code, signal) => {
      const timedOut = signal === 'SIGTERM' || signal === 'SIGKILL';
      resolve({
        command,
        exitCode: code,
        timedOut,
        outputTail: output.slice(-MAX_TAIL_CHARS),
        durationMs: Date.now() - start,
      });
    });

    child.on('error', (err) => {
      resolve({
        command,
        exitCode: null,
        timedOut: false,
        outputTail: `failed to start: ${(err as Error).message}`,
        durationMs: Date.now() - start,
      });
    });
  });
}
