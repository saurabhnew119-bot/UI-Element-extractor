import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InspectorError } from '../src/core/errors.ts';
import { accessibilityIssues, findAll, parseHierarchy } from '../src/core/hierarchy.ts';
import { bestLocator, evaluateOffline, generateLocators, quoteXPath } from '../src/core/locators.ts';
import { unifiedDiff } from '../src/util/diff.ts';
import { parseXml } from '../src/util/xml.ts';
import { fixture, tree } from './helpers.ts';

describe('xml + hierarchy', () => {
  it('parses Android bounds, entities and nesting', () => {
    const t = tree('android', 'android-login.xml');
    const btn = findAll(t, { attrs: { 'resource-id': 'com.example.shop:id/login_button' } })[0];
    assert.equal(btn.tag, 'android.widget.Button');
    assert.deepEqual(btn.bounds, { x: 80, y: 960, width: 920, height: 130 });
    assert.equal(findAll(t, { attrs: { text: 'Need help? & "Support"' } }).length, 1);
  });

  it('parses iOS geometry and uses the element type as tag', () => {
    const t = tree('ios', 'ios-login.xml');
    const btn = findAll(t, { attrs: { name: 'loginButton' } })[0];
    assert.equal(btn.tag, 'XCUIElementTypeButton');
    assert.deepEqual(btn.bounds, { x: 24, y: 384, width: 342, height: 52 });
  });

  it('refuses to parse one platform\'s source as the other', () => {
    assert.throws(() => parseHierarchy(fixture('ios-login.xml'), 'android'), (e: InspectorError) => e.code === 'WRONG_PLATFORM_BINARY');
    assert.throws(() => parseHierarchy(fixture('android-login.xml'), 'ios'), (e: InspectorError) => e.code === 'WRONG_PLATFORM_BINARY');
  });

  it('reports malformed XML instead of returning a partial tree', () => {
    assert.throws(() => parseHierarchy('<hierarchy><android.widget.Button></hierarchy>', 'android'), (e: InspectorError) => e.code === 'INVALID_INPUT');
    assert.throws(() => parseXml('<a x="1>'));
  });

  it('flags elements that only support structural locators', () => {
    const t = tree('ios', 'ios-login.xml');
    const img = findAll(t, { tag: 'XCUIElementTypeImage', attrs: {} })[0];
    assert.match(accessibilityIssues(img, 'ios').join(' '), /structural locators/);
  });
});

describe('android locators', () => {
  const t = tree('android', 'android-login.xml');

  it('prefers content-desc, then resource-id, then UiAutomator, text, and XPath last', () => {
    const forgot = findAll(t, { attrs: { 'content-desc': 'forgot_password' } })[0];
    const c = generateLocators(t, forgot);
    assert.equal(c[0].strategy, 'accessibility id');
    assert.equal(c[0].value, 'forgot_password');
    const login = findAll(t, { attrs: { 'resource-id': 'com.example.shop:id/login_button' } })[0];
    const lc = generateLocators(t, login);
    assert.deepEqual(lc.slice(0, 2).map((x) => x.strategy), ['id', '-android uiautomator']);
    assert.equal(lc.at(-1)!.strategy, 'xpath');
  });

  it('marks non-unique resource ids and demotes them', () => {
    const icon = findAll(t, { attrs: { 'resource-id': 'android:id/icon' } })[0];
    const c = generateLocators(t, icon);
    const byId = c.find((x) => x.strategy === 'id')!;
    assert.equal(byId.unique, false);
    assert.equal(byId.snapshotMatches, 2);
    assert.ok(byId.warnings.some((w) => w.includes('System resource id')));
    assert.equal(bestLocator(c)!.strategy, 'xpath');
  });

  it('every unique generated locator resolves offline to exactly its element', () => {
    for (const node of t.nodes.values()) {
      for (const c of generateLocators(t, node).filter((x) => x.unique)) {
        const hits = evaluateOffline(t, c.strategy, c.value);
        assert.ok(hits, `${c.strategy} should be evaluable offline`);
        assert.deepEqual(hits.map((h) => h.id), [node.id], `${c.strategy}=${c.value}`);
      }
    }
  });

  it('resolves short resource ids the way UiAutomator2 does', () => {
    assert.equal(evaluateOffline(t, 'id', 'username')!.length, 1);
    assert.equal(evaluateOffline(t, 'id', 'com.example.shop:id/username')!.length, 1);
    assert.equal(evaluateOffline(t, 'id', 'missing')!.length, 0);
  });

  it('does not offer the id strategy for package-less ids such as React Native testIDs', () => {
    // Shape seen live on mSpace (com.mli.mspace): UiAutomator2 found 0 elements for id=track-button.
    const rn = parseHierarchy(`<hierarchy rotation="0"><android.widget.FrameLayout package="com.mli.mspace" bounds="[0,0][1080,2400]">
      <android.view.ViewGroup resource-id="track-button" content-desc="Login" clickable="true" package="com.mli.mspace" bounds="[209,1788][871,1929]"/>
    </android.widget.FrameLayout></hierarchy>`, 'android');
    const btn = findAll(rn, { attrs: { 'resource-id': 'track-button' } })[0];
    const c = generateLocators(rn, btn);
    assert.ok(!c.some((x) => x.strategy === 'id'), c.map((x) => x.strategy).join());
    assert.ok(c.some((x) => x.value === 'new UiSelector().resourceId("track-button").className("android.view.ViewGroup")' && x.unique));
    assert.equal(evaluateOffline(rn, 'id', 'track-button')!.length, 0, 'a bare id is expanded to <package>:id/…');
  });
});

describe('ios locators', () => {
  const t = tree('ios', 'ios-login.xml');

  it('treats a name that differs from the label as an accessibilityIdentifier (rank 1)', () => {
    const btn = findAll(t, { attrs: { name: 'loginButton' } })[0];
    const c = generateLocators(t, btn);
    assert.equal(c[0].strategy, 'accessibility id');
    assert.equal(c[0].rank, 1);
    assert.ok(c.some((x) => x.strategy === '-ios predicate string'));
    assert.ok(c.some((x) => x.strategy === '-ios class chain'));
  });

  it('warns when the accessibility id is only the visible label', () => {
    const forgot = findAll(t, { attrs: { name: 'Forgot password?' } })[0];
    const c = generateLocators(t, forgot);
    const acc = c.find((x) => x.strategy === 'accessibility id')!;
    assert.equal(acc.rank, 2);
    assert.ok(acc.warnings.some((w) => w.includes('no accessibilityIdentifier')));
  });

  it('every unique generated locator resolves offline to exactly its element', () => {
    for (const node of t.nodes.values()) {
      for (const c of generateLocators(t, node).filter((x) => x.unique)) {
        const hits = evaluateOffline(t, c.strategy, c.value);
        assert.ok(hits, `${c.strategy} should be evaluable offline`);
        assert.deepEqual(hits.map((h) => h.id), [node.id], `${c.strategy}=${c.value}`);
      }
    }
  });

  it('never emits Android strategies for iOS and vice versa', () => {
    const iosStrategies = new Set([...t.nodes.values()].flatMap((n) => generateLocators(t, n).map((c) => c.strategy)));
    assert.ok(!iosStrategies.has('-android uiautomator'));
    const a = tree('android', 'android-login.xml');
    const androidStrategies = new Set([...a.nodes.values()].flatMap((n) => generateLocators(a, n).map((c) => c.strategy)));
    assert.ok(!androidStrategies.has('-ios predicate string') && !androidStrategies.has('-ios class chain'));
  });
});

describe('utilities', () => {
  it('quotes XPath literals containing both quote kinds', () => {
    assert.equal(quoteXPath(`a"b'c`), `concat("a", '"', "b'c")`);
  });

  it('produces a unified diff with only the changed hunk', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 10', 'line ten');
    const d = unifiedDiff(a, b, 'a/f', 'b/f');
    assert.match(d, /^--- a\/f\n\+\+\+ b\/f\n@@ -8,7 \+8,7 @@\n/);
    assert.ok(d.includes('-line 10\n+line ten'));
    assert.equal(unifiedDiff(a, a, 'a', 'b'), '');
  });
});
