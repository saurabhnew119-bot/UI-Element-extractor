import { InspectorError } from './errors.ts';
import type { ElementFingerprint, MatchCriteria, Platform, Rect, UiNode, UiTree } from './types.ts';
import { parseXml, type XmlElement } from '../util/xml.ts';

/** Attributes that identify an element on each platform. They are deliberately not shared. */
export const FINGERPRINT_ATTRS: Record<Platform, string[]> = {
  android: ['resource-id', 'content-desc', 'text', 'class', 'package', 'clickable', 'password', 'hint'],
  ios: ['name', 'label', 'value', 'type', 'accessible'],
};

export function detectPlatform(xml: string): Platform | null {
  if (/<XCUIElementType|<AppiumAUT/.test(xml)) return 'ios';
  if (/<hierarchy[\s>]|resource-id=|android\.widget\./.test(xml)) return 'android';
  return null;
}

export function parseHierarchy(xml: string, platform: Platform): UiTree {
  const detected = detectPlatform(xml);
  if (detected && detected !== platform) {
    throw new InspectorError(
      'WRONG_PLATFORM_BINARY',
      `This page source comes from ${detected}, but the ${platform} inspector was asked to parse it.`,
      { platform, hint: 'Android and iOS hierarchies are not interchangeable; inspect each platform with its own session.' },
    );
  }
  let doc: XmlElement;
  try {
    doc = parseXml(xml);
  } catch (e) {
    throw new InspectorError('INVALID_INPUT', `Page source is not valid XML: ${(e as Error).message}`, { platform });
  }
  const nodes = new Map<string, UiNode>();
  const build = (el: XmlElement, id: string, parentId: string | null, depth: number): UiNode => {
    const tag = platform === 'ios' ? (el.attrs.type ?? el.name) : (el.attrs.class ?? el.name);
    const node: UiNode = { id, tag, attrs: el.attrs, bounds: readBounds(el.attrs, platform), parentId, depth, children: [] };
    nodes.set(id, node);
    el.children.forEach((child, i) => node.children.push(build(child, `${id}.${i}`, id, depth + 1)));
    return node;
  };
  const root = build(doc, '0', null, 0);
  return { platform, root, nodes };
}

function readBounds(attrs: Record<string, string>, platform: Platform): Rect | null {
  if (platform === 'android') {
    const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attrs.bounds ?? '');
    if (!m) return null;
    const [x1, y1, x2, y2] = m.slice(1).map(Number);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  if (attrs.x === undefined || attrs.width === undefined) return null;
  return { x: Number(attrs.x), y: Number(attrs.y), width: Number(attrs.width), height: Number(attrs.height) };
}

export function ancestors(tree: UiTree, node: UiNode): UiNode[] {
  const out: UiNode[] = [];
  let cur = node.parentId ? tree.nodes.get(node.parentId) : undefined;
  while (cur) {
    out.unshift(cur);
    cur = cur.parentId ? tree.nodes.get(cur.parentId) : undefined;
  }
  return out;
}

/** Largest bounded node, used as the screen size reference (Android root has no bounds). */
export function screenSize(tree: UiTree): { width: number; height: number } | null {
  let best: Rect | null = null;
  for (const n of tree.nodes.values()) {
    if (n.bounds && (!best || n.bounds.width * n.bounds.height > best.width * best.height)) best = n.bounds;
  }
  return best ? { width: best.width, height: best.height } : null;
}

export function fingerprint(tree: UiTree, node: UiNode): ElementFingerprint {
  const attrs: Record<string, string> = {};
  for (const key of FINGERPRINT_ATTRS[tree.platform]) {
    const v = node.attrs[key];
    if (v !== undefined && v !== '') attrs[key] = v;
  }
  const parent = node.parentId ? tree.nodes.get(node.parentId) : undefined;
  return {
    platform: tree.platform,
    tag: node.tag,
    attrs,
    bounds: node.bounds,
    ancestry: ancestors(tree, node).slice(-5).map((a) => a.tag),
    siblingIndex: parent ? parent.children.indexOf(node) : 0,
    screenSize: screenSize(tree),
  };
}

export function matches(node: UiNode, criteria: MatchCriteria): boolean {
  if (criteria.nodeId !== undefined) return node.id === criteria.nodeId;
  if (criteria.tag !== undefined && node.tag !== criteria.tag) return false;
  for (const [k, v] of Object.entries(criteria.attrs)) {
    if ((node.attrs[k] ?? '') !== v) return false;
  }
  return true;
}

export function findAll(tree: UiTree, criteria: MatchCriteria): UiNode[] {
  const out: UiNode[] = [];
  for (const n of tree.nodes.values()) if (matches(n, criteria)) out.push(n);
  return out;
}

export function describeNode(node: UiNode, platform: Platform): string {
  const a = node.attrs;
  const key =
    platform === 'android'
      ? a['resource-id'] || a['content-desc'] || a.text
      : a.name || a.label || a.value;
  const shortTag = node.tag.replace(/^android\.widget\.|^XCUIElementType/, '');
  return key ? `${shortTag} "${key}"` : shortTag;
}

/** Elements the user cannot reliably act on; reported instead of silently offered as targets. */
export function accessibilityIssues(node: UiNode, platform: Platform): string[] {
  const a = node.attrs;
  const issues: string[] = [];
  if (platform === 'android') {
    if (a.displayed === 'false') issues.push('Element is not displayed.');
    if (a.enabled === 'false') issues.push('Element is disabled.');
    if (!a['resource-id'] && !a['content-desc'] && !a.text) issues.push('No resource-id, content-desc or text: only structural locators are possible.');
  } else {
    if (a.visible === 'false') issues.push('Element is not visible.');
    if (a.enabled === 'false') issues.push('Element is disabled.');
    if (a.accessible === 'false' && !a.name) issues.push('Element is not exposed to accessibility and has no name: only structural locators are possible.');
  }
  if (node.bounds && (node.bounds.width <= 0 || node.bounds.height <= 0)) issues.push('Element has zero size.');
  return issues;
}
