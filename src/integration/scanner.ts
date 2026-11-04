import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CodeRef, CodeSyntax, LocatorStrategy, LogicalElement, Platform } from '../core/types.ts';
import { detectProject, type ProjectInfo } from './detect.ts';

type RefStrategy = CodeRef['strategy'];

const ANDROID_ANNOTATION_KEYS: Record<string, RefStrategy> = {
  accessibility: 'accessibility id', id: 'id', uiAutomator: '-android uiautomator', xpath: 'xpath', className: 'class name',
};
const IOS_ANNOTATION_KEYS: Record<string, RefStrategy> = {
  accessibility: 'accessibility id', id: 'id', iOSNsPredicate: '-ios predicate string', iOSClassChain: '-ios class chain', xpath: 'xpath', className: 'class name',
};
const SELENIUM_ANNOTATION_KEYS: Record<string, RefStrategy> = {
  id: 'id', css: 'css', xpath: 'xpath', name: 'name', className: 'class name', linkText: 'link text',
};
const JAVA_BY_METHODS: Record<string, { strategy: RefStrategy; platform?: Platform }> = {
  accessibilityId: { strategy: 'accessibility id' }, AccessibilityId: { strategy: 'accessibility id' },
  id: { strategy: 'id' }, xpath: { strategy: 'xpath' }, className: { strategy: 'class name' },
  androidUIAutomator: { strategy: '-android uiautomator', platform: 'android' }, AndroidUIAutomator: { strategy: '-android uiautomator', platform: 'android' },
  iOSNsPredicateString: { strategy: '-ios predicate string', platform: 'ios' },
  iOSClassChain: { strategy: '-ios class chain', platform: 'ios' },
  cssSelector: { strategy: 'css' }, name: { strategy: 'name' }, linkText: { strategy: 'link text' },
};
const PY_STRATEGIES: Record<string, { strategy: RefStrategy; platform?: Platform }> = {
  ACCESSIBILITY_ID: { strategy: 'accessibility id' }, ID: { strategy: 'id' }, XPATH: { strategy: 'xpath' }, CLASS_NAME: { strategy: 'class name' },
  ANDROID_UIAUTOMATOR: { strategy: '-android uiautomator', platform: 'android' },
  IOS_PREDICATE: { strategy: '-ios predicate string', platform: 'ios' }, IOS_CLASS_CHAIN: { strategy: '-ios class chain', platform: 'ios' },
  CSS_SELECTOR: { strategy: 'css' }, NAME: { strategy: 'name' },
};

interface Literal {
  /** Offset of the opening quote. */
  start: number;
  /** Offset just past the closing quote. */
  end: number;
  quote: string;
  value: string;
}

/** Reads a quoted string literal starting at `i` (which must point at the quote). */
function readLiteral(src: string, i: number): Literal | null {
  const quote = src[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let j = i + 1;
  let value = '';
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      const n = src[j + 1];
      value += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      j += 2;
      continue;
    }
    if (c === quote) return { start: i, end: j + 1, quote, value };
    if (c === '\n' && quote !== '`') return null;
    value += c;
    j++;
  }
  return null;
}

export function encodeLiteral(value: string, quote: string): string {
  const esc = value.replace(/\\/g, '\\\\').replace(new RegExp(quote === '`' ? '`' : quote, 'g'), '\\' + quote).replace(/\n/g, '\\n');
  return quote + esc + quote;
}

/** Index of the parenthesis matching the one at `open`, skipping string literals. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const lit = readLiteral(src, i);
      if (lit) i = lit.end - 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function inferPlatformFromPath(file: string, src: string): Platform | 'shared' | 'web' {
  const norm = file.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(norm);
  if (/(^|\/)android(\/|$)/.test(path.dirname(norm)) || /android/.test(base)) return 'android';
  if (/(^|\/)ios(\/|$)/.test(path.dirname(norm)) || /ios/.test(base)) return 'ios';
  if (/import\s+org\.openqa\.selenium/.test(src) && !/io\.appium/.test(src)) return 'web';
  if (/from\s+selenium/.test(src) && !/appium/.test(src)) return 'web';
  return 'shared';
}

function ownerOf(src: string, file: string): string {
  return /\bclass\s+(\w+)/.exec(src)?.[1] ?? path.basename(file).replace(/\.[^.]+$/, '');
}

function javaFieldAfter(src: string, from: number): string | null {
  const window = src.slice(from, from + 800);
  // Skip any further annotations (e.g. @iOSXCUITFindBy after @AndroidFindBy) before the declaration.
  let rest = window;
  for (;;) {
    const m = /^\s*@\w+\s*/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
    if (rest[0] === '(') {
      const close = matchParen(rest, 0);
      if (close < 0) return null;
      rest = rest.slice(close + 1);
    }
  }
  return /^\s*(?:(?:private|protected|public|static|final)\s+)*[\w.<>\[\], ?]+?\s+(\w+)\s*[;=]/.exec(rest)?.[1] ?? null;
}

function assignedNameBefore(src: string, at: number): string | null {
  const before = src.slice(Math.max(0, at - 300), at);
  const getter = /get\s+(\w+)\s*\(\s*\)\s*\{\s*return\s+(?:this\.)?(?:driver\.)?$/.exec(before);
  if (getter) return getter[1];
  const assign = /(\w+)[ \t]*(?::[ \t]*[\w.<>\[\]]+[ \t]*)?[=:][ \t]*(?:\([ \t]*)?(?:new[ \t]+)?$/.exec(before);
  return assign?.[1] ?? null;
}

function scanJava(file: string, src: string): CodeRef[] {
  const refs: CodeRef[] = [];
  const owner = ownerOf(src, file);
  const filePlatform = inferPlatformFromPath(file, src);
  for (const m of src.matchAll(/@(AndroidFindBy|iOSXCUITFindBy|iOSFindBy|FindBy)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const kind = m[1];
    const keys = kind === 'AndroidFindBy' ? ANDROID_ANNOTATION_KEYS : kind === 'FindBy' ? SELENIUM_ANNOTATION_KEYS : IOS_ANNOTATION_KEYS;
    const syntax: CodeSyntax = kind === 'AndroidFindBy' ? 'java-android-annotation' : kind === 'FindBy' ? 'java-selenium-annotation' : 'java-ios-annotation';
    const platform = kind === 'AndroidFindBy' ? 'android' : kind === 'FindBy' ? (filePlatform === 'shared' ? 'web' : filePlatform) : 'ios';
    const argRe = /(\w+)\s*=\s*/g;
    argRe.lastIndex = open + 1;
    let a: RegExpExecArray | null;
    while ((a = argRe.exec(src)) && a.index < close) {
      const lit = readLiteral(src, argRe.lastIndex);
      if (!lit) continue;
      argRe.lastIndex = lit.end;
      const strategy = keys[a[1]];
      if (!strategy) continue;
      refs.push({
        file, line: lineOf(src, a.index), valueStart: lit.start + 1, valueEnd: lit.end - 1, exprStart: a.index, exprEnd: lit.end,
        platform, strategy, value: lit.value, syntax, owner, field: javaFieldAfter(src, close + 1), raw: src.slice(m.index!, close + 1),
      });
      break;
    }
  }
  for (const m of src.matchAll(/\b(AppiumBy|MobileBy|By)\s*\.\s*(\w+)\s*\(\s*/g)) {
    const spec = JAVA_BY_METHODS[m[2]];
    if (!spec) continue;
    const lit = readLiteral(src, m.index! + m[0].length);
    if (!lit) continue;
    const close = src.indexOf(')', lit.end);
    if (close < 0 || src.slice(lit.end, close).trim() !== '') continue;
    const generic = spec.strategy === 'css' || spec.strategy === 'name' || spec.strategy === 'link text' ? 'web' : filePlatform;
    refs.push({
      file, line: lineOf(src, m.index!), valueStart: lit.start + 1, valueEnd: lit.end - 1, exprStart: m.index!, exprEnd: close + 1,
      platform: spec.platform ?? generic, strategy: spec.strategy, value: lit.value, syntax: 'java-by-call', owner,
      field: assignedNameBefore(src, m.index!), raw: src.slice(m.index!, close + 1),
    });
  }
  return refs;
}

export function parseWdioSelector(sel: string): { strategy: RefStrategy; value: string; platform?: Platform } {
  if (sel.startsWith('~')) return { strategy: 'accessibility id', value: sel.slice(1) };
  if (sel.startsWith('id=')) return { strategy: 'id', value: sel.slice(3) };
  if (sel.startsWith('android=')) return { strategy: '-android uiautomator', value: sel.slice(8), platform: 'android' };
  if (sel.startsWith('-ios predicate string:')) return { strategy: '-ios predicate string', value: sel.slice(22), platform: 'ios' };
  if (sel.startsWith('-ios class chain:')) return { strategy: '-ios class chain', value: sel.slice(17), platform: 'ios' };
  if (sel.startsWith('//') || sel.startsWith('(/')) return { strategy: 'xpath', value: sel };
  return { strategy: 'css', value: sel };
}

export function formatWdioSelector(strategy: LocatorStrategy, value: string): string | null {
  switch (strategy) {
    case 'accessibility id': return '~' + value;
    case 'id': return 'id=' + value;
    case '-android uiautomator': return 'android=' + value;
    case '-ios predicate string': return '-ios predicate string:' + value;
    case '-ios class chain': return '-ios class chain:' + value;
    case 'xpath': return value;
    default: return null;
  }
}

function scanJs(file: string, src: string): CodeRef[] {
  const refs: CodeRef[] = [];
  const owner = ownerOf(src, file);
  const filePlatform = inferPlatformFromPath(file, src);
  for (const m of src.matchAll(/\$\$?\(\s*/g)) {
    const lit = readLiteral(src, m.index! + m[0].length);
    if (!lit || (lit.quote === '`' && lit.value.includes('${'))) continue;
    const sel = parseWdioSelector(lit.value);
    refs.push({
      file, line: lineOf(src, m.index!), valueStart: lit.start + 1, valueEnd: lit.end - 1, exprStart: lit.start, exprEnd: lit.end,
      platform: sel.platform ?? (sel.strategy === 'css' ? 'web' : filePlatform), strategy: sel.strategy, value: sel.value,
      syntax: 'js-selector', owner, field: assignedNameBefore(src, m.index!), raw: src.slice(m.index!, lit.end + 1),
    });
  }
  return refs;
}

function scanPython(file: string, src: string): CodeRef[] {
  const refs: CodeRef[] = [];
  const owner = ownerOf(src, file);
  const filePlatform = inferPlatformFromPath(file, src);
  for (const m of src.matchAll(/\b(AppiumBy|MobileBy|By)\.([A-Z_]+)\s*,\s*r?/g)) {
    const spec = PY_STRATEGIES[m[2]];
    if (!spec) continue;
    const lit = readLiteral(src, m.index! + m[0].length);
    if (!lit) continue;
    refs.push({
      file, line: lineOf(src, m.index!), valueStart: lit.start + 1, valueEnd: lit.end - 1, exprStart: m.index!, exprEnd: lit.end,
      platform: spec.platform ?? (spec.strategy === 'css' || spec.strategy === 'name' ? 'web' : filePlatform),
      strategy: spec.strategy, value: lit.value, syntax: 'py-tuple', owner,
      field: assignedNameBefore(src, src.lastIndexOf('(', m.index!)), raw: src.slice(m.index!, lit.end),
    });
  }
  return refs;
}

export function scanSource(file: string, src: string): CodeRef[] {
  const ext = path.extname(file);
  if (ext === '.java') return scanJava(file, src);
  if (ext === '.py') return scanPython(file, src);
  if (/^\.[cm]?[jt]sx?$/.test(ext)) return scanJs(file, src);
  return [];
}

export interface ScanResult {
  project: ProjectInfo;
  refs: CodeRef[];
}

export function scanProject(root: string): ScanResult {
  const project = detectProject(root);
  const refs: CodeRef[] = [];
  for (const file of project.sourceFiles) {
    const found = scanSource(file, readFileSync(file, 'utf8'));
    if (found.length && !project.testFiles.includes(file)) project.pageObjects.push(file);
    refs.push(...found);
  }
  return { project, refs };
}

function normalizeValue(platform: Platform, strategy: string, value: string): string {
  if (platform === 'android' && strategy === 'id') return value.replace(/^[\w.]+:id\//, '');
  return value;
}

/** True when a code reference locates the same thing as a repository locator on the given platform. */
export function refMatchesLocator(ref: Pick<CodeRef, 'strategy' | 'value'>, platform: Platform, loc: { strategy: string; value: string }): boolean {
  const same = (s: string) => (platform === 'ios' && (s === 'id' || s === 'accessibility id') ? 'accessibility id' : s);
  if (same(ref.strategy) !== same(loc.strategy)) return false;
  return normalizeValue(platform, ref.strategy, ref.value) === normalizeValue(platform, loc.strategy, loc.value);
}

export interface ElementMapping {
  elementId: string;
  name: string;
  platform: Platform;
  refs: CodeRef[];
}

/**
 * Maps repository elements to code. A reference is only attached to a platform binding when the reference
 * is declared for that platform (or shared) and matches one of that platform's recorded locators.
 */
export function mapElementsToCode(elements: LogicalElement[], refs: CodeRef[]): { mappings: ElementMapping[]; unmapped: CodeRef[] } {
  const used = new Set<CodeRef>();
  const mappings: ElementMapping[] = [];
  for (const el of elements) {
    for (const platform of ['android', 'ios'] as const) {
      const b = el.platforms[platform];
      if (!b) continue;
      const known = [...b.locators, ...b.history.flatMap((h) => h.locators)];
      const hits = refs.filter((r) => (r.platform === platform || r.platform === 'shared') && known.some((l) => refMatchesLocator(r, platform, l)));
      hits.forEach((h) => used.add(h));
      mappings.push({ elementId: el.id, name: el.name, platform, refs: hits });
    }
  }
  return { mappings, unmapped: refs.filter((r) => !used.has(r) && r.platform !== 'web') };
}
