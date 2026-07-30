import { spawn } from 'node:child_process';

export type RunResult = { stdout: string; stderr: string; code: number };

export class ProcessError extends Error {
  readonly code: number;
  readonly stderr: string;
  readonly command: string;

  constructor(command: string, code: number, stderr: string) {
    // Surface the tail of stderr in the message — that is where ffmpeg and
    // yt-dlp put the actual reason, and it is what ends up in the job's
    // last_error and eventually in front of the user.
    const tail = stderr.trim().split('\n').slice(-4).join(' | ').slice(0, 600);
    super(`${command} exited ${code}${tail ? `: ${tail}` : ''}`);
    this.name = 'ProcessError';
    this.code = code;
    this.stderr = stderr;
    this.command = command;
  }
}

export type RunOptions = {
  /** Kill the process after this many ms. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Cap captured output so a chatty process cannot exhaust memory. */
  maxOutputBytes?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Resolve instead of throwing on a non-zero exit. */
  allowFailure?: boolean;
  signal?: AbortSignal;
  onStderrLine?: (line: string) => void;
};

/**
 * Run a command and collect its output.
 *
 * Uses spawn with an argv array — never a shell string — so filenames
 * containing quotes, spaces, semicolons or `$(...)` cannot become shell
 * syntax. Every caller here passes user-influenced values (filenames, URLs).
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const {
    timeoutMs = 10 * 60 * 1000,
    maxOutputBytes = 8 * 1024 * 1024,
    cwd,
    env,
    allowFailure = false,
    signal,
    onStderrLine,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrCarry = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxOutputBytes) stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      const text = chunk.toString('utf8');
      // Keep only the tail of stderr: ffmpeg emits a progress line per frame,
      // and the useful error is always at the end.
      if (stderrBytes <= maxOutputBytes) {
        stderr += text;
      } else {
        stderr = (stderr + text).slice(-64 * 1024);
      }

      if (onStderrLine) {
        stderrCarry += text;
        const lines = stderrCarry.split(/\r?\n|\r/);
        stderrCarry = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) onStderrLine(line);
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new ProcessError(
          command,
          -1,
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `${command} is not installed or not on PATH`
            : String(err),
        ),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();

      const exitCode = code ?? -1;
      if (timedOut) {
        reject(new ProcessError(command, exitCode, `${stderr}\ntimed out after ${timeoutMs}ms`));
        return;
      }
      if (exitCode !== 0 && !allowFailure) {
        reject(new ProcessError(command, exitCode, stderr));
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });
  });
}

/** True if the binary exists and responds to a version probe. */
export async function commandExists(command: string, versionArg = '--version'): Promise<boolean> {
  try {
    await run(command, [versionArg], { timeoutMs: 15_000, allowFailure: true });
    return true;
  } catch {
    return false;
  }
}
