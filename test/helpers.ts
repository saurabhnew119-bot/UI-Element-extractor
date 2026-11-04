import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { findAll, parseHierarchy } from '../src/core/hierarchy.ts';
import { ElementRepository } from '../src/core/repository.ts';
import type { Platform, UiTree } from '../src/core/types.ts';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

export function fixture(name: string): string {
  return readFileSync(path.join(HERE, 'fixtures', name), 'utf8');
}

export function tree(platform: Platform, name: string): UiTree {
  return parseHierarchy(fixture(name), platform);
}

export function tempDir(prefix = 'elementiq-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copies the example Java Appium project into a temp dir so repairs never touch the checked-in copy. */
export function copyExampleProject(): string {
  const dest = path.join(tempDir(), 'java-appium-shop');
  cpSync(path.join(ROOT, 'examples', 'java-appium-shop'), dest, { recursive: true });
  return dest;
}

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export function capture(repo: ElementRepository, platform: Platform, t: UiTree, attrs: Record<string, string>, name: string, elementId?: string) {
  const node = findAll(t, { attrs })[0];
  assert.ok(node, `fixture node ${JSON.stringify(attrs)}`);
  return repo.capture({ platform, tree: t, node, name, screen: 'Login', purpose: 'Submit credentials', elementId, device: null, appId: 'com.example.shop', screenshotBase64: PNG_1x1, source: 'offline-snapshot' });
}

export function seedLoginRepository(dir: string) {
  const repo = new ElementRepository(dir);
  const a = tree('android', 'android-login.xml');
  const i = tree('ios', 'ios-login.xml');
  const login = capture(repo, 'android', a, { 'resource-id': 'com.example.shop:id/login_button' }, 'loginButton').element;
  capture(repo, 'ios', i, { name: 'loginButton' }, 'loginButton', login.id);
  const user = capture(repo, 'android', a, { 'resource-id': 'com.example.shop:id/username' }, 'username').element;
  capture(repo, 'ios', i, { name: 'usernameField' }, 'username', user.id);
  return { repo, loginId: login.id, usernameId: user.id };
}
