import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { InspectorError } from '../src/core/errors.ts';
import { findAll } from '../src/core/hierarchy.ts';
import { ElementRepository } from '../src/core/repository.ts';
import { detectProject } from '../src/integration/detect.ts';
import { mapElementsToCode, scanProject, scanSource } from '../src/integration/scanner.ts';
import { capture, ROOT, seedLoginRepository, tempDir, tree } from './helpers.ts';

describe('element repository', () => {
  it('keeps separate Android and iOS bindings under one logical element', () => {
    const { repo, loginId } = seedLoginRepository(tempDir());
    const el = repo.get(loginId);
    assert.equal(el.platforms.android!.locators[0].strategy, 'id');
    assert.equal(el.platforms.ios!.locators[0].strategy, 'accessibility id');
    assert.notEqual(el.platforms.android!.locators[0].value, el.platforms.ios!.locators[0].value);
  });

  it('records history and reports what changed between captures', () => {
    const { repo, loginId } = seedLoginRepository(tempDir());
    const v2 = tree('android', 'android-login-v2.xml');
    const { changes } = capture(repo, 'android', v2, { 'resource-id': 'com.example.shop:id/sign_in_button' }, 'loginButton', loginId);
    const fields = changes.map((c) => c.field).sort();
    assert.deepEqual(fields, ['bounds', 'resource-id', 'text']);
    assert.equal(repo.history(loginId, 'android').length, 2);
    assert.equal(repo.history(loginId, 'ios').length, 1, 'capturing Android must not touch the iOS binding');
  });

  it('exports and reloads a bundle including screenshots', () => {
    const { repo } = seedLoginRepository(tempDir());
    const bundle = JSON.parse(JSON.stringify(repo.exportBundle()));
    assert.equal(Object.keys(bundle.screenshots).length, 1);
    const fresh = new ElementRepository(tempDir());
    assert.deepEqual(fresh.importBundle(bundle, 'replace'), { elements: 2, tests: 0 });
    assert.deepEqual(fresh.elements(), repo.elements());
    const shot = fresh.elements()[0].platforms.android!.history[0].screenshot!;
    assert.ok(existsSync(fresh.screenshotPath(shot)), 'screenshots are restored on import');
    const reopened = new ElementRepository(fresh.dir);
    assert.equal(reopened.elements().length, 2);
  });

  it('rejects foreign or tampered bundles', () => {
    const repo = new ElementRepository(tempDir());
    assert.throws(() => repo.importBundle({ format: 'other' }, 'merge'), (e: InspectorError) => e.code === 'INVALID_INPUT');
    const bundle = seedLoginRepository(tempDir()).repo.exportBundle();
    const name = Object.keys(bundle.screenshots)[0];
    bundle.screenshots[name] = Buffer.from('tampered').toString('base64');
    assert.throws(() => repo.importBundle(bundle, 'merge'), /checksum/);
  });

  it('resolves a shared logical test per platform and reports gaps instead of borrowing locators', () => {
    const { repo, loginId, usernameId } = seedLoginRepository(tempDir());
    const a = tree('android', 'android-login.xml');
    const forgot = capture(repo, 'android', a, { 'content-desc': 'forgot_password' }, 'forgotPassword').element;
    const t = repo.upsertTest({ name: 'Login', steps: [
      { action: 'type', elementId: usernameId, value: 'demo' },
      { action: 'tap', elementId: loginId },
      { action: 'tap', elementId: forgot.id },
    ] });
    const android = repo.resolveTest(t.id, 'android');
    assert.deepEqual(android.gaps, []);
    assert.equal(android.steps[1].locator!.value, 'com.example.shop:id/login_button');
    const ios = repo.resolveTest(t.id, 'ios');
    assert.equal(ios.steps[1].locator!.value, 'loginButton');
    assert.equal(ios.gaps.length, 1);
    assert.equal(ios.steps[2].locator, null);
  });
});

describe('project integration', () => {
  const example = path.join(ROOT, 'examples', 'java-appium-shop');

  it('detects Java + Maven + Appium + TestNG and the test files', () => {
    const p = detectProject(example);
    assert.equal(p.buildSystem, 'maven');
    assert.deepEqual(p.languages, ['java']);
    assert.deepEqual(p.frameworks, ['appium-java-client', 'testng']);
    assert.deepEqual(p.testFiles.map((f) => path.basename(f)), ['BaseTest.java', 'LoginTest.java']);
  });

  it('skips test-run output at the project root but not same-named source packages', () => {
    const root = tempDir();
    const put = (rel: string, body: string) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), body); };
    put('reports/gallery-lib/photobox.js', "const el = $('<div id=\"pbOverlay\">');");
    put('src/main/java/com/app/reports/ReportsPage.java', 'class ReportsPage {}');
    const files = detectProject(root).sourceFiles.map((f) => f.replaceAll('\\', '/'));
    assert.ok(!files.some((f) => f.includes('gallery-lib')), files.join());
    assert.ok(files.some((f) => f.endsWith('com/app/reports/ReportsPage.java')), files.join());
  });

  it('finds platform-specific annotation locators with field names', () => {
    const { refs, project } = scanProject(example);
    const login = refs.filter((r) => r.field === 'loginButton');
    assert.deepEqual(login.map((r) => [r.platform, r.strategy, r.value]), [
      ['android', 'id', 'com.example.shop:id/login_button'],
      ['ios', 'accessibility id', 'loginButton'],
    ]);
    const pred = refs.find((r) => r.strategy === '-ios predicate string')!;
    assert.equal(pred.value, 'type == "XCUIElementTypeButton" AND label == "Forgot password?"');
    const shared = refs.find((r) => r.field === 'greeting')!;
    assert.equal(shared.platform, 'shared');
    assert.equal(project.pageObjects.length, 2);
  });

  it('scans WebdriverIO and Python locator styles', () => {
    const js = scanSource('/p/screens/ios/login.screen.ts', `class LoginScreen { get submit () { return $('~login.submit'); } get title () { return $('-ios predicate string:label == "Hi"'); } }`);
    assert.deepEqual(js.map((r) => [r.platform, r.strategy, r.value, r.field]), [
      ['ios', 'accessibility id', 'login.submit', 'submit'],
      ['ios', '-ios predicate string', 'label == "Hi"', 'title'],
    ]);
    const py = scanSource('/p/pages/login_page.py', `from appium.webdriver.common.appiumby import AppiumBy\nclass LoginPage:\n    SUBMIT = (AppiumBy.ANDROID_UIAUTOMATOR, 'new UiSelector().text("Go")')\n`);
    assert.deepEqual(py.map((r) => [r.platform, r.strategy, r.field]), [['android', '-android uiautomator', 'SUBMIT']]);
  });

  it('maps repository elements to code per platform only', () => {
    const { repo } = seedLoginRepository(tempDir());
    const { refs } = scanProject(example);
    const { mappings } = mapElementsToCode(repo.elements(), refs);
    const loginAndroid = mappings.find((m) => m.name === 'loginButton' && m.platform === 'android')!;
    const loginIos = mappings.find((m) => m.name === 'loginButton' && m.platform === 'ios')!;
    assert.deepEqual(loginAndroid.refs.map((r) => r.syntax), ['java-android-annotation']);
    assert.deepEqual(loginIos.refs.map((r) => r.syntax), ['java-ios-annotation']);
    const userAndroid = mappings.find((m) => m.name === 'username' && m.platform === 'android')!;
    assert.equal(userAndroid.refs[0].value, 'username', 'short resource id in code matches the full id on device');
  });
});
