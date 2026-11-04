import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { InspectorError } from '../src/core/errors.ts';
import { parseHierarchy } from '../src/core/hierarchy.ts';
import { evaluateOffline } from '../src/core/locators.ts';
import { SessionManager } from '../src/core/sessions.ts';
import type { Platform } from '../src/core/types.ts';
import { createApp, createContext } from '../src/server.ts';
import { fixture, tempDir } from './helpers.ts';

/**
 * Test double for an Appium server. It answers the W3C endpoints the inspector uses from fixture page
 * sources so the client, session and recording plumbing can be exercised without a device.
 */
function fakeAppium() {
  const log: string[] = [];
  const sessions = new Map<string, Platform>();
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value }));
    };
    const url = req.url!;
    if (url === '/status') return reply(200, { ready: true, build: { version: 'fake' } });
    if (req.method === 'POST' && url === '/session') {
      const caps = body.capabilities.alwaysMatch;
      if (caps['appium:udid'] === 'needs-signing') return reply(500, { error: 'session not created', message: 'xcodebuild failed with code 65' });
      const platform: Platform = caps.platformName === 'iOS' ? 'ios' : 'android';
      const sid = `s${sessions.size + 1}`;
      sessions.set(sid, platform);
      return reply(200, { sessionId: sid, capabilities: { ...caps, deviceName: 'Fake device', platformVersion: '15' } });
    }
    const m = /^\/session\/(\w+)(\/.*)?$/.exec(url)!;
    const platform = sessions.get(m[1]);
    if (!platform) return reply(404, { error: 'invalid session id', message: 'gone' });
    const tree = parseHierarchy(fixture(platform === 'ios' ? 'ios-login.xml' : 'android-login.xml'), platform);
    const sub = m[2] ?? '';
    if (req.method === 'DELETE' && !sub) return reply(200, null);
    if (sub === '/source') return reply(200, fixture(platform === 'ios' ? 'ios-login.xml' : 'android-login.xml'));
    if (sub === '/screenshot') return reply(200, 'iVBORw0KGgo=');
    if (sub === '/contexts') return reply(200, ['NATIVE_APP']);
    if (sub === '/context') return reply(200, 'NATIVE_APP');
    if (sub === '/elements') {
      const hits = evaluateOffline(tree, body.using, body.value);
      if (!hits) return reply(400, { error: 'invalid selector', message: `unsupported ${body.using}` });
      return reply(200, hits.map((h) => ({ 'element-6066-11e4-a23c-4b9b0c3c3e7a': h.id })));
    }
    const el = /^\/element\/([\d.]+)\/(\w+)$/.exec(sub);
    if (el) {
      log.push(`${el[2]} ${el[1]}${body.text ? ' ' + body.text : ''}`);
      if (el[2] === 'displayed') return reply(200, true);
      if (el[2] === 'text') return reply(200, tree.nodes.get(el[1])!.attrs.text ?? '');
      return reply(200, null);
    }
    reply(404, { error: 'unknown method', message: sub });
  });
  return { server, log };
}

describe('live sessions (against a fake Appium server)', () => {
  const fake = fakeAppium();
  let url = '';
  before(async () => {
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });
  after(() => fake.server.close());

  it('runs Android and iOS sessions side by side and validates locators live', async () => {
    const m = new SessionManager();
    const a = await m.create({ platform: 'android', udid: 'emulator-5554', appId: 'com.example.shop', appiumUrl: url });
    const i = await m.create({ platform: 'ios', udid: 'SIM-1', deviceKind: 'simulator', appId: 'com.example.shop', appiumUrl: url });
    assert.equal(m.list().length, 2);
    const snapA = await m.snapshot(a.id);
    const snapI = await m.snapshot(i.id);
    assert.equal(snapA.tree!.tag, 'hierarchy');
    assert.equal(snapI.tree!.tag, 'AppiumAUT');
    const loginNode = [...m.get(a.id).tree!.nodes.values()].find((n) => n.attrs['resource-id']?.endsWith('login_button'))!;
    const { candidates } = await m.locators(a.id, loginNode.id);
    assert.equal(candidates[0].liveMatches, 1);
    assert.ok(candidates.every((c) => c.liveMatches !== null));
  });

  it('refuses a second session on a busy device', async () => {
    const m = new SessionManager();
    await m.create({ platform: 'android', udid: 'busy-1', appId: 'com.example.shop', appiumUrl: url });
    await assert.rejects(m.create({ platform: 'android', udid: 'busy-1', appId: 'com.example.shop', appiumUrl: url }), (e: InspectorError) => e.code === 'DEVICE_BUSY');
  });

  it('records actions and plays them back', async () => {
    const m = new SessionManager();
    const s = await m.create({ platform: 'ios', udid: 'SIM-2', deviceKind: 'simulator', appId: 'com.example.shop', appiumUrl: url });
    await m.snapshot(s.id);
    const nodes = [...m.get(s.id).tree!.nodes.values()];
    m.setRecording(s.id, true);
    await m.perform(s.id, { action: 'type', nodeId: nodes.find((n) => n.attrs.name === 'usernameField')!.id, value: 'demo' });
    await m.perform(s.id, { action: 'tap', nodeId: nodes.find((n) => n.attrs.name === 'loginButton')!.id });
    const rec = m.setRecording(s.id, false).actions;
    assert.deepEqual(rec.map((r) => [r.action, r.locator]), [
      ['type', { strategy: 'accessibility id', value: 'usernameField' }],
      ['tap', { strategy: 'accessibility id', value: 'loginButton' }],
    ]);
    fake.log.length = 0;
    const steps = await m.playback(s.id, rec);
    assert.deepEqual(steps.map((x) => x.status), ['passed', 'passed']);
    assert.equal(fake.log.length, 2);
    // A broken primary locator falls back to a recorded alternative.
    const broken = [{ ...rec[1], locator: { strategy: 'accessibility id' as const, value: 'gone' } }];
    assert.equal((await m.playback(s.id, broken))[0].status, 'passed-with-alternative');
  });

  it('will not replay one platform\'s recording on the other', async () => {
    const m = new SessionManager();
    const s = await m.create({ platform: 'android', udid: 'emulator-9', appId: 'com.example.shop', appiumUrl: url });
    await assert.rejects(m.playback(s.id, [{ at: '', platform: 'ios', action: 'tap', locator: { strategy: 'accessibility id', value: 'x' }, alternatives: [], elementId: null, nodeSummary: null }]), (e: InspectorError) => e.code === 'INVALID_INPUT');
  });

  it('classifies WDA signing failures reported by the server', async () => {
    const m = new SessionManager();
    await assert.rejects(m.create({ platform: 'ios', udid: 'needs-signing', deviceKind: 'physical', appId: 'com.example.shop', appiumUrl: url }), (e: InspectorError) => e.code === 'IOS_SIGNING_FAILED');
  });

  it('reports an unreachable Appium server instead of empty results', async () => {
    const m = new SessionManager();
    await assert.rejects(m.create({ platform: 'android', udid: 'x', appId: 'com.example.shop', appiumUrl: 'http://127.0.0.1:1' }), (e: InspectorError) => e.code === 'APPIUM_UNREACHABLE');
  });

  it('rejects live operations on offline snapshots', async () => {
    const m = new SessionManager();
    const s = m.createOffline('android', fixture('android-login.xml'), null, 'captured');
    await assert.rejects(m.perform(s.id, { action: 'back' }), (e: InspectorError) => e.code === 'UNSUPPORTED_CAPABILITY');
  });
});

describe('HTTP API', () => {
  let server: Server;
  let base = '';
  before(async () => {
    server = createApp(createContext(tempDir()));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };

  it('inspects an offline snapshot, captures an element and exports the repository', async () => {
    const s = (await call('POST', '/api/sessions/offline', { platform: 'android', source: fixture('android-login.xml') })).json;
    const snap = (await call('GET', `/api/sessions/${s.id}/snapshot`)).json;
    assert.ok(snap.notices.some((n: string) => n.includes('Offline snapshot')));
    const loc = (await call('GET', `/api/sessions/${s.id}/locators?nodeId=0.0.0.4`)).json;
    assert.equal(loc.candidates[0].strategy, 'id');
    const cap = await call('POST', '/api/repository/capture', { sessionId: s.id, nodeId: '0.0.0.4', name: 'loginButton', screen: 'Login' });
    assert.equal(cap.status, 200);
    const exp = (await call('GET', '/api/repository/export')).json;
    assert.equal(exp.elements.length, 1);
  });

  it('returns structured errors with HTTP status codes', async () => {
    const bad = await call('POST', '/api/sessions/offline', { platform: 'ios', source: fixture('android-login.xml') });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'WRONG_PLATFORM_BINARY');
    assert.equal((await call('GET', '/api/devices?platform=windows')).json.error.code, 'INVALID_INPUT');
    assert.equal((await call('GET', '/api/sessions/nope/snapshot')).status, 404);
  });
});
