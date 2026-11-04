/**
 * End-to-end repair demonstration on a copy of examples/java-appium-shop, using captured page sources.
 * Build and test steps use this machine's real toolchain (mvn / devices); when those are missing the
 * repair is reported as UNVERIFIED rather than passed.
 */
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAll, parseHierarchy } from '../src/core/hierarchy.ts';
import { ElementRepository } from '../src/core/repository.ts';
import type { Platform } from '../src/core/types.ts';
import { Healer } from '../src/repair/healer.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = (n: string, p: Platform) => parseHierarchy(readFileSync(path.join(ROOT, 'test', 'fixtures', n), 'utf8'), p);

const work = mkdtempSync(path.join(os.tmpdir(), 'elementiq-demo-'));
const project = path.join(work, 'java-appium-shop');
cpSync(path.join(ROOT, 'examples', 'java-appium-shop'), project, { recursive: true });
const repo = new ElementRepository(path.join(work, 'data'));
const healer = new Healer(repo);

console.log(`Project copy: ${project}\n`);
const a1 = fx('android-login.xml', 'android');
const i1 = fx('ios-login.xml', 'ios');
const pick = (t: ReturnType<typeof fx>, attrs: Record<string, string>) => findAll(t, { attrs })[0];
const base = { screen: 'Login', purpose: 'Submit credentials', device: null, appId: 'com.example.shop', screenshotBase64: null, source: 'offline-snapshot' as const };
const login = repo.capture({ ...base, platform: 'android', tree: a1, node: pick(a1, { 'resource-id': 'com.example.shop:id/login_button' }), name: 'loginButton' }).element;
repo.capture({ ...base, platform: 'ios', tree: i1, node: pick(i1, { name: 'loginButton' }), name: 'loginButton', elementId: login.id });

for (const platform of ['android', 'ios'] as const) {
  console.log(`=== ${platform.toUpperCase()}: locator changed in the app build ===`);
  const rec = await healer.repair({ projectRoot: project, platform, elementId: login.id, tree: fx(`${platform}-login-v2.xml`, platform), hierarchySource: 'offline-snapshot' });
  console.log(`status: ${rec.status}\n${rec.message}`);
  console.log(`match: ${rec.match?.summary} score=${rec.match?.score} margin=${rec.match?.margin}`);
  for (const c of rec.match?.changes ?? []) console.log(`  changed ${c.field}: ${c.before} -> ${c.after}`);
  console.log(rec.diff);
  console.log(`build: ${rec.build?.status} - ${rec.build?.reason}`);
  for (const [p, t] of Object.entries(rec.tests)) console.log(`${p} tests: ${t!.status} - ${t!.reason}`);
  if (rec.rollback.available) {
    const rb = healer.rollback(project, rec.id);
    console.log(`rollback: ${rb.status} (${rb.rollback.conflicts.length} conflicts)\n`);
  }
}
