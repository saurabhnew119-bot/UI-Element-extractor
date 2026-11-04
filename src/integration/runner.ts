import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { InspectorError } from '../core/errors.ts';
import type { Platform } from '../core/types.ts';
import { run, tail, which } from '../util/exec.ts';
import { parseXml } from '../util/xml.ts';
import type { ProjectInfo } from './detect.ts';

export interface ProjectConfig {
  /** Overrides the compile/type-check command, e.g. "mvn -q -DskipTests test-compile". */
  buildCommand?: string;
  /** Per-platform test command. Placeholders: {tests} (comma list), {testArgs} (space list), {platform}. */
  testCommand?: Partial<Record<Platform, string>>;
  /** Roll the change back automatically when the build or the affected tests fail. Default true. */
  rollbackOnFailure?: boolean;
  /**
   * Directory (relative to the project) holding an ElementIQ repository.json that the test framework reads its
   * locators from. Repairs then update that file instead of source code.
   */
  repositoryDir?: string;
  timeoutMinutes?: number;
}

export interface StepResult {
  status: 'passed' | 'failed' | 'skipped';
  reason: string;
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  output: string;
  summary?: { tests: number; failures: number; errors: number; skipped: number };
}

export function loadConfig(root: string): ProjectConfig {
  for (const f of [path.join(root, '.elementiq', 'config.json'), path.join(root, 'elementiq.config.json')]) {
    if (existsSync(f)) {
      try {
        return JSON.parse(readFileSync(f, 'utf8'));
      } catch (e) {
        throw new InspectorError('CONFIG_ERROR', `Cannot parse ${f}: ${(e as Error).message}`);
      }
    }
  }
  return {};
}

export function splitCommand(cmd: string): string[] {
  return [...cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** Prefers the project's wrapper scripts (mvnw, gradlew) over globally installed tools. */
function resolveTool(root: string, name: string): string | null {
  const wrappers: Record<string, string[]> = {
    mvn: process.platform === 'win32' ? ['mvnw.cmd'] : ['mvnw'],
    gradle: process.platform === 'win32' ? ['gradlew.bat'] : ['gradlew'],
  };
  for (const w of wrappers[name] ?? []) {
    const p = path.join(root, w);
    if (existsSync(p)) return p;
  }
  return which(name);
}

async function execute(root: string, cmd: string[], timeoutMs: number, platform: Platform | null): Promise<StepResult> {
  const exe = resolveTool(root, cmd[0]);
  if (!exe) {
    return { status: 'skipped', reason: `"${cmd[0]}" is not installed or not on PATH, so this step could not run.`, command: cmd.join(' '), exitCode: null, durationMs: 0, output: '' };
  }
  const env = platform ? { ...process.env, PLATFORM: platform, ELEMENTIQ_PLATFORM: platform } : process.env;
  const r = await run(exe, cmd.slice(1), { cwd: root, timeoutMs, env });
  const output = tail(r.stdout + (r.stderr ? '\n' + r.stderr : ''), 80);
  if (r.timedOut) return { status: 'failed', reason: `Timed out after ${Math.round(timeoutMs / 1000)}s.`, command: r.command, exitCode: r.code, durationMs: r.durationMs, output };
  return { status: r.code === 0 ? 'passed' : 'failed', reason: r.code === 0 ? 'Exit code 0.' : `Exit code ${r.code}.`, command: r.command, exitCode: r.code, durationMs: r.durationMs, output };
}

export async function buildCheck(project: ProjectInfo, changedFiles: string[], config: ProjectConfig): Promise<StepResult> {
  const timeout = (config.timeoutMinutes ?? 15) * 60_000;
  if (config.buildCommand) return execute(project.root, splitCommand(config.buildCommand), timeout, null);
  switch (project.buildSystem) {
    case 'maven':
      return execute(project.root, ['mvn', '-q', '-DskipTests', 'test-compile'], timeout, null);
    case 'gradle':
      return execute(project.root, ['gradle', '-q', 'testClasses'], timeout, null);
    case 'npm':
      if (existsSync(path.join(project.root, 'tsconfig.json'))) return execute(project.root, ['npx', '--no-install', 'tsc', '--noEmit', '-p', '.'], timeout, null);
      return checkEach(project.root, changedFiles.filter((f) => /\.[cm]?js$/.test(f)), (f) => ['node', '--check', f], timeout);
    case 'python':
      return checkEach(project.root, changedFiles.filter((f) => f.endsWith('.py')), (f) => ['python', '-m', 'py_compile', f], timeout);
    default:
      return { status: 'skipped', reason: 'No build system detected; configure buildCommand in .elementiq/config.json.', command: null, exitCode: null, durationMs: 0, output: '' };
  }
}

async function checkEach(root: string, files: string[], cmd: (f: string) => string[], timeout: number): Promise<StepResult> {
  if (!files.length) return { status: 'skipped', reason: 'No changed files of this type to check.', command: null, exitCode: null, durationMs: 0, output: '' };
  const results: StepResult[] = [];
  for (const f of files) {
    const r = await execute(root, cmd(f), timeout, null);
    results.push(r);
    if (r.status !== 'passed') return r;
  }
  return { ...results[0], reason: `${files.length} file(s) checked.`, durationMs: results.reduce((a, r) => a + r.durationMs, 0) };
}

/** Test classes/files that reference any of the given page/screen object owners. */
export function findAffectedTests(project: ProjectInfo, owners: string[]): string[] {
  const out = new Set<string>();
  for (const file of project.testFiles) {
    const src = readFileSync(file, 'utf8');
    if (owners.some((o) => new RegExp(`\\b${o}\\b`).test(src))) out.add(file);
  }
  return [...out].sort();
}

function testIdentifier(project: ProjectInfo, file: string): string {
  if (file.endsWith('.java')) return path.basename(file, '.java');
  return path.relative(project.root, file).replace(/\\/g, '/');
}

export async function runAffectedTests(project: ProjectInfo, testFiles: string[], platform: Platform, config: ProjectConfig): Promise<StepResult> {
  if (!testFiles.length) {
    return { status: 'skipped', reason: 'No automated tests reference the changed page/screen objects.', command: null, exitCode: null, durationMs: 0, output: '' };
  }
  const tests = testFiles.map((f) => testIdentifier(project, f));
  const timeout = (config.timeoutMinutes ?? 30) * 60_000;
  const started = Date.now();
  let cmd: string[];
  const custom = config.testCommand?.[platform];
  if (custom) {
    cmd = splitCommand(custom).flatMap((part) =>
      part === '{testArgs}' ? tests : [part.replace('{tests}', tests.join(',')).replace('{platform}', platform)],
    );
  } else {
    switch (project.buildSystem) {
      case 'maven':
        cmd = ['mvn', 'test', `-Dtest=${tests.join(',')}`, '-Dsurefire.failIfNoSpecifiedTests=false', `-Dplatform=${platform}`];
        break;
      case 'gradle':
        cmd = ['gradle', 'test', ...tests.flatMap((t) => ['--tests', t]), `-Dplatform=${platform}`];
        break;
      case 'npm': {
        const conf = ['ts', 'js', 'mjs'].map((e) => `wdio.${platform}.conf.${e}`).find((f) => existsSync(path.join(project.root, f)));
        cmd = conf ? ['npx', '--no-install', 'wdio', 'run', conf, ...tests.flatMap((t) => ['--spec', t])] : ['npm', 'test', '--', ...tests];
        break;
      }
      case 'python':
        cmd = ['python', '-m', 'pytest', ...tests, `--junitxml=.elementiq/pytest-${platform}.xml`];
        break;
      default:
        return { status: 'skipped', reason: 'No build system detected; configure testCommand in .elementiq/config.json.', command: null, exitCode: null, durationMs: 0, output: '' };
    }
  }
  const result = await execute(project.root, cmd, timeout, platform);
  const summary = readJUnitReports(project.root, started);
  if (summary) {
    result.summary = summary;
    if (summary.tests === 0 || summary.tests === summary.skipped) {
      return { ...result, status: 'skipped', reason: 'The test command ran but no tests were executed.' };
    }
    if (summary.failures + summary.errors > 0) result.status = 'failed';
  }
  return result;
}

/** Aggregates JUnit XML reports written after `since` (surefire, gradle, pytest --junitxml). */
export function readJUnitReports(root: string, since: number): StepResult['summary'] | undefined {
  const dirs = ['target/surefire-reports', 'build/test-results/test', '.elementiq'].map((d) => path.join(root, d));
  const total = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  let found = false;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (!name.endsWith('.xml') || statSync(file).mtimeMs < since) continue;
      try {
        const root = parseXml(readFileSync(file, 'utf8'));
        const suites = root.name === 'testsuites' ? root.children.filter((c) => c.name === 'testsuite') : [root];
        for (const s of suites) {
          if (s.name !== 'testsuite') continue;
          found = true;
          total.tests += Number(s.attrs.tests ?? 0);
          total.failures += Number(s.attrs.failures ?? 0);
          total.errors += Number(s.attrs.errors ?? 0);
          total.skipped += Number(s.attrs.skipped ?? s.attrs.skips ?? 0);
        }
      } catch {
        // Not a JUnit report.
      }
    }
  }
  return found ? total : undefined;
}
