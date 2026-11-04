import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InspectorError } from '../src/core/errors.ts';
import { AndroidAdapter, parseAdbDevices } from '../src/platforms/android.ts';
import { IosAdapter, parseDevicectl, parseSimctl } from '../src/platforms/ios.ts';

const android = new AndroidAdapter();
const ios = new IosAdapter();
const code = (c: string) => (e: InspectorError) => e.code === c;

describe('android adapter', () => {
  it('parses adb device states, including unauthorized devices', () => {
    const out = 'List of devices attached\nemulator-5554          device product:sdk_gphone64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\nR58M12ABC     unauthorized usb:1-1 transport_id:2\n\n';
    const d = parseAdbDevices(out);
    assert.equal(d.length, 2);
    assert.equal(d[0].props.model, 'sdk_gphone64_x86_64');
    assert.equal(d[1].state, 'unauthorized');
  });

  it('builds UiAutomator2 capabilities', () => {
    const { capabilities } = android.buildCapabilities({ platform: 'android', udid: 'emulator-5554', appId: 'com.example.shop' });
    assert.equal(capabilities.platformName, 'Android');
    assert.equal(capabilities['appium:automationName'], 'UiAutomator2');
    assert.equal(capabilities['appium:appPackage'], 'com.example.shop');
  });

  it('rejects iOS binaries and missing app identifiers', () => {
    assert.throws(() => android.buildCapabilities({ platform: 'android', udid: 'x', app: '/builds/Shop.ipa' }), code('WRONG_PLATFORM_BINARY'));
    assert.throws(() => android.buildCapabilities({ platform: 'android', udid: 'x' }), code('INVALID_INPUT'));
  });

  it('classifies common session failures', () => {
    assert.equal(android.classifySessionError('Error: INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package com.x signatures do not match').code, 'ANDROID_INSTALL_FAILED');
    assert.equal(android.classifySessionError('Neither ANDROID_HOME nor ANDROID_SDK_ROOT environment variable was exported').code, 'ANDROID_SDK_MISSING');
    assert.equal(android.classifySessionError('Could not find a driver for automationName \'UiAutomator2\'').code, 'DRIVER_NOT_INSTALLED');
  });
});

describe('ios adapter', () => {
  it('parses simulators from simctl and skips non-iOS runtimes', () => {
    const json = JSON.stringify({ devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [{ udid: 'SIM-1', name: 'iPhone 15', state: 'Booted', isAvailable: true }],
      'com.apple.CoreSimulator.SimRuntime.watchOS-10-5': [{ udid: 'W-1', name: 'Watch', state: 'Shutdown', isAvailable: true }],
    } });
    const d = parseSimctl(json);
    assert.equal(d.length, 1);
    assert.equal(d[0].osVersion, 'iOS 17.5');
    assert.equal(d[0].kind, 'simulator');
  });

  it('reports untrusted devices and disabled Developer Mode from devicectl', () => {
    const json = JSON.stringify({ result: { devices: [{
      hardwareProperties: { udid: '00008110-AAA', productType: 'iPhone15,2', platform: 'iOS', reality: 'physical' },
      deviceProperties: { name: 'QA iPhone', osVersionNumber: '17.4', developerModeStatus: 'disabled' },
      connectionProperties: { pairingState: 'unpaired' },
    }] } });
    const [d] = parseDevicectl(json);
    assert.equal(d.usable, false);
    assert.equal(d.notes.length, 2);
  });

  it('builds XCUITest capabilities with WDA signing for physical devices', () => {
    const { capabilities, warnings } = ios.buildCapabilities({
      platform: 'ios', udid: '00008110-AAA', deviceKind: 'physical', appId: 'com.example.shop',
      ios: { xcodeOrgId: 'TEAM123', updatedWDABundleId: 'com.example.wda' },
    });
    assert.equal(capabilities['appium:automationName'], 'XCUITest');
    assert.equal(capabilities['appium:bundleId'], 'com.example.shop');
    assert.equal(capabilities['appium:xcodeOrgId'], 'TEAM123');
    assert.equal(capabilities['appium:xcodeSigningId'], 'Apple Development');
    assert.deepEqual(warnings, []);
  });

  it('warns when a physical device has no WDA signing configured', () => {
    const { warnings } = ios.buildCapabilities({ platform: 'ios', udid: 'u', deviceKind: 'physical', appId: 'com.example.shop' });
    assert.match(warnings[0], /code 65/);
  });

  it('rejects Android binaries and device builds on simulators', () => {
    assert.throws(() => ios.buildCapabilities({ platform: 'ios', udid: 'u', app: 'shop.apk' }), code('WRONG_PLATFORM_BINARY'));
    assert.throws(() => ios.buildCapabilities({ platform: 'ios', udid: 'u', deviceKind: 'simulator', app: 'Shop.ipa' }), code('WRONG_PLATFORM_BINARY'));
  });

  it('classifies signing, provisioning, trust and Developer Mode failures', () => {
    assert.equal(ios.classifySessionError('xcodebuild failed with code 65. Signing for "WebDriverAgentRunner" requires a development team').code, 'IOS_SIGNING_FAILED');
    assert.equal(ios.classifySessionError('error: No profiles for \'com.facebook.WebDriverAgentRunner.xctrunner\' were found').code, 'IOS_PROVISIONING_PROFILE');
    assert.equal(ios.classifySessionError('Developer Mode is disabled on the device').code, 'IOS_DEVELOPER_MODE_DISABLED');
    assert.equal(ios.classifySessionError('Could not start: the device is not paired (InvalidHostID)').code, 'IOS_DEVICE_NOT_TRUSTED');
    assert.equal(ios.classifySessionError('Unable to launch WebDriverAgent because of xcodebuild failure').code, 'IOS_WDA_FAILED');
  });

  it('reports that local discovery needs macOS instead of returning an empty success', async () => {
    if (process.platform === 'darwin') return;
    const d = await ios.discover();
    assert.equal(d.devices.length, 0);
    assert.ok(d.issues.some((i) => i.code === 'IOS_REQUIRES_MACOS'));
  });
});
