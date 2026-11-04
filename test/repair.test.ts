import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { InspectorError } from '../src/core/errors.ts';
import { findAll } from '../src/core/hierarchy.ts';
import type { Platform } from '../src/core/types.ts';
import { Healer } from '../src/repair/healer.ts';
import { copyExampleProject, seedLoginRepository, tempDir, tree } from './helpers.ts';

const LOGIN = 'src/main/java/com/example/shop/screens/LoginScreen.java';

/** Uses `node` as the build and test command so verification runs a real process on any machine. */
function configure(project: string, testExit: Record<Platform, number>) {
  mkdirSync(path.join(project, '.elementiq'), { recursive: true });
  writeFileSync(path.join(project, '.elementiq', 'config.json'), JSON.stringify({
    buildCommand: 'node -e "process.exit(0)"',
    testCommand: {
      android: `node -e "process.exit(${testExit.android})" {tests} {platform}`,
      ios: `node -e "process.exit(${testExit.ios})" {tests} {platform}`,
    },
  }));
}

function setup() {
  const project = copyExampleProject();
  const { repo, loginId, usernameId } = seedLoginRepository(tempDir());
  const original = readFileSync(path.join(project, LOGIN), 'utf8');
  return { project, repo, loginId, usernameId, original, healer: new Healer(repo) };
}

describe('automatic repair', () => {
  it('repairs Android code only, verifies it, and leaves iOS locators untouched', async () => {
    const { project, repo, loginId, original, healer } = setup();
    configure(project, { android: 0, ios: 0 });
    const rec = await healer.repair({ projectRoot: project, platform: 'android', elementId: loginId, tree: tree('android', 'android-login-v2.xml'), hierarchySource: 'offline-snapshot' });
    assert.equal(rec.status, 'verified', rec.message);
    assert.equal(rec.match!.summary, 'Button "com.example.shop:id/sign_in_button"');
    const after = readFileSync(path.join(project, LOGIN), 'utf8');
    assert.equal(after, original.replace('@AndroidFindBy(id = "com.example.shop:id/login_button")', '@AndroidFindBy(id = "com.example.shop:id/sign_in_button")'));
    assert.ok(after.includes('@iOSXCUITFindBy(accessibility = "loginButton")'));
    assert.match(rec.diff, /-    @AndroidFindBy\(id = "com.example.shop:id\/login_button"\)\n\+    @AndroidFindBy\(id = "com.example.shop:id\/sign_in_button"\)/);
    assert.deepEqual(rec.platformsValidated, ['android']);
    assert.deepEqual(rec.affectedTests, ['src/test/java/com/example/shop/tests/LoginTest.java']);
    assert.match(rec.tests.android!.command!, /LoginTest android/);
    assert.equal(repo.get(loginId).platforms.android!.locators[0].value, 'com.example.shop:id/sign_in_button');
    assert.equal(repo.get(loginId).platforms.ios!.history.length, 1);
  });

  it('keeps the short resource-id style used by the code', async () => {
    const { project, usernameId, healer } = setup();
    configure(project, { android: 0, ios: 0 });
    const rec = await healer.repair({ projectRoot: project, platform: 'android', elementId: usernameId, tree: tree('android', 'android-login-v2.xml'), hierarchySource: 'offline-snapshot' });
    assert.equal(rec.status, 'verified', rec.message);
    assert.ok(readFileSync(path.join(project, LOGIN), 'utf8').includes('@AndroidFindBy(id = "login_username_input")'));
  });

  it('repairs iOS code only and leaves Android locators untouched', async () => {
    const { project, loginId, original, healer } = setup();
    configure(project, { android: 0, ios: 0 });
    const rec = await healer.repair({ projectRoot: project, platform: 'ios', elementId: loginId, tree: tree('ios', 'ios-login-v2.xml'), hierarchySource: 'offline-snapshot' });
    assert.equal(rec.status, 'verified', rec.message);
    const after = readFileSync(path.join(project, LOGIN), 'utf8');
    assert.equal(after, original.replace('@iOSXCUITFindBy(accessibility = "loginButton")', '@iOSXCUITFindBy(accessibility = "login.submit")'));
    assert.match(rec.tests.ios!.command!, /LoginTest ios/);
  });

  it('rolls back automatically when the affected tests fail', async () => {
    const { project, loginId, original, healer } = setup();
    configure(project, { android: 1, ios: 0 });
    const rec = await healer.repair({ projectRoot: project, platform: 'android', elementId: loginId, tree: tree('android', 'android-login-v2.xml'), hierarchySource: 'offline-snapshot' });
    assert.equal(rec.status, 'rolled-back');
    assert.equal(rec.tests.android!.status, 'failed');
    assert.equal(readFileSync(path.join(project, LOGIN), 'utf8'), original);
  });

  it('marks the repair unverified when build tools or devices are unavailable', async () => {
    const { project, loginId, healer } = setup();
    writeFileSync(path.join(project, 'elementiq.config.json'), JSON.stringify({ buildCommand: 'definitely-not-a-build-tool-xyz' }));
    const rec = await healer.repair({ projectRoot: project, platform: 'android', elementId: loginId, tree: tree('android', 'android-login-v2.xml'), hierarchySource: 'offline-snapshot', skipTests: true });
    assert.equal(rec.status, 'unverified');
    assert.equal(rec.build!.status, 'skipped');
    assert.match(rec.message, /NOT verified/);
  });

  it('supports manual rollback and refuses to clobber later edits', async () => {
    const { project, loginId, original, healer } = setup();
    configure(project, { android: 0, ios: 0 });
    const rec = await healer.repair({ projectRoot: project, platform: 'android', elementId: loginId, tree: tree('android', 'android-login-v2.xml'), hierarchySource: 'offline-snapshot' });
    const file = path.join(project, LOGIN);
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// edited by a developer\n');
    const blocked = healer.rollback(project, rec.id);
    assert.equal(blocked.rollback.conflicts.length, 1);
    assert.notEqual(readFileSync(file, 'utf8'), original);
    const forced = healer.rollback(project, rec.id, true);
    assert.equal(forced.status, 'rolled-back');
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(healer.list(project)[0].id, rec.id);
  });

  it('produces a diff without writing in dry-run mode', async () => {
    const { project, loginId, original, healer } = setup();
    const rec = await healer.repair({ projectRoot: project, platform: 'ios', elementId: loginId, tree: tree('ios', 'ios-login-v2.xml'), hierarchySource: 'offline-snapshot', dryRun: true });
    assert.equal(rec.status, 'dry-run');
    assert.ok(rec.diff.includes('+    @iOSXCUITFindBy(accessibility = "login.submit")'));
    assert.equal(readFileSync(path.join(project, LOGIN), 'utf8'), original);
  });

  it('reports not-broken when the locator still works', async () => {
    const { project, loginId, healer } = setup();
    const rec = await healer.repair({ projectRoot: project, platform: 'android', elementId: loginId, tree: tree('android', 'android-login.xml'), hierarchySource: 'offline-snapshot' });
    assert.equal(rec.status, 'not-broken');
    assert.equal(rec.files.length, 0);
  });

  it('refuses to guess when the element cannot be re-identified', async () => {
    const { project, loginId, original, healer } = setup();
    const t = tree('android', 'android-login-v2.xml');
    // Remove the button entirely: nothing on screen should be confidently matched.
    const btn = findAll(t, { attrs: { 'resource-id': 'com.example.shop:id/sign_in_button' } })[0];
    const parent = t.nodes.get(btn.parentId!)!;
    parent.children = parent.children.filter((c) => c !== btn);
    t.nodes.delete(btn.id);
    const rec = await healer.repair({ projectRoot: project, platform: 'android', elementId: loginId, tree: t, hierarchySource: 'offline-snapshot' });
    assert.equal(rec.status, 'ambiguous');
    assert.equal(readFileSync(path.join(project, LOGIN), 'utf8'), original);
  });

  it('blocks shared (cross-platform) references unless explicitly allowed', async () => {
    const project = copyExampleProject();
    configure(project, { android: 0, ios: 0 });
    const { repo } = seedLoginRepository(tempDir());
    // Pretend the Android login button carried the shared dashboard accessibility id when it was recorded.
    const shared = tree('android', 'android-login.xml');
    const v2 = tree('android', 'android-login-v2.xml');
    const node = findAll(shared, { attrs: { 'resource-id': 'com.example.shop:id/login_button' } })[0];
    node.attrs['content-desc'] = 'dashboard_greeting';
    const el = repo.capture({ platform: 'android', tree: shared, node, name: 'greeting', screen: 'Dashboard', device: null, appId: null, screenshotBase64: null, source: 'offline-snapshot' }).element;
    const v2node = findAll(v2, { attrs: { 'resource-id': 'com.example.shop:id/sign_in_button' } })[0];
    v2node.attrs['content-desc'] = 'dashboard_welcome';
    const healer = new Healer(repo);
    const rec = await healer.repair({ projectRoot: project, platform: 'android', elementId: el.id, tree: v2, hierarchySource: 'offline-snapshot' });
    assert.equal(rec.status, 'partial', rec.message);
    assert.equal(rec.refs.find((r) => r.field === 'greeting')!.action, 'blocked');
    assert.equal(rec.refs.find((r) => r.field === 'loginButton')!.action, 'patched');
    assert.deepEqual(rec.platformsValidated, ['android']);

    const allowed = await healer.repair({ projectRoot: project, platform: 'android', elementId: el.id, tree: v2, hierarchySource: 'offline-snapshot', allowSharedEdits: true });
    assert.equal(allowed.status, 'verified', allowed.message);
    assert.deepEqual(allowed.platformsValidated, ['android', 'ios'], 'shared edits must be validated on both platforms');
    assert.ok(allowed.diff.includes('+    private final By greeting = AppiumBy.accessibilityId("dashboard_welcome");'));
  });

  it('will not use a hierarchy from the other platform', async () => {
    const { project, loginId, healer } = setup();
    await assert.rejects(
      healer.repair({ projectRoot: project, platform: 'android', elementId: loginId, tree: tree('ios', 'ios-login-v2.xml'), hierarchySource: 'offline-snapshot' }),
      (e: InspectorError) => e.code === 'WRONG_PLATFORM_BINARY',
    );
  });
});
