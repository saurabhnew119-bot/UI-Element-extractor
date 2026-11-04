import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ElementRepository } from '../src/core/repository.ts';
import { Healer } from '../src/repair/healer.ts';
import { applyHealing } from '../src/repair/healing-report.ts';
import { ROOT, seedLoginRepository, tempDir, tree } from './helpers.ts';

const REPO_REL = 'src/test/resources/elementiq/repository.json';

/** Copies framework-java (sources only) and makes build/test commands deterministic real processes. */
function frameworkCopy(testExit = 0) {
  const dest = path.join(tempDir(), 'framework-java');
  cpSync(path.join(ROOT, 'framework-java'), dest, { recursive: true, filter: (src) => !/[\\/](target|\.mvn)([\\/]|$)/.test(src) });
  mkdirSync(path.join(dest, '.elementiq'), { recursive: true });
  writeFileSync(path.join(dest, '.elementiq', 'config.json'), JSON.stringify({
    repositoryDir: 'src/test/resources/elementiq',
    buildCommand: 'node -e "process.exit(0)"',
    testCommand: { android: `node -e "process.exit(${testExit})" {platform}`, ios: `node -e "process.exit(${testExit})" {platform}` },
  }));
  return dest;
}

const primary = (r: ElementRepository, name: string, p: 'android' | 'ios') => {
  const l = r.findByName(name)!.platforms[p]!.locators[0];
  return `${l.strategy}=${l.value}`;
};

describe('ElementIQ Java framework integration', () => {
  it('repairs the Android binding the framework reads, leaving iOS untouched', async () => {
    const project = frameworkCopy();
    // Inspector and framework share one repository file (the recommended setup).
    const repo = new ElementRepository(path.join(project, 'src/test/resources/elementiq'));
    const rec = await new Healer(repo).repair({
      projectRoot: project, platform: 'android', elementId: repo.findByName('loginButton')!.id,
      tree: tree('android', 'android-login-v2.xml'), hierarchySource: 'offline-snapshot',
    });
    assert.equal(rec.status, 'verified', rec.message);
    assert.deepEqual(rec.files.map((f) => f.file), [REPO_REL]);
    assert.equal(rec.refs[0].field, 'loginButton');
    assert.deepEqual(rec.refs[0].newLocator, { strategy: 'id', value: 'com.example.shop:id/sign_in_button' });
    assert.ok(rec.affectedTests.some((t) => t.endsWith('LoginTest.java')), rec.affectedTests.join());
    assert.ok(rec.affectedTests.some((t) => t.endsWith('LoginSteps.java')), 'Cucumber steps are affected too');
    const onDisk = new ElementRepository(path.join(project, 'src/test/resources/elementiq'));
    assert.equal(primary(onDisk, 'loginButton', 'android'), 'id=com.example.shop:id/sign_in_button');
    assert.equal(primary(onDisk, 'loginButton', 'ios'), 'accessibility id=loginButton');

    // Rollback restores the file byte-for-byte and the in-memory repository follows it.
    new Healer(repo).rollback(project, rec.id);
    assert.equal(readFileSync(path.join(project, REPO_REL), 'utf8'), readFileSync(path.join(ROOT, 'framework-java', REPO_REL), 'utf8'));
    assert.equal(primary(repo, 'loginButton', 'android'), 'id=com.example.shop:id/login_button');
  });

  it('repairs the iOS binding when the inspector keeps its own repository', async () => {
    const project = frameworkCopy();
    const { repo, loginId } = seedLoginRepository(tempDir());
    const rec = await new Healer(repo).repair({
      projectRoot: project, platform: 'ios', elementId: loginId, tree: tree('ios', 'ios-login-v2.xml'), hierarchySource: 'offline-snapshot',
    });
    assert.equal(rec.status, 'verified', rec.message);
    const onDisk = new ElementRepository(path.join(project, 'src/test/resources/elementiq'));
    assert.equal(primary(onDisk, 'loginButton', 'ios'), 'accessibility id=login.submit');
    assert.equal(primary(onDisk, 'loginButton', 'android'), 'id=com.example.shop:id/login_button');
    assert.equal(primary(repo, 'loginButton', 'ios'), 'accessibility id=login.submit', 'inspector history follows');
  });

  it('rolls the repository back when the framework tests fail', async () => {
    const project = frameworkCopy(1);
    const repo = new ElementRepository(path.join(project, 'src/test/resources/elementiq'));
    const before = readFileSync(path.join(project, REPO_REL), 'utf8');
    const rec = await new Healer(repo).repair({
      projectRoot: project, platform: 'android', elementId: repo.findByName('loginButton')!.id,
      tree: tree('android', 'android-login-v2.xml'), hierarchySource: 'offline-snapshot',
    });
    assert.equal(rec.status, 'rolled-back');
    assert.equal(readFileSync(path.join(project, REPO_REL), 'utf8'), before);
    assert.equal(primary(repo, 'loginButton', 'android'), 'id=com.example.shop:id/login_button');
  });

  it('reports not-broken when the framework locator still works', async () => {
    const project = frameworkCopy();
    const repo = new ElementRepository(path.join(project, 'src/test/resources/elementiq'));
    const rec = await new Healer(repo).repair({
      projectRoot: project, platform: 'ios', elementId: repo.findByName('loginButton')!.id,
      tree: tree('ios', 'ios-login.xml'), hierarchySource: 'offline-snapshot',
    });
    assert.equal(rec.status, 'not-broken');
    assert.equal(rec.files.length, 0);
  });

  it('promotes runtime-healing fallbacks from the framework report', () => {
    const repo = new ElementRepository(path.join(frameworkCopy(), 'src/test/resources/elementiq'));
    const alt = repo.findByName('loginButton')!.platforms.android!.locators[1];
    const results = applyHealing(repo, [
      { element: 'loginButton', platform: 'android', outcome: 'HEALED', failedLocator: { strategy: 'id', value: 'com.example.shop:id/login_button' }, usedLocator: { strategy: alt.strategy, value: alt.value }, test: 'LoginTest.validUserReachesDashboard' },
      { element: 'username', platform: 'ios', outcome: 'BROKEN', failedLocator: { strategy: 'accessibility id', value: 'usernameField' }, usedLocator: null, test: null },
      { element: 'loginButton', platform: 'ios', outcome: 'HEALED', failedLocator: { strategy: 'accessibility id', value: 'loginButton' }, usedLocator: { strategy: 'accessibility id', value: 'made-up' }, test: null },
    ]);
    assert.deepEqual(results.map((r) => r.result), ['promoted', 'repair', 'missing']);
    assert.equal(primary(repo, 'loginButton', 'android'), `${alt.strategy}=${alt.value}`);
    assert.equal(primary(repo, 'loginButton', 'ios'), 'accessibility id=loginButton', 'unknown locators are never adopted');
  });
});
