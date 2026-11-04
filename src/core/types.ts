export type Platform = 'android' | 'ios';

export const PLATFORMS: readonly Platform[] = ['android', 'ios'];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One node of a parsed Appium page source. `id` is a stable path such as "0.2.1". */
export interface UiNode {
  id: string;
  tag: string;
  attrs: Record<string, string>;
  bounds: Rect | null;
  parentId: string | null;
  depth: number;
  children: UiNode[];
}

export interface UiTree {
  platform: Platform;
  root: UiNode;
  /** Flat lookup by node id, in document order. */
  nodes: Map<string, UiNode>;
}

/** W3C / Appium locator strategies used by the inspector. */
export type LocatorStrategy =
  | 'accessibility id'
  | 'id'
  | '-android uiautomator'
  | '-ios predicate string'
  | '-ios class chain'
  | 'class name'
  | 'xpath';

/** Attribute-equality criteria used to evaluate a locator against a captured hierarchy offline. */
export interface MatchCriteria {
  tag?: string;
  attrs: Record<string, string>;
  /** Absolute node id, used for indexed XPath fallbacks. */
  nodeId?: string;
}

export interface LocatorCandidate {
  platform: Platform;
  strategy: LocatorStrategy;
  value: string;
  /** Preference rank from the platform rules (1 = most preferred). */
  rank: number;
  score: number;
  reason: string;
  warnings: string[];
  criteria: MatchCriteria;
  /** Matches in the captured hierarchy. */
  snapshotMatches: number;
  /** Matches reported by the live device, when validated; null when not validated. */
  liveMatches: number | null;
  unique: boolean;
}

export interface DeviceInfo {
  platform: Platform;
  udid: string;
  name: string;
  model: string;
  osVersion: string;
  kind: 'physical' | 'emulator' | 'simulator';
  state: string;
  /** False when the device is listed but cannot be used (unauthorized, offline, untrusted...). */
  usable: boolean;
  notes: string[];
}

/** Platform-specific stable signature of an element, used for change detection and healing. */
export interface ElementFingerprint {
  platform: Platform;
  tag: string;
  attrs: Record<string, string>;
  bounds: Rect | null;
  /** Ancestor tags, nearest last, at most 5. */
  ancestry: string[];
  siblingIndex: number;
  screenSize: { width: number; height: number } | null;
}

export interface ElementSnapshot {
  capturedAt: string;
  device: { udid: string; model: string; osVersion: string } | null;
  appId: string | null;
  fingerprint: ElementFingerprint;
  locators: LocatorCandidate[];
  /** Screenshot file name inside the repository's screenshot folder. */
  screenshot: string | null;
  source: 'live' | 'offline-snapshot';
}

export interface CodeRef {
  file: string;
  line: number;
  /** Absolute character offsets of the locator literal (string contents, without quotes). */
  valueStart: number;
  valueEnd: number;
  /** Absolute offsets of the whole locator expression, used when the strategy has to change. */
  exprStart: number;
  exprEnd: number;
  platform: Platform | 'shared' | 'web';
  strategy: LocatorStrategy | 'css' | 'name' | 'link text' | 'unknown';
  value: string;
  syntax: CodeSyntax;
  owner: string | null;
  field: string | null;
  raw: string;
}

export type CodeSyntax =
  | 'java-android-annotation'
  | 'java-ios-annotation'
  | 'java-selenium-annotation'
  | 'java-by-call'
  | 'js-selector'
  | 'py-tuple';

export interface PlatformBinding {
  screen: string;
  locators: LocatorCandidate[];
  fingerprint: ElementFingerprint;
  history: ElementSnapshot[];
  /** Code references confirmed for this platform (file:line). */
  codeRefs: Pick<CodeRef, 'file' | 'line' | 'field' | 'owner' | 'strategy' | 'value' | 'syntax'>[];
  implementation: string | null;
}

export interface LogicalElement {
  id: string;
  name: string;
  purpose: string;
  platforms: Partial<Record<Platform, PlatformBinding>>;
  tests: string[];
  createdAt: string;
  updatedAt: string;
}

export type LogicalAction = 'tap' | 'type' | 'clear' | 'verifyVisible' | 'verifyText' | 'back';

export interface LogicalStep {
  action: LogicalAction;
  elementId: string | null;
  value?: string;
}

/** Shared test specification; each platform resolves elements through its own binding. */
export interface LogicalTest {
  id: string;
  name: string;
  steps: LogicalStep[];
}

export interface RecordedAction {
  at: string;
  platform: Platform;
  action: LogicalAction;
  value?: string;
  locator: { strategy: LocatorStrategy; value: string } | null;
  alternatives: { strategy: LocatorStrategy; value: string }[];
  elementId: string | null;
  nodeSummary: string | null;
}
