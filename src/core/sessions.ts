import { randomUUID } from 'node:crypto';
import { adapterFor } from '../platforms/index.ts';
import type { SessionRequest } from '../platforms/common.ts';
import { InspectorError, toInspectorError } from './errors.ts';
import { accessibilityIssues, describeNode, parseHierarchy } from './hierarchy.ts';
import { bestLocator, generateLocators, sortCandidates } from './locators.ts';
import type { LocatorCandidate, LocatorStrategy, LogicalAction, Platform, RecordedAction, UiTree } from './types.ts';
import { WebDriverClient, WebDriverRequestError } from './webdriver.ts';

export const DEFAULT_APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';

export interface InspectorSession {
  id: string;
  mode: 'live' | 'offline';
  platform: Platform;
  udid: string | null;
  deviceKind: SessionRequest['deviceKind'] | null;
  deviceLabel: string;
  osVersion: string | null;
  appId: string | null;
  appiumUrl: string | null;
  appiumSessionId: string | null;
  capabilities: Record<string, unknown>;
  warnings: string[];
  startedAt: string;
  recording: boolean;
  actions: RecordedAction[];
  tree: UiTree | null;
  source: string | null;
  screenshot: string | null;
  context: string;
}

export interface SnapshotResult {
  sessionId: string;
  platform: Platform;
  context: string;
  contexts: string[];
  capturedAt: string;
  screenshot: string | null;
  tree: UiTree['root'] | null;
  /** Raw HTML when the active context is a WebView. */
  webSource: string | null;
  notices: string[];
}

export interface ActionRequest {
  action: LogicalAction;
  nodeId?: string;
  locator?: { strategy: LocatorStrategy; value: string };
  value?: string;
  elementId?: string | null;
}

export interface PlaybackStep {
  index: number;
  action: LogicalAction;
  status: 'passed' | 'passed-with-alternative' | 'failed';
  usedLocator: { strategy: LocatorStrategy; value: string } | null;
  error: ReturnType<InspectorError['toJSON']> | null;
}

export class SessionManager {
  private sessions = new Map<string, InspectorSession>();
  private clients = new Map<string, WebDriverClient>();

  list(): Omit<InspectorSession, 'tree' | 'source' | 'screenshot'>[] {
    return [...this.sessions.values()].map(({ tree: _t, source: _s, screenshot: _sc, ...rest }) => rest);
  }

  get(id: string): InspectorSession {
    const s = this.sessions.get(id);
    if (!s) throw new InspectorError('SESSION_NOT_FOUND', `No inspector session ${id}.`);
    return s;
  }

  private client(url: string): WebDriverClient {
    let c = this.clients.get(url);
    if (!c) this.clients.set(url, (c = new WebDriverClient(url)));
    return c;
  }

  async create(req: SessionRequest): Promise<InspectorSession> {
    const adapter = adapterFor(req.platform);
    const busy = [...this.sessions.values()].find((s) => s.mode === 'live' && s.udid === req.udid);
    if (busy) {
      throw new InspectorError('DEVICE_BUSY', `Device ${req.udid} already has an active ${busy.platform} session (${busy.id}).`, { platform: req.platform, hint: 'Close that session or use another device.' });
    }
    const { capabilities, warnings } = adapter.buildCapabilities(req);
    const appiumUrl = req.appiumUrl || DEFAULT_APPIUM_URL;
    const client = this.client(appiumUrl);
    let created: { sessionId: string; capabilities: Record<string, unknown> };
    try {
      created = await client.createSession(capabilities);
    } catch (e) {
      if (e instanceof WebDriverRequestError) throw adapter.classifySessionError(e.message);
      throw toInspectorError(e, req.platform);
    }
    const caps = created.capabilities;
    const session: InspectorSession = {
      id: randomUUID(),
      mode: 'live',
      platform: req.platform,
      udid: req.udid,
      deviceKind: req.deviceKind ?? null,
      deviceLabel: String(caps.deviceModel ?? caps.deviceName ?? req.deviceName ?? req.udid),
      osVersion: caps.platformVersion ? String(caps.platformVersion) : null,
      appId: req.appId ?? ((caps.appPackage ?? caps.bundleId) as string | undefined) ?? null,
      appiumUrl,
      appiumSessionId: created.sessionId,
      capabilities: caps,
      warnings,
      startedAt: new Date().toISOString(),
      recording: false,
      actions: [],
      tree: null,
      source: null,
      screenshot: null,
      context: 'NATIVE_APP',
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Loads a previously captured page source (and optional screenshot) for offline inspection. */
  createOffline(platform: Platform, source: string, screenshot: string | null, label: string): InspectorSession {
    const tree = parseHierarchy(source, platform);
    const session: InspectorSession = {
      id: randomUUID(), mode: 'offline', platform, udid: null, deviceKind: null, deviceLabel: label, osVersion: null,
      appId: null, appiumUrl: null, appiumSessionId: null, capabilities: {},
      warnings: ['Offline snapshot: no device is connected. Locators are validated against the captured hierarchy only, and actions are unavailable.'],
      startedAt: new Date().toISOString(), recording: false, actions: [], tree, source, screenshot, context: 'NATIVE_APP',
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async close(id: string): Promise<void> {
    const s = this.get(id);
    this.sessions.delete(id);
    if (s.mode === 'live' && s.appiumUrl && s.appiumSessionId) {
      await this.client(s.appiumUrl).deleteSession(s.appiumSessionId).catch(() => undefined);
    }
  }

  private live(id: string): { s: InspectorSession; c: WebDriverClient; sid: string } {
    const s = this.get(id);
    if (s.mode !== 'live' || !s.appiumUrl || !s.appiumSessionId) {
      throw new InspectorError('UNSUPPORTED_CAPABILITY', 'This is an offline snapshot; connect a device to perform live operations.', { platform: s.platform });
    }
    return { s, c: this.client(s.appiumUrl), sid: s.appiumSessionId };
  }

  async snapshot(id: string): Promise<SnapshotResult> {
    const s = this.get(id);
    const notices = [...s.warnings];
    if (s.mode === 'offline') {
      return { sessionId: s.id, platform: s.platform, context: s.context, contexts: ['NATIVE_APP'], capturedAt: s.startedAt, screenshot: s.screenshot, tree: s.tree!.root, webSource: null, notices };
    }
    const { c, sid } = this.live(id);
    try {
      let contexts: string[] = ['NATIVE_APP'];
      try {
        contexts = await c.contexts(sid);
        s.context = await c.currentContext(sid);
      } catch {
        notices.push('Context listing is not supported by this driver/app; only NATIVE_APP is available.');
      }
      const [source, screenshot] = await Promise.all([c.pageSource(sid), c.screenshot(sid)]);
      s.screenshot = screenshot;
      s.source = source;
      if (s.context !== 'NATIVE_APP') {
        s.tree = null;
        notices.push(`Active context ${s.context} is a WebView: the source is HTML. Use CSS/XPath web locators, or switch back to NATIVE_APP.`);
        return { sessionId: s.id, platform: s.platform, context: s.context, contexts, capturedAt: new Date().toISOString(), screenshot, tree: null, webSource: source, notices };
      }
      s.tree = parseHierarchy(source, s.platform);
      return { sessionId: s.id, platform: s.platform, context: s.context, contexts, capturedAt: new Date().toISOString(), screenshot, tree: s.tree.root, webSource: null, notices };
    } catch (e) {
      throw this.wrap(e, s.platform);
    }
  }

  async switchContext(id: string, name: string): Promise<void> {
    const { s, c, sid } = this.live(id);
    try {
      await c.setContext(sid, name);
      s.context = name;
    } catch (e) {
      throw this.wrap(e, s.platform);
    }
  }

  /** Generates platform locators for a node and, for live sessions, verifies their match counts on the device. */
  async locators(id: string, nodeId: string): Promise<{ candidates: LocatorCandidate[]; issues: string[]; summary: string }> {
    const s = this.get(id);
    if (!s.tree) throw new InspectorError('INVALID_INPUT', 'Capture a native snapshot before generating locators.', { platform: s.platform });
    const node = s.tree.nodes.get(nodeId);
    if (!node) throw new InspectorError('ELEMENT_NOT_FOUND', `Node ${nodeId} is not in the current snapshot. Refresh and select again.`, { platform: s.platform });
    const candidates = generateLocators(s.tree, node);
    if (s.mode === 'live') {
      const { c, sid } = this.live(id);
      for (const cand of candidates) {
        try {
          cand.liveMatches = (await c.findElements(sid, cand.strategy, cand.value)).length;
          if (cand.liveMatches !== cand.snapshotMatches) {
            cand.warnings.push(`Device returned ${cand.liveMatches} match(es) but the snapshot has ${cand.snapshotMatches}; the screen may have changed.`);
          }
          cand.unique = cand.unique && cand.liveMatches === 1;
        } catch (e) {
          cand.warnings.push(`Live validation failed: ${(e as Error).message.split('\n')[0]}`);
          cand.unique = false;
        }
      }
    }
    return { candidates: sortCandidates(candidates), issues: accessibilityIssues(node, s.platform), summary: describeNode(node, s.platform) };
  }

  async perform(id: string, req: ActionRequest): Promise<RecordedAction> {
    const { s, c, sid } = this.live(id);
    let locator = req.locator ?? null;
    let alternatives: { strategy: LocatorStrategy; value: string }[] = [];
    let nodeSummary: string | null = null;
    if (req.nodeId) {
      const { candidates, summary } = await this.locators(id, req.nodeId);
      const best = bestLocator(candidates);
      if (!best) throw new InspectorError('ELEMENT_NOT_ACCESSIBLE', `No unique locator exists for ${summary}; refusing to act on an ambiguous element.`, { platform: s.platform });
      locator = { strategy: best.strategy, value: best.value };
      alternatives = candidates.filter((x) => x.unique && x !== best).map((x) => ({ strategy: x.strategy, value: x.value }));
      nodeSummary = summary;
    }
    if (req.action !== 'back' && !locator) throw new InspectorError('INVALID_INPUT', `Action ${req.action} needs a nodeId or locator.`, { platform: s.platform });
    try {
      await this.execute(c, sid, req.action, locator, req.value, s.platform);
    } catch (e) {
      throw this.wrap(e, s.platform);
    }
    const rec: RecordedAction = {
      at: new Date().toISOString(), platform: s.platform, action: req.action, value: req.value,
      locator, alternatives, elementId: req.elementId ?? null, nodeSummary,
    };
    if (s.recording) s.actions.push(rec);
    return rec;
  }

  private async execute(c: WebDriverClient, sid: string, action: LogicalAction, locator: { strategy: LocatorStrategy; value: string } | null, value: string | undefined, platform: Platform) {
    if (action === 'back') return void (await c.back(sid));
    const ids = await c.findElements(sid, locator!.strategy, locator!.value);
    if (ids.length === 0) throw new InspectorError('ELEMENT_NOT_FOUND', `No element matches ${locator!.strategy}="${locator!.value}".`, { platform });
    if (ids.length > 1) throw new InspectorError('ELEMENT_NOT_FOUND', `${ids.length} elements match ${locator!.strategy}="${locator!.value}"; locator is not unique.`, { platform });
    const el = ids[0];
    switch (action) {
      case 'tap': return void (await c.click(sid, el));
      case 'type': return void (await c.sendKeys(sid, el, value ?? ''));
      case 'clear': return void (await c.clear(sid, el));
      case 'verifyVisible':
        if (!(await c.elementDisplayed(sid, el))) throw new InspectorError('ELEMENT_NOT_ACCESSIBLE', 'Element exists but is not displayed.', { platform });
        return;
      case 'verifyText': {
        const text = await c.elementText(sid, el);
        if (text !== (value ?? '')) throw new InspectorError('ELEMENT_NOT_FOUND', `Expected text "${value}" but found "${text}".`, { platform });
        return;
      }
    }
  }

  /** Live match count for a locator; used to validate locators that cannot be evaluated offline. */
  async count(id: string, strategy: LocatorStrategy, value: string): Promise<number> {
    const { s, c, sid } = this.live(id);
    try {
      return (await c.findElements(sid, strategy, value)).length;
    } catch (e) {
      throw this.wrap(e, s.platform);
    }
  }

  setRecording(id: string, on: boolean): InspectorSession {
    const s = this.get(id);
    if (on && s.mode !== 'live') throw new InspectorError('UNSUPPORTED_CAPABILITY', 'Recording needs a live device session.', { platform: s.platform });
    if (on) s.actions = [];
    s.recording = on;
    return s;
  }

  /** Replays recorded actions on this session's platform, falling back to recorded alternative locators. */
  async playback(id: string, actions: RecordedAction[]): Promise<PlaybackStep[]> {
    const { s, c, sid } = this.live(id);
    const foreign = actions.find((a) => a.platform !== s.platform);
    if (foreign) {
      throw new InspectorError('INVALID_INPUT', `Recording contains ${foreign.platform} actions; it cannot be replayed on ${s.platform}. Use a logical test with per-platform bindings instead.`, { platform: s.platform });
    }
    const results: PlaybackStep[] = [];
    for (const [index, a] of actions.entries()) {
      const tries = a.locator ? [a.locator, ...a.alternatives] : [null];
      let step: PlaybackStep | null = null;
      let lastErr: InspectorError | null = null;
      for (const [i, loc] of tries.entries()) {
        try {
          await this.execute(c, sid, a.action, loc, a.value, s.platform);
          step = { index, action: a.action, status: i === 0 ? 'passed' : 'passed-with-alternative', usedLocator: loc, error: null };
          break;
        } catch (e) {
          lastErr = this.wrap(e, s.platform);
          if (lastErr.code !== 'ELEMENT_NOT_FOUND') break;
        }
      }
      results.push(step ?? { index, action: a.action, status: 'failed', usedLocator: null, error: lastErr?.toJSON() ?? null });
      if (!step) break;
    }
    return results;
  }

  private wrap(e: unknown, platform: Platform): InspectorError {
    if (e instanceof WebDriverRequestError) {
      if (e.wdError === 'invalid session id') return new InspectorError('SESSION_NOT_FOUND', 'The Appium session ended (device disconnected, app crashed, or timeout).', { platform, detail: e.message });
      if (e.wdError === 'no such element') return new InspectorError('ELEMENT_NOT_FOUND', e.message.split('\n')[0], { platform });
      if (e.wdError === 'unknown method' || e.wdError === 'unsupported operation') return new InspectorError('UNSUPPORTED_CAPABILITY', e.message.split('\n')[0], { platform });
      return new InspectorError('WEBDRIVER_ERROR', e.message.split('\n')[0], { platform, detail: e.message });
    }
    return toInspectorError(e, platform);
  }
}
