import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface RunResult {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Resolves an executable on PATH (honouring PATHEXT on Windows). Returns null when it is not installed. */
export function which(cmd: string, extraDirs: string[] = []): string | null {
  if (path.isAbsolute(cmd)) return existsSync(cmd) ? cmd : null;
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  const dirs = [...extraDirs, ...(process.env.PATH ?? '').split(path.delimiter)].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ['', ...exts]) {
      const candidate = path.join(dir, cmd + ext);
      if (existsSync(candidate) && (process.platform !== 'win32' || ext !== '' || /\.\w+$/.test(cmd))) return candidate;
    }
  }
  return null;
}

export function run(
  exe: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const started = Date.now();
  // .cmd/.bat wrappers (mvn.cmd, gradlew.bat, npx.cmd) can only be started through a shell on Windows.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
  const quoted = needsShell ? [`"${exe}"`, ...args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))] : null;
  return new Promise((resolve) => {
    const child = quoted
      ? spawn(quoted.join(' '), { cwd: opts.cwd, env: opts.env ?? process.env, shell: true, windowsHide: true })
      : spawn(exe, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      stderr += e.message;
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ command: [exe, ...args].join(' '), code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

export function tail(s: string, lines = 60): string {
  const all = s.split(/\r?\n/);
  return all.slice(-lines).join('\n');
}
