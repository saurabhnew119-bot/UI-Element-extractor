import { ancestors, describeNode } from '../core/hierarchy.ts';
import type { ElementFingerprint, Platform, Rect, UiNode, UiTree } from '../core/types.ts';

export interface Evidence {
  feature: string;
  weight: number;
  similarity: number;
  recorded: string | null;
  current: string | null;
}

export interface MatchCandidate {
  nodeId: string;
  summary: string;
  score: number;
  evidence: Evidence[];
}

const WEIGHTS: Record<Platform, Record<string, number>> = {
  android: { 'resource-id': 0.3, 'content-desc': 0.2, text: 0.15, class: 0.15, bounds: 0.1, ancestry: 0.1 },
  ios: { name: 0.3, label: 0.2, value: 0.05, type: 0.2, bounds: 0.1, ancestry: 0.15 },
};

/** Minimum score and lead over the runner-up required before a repair is applied automatically. */
export const MIN_SCORE = 0.6;
export const MIN_MARGIN = 0.08;

function tokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  // A shared Android package prefix says nothing about whether two ids name the same element.
  a = a.replace(/^[\w.]+:id\//, '');
  b = b.replace(/^[\w.]+:id\//, '');
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = union ? inter / union : 0;
  return Math.max(jaccard, levenshteinRatio(a.toLowerCase(), b.toLowerCase()));
}

function boundsSimilarity(a: Rect, b: Rect, screen: { width: number; height: number } | null): number {
  const diag = screen ? Math.hypot(screen.width, screen.height) : 2000;
  const d = Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
  const pos = Math.max(0, 1 - d / (0.25 * diag));
  const size = Math.min(a.width * a.height, b.width * b.height) / Math.max(1, a.width * a.height, b.width * b.height);
  return 0.7 * pos + 0.3 * size;
}

function sequenceSimilarity(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp[0][0] / Math.max(a.length, b.length);
}

function scoreNode(tree: UiTree, node: UiNode, fp: ElementFingerprint): { score: number; evidence: Evidence[] } {
  const weights = WEIGHTS[fp.platform];
  const evidence: Evidence[] = [];
  for (const [feature, weight] of Object.entries(weights)) {
    let recorded: string | null = null;
    let current: string | null = null;
    let similarity: number;
    if (feature === 'class' || feature === 'type') {
      recorded = fp.tag;
      current = node.tag;
      similarity = recorded === current ? 1 : 0;
    } else if (feature === 'bounds') {
      if (!fp.bounds || !node.bounds) continue;
      recorded = `${fp.bounds.x},${fp.bounds.y} ${fp.bounds.width}x${fp.bounds.height}`;
      current = `${node.bounds.x},${node.bounds.y} ${node.bounds.width}x${node.bounds.height}`;
      similarity = boundsSimilarity(fp.bounds, node.bounds, fp.screenSize);
    } else if (feature === 'ancestry') {
      const anc = ancestors(tree, node).slice(-5).map((a) => a.tag);
      recorded = fp.ancestry.join(' > ');
      current = anc.join(' > ');
      similarity = sequenceSimilarity(fp.ancestry, anc);
    } else {
      recorded = fp.attrs[feature] ?? null;
      current = node.attrs[feature] || null;
      // Features absent from the recording carry no evidence either way.
      if (recorded === null) continue;
      similarity = current === null ? 0 : stringSimilarity(recorded, current);
    }
    evidence.push({ feature, weight, similarity: Math.round(similarity * 1000) / 1000, recorded, current });
  }
  const totalWeight = evidence.reduce((a, e) => a + e.weight, 0);
  const score = totalWeight ? evidence.reduce((a, e) => a + e.weight * e.similarity, 0) / totalWeight : 0;
  return { score: Math.round(score * 1000) / 1000, evidence };
}

/** Ranks every node in the current hierarchy by similarity to the recorded fingerprint. */
export function rankMatches(tree: UiTree, fp: ElementFingerprint, limit = 5): MatchCandidate[] {
  if (tree.platform !== fp.platform) throw new Error(`Cannot match a ${fp.platform} fingerprint against a ${tree.platform} hierarchy.`);
  const out: MatchCandidate[] = [];
  for (const node of tree.nodes.values()) {
    if (!node.parentId) continue;
    const { score, evidence } = scoreNode(tree, node, fp);
    out.push({ nodeId: node.id, summary: describeNode(node, tree.platform), score, evidence });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
