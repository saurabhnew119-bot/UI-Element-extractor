import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { InspectorError } from '../core/errors.ts';

export type Language = 'java' | 'typescript' | 'javascript' | 'python';
export type BuildSystem = 'maven' | 'gradle' | 'npm' | 'python' | 'unknown';

export interface ProjectInfo {
  root: string;
  languages: Language[];
  buildSystem: BuildSystem;
  frameworks: string[];
  sourceFiles: string[];
  testFiles: string[];
  /** Files that declare locators (page/screen objects). Filled in by the scanner. */
  pageObjects: string[];
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'out', 'dist', '.gradle', '.idea', '.vscode', '.elementiq', '__pycache__', '.venv', 'venv', '.pytest_cache', 'allure-results', 'allure-report']);
/** Test-run output folders; skipped only at the project root, since e.g. a `reports` package is real code. */
const SKIP_ROOT_DIRS = new Set(['reports', 'test-output', 'screenshots', 'screenshots_reports', 'logs']);
const EXT_LANG: Record<string, Language> = { '.java': 'java', '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.mjs': 'javascript', '.py': 'python' };
const MAX_FILES = 20_000;

export function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const outputDir = dir === root && SKIP_ROOT_DIRS.has(entry.name.toLowerCase());
        if (!SKIP_DIRS.has(entry.name) && !outputDir && !entry.name.startsWith('.')) stack.push(full);
      } else if (EXT_LANG[path.extname(entry.name)] && !entry.name.endsWith('.d.ts')) {
        out.push(full);
        if (out.length > MAX_FILES) throw new InspectorError('INVALID_INPUT', `Project has more than ${MAX_FILES} source files; point the scanner at the automation module.`);
      }
    }
  }
  return out.sort();
}

export function isTestFile(file: string): boolean {
  const norm = file.replace(/\\/g, '/');
  const base = path.basename(file);
  if (norm.includes('/src/test/')) return /\.java$/.test(base) && !/(Page|Screen)\.java$/.test(base);
  if (/(Test|Tests|IT)\.java$/.test(base)) return true;
  if (/\.(spec|test|e2e)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/^test_.*\.py$|_test\.py$/.test(base)) return true;
  return false;
}

function read(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function detectProject(root: string): ProjectInfo {
  const abs = path.resolve(root);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new InspectorError('INVALID_INPUT', `Project directory ${abs} does not exist.`);
  const files = walk(abs);
  const languages = [...new Set(files.map((f) => EXT_LANG[path.extname(f)]))];
  const frameworks = new Set<string>();
  let buildSystem: BuildSystem = 'unknown';

  const pom = path.join(abs, 'pom.xml');
  const gradle = ['build.gradle', 'build.gradle.kts'].map((f) => path.join(abs, f)).find(existsSync);
  const pkg = path.join(abs, 'package.json');
  const pyFiles = ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'].map((f) => path.join(abs, f)).filter(existsSync);

  const jvmDeps = existsSync(pom) ? read(pom) : gradle ? read(gradle) : '';
  if (existsSync(pom)) buildSystem = 'maven';
  else if (gradle) buildSystem = 'gradle';
  if (jvmDeps) {
    if (/io\.appium[^\n]*java-client|java-client/.test(jvmDeps)) frameworks.add('appium-java-client');
    if (/org\.testng|testng/.test(jvmDeps)) frameworks.add('testng');
    if (/junit-jupiter|org\.junit\.jupiter/.test(jvmDeps)) frameworks.add('junit5');
    else if (/<artifactId>junit<\/artifactId>|junit:junit/.test(jvmDeps)) frameworks.add('junit4');
    if (/selenium-java|org\.seleniumhq/.test(jvmDeps)) frameworks.add('selenium');
    if (/cucumber/.test(jvmDeps)) frameworks.add('cucumber');
  }
  if (existsSync(pkg)) {
    if (buildSystem === 'unknown') buildSystem = 'npm';
    const deps = (() => {
      try {
        const j = JSON.parse(read(pkg));
        return Object.keys({ ...j.dependencies, ...j.devDependencies });
      } catch {
        return [];
      }
    })();
    if (deps.some((d) => d.startsWith('@wdio/') || d === 'webdriverio')) frameworks.add('webdriverio');
    if (deps.includes('appium') || deps.some((d) => d.includes('appium'))) frameworks.add('appium-js');
    if (deps.some((d) => d.startsWith('@playwright/') || d === 'playwright')) frameworks.add('playwright');
  }
  if (pyFiles.length) {
    if (buildSystem === 'unknown') buildSystem = 'python';
    const text = pyFiles.map(read).join('\n');
    if (/Appium-Python-Client|appium-python-client/i.test(text)) frameworks.add('appium-python');
    if (/pytest/.test(text)) frameworks.add('pytest');
    if (/selenium/.test(text)) frameworks.add('selenium');
  }
  return {
    root: abs,
    languages,
    buildSystem,
    frameworks: [...frameworks].sort(),
    sourceFiles: files,
    testFiles: files.filter(isTestFile),
    pageObjects: [],
  };
}
