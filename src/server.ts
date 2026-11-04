import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InspectorError, toInspectorError, type ErrorCode } from './core/errors.ts';
import { ElementRepository } from './core/repository.ts';
import { DEFAULT_APPIUM_URL, SessionManager } from './core/sessions.ts';
import type { LocatorStrategy, RecordedAction } from './core/types.ts';
import { WebDriverClient } from './core/webdriver.ts';
import { mapElementsToCode, scanProject } from './integration/scanner.ts';
import { adbPath } from './platforms/android.ts';
import { installedAppiumDrivers } from './platforms/common.ts';
import { adapterFor, AndroidAdapter, assertPlatform } from './platforms/index.ts';
import { Healer } from './repair/healer.ts';
import { which } from './util/exec.ts';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

export interface AppContext {
  sessions: SessionManager;
  repo: ElementRepository;
  healer: Healer;
}

export function createContext(dataDir: string): AppContext {
  const repo = new ElementRepository(dataDir);
  return { sessions: new SessionManager(), repo, healer: new Healer(repo) };
}

type Handler = (ctx: AppContext, p: { params: Record<string, string>; query: URLSearchParams; body: any }) => Promise<unknown> | unknown;

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

function route(method: string, pathPattern: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + pathPattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, pattern, keys, handler });
}

const STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_INPUT: 400, WRONG_PLATFORM_BINARY: 400, CONFIG_ERROR: 400, SESSION_NOT_FOUND: 404, ELEMENT_NOT_FOUND: 404,
  DEVICE_NOT_FOUND: 404, DEVICE_BUSY: 409, UNSUPPORTED_CAPABILITY: 422, APPIUM_UNREACHABLE: 502, WEBDRIVER_ERROR: 502,
};

function requireString(body: any, key: string): string {
  const v = body?.[key];
  if (typeof v !== 'string' || !v.trim()) throw new InspectorError('INVALID_INPUT', `"${key}" is required.`);
  return v;
}

// ---- health & devices ---------------------------------------------------------------------------

route('GET', '/api/health', async (_ctx, { query }) => {
  const appiumUrl = query.get('appiumUrl') || DEFAULT_APPIUM_URL;
  const appiumCli = which('appium');
  const [drivers, server] = await Promise.all([
    installedAppiumDrivers(),
    new WebDriverClient(appiumUrl).status().then((s) => ({ reachable: true, ready: s.ready ?? true, version: s.build?.version ?? null }), (e) => ({ reachable: false, error: (e as Error).message })),
  ]);
  const tools: Record<string, string | null> = {};
  for (const t of ['java', 'mvn', 'gradle', 'npx', 'python', 'xcrun']) tools[t] = which(t);
  tools.adb = adbPath();
  return {
    host: { os: process.platform, release: os.release(), node: process.version },
    appium: { cli: appiumCli, url: appiumUrl, server, drivers: drivers ? Object.keys(drivers) : null },
    platforms: {
      android: { driverInstalled: drivers ? !!drivers.uiautomator2 : null, adb: tools.adb },
      ios: { driverInstalled: drivers ? !!drivers.xcuitest : null, localDiscovery: process.platform === 'darwin', note: process.platform === 'darwin' ? null : 'iOS automation requires a Mac running Appium + XCUITest; point appiumUrl at it.' },
    },
    tools,
  };
});

route('GET', '/api/devices', async (_ctx, { query }) => adapterFor(query.get('platform') ?? '').discover());

route('GET', '/api/android/packages', async (_ctx, { query }) => (adapterFor('android') as AndroidAdapter).listPackages(query.get('udid') ?? ''));

// ---- sessions -----------------------------------------------------------------------------------

route('GET', '/api/sessions', (ctx) => ctx.sessions.list());
route('POST', '/api/sessions', async (ctx, { body }) => {
  const s = await ctx.sessions.create({ ...body, platform: assertPlatform(body?.platform) });
  return ctx.sessions.list().find((x) => x.id === s.id);
});
route('POST', '/api/sessions/offline', (ctx, { body }) => {
  const s = ctx.sessions.createOffline(assertPlatform(body?.platform), requireString(body, 'source'), body.screenshot ?? null, body.label || 'Offline snapshot');
  return ctx.sessions.list().find((x) => x.id === s.id);
});
route('DELETE', '/api/sessions/:id', async (ctx, { params }) => (await ctx.sessions.close(params.id), { closed: params.id }));
route('GET', '/api/sessions/:id/snapshot', (ctx, { params }) => ctx.sessions.snapshot(params.id));
route('GET', '/api/sessions/:id/source', (ctx, { params }) => ({ source: ctx.sessions.get(params.id).source }));
route('POST', '/api/sessions/:id/context', async (ctx, { params, body }) => (await ctx.sessions.switchContext(params.id, requireString(body, 'name')), { context: body.name }));
route('GET', '/api/sessions/:id/locators', (ctx, { params, query }) => ctx.sessions.locators(params.id, query.get('nodeId') ?? ''));
route('POST', '/api/sessions/:id/actions', (ctx, { params, body }) => ctx.sessions.perform(params.id, body));
route('POST', '/api/sessions/:id/recording', (ctx, { params, body }) => {
  const s = ctx.sessions.setRecording(params.id, !!body?.on);
  return { recording: s.recording, actions: s.actions };
});
route('GET', '/api/sessions/:id/recording', (ctx, { params }) => {
  const s = ctx.sessions.get(params.id);
  return { recording: s.recording, actions: s.actions };
});
route('POST', '/api/sessions/:id/playback', async (ctx, { params, body }) => {
  const s = ctx.sessions.get(params.id);
  let actions: RecordedAction[] = body?.actions ?? s.actions;
  if (body?.testId) {
    const resolved = ctx.repo.resolveTest(body.testId, s.platform);
    if (resolved.gaps.length) throw new InspectorError('INVALID_INPUT', `Test cannot run on ${s.platform}: ${resolved.gaps.join(' ')}`, { platform: s.platform });
    actions = resolved.steps.map((st) => ({
      at: new Date().toISOString(), platform: s.platform, action: st.action, value: st.value, locator: st.locator,
      alternatives: st.alternatives, elementId: st.elementId, nodeSummary: null,
    }));
  }
  return ctx.sessions.playback(params.id, actions);
});

// ---- repository ---------------------------------------------------------------------------------

route('GET', '/api/repository', (ctx) => ({ elements: ctx.repo.elements(), tests: ctx.repo.tests() }));
route('POST', '/api/repository/capture', (ctx, { body }) => {
  const s = ctx.sessions.get(requireString(body, 'sessionId'));
  if (!s.tree) throw new InspectorError('INVALID_INPUT', 'Capture a native snapshot first.', { platform: s.platform });
  const node = s.tree.nodes.get(requireString(body, 'nodeId'));
  if (!node) throw new InspectorError('ELEMENT_NOT_FOUND', 'Selected node is not in the current snapshot.', { platform: s.platform });
  return ctx.repo.capture({
    platform: s.platform, tree: s.tree, node, name: requireString(body, 'name'), screen: requireString(body, 'screen'),
    purpose: body.purpose, elementId: body.elementId || undefined,
    device: s.udid ? { udid: s.udid, model: s.deviceLabel, osVersion: s.osVersion ?? 'unknown' } : null,
    appId: s.appId, screenshotBase64: s.screenshot, source: s.mode === 'live' ? 'live' : 'offline-snapshot',
  });
});
route('GET', '/api/repository/elements/:id/history', (ctx, { params, query }) => ctx.repo.history(params.id, assertPlatform(query.get('platform'))));
route('PATCH', '/api/repository/elements/:id', (ctx, { params, body }) => ctx.repo.update(params.id, body ?? {}));
route('DELETE', '/api/repository/elements/:id', (ctx, { params }) => (ctx.repo.remove(params.id), { removed: params.id }));
route('GET', '/api/repository/export', (ctx) => ctx.repo.exportBundle());
route('POST', '/api/repository/import', (ctx, { body }) => ctx.repo.importBundle(body?.bundle, body?.mode === 'replace' ? 'replace' : 'merge'));
route('POST', '/api/repository/tests', (ctx, { body }) => ctx.repo.upsertTest(body));
route('GET', '/api/repository/tests/:id/resolve', (ctx, { params, query }) => ctx.repo.resolveTest(params.id, assertPlatform(query.get('platform'))));

// ---- project integration & repair ---------------------------------------------------------------

route('POST', '/api/project/scan', (ctx, { body }) => {
  const { project, refs } = scanProject(requireString(body, 'root'));
  const { mappings, unmapped } = mapElementsToCode(ctx.repo.elements(), refs);
  for (const m of mappings) {
    ctx.repo.setCodeRefs(m.elementId, m.platform, m.refs.map((r) => ({ file: path.relative(project.root, r.file), line: r.line, field: r.field, owner: r.owner, strategy: r.strategy, value: r.value, syntax: r.syntax })));
  }
  const rel = (f: string) => path.relative(project.root, f).replace(/\\/g, '/');
  const slim = (r: (typeof refs)[number]) => ({ file: rel(r.file), line: r.line, platform: r.platform, strategy: r.strategy, value: r.value, field: r.field, owner: r.owner, syntax: r.syntax });
  return {
    project: { ...project, sourceFiles: project.sourceFiles.length, testFiles: project.testFiles.map(rel), pageObjects: project.pageObjects.map(rel) },
    refs: refs.map(slim),
    mappings: mappings.map((m) => ({ ...m, refs: m.refs.map(slim) })),
    unmapped: unmapped.map(slim),
  };
});
route('POST', '/api/repair', async (ctx, { body }) => {
  const s = ctx.sessions.get(requireString(body, 'sessionId'));
  if (!s.tree) throw new InspectorError('INVALID_INPUT', 'Capture a native snapshot of the changed screen first.', { platform: s.platform });
  return ctx.healer.repair({
    projectRoot: requireString(body, 'root'), platform: s.platform, elementId: requireString(body, 'elementId'), tree: s.tree,
    hierarchySource: s.mode === 'live' ? 'live' : 'offline-snapshot', screenshot: s.screenshot,
    device: s.udid ? { udid: s.udid, model: s.deviceLabel, osVersion: s.osVersion ?? 'unknown' } : null, appId: s.appId,
    countLive: s.mode === 'live' ? (strategy: LocatorStrategy, value: string) => ctx.sessions.count(s.id, strategy, value) : undefined,
    dryRun: !!body.dryRun, skipTests: !!body.skipTests, allowSharedEdits: !!body.allowSharedEdits,
  });
});
route('GET', '/api/repairs', (ctx, { query }) => ctx.healer.list(query.get('root') ?? ''));
route('POST', '/api/repairs/:id/rollback', (ctx, { params, body }) => ctx.healer.rollback(requireString(body, 'root'), params.id, !!body.force));

// ---- http plumbing ------------------------------------------------------------------------------

const MAX_BODY = 64 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new InspectorError('INVALID_INPUT', 'Request body too large.');
    chunks.push(chunk);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InspectorError('INVALID_INPUT', 'Request body is not valid JSON.');
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveFile(res: ServerResponse, file: string) {
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

export function createApp(ctx: AppContext) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const shot = /^\/api\/repository\/screenshots\/([^/]+)$/.exec(url.pathname);
        if (shot && req.method === 'GET') {
          const file = ctx.repo.screenshotPath(shot[1]);
          if (!existsSync(file)) return send(res, 404, { error: { code: 'INVALID_INPUT', message: 'Screenshot not found.' } });
          return serveFile(res, file);
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.pattern.exec(url.pathname);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const body = req.method === 'GET' ? undefined : await readBody(req);
          return send(res, 200, await r.handler(ctx, { params, query: url.searchParams, body }));
        }
        return send(res, 404, { error: { code: 'INVALID_INPUT', message: `No route ${req.method} ${url.pathname}` } });
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(UI_DIR, rel);
      if (!file.startsWith(UI_DIR + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      serveFile(res, file);
    } catch (e) {
      const err = toInspectorError(e);
      send(res, STATUS[err.code] ?? 422, { error: err.toJSON() });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4780);
  const host = process.env.HOST ?? '127.0.0.1';
  const dataDir = path.resolve(process.env.ELEMENTIQ_DATA ?? path.join(process.cwd(), '.elementiq', 'data'));
  const ctx = createContext(dataDir);
  createApp(ctx).listen(port, host, () => {
    console.log(`ElementIQ Inspector on http://${host}:${port}`);
    console.log(`Repository: ${dataDir}`);
    console.log(`Appium:     ${DEFAULT_APPIUM_URL} (override with APPIUM_URL or per session)`);
  });
}
