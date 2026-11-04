import type { CodeRef, LocatorStrategy } from '../core/types.ts';
import { encodeLiteral, formatWdioSelector } from '../integration/scanner.ts';

export interface Edit {
  start: number;
  end: number;
  text: string;
}

const ANDROID_KEYS: Partial<Record<LocatorStrategy, string>> = {
  'accessibility id': 'accessibility', id: 'id', '-android uiautomator': 'uiAutomator', xpath: 'xpath', 'class name': 'className',
};
const IOS_KEYS: Partial<Record<LocatorStrategy, string>> = {
  'accessibility id': 'accessibility', '-ios predicate string': 'iOSNsPredicate', '-ios class chain': 'iOSClassChain', xpath: 'xpath', 'class name': 'className',
};
const APPIUM_BY: Partial<Record<LocatorStrategy, string>> = {
  'accessibility id': 'accessibilityId', id: 'id', '-android uiautomator': 'androidUIAutomator', '-ios predicate string': 'iOSNsPredicateString',
  '-ios class chain': 'iOSClassChain', xpath: 'xpath', 'class name': 'className',
};
const PY_BY: Partial<Record<LocatorStrategy, string>> = {
  'accessibility id': 'ACCESSIBILITY_ID', id: 'ID', '-android uiautomator': 'ANDROID_UIAUTOMATOR', '-ios predicate string': 'IOS_PREDICATE',
  '-ios class chain': 'IOS_CLASS_CHAIN', xpath: 'XPATH', 'class name': 'CLASS_NAME',
};

/** Strategies that exist with identical semantics on both platforms, and so may appear in shared code. */
export const CROSS_PLATFORM_STRATEGIES: LocatorStrategy[] = ['accessibility id', 'xpath', 'class name'];

function sameStrategy(ref: CodeRef, strategy: LocatorStrategy): boolean {
  if (ref.strategy === strategy) return true;
  // XCUITest treats "id" and "accessibility id" identically (both match the element name).
  return ref.platform === 'ios' && (ref.strategy === 'id' || ref.strategy === 'accessibility id') && (strategy === 'id' || strategy === 'accessibility id');
}

/** Keeps the code's Android id style: short ids stay short when the package prefix is implied. */
function adaptValue(ref: CodeRef, strategy: LocatorStrategy, value: string): string {
  if (strategy === 'id' && ref.strategy === 'id' && ref.platform !== 'ios' && !ref.value.includes(':id/')) {
    return value.replace(/^[\w.]+:id\//, '');
  }
  return value;
}

/**
 * Produces the minimal source edits that make `ref` use the new locator, or null when the locator cannot be
 * expressed in that syntax (the caller then tries the next candidate).
 */
export function renderEdits(src: string, ref: CodeRef, strategy: LocatorStrategy, rawValue: string): Edit[] | null {
  const value = adaptValue(ref, strategy, rawValue);
  const quote = src[ref.valueStart - 1];
  if (ref.syntax === 'js-selector') {
    const sel = formatWdioSelector(strategy, value);
    return sel === null ? null : [{ start: ref.exprStart, end: ref.exprEnd, text: encodeLiteral(sel, quote) }];
  }
  if (sameStrategy(ref, strategy)) {
    return [{ start: ref.valueStart - 1, end: ref.valueEnd + 1, text: encodeLiteral(value, quote) }];
  }
  switch (ref.syntax) {
    case 'java-android-annotation':
    case 'java-ios-annotation': {
      const key = (ref.syntax === 'java-android-annotation' ? ANDROID_KEYS : IOS_KEYS)[strategy];
      return key ? [{ start: ref.exprStart, end: ref.exprEnd, text: `${key} = ${encodeLiteral(value, '"')}` }] : null;
    }
    case 'java-by-call': {
      const method = APPIUM_BY[strategy];
      if (!method) return null;
      const edits: Edit[] = [{ start: ref.exprStart, end: ref.exprEnd, text: `AppiumBy.${method}(${encodeLiteral(value, '"')})` }];
      const imp = javaImportEdit(src);
      if (imp) edits.push(imp);
      return edits;
    }
    case 'py-tuple': {
      const name = PY_BY[strategy];
      if (!name) return null;
      const edits: Edit[] = [{ start: ref.exprStart, end: ref.exprEnd, text: `AppiumBy.${name}, ${encodeLiteral(value, quote)}` }];
      if (!/\bimport\s+AppiumBy\b|import[^\n]*\bAppiumBy\b/.test(src)) edits.push({ start: 0, end: 0, text: 'from appium.webdriver.common.appiumby import AppiumBy\n' });
      return edits;
    }
    default:
      return null;
  }
}

function javaImportEdit(src: string): Edit | null {
  if (/import\s+io\.appium\.java_client\.(AppiumBy|\*)\s*;/.test(src)) return null;
  const imports = [...src.matchAll(/^import\s+[\w.*]+\s*;[^\n]*\n/gm)];
  const at = imports.length ? imports[imports.length - 1].index! + imports[imports.length - 1][0].length : (() => {
    const pkg = /^package\s+[\w.]+\s*;[^\n]*\n/m.exec(src);
    return pkg ? pkg.index + pkg[0].length : 0;
  })();
  return { start: at, end: at, text: 'import io.appium.java_client.AppiumBy;\n' };
}

export function applyEdits(src: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].end > sorted[i - 1].start && !(sorted[i].start === sorted[i].end && sorted[i - 1].start === sorted[i - 1].end)) {
      throw new Error('Overlapping source edits');
    }
  }
  let out = src;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
