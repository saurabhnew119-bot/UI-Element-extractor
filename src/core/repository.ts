import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { InspectorError } from './errors.ts';
import { fingerprint } from './hierarchy.ts';
import { generateLocators } from './locators.ts';
import type { ElementFingerprint, ElementSnapshot, LogicalElement, LogicalTest, Platform, PlatformBinding, UiNode, UiTree } from './types.ts';

export const REPOSITORY_FORMAT = 'elementiq-repository';
export const SCHEMA_VERSION = 1;

interface RepositoryFile {
  format: typeof REPOSITORY_FORMAT;
  schemaVersion: number;
  elements: LogicalElement[];
  tests: LogicalTest[];
}

export interface RepositoryBundle extends RepositoryFile {
  exportedAt: string;
  /** Screenshot file name -> base64 PNG. */
  screenshots: Record<string, string>;
}

export interface FingerprintChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface CaptureInput {
  platform: Platform;
  tree: UiTree;
  node: UiNode;
  name: string;
  screen: string;
  purpose?: string;
  /** Existing logical element to attach this platform binding to (shared business purpose). */
  elementId?: string;
  device: ElementSnapshot['device'];
  appId: string | null;
  screenshotBase64: string | null;
  source: ElementSnapshot['source'];
}

export function compareFingerprints(a: ElementFingerprint, b: ElementFingerprint): FingerprintChange[] {
  const changes: FingerprintChange[] = [];
  if (a.tag !== b.tag) changes.push({ field: 'type', before: a.tag, after: b.tag });
  for (const key of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) {
    if ((a.attrs[key] ?? null) !== (b.attrs[key] ?? null)) changes.push({ field: key, before: a.attrs[key] ?? null, after: b.attrs[key] ?? null });
  }
  if (a.bounds && b.bounds) {
    const moved = Math.abs(a.bounds.x - b.bounds.x) + Math.abs(a.bounds.y - b.bounds.y);
    const resized = Math.abs(a.bounds.width - b.bounds.width) + Math.abs(a.bounds.height - b.bounds.height);
    if (moved > 8 || resized > 8) changes.push({ field: 'bounds', before: rectStr(a.bounds), after: rectStr(b.bounds) });
  }
  if (a.ancestry.join('>') !== b.ancestry.join('>')) changes.push({ field: 'ancestry', before: a.ancestry.join(' > '), after: b.ancestry.join(' > ') });
  return changes;
}

function rectStr(r: { x: number; y: number; width: number; height: number }) {
  return `${r.x},${r.y} ${r.width}x${r.height}`;
}

export class ElementRepository {
  readonly dir: string;
  private data: RepositoryFile;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
    const file = this.file();
    this.data = existsSync(file) ? validate(JSON.parse(readFileSync(file, 'utf8'))) : { format: REPOSITORY_FORMAT, schemaVersion: SCHEMA_VERSION, elements: [], tests: [] };
  }

  /** Re-reads repository.json, e.g. after a rollback restored it on disk. */
  reload() {
    const file = this.file();
    if (existsSync(file)) this.data = validate(JSON.parse(readFileSync(file, 'utf8')));
  }

  private file() {
    return path.join(this.dir, 'repository.json');
  }

  private save() {
    const tmp = this.file() + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file());
  }

  elements(): LogicalElement[] {
    return this.data.elements;
  }

  tests(): LogicalTest[] {
    return this.data.tests;
  }

  get(id: string): LogicalElement {
    const el = this.data.elements.find((e) => e.id === id);
    if (!el) throw new InspectorError('INVALID_INPUT', `Logical element ${id} does not exist.`);
    return el;
  }

  findByName(name: string): LogicalElement | undefined {
    return this.data.elements.find((e) => e.name === name);
  }

  screenshotPath(name: string): string {
    if (!/^[0-9a-f]{64}\.png$/.test(name)) throw new InspectorError('INVALID_INPUT', 'Invalid screenshot name.');
    return path.join(this.dir, 'screenshots', name);
  }

  private storeScreenshot(base64: string): string {
    const buf = Buffer.from(base64, 'base64');
    const name = createHash('sha256').update(buf).digest('hex') + '.png';
    const file = path.join(this.dir, 'screenshots', name);
    if (!existsSync(file)) writeFileSync(file, buf);
    return name;
  }

  /**
   * Records an element for one platform. Capturing again for the same platform appends to its history and
   * reports what changed; the other platform's binding is never touched.
   */
  capture(input: CaptureInput): { element: LogicalElement; changes: FingerprintChange[] } {
    const now = new Date().toISOString();
    const fp = fingerprint(input.tree, input.node);
    const locators = generateLocators(input.tree, input.node);
    const snapshot: ElementSnapshot = {
      capturedAt: now, device: input.device, appId: input.appId, fingerprint: fp, locators,
      screenshot: input.screenshotBase64 ? this.storeScreenshot(input.screenshotBase64) : null, source: input.source,
    };
    let element = input.elementId ? this.get(input.elementId) : this.findByName(input.name);
    if (!element) {
      element = { id: randomUUID(), name: input.name, purpose: input.purpose ?? '', platforms: {}, tests: [], createdAt: now, updatedAt: now };
      this.data.elements.push(element);
    }
    if (input.purpose) element.purpose = input.purpose;
    const prev = element.platforms[input.platform];
    const changes = prev ? compareFingerprints(prev.fingerprint, fp) : [];
    const binding: PlatformBinding = {
      screen: input.screen,
      locators,
      fingerprint: fp,
      history: [...(prev?.history ?? []), snapshot],
      codeRefs: prev?.codeRefs ?? [],
      implementation: prev?.implementation ?? null,
    };
    element.platforms[input.platform] = binding;
    element.updatedAt = now;
    this.save();
    return { element, changes };
  }

  history(id: string, platform: Platform): { snapshot: ElementSnapshot; changesFromPrevious: FingerprintChange[] }[] {
    const b = this.get(id).platforms[platform];
    if (!b) throw new InspectorError('INVALID_INPUT', `Element has no ${platform} binding.`, { platform });
    return b.history.map((snapshot, i) => ({ snapshot, changesFromPrevious: i === 0 ? [] : compareFingerprints(b.history[i - 1].fingerprint, snapshot.fingerprint) }));
  }

  update(id: string, patch: Partial<Pick<LogicalElement, 'name' | 'purpose' | 'tests'>> & { implementation?: { platform: Platform; value: string | null } }) {
    const el = this.get(id);
    if (patch.name !== undefined) el.name = patch.name;
    if (patch.purpose !== undefined) el.purpose = patch.purpose;
    if (patch.tests !== undefined) el.tests = patch.tests;
    if (patch.implementation) {
      const b = el.platforms[patch.implementation.platform];
      if (!b) throw new InspectorError('INVALID_INPUT', `Element has no ${patch.implementation.platform} binding.`);
      b.implementation = patch.implementation.value;
    }
    el.updatedAt = new Date().toISOString();
    this.save();
    return el;
  }

  setCodeRefs(id: string, platform: Platform, refs: PlatformBinding['codeRefs']) {
    const b = this.get(id).platforms[platform];
    if (!b) return;
    b.codeRefs = refs;
    this.save();
  }

  /** Called by the healer after a verified repair so the repository follows the code. */
  replaceBinding(id: string, platform: Platform, binding: PlatformBinding) {
    const el = this.get(id);
    el.platforms[platform] = binding;
    el.updatedAt = new Date().toISOString();
    this.save();
  }

  /**
   * Moves a recorded unique locator to the front of a platform binding (used to adopt a runtime-healing fallback).
   * Returns false when the locator is not recorded for that platform.
   */
  promoteLocator(id: string, platform: Platform, strategy: string, value: string): boolean {
    const b = this.get(id).platforms[platform];
    const i = b?.locators.findIndex((l) => l.unique && l.strategy === strategy && l.value === value) ?? -1;
    if (!b || i < 0) return false;
    if (i > 0) {
      b.locators.unshift(...b.locators.splice(i, 1));
      this.get(id).updatedAt = new Date().toISOString();
      this.save();
    }
    return true;
  }

  remove(id: string) {
    this.data.elements = this.data.elements.filter((e) => e.id !== id);
    this.data.tests = this.data.tests.map((t) => ({ ...t, steps: t.steps.filter((s) => s.elementId !== id) }));
    this.save();
  }

  upsertTest(test: Omit<LogicalTest, 'id'> & { id?: string }): LogicalTest {
    for (const step of test.steps) if (step.elementId) this.get(step.elementId);
    const t: LogicalTest = { id: test.id ?? randomUUID(), name: test.name, steps: test.steps };
    const i = this.data.tests.findIndex((x) => x.id === t.id);
    if (i >= 0) this.data.tests[i] = t;
    else this.data.tests.push(t);
    this.save();
    return t;
  }

  /**
   * Resolves a shared logical test into a platform-specific action list. Steps whose element has no binding
   * for this platform are reported as gaps, never substituted with the other platform's locator.
   */
  resolveTest(testId: string, platform: Platform) {
    const test = this.data.tests.find((t) => t.id === testId);
    if (!test) throw new InspectorError('INVALID_INPUT', `Test ${testId} does not exist.`);
    const gaps: string[] = [];
    const steps = test.steps.map((step, i) => {
      if (!step.elementId) return { ...step, locator: null, alternatives: [] };
      const el = this.get(step.elementId);
      const b = el.platforms[platform];
      const usable = b?.locators.filter((l) => l.unique) ?? [];
      if (!usable.length) gaps.push(`Step ${i + 1} (${step.action} ${el.name}) has no unique ${platform} locator.`);
      return {
        ...step,
        locator: usable[0] ? { strategy: usable[0].strategy, value: usable[0].value } : null,
        alternatives: usable.slice(1).map((l) => ({ strategy: l.strategy, value: l.value })),
      };
    });
    return { test, platform, steps, gaps };
  }

  exportBundle(): RepositoryBundle {
    const screenshots: Record<string, string> = {};
    for (const el of this.data.elements) {
      for (const b of Object.values(el.platforms)) {
        for (const h of b?.history ?? []) {
          if (h.screenshot && !screenshots[h.screenshot]) {
            const file = path.join(this.dir, 'screenshots', h.screenshot);
            if (existsSync(file)) screenshots[h.screenshot] = readFileSync(file).toString('base64');
          }
        }
      }
    }
    return { ...this.data, exportedAt: new Date().toISOString(), screenshots };
  }

  importBundle(raw: unknown, mode: 'merge' | 'replace'): { elements: number; tests: number } {
    const bundle = validate(raw);
    const screenshots = (raw as Partial<RepositoryBundle>).screenshots ?? {};
    if (typeof screenshots !== 'object' || Object.values(screenshots).some((v) => typeof v !== 'string')) {
      throw new InspectorError('INVALID_INPUT', 'Bundle screenshots must map file names to base64 strings.');
    }
    for (const [name, b64] of Object.entries(screenshots)) {
      const file = this.screenshotPath(name);
      const buf = Buffer.from(b64, 'base64');
      if (createHash('sha256').update(buf).digest('hex') + '.png' !== name) throw new InspectorError('INVALID_INPUT', `Screenshot ${name} does not match its checksum.`);
      if (!existsSync(file)) writeFileSync(file, buf);
    }
    if (mode === 'replace') {
      this.data = { format: REPOSITORY_FORMAT, schemaVersion: SCHEMA_VERSION, elements: bundle.elements, tests: bundle.tests };
    } else {
      const byId = new Map(this.data.elements.map((e) => [e.id, e]));
      for (const e of bundle.elements) byId.set(e.id, e);
      this.data.elements = [...byId.values()];
      const tests = new Map(this.data.tests.map((t) => [t.id, t]));
      for (const t of bundle.tests) tests.set(t.id, t);
      this.data.tests = [...tests.values()];
    }
    this.save();
    return { elements: bundle.elements.length, tests: bundle.tests.length };
  }
}

function validate(raw: unknown): RepositoryFile {
  const r = raw as Partial<RepositoryFile> | null;
  if (!r || r.format !== REPOSITORY_FORMAT) throw new InspectorError('INVALID_INPUT', `Not an ElementIQ repository (expected format "${REPOSITORY_FORMAT}").`);
  if (r.schemaVersion !== SCHEMA_VERSION) throw new InspectorError('INVALID_INPUT', `Unsupported repository schemaVersion ${r.schemaVersion}; this build reads version ${SCHEMA_VERSION}.`);
  if (!Array.isArray(r.elements) || !Array.isArray(r.tests)) throw new InspectorError('INVALID_INPUT', 'Repository is missing elements or tests arrays.');
  for (const e of r.elements) {
    if (!e.id || !e.name || typeof e.platforms !== 'object') throw new InspectorError('INVALID_INPUT', `Malformed element entry ${JSON.stringify(e).slice(0, 120)}.`);
    for (const p of Object.keys(e.platforms)) {
      if (p !== 'android' && p !== 'ios') throw new InspectorError('INVALID_INPUT', `Element ${e.name} has unknown platform binding "${p}".`);
    }
  }
  return { format: REPOSITORY_FORMAT, schemaVersion: SCHEMA_VERSION, elements: r.elements, tests: r.tests };
}
