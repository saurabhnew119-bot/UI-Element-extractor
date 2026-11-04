import { ancestors, findAll } from './hierarchy.ts';
import type { LocatorCandidate, LocatorStrategy, MatchCriteria, Platform, UiNode, UiTree } from './types.ts';

interface Draft {
  strategy: LocatorStrategy;
  value: string;
  rank: number;
  score: number;
  reason: string;
  warnings?: string[];
  criteria: MatchCriteria;
}

export function quoteJava(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function quoteXPath(s: string): string {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return 'concat(' + s.split('"').map((p) => `"${p}"`).join(`, '"', `) + ')';
}

/** Resource ids that are system-provided or look auto-generated are poor long-term anchors. */
function resourceIdWarnings(rid: string): string[] {
  const w: string[] = [];
  if (rid.startsWith('android:id/')) w.push('System resource id (android:id/...) is shared by many screens.');
  if (/\d{3,}|_[0-9a-f]{6,}$/i.test(rid)) w.push('Resource id looks generated and may change between builds.');
  return w;
}

function androidDrafts(node: UiNode): Draft[] {
  const a = node.attrs;
  const cls = node.tag;
  const desc = a['content-desc'] ?? '';
  const rid = a['resource-id'] ?? '';
  const text = a.text ?? '';
  const d: Draft[] = [];
  if (desc) {
    d.push({ strategy: 'accessibility id', value: desc, rank: 1, score: 95, reason: 'content-desc (accessibility description)', criteria: { attrs: { 'content-desc': desc } } });
  }
  if (rid) {
    // UiAutomator2 prefixes a bare id with the app package, so ids without ":id/" (e.g. React Native
    // testIDs) are unreachable through the id strategy; the UiSelector drafts below still find them.
    if (rid.includes(':id/')) {
      d.push({ strategy: 'id', value: rid, rank: 2, score: 90, reason: 'resource-id', warnings: resourceIdWarnings(rid), criteria: { attrs: { 'resource-id': rid } } });
    }
    d.push({
      strategy: '-android uiautomator',
      value: `new UiSelector().resourceId(${quoteJava(rid)}).className(${quoteJava(cls)})`,
      rank: 3, score: 82, reason: 'UiAutomator: resource-id + class',
      criteria: { tag: cls, attrs: { 'resource-id': rid } },
    });
    if (text) {
      d.push({
        strategy: '-android uiautomator',
        value: `new UiSelector().resourceId(${quoteJava(rid)}).text(${quoteJava(text)})`,
        rank: 3, score: 78, reason: 'UiAutomator: resource-id + text (disambiguates repeated ids)',
        warnings: ['Text may change with copy edits or localization.'],
        criteria: { attrs: { 'resource-id': rid, text } },
      });
    }
  }
  if (desc) {
    d.push({
      strategy: '-android uiautomator',
      value: `new UiSelector().description(${quoteJava(desc)}).className(${quoteJava(cls)})`,
      rank: 3, score: 80, reason: 'UiAutomator: content-desc + class',
      criteria: { tag: cls, attrs: { 'content-desc': desc } },
    });
  }
  if (text) {
    d.push({
      strategy: '-android uiautomator',
      value: `new UiSelector().className(${quoteJava(cls)}).text(${quoteJava(text)})`,
      rank: 4, score: 60, reason: 'UiAutomator: class + visible text',
      warnings: ['Text may change with copy edits or localization.'],
      criteria: { tag: cls, attrs: { text } },
    });
    d.push({ strategy: 'xpath', value: `//${cls}[@text=${quoteXPath(text)}]`, rank: 5, score: 30, reason: 'XPath on class + text', warnings: ['XPath is slower and more brittle than UiAutomator.'], criteria: { tag: cls, attrs: { text } } });
  }
  return d;
}

function iosDrafts(node: UiNode): Draft[] {
  const a = node.attrs;
  const type = node.tag;
  const name = a.name ?? '';
  const label = a.label ?? '';
  const value = a.value ?? '';
  // XCUITest exposes accessibilityIdentifier as `name` and falls back to the label when no identifier is set.
  // A name that differs from the label is therefore very likely a real identifier.
  const identifierLikely = name !== '' && name !== label;
  const d: Draft[] = [];
  if (identifierLikely) {
    d.push({ strategy: 'accessibility id', value: name, rank: 1, score: 95, reason: 'accessibilityIdentifier (name differs from label)', criteria: { attrs: { name } } });
  } else if (name) {
    d.push({
      strategy: 'accessibility id', value: name, rank: 2, score: 72,
      reason: 'accessibility id (name)',
      warnings: ['name equals label, so no accessibilityIdentifier appears to be set; this value follows the visible label and may change with copy or localization.'],
      criteria: { attrs: { name } },
    });
  }
  if (label) {
    d.push({
      strategy: '-ios predicate string', value: `type == ${quoteJava(type)} AND label == ${quoteJava(label)}`,
      rank: 3, score: 66, reason: 'Predicate: type + accessibility label',
      warnings: identifierLikely ? [] : ['Label may change with copy or localization.'],
      criteria: { tag: type, attrs: { label } },
    });
  }
  if (name && !name.includes('`')) {
    d.push({ strategy: '-ios class chain', value: `**/${type}[\`name == ${quoteJava(name)}\`]`, rank: 4, score: identifierLikely ? 80 : 58, reason: 'Class chain: type + name', criteria: { tag: type, attrs: { name } } });
  }
  if (label && label !== name && !label.includes('`')) {
    d.push({ strategy: '-ios class chain', value: `**/${type}[\`label == ${quoteJava(label)}\`]`, rank: 4, score: 55, reason: 'Class chain: type + label', criteria: { tag: type, attrs: { label } } });
  }
  if (value) {
    d.push({
      strategy: '-ios predicate string', value: `type == ${quoteJava(type)} AND value == ${quoteJava(value)}`,
      rank: 5, score: 42, reason: 'Predicate: type + value',
      warnings: ['Value reflects element state (typed text, switch state) and is often unstable.'],
      criteria: { tag: type, attrs: { value } },
    });
  }
  d.push({ strategy: 'class name', value: type, rank: 5, score: 35, reason: 'Element type only', criteria: { tag: type, attrs: {} } });
  if (name) {
    d.push({ strategy: 'xpath', value: `//${type}[@name=${quoteXPath(name)}]`, rank: 6, score: 25, reason: 'XPath on type + name', warnings: ['XPath is slow on iOS; prefer accessibility id or predicates.'], criteria: { tag: type, attrs: { name } } });
  }
  return d;
}

function absoluteXPath(tree: UiTree, node: UiNode): string {
  const chain = [...ancestors(tree, node), node];
  return chain
    .map((n) => {
      const parent = n.parentId ? tree.nodes.get(n.parentId) : undefined;
      if (!parent) return `/${n.tag}`;
      const same = parent.children.filter((c) => c.tag === n.tag);
      return `/${n.tag}[${same.indexOf(n) + 1}]`;
    })
    .join('');
}

/**
 * Generates locator alternatives for one node following the platform's preference order, then validates
 * each one for uniqueness against the captured hierarchy. Non-unique candidates are kept (they are useful
 * evidence) but demoted and flagged.
 */
export function generateLocators(tree: UiTree, node: UiNode): LocatorCandidate[] {
  const drafts = tree.platform === 'android' ? androidDrafts(node) : iosDrafts(node);
  drafts.push({
    strategy: 'xpath', value: absoluteXPath(tree, node), rank: tree.platform === 'android' ? 5 : 6, score: 10,
    reason: 'Absolute indexed XPath (last resort)',
    warnings: ['Breaks on any layout change above this element.'],
    criteria: { attrs: {}, nodeId: node.id },
  });
  const seen = new Set<string>();
  const out: LocatorCandidate[] = [];
  for (const draft of drafts) {
    const key = `${draft.strategy}|${draft.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hits = findAll(tree, draft.criteria);
    const unique = hits.length === 1 && hits[0].id === node.id;
    const warnings = [...(draft.warnings ?? [])];
    if (!unique) warnings.unshift(`Matches ${hits.length} elements in this hierarchy.`);
    out.push({
      platform: tree.platform,
      strategy: draft.strategy,
      value: draft.value,
      rank: draft.rank,
      score: unique ? draft.score : Math.max(0, draft.score - 50),
      reason: draft.reason,
      warnings,
      criteria: draft.criteria,
      snapshotMatches: hits.length,
      liveMatches: null,
      unique,
    });
  }
  return sortCandidates(out);
}

export function sortCandidates(c: LocatorCandidate[]): LocatorCandidate[] {
  return [...c].sort((a, b) => Number(b.unique) - Number(a.unique) || a.rank - b.rank || b.score - a.score);
}

export function bestLocator(c: LocatorCandidate[]): LocatorCandidate | null {
  return sortCandidates(c).find((x) => x.unique && x.strategy !== 'xpath') ?? sortCandidates(c).find((x) => x.unique) ?? null;
}

/**
 * Evaluates a locator that was not generated by us (e.g. read from source code) against a captured
 * hierarchy. Returns null when the strategy cannot be evaluated offline, so callers must use a live session.
 */
export function evaluateOffline(tree: UiTree, strategy: string, value: string): UiNode[] | null {
  const p = tree.platform;
  switch (strategy) {
    case 'accessibility id':
      return findAll(tree, { attrs: p === 'android' ? { 'content-desc': value } : { name: value } });
    case 'id':
      if (p === 'ios') return findAll(tree, { attrs: { name: value } });
      return [...tree.nodes.values()].filter((n) => {
        const rid = n.attrs['resource-id'] ?? '';
        return value.includes(':id/') ? rid === value : rid.endsWith(`:id/${value}`);
      });
    case 'class name':
      return findAll(tree, { tag: value, attrs: {} });
    case '-android uiautomator':
      return p === 'android' ? evalUiSelector(tree, value) : null;
    case '-ios predicate string':
      return p === 'ios' ? evalSimplePredicate(tree, value) : null;
    case '-ios class chain': {
      if (p !== 'ios') return null;
      const m = /^\*\*\/(\w+)(?:\[`(.+)`\])?$/.exec(value);
      if (!m) return null;
      const byType = findAll(tree, { tag: m[1], attrs: {} });
      if (!m[2]) return byType;
      const pred = evalSimplePredicate(tree, m[2]);
      return pred ? byType.filter((n) => pred.includes(n)) : null;
    }
    case 'xpath':
      return evalSimpleXPath(tree, value);
    default:
      return null;
  }
}

const UI_SELECTOR_ATTR: Record<string, string> = {
  resourceId: 'resource-id', description: 'content-desc', text: 'text', className: 'class',
};

function evalUiSelector(tree: UiTree, sel: string): UiNode[] | null {
  const body = sel.trim().replace(/^new UiSelector\(\)/, '');
  const attrs: Record<string, string> = {};
  const re = /\.(\w+)\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
  let consumed = 0;
  for (const m of body.matchAll(re)) {
    const attr = UI_SELECTOR_ATTR[m[1]];
    if (!attr) return null;
    attrs[attr] = m[2].replace(/\\(.)/g, '$1');
    consumed += m[0].length;
  }
  if (consumed !== body.replace(/;$/, '').length) return null;
  return findAll(tree, { attrs });
}

function evalSimplePredicate(tree: UiTree, pred: string): UiNode[] | null {
  const parts = pred.split(/\s+AND\s+/i);
  const attrs: Record<string, string> = {};
  let tag: string | undefined;
  for (const part of parts) {
    const m = /^\s*(\w+)\s*==\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*$/.exec(part);
    if (!m) return null;
    const v = (m[2] ?? m[3]).replace(/\\(.)/g, '$1');
    if (m[1] === 'type' || m[1] === 'elementType') tag = v;
    else attrs[m[1]] = v;
  }
  return findAll(tree, { tag, attrs });
}

function evalSimpleXPath(tree: UiTree, xp: string): UiNode[] | null {
  const rel = /^\/\/([\w.$*]+)(?:\[@([\w-]+)=(?:"([^"]*)"|'([^']*)')\])?$/.exec(xp);
  if (rel) {
    const tag = rel[1] === '*' ? undefined : rel[1];
    const attrs: Record<string, string> = rel[2] ? { [rel[2]]: rel[3] ?? rel[4] } : {};
    return findAll(tree, { tag, attrs });
  }
  if (/^(\/[\w.$]+(\[\d+\])?)+$/.test(xp)) {
    const steps = xp.split('/').slice(1);
    let current: UiNode[] = [];
    for (const [i, step] of steps.entries()) {
      const m = /^([\w.$]+)(?:\[(\d+)\])?$/.exec(step)!;
      const pool = i === 0 ? [tree.root] : current.flatMap((n) => n.children);
      let next = pool.filter((n) => n.tag === m[1]);
      if (m[2]) {
        const idx = Number(m[2]) - 1;
        next = i === 0 ? next.slice(idx, idx + 1) : current.flatMap((n) => n.children.filter((c) => c.tag === m[1]).slice(idx, idx + 1));
      }
      current = next;
    }
    return current;
  }
  return null;
}
