import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InspectorError } from '../core/errors.ts';
import type { DeviceInfo } from '../core/types.ts';
import { run, which } from '../util/exec.ts';
import { checkBinaryForPlatform, commonCapabilities, installedAppiumDrivers, issue, type Discovery, type PlatformAdapter, type SessionRequest } from './common.ts';

/** Parses `xcrun simctl list devices available -j`. Exported for tests. */
export function parseSimctl(json: string): DeviceInfo[] {
  const data = JSON.parse(json) as { devices: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]> };
  const out: DeviceInfo[] = [];
  for (const [runtime, devices] of Object.entries(data.devices)) {
    const m = /SimRuntime\.(iOS|watchOS|tvOS|xrOS)-([\d-]+)$/.exec(runtime);
    if (!m || m[1] !== 'iOS') continue;
    for (const d of devices) {
      if (d.isAvailable === false) continue;
      out.push({
        platform: 'ios', udid: d.udid, name: d.name, model: d.name, osVersion: `iOS ${m[2].replace(/-/g, '.')}`,
        kind: 'simulator', state: d.state, usable: true,
        notes: d.state === 'Booted' ? [] : ['Simulator is shut down; Appium boots it on session start.'],
      });
    }
  }
  return out;
}

interface DevicectlDevice {
  hardwareProperties?: { udid?: string; productType?: string; platform?: string; reality?: string };
  deviceProperties?: { name?: string; osVersionNumber?: string; developerModeStatus?: string };
  connectionProperties?: { pairingState?: string; tunnelState?: string };
}

/** Parses `xcrun devicectl list devices --json-output`. Exported for tests. */
export function parseDevicectl(json: string): DeviceInfo[] {
  const data = JSON.parse(json) as { result?: { devices?: DevicectlDevice[] } };
  const out: DeviceInfo[] = [];
  for (const d of data.result?.devices ?? []) {
    const hw = d.hardwareProperties ?? {};
    if (hw.platform !== 'iOS' || hw.reality !== 'physical' || !hw.udid) continue;
    const notes: string[] = [];
    const pairing = d.connectionProperties?.pairingState;
    const devMode = d.deviceProperties?.developerModeStatus;
    if (pairing && pairing !== 'paired') notes.push('Device is not paired/trusted with this Mac: unlock it and tap "Trust This Computer".');
    if (devMode && devMode !== 'enabled') notes.push('Developer Mode is disabled: enable it in Settings > Privacy & Security > Developer Mode (iOS 16+).');
    out.push({
      platform: 'ios', udid: hw.udid, name: d.deviceProperties?.name ?? hw.udid, model: hw.productType ?? 'unknown',
      osVersion: d.deviceProperties?.osVersionNumber ? `iOS ${d.deviceProperties.osVersionNumber}` : 'unknown',
      kind: 'physical', state: d.connectionProperties?.tunnelState ?? pairing ?? 'unknown',
      usable: notes.length === 0, notes,
    });
  }
  return out;
}

export class IosAdapter implements PlatformAdapter {
  readonly platform = 'ios' as const;
  readonly appiumDriver = 'xcuitest' as const;
  readonly automationName = 'XCUITest' as const;

  async discover(): Promise<Discovery> {
    const result: Discovery = { platform: 'ios', devices: [], issues: [] };
    const drivers = await installedAppiumDrivers();
    if (drivers && !drivers.xcuitest) {
      result.issues.push(issue('DRIVER_NOT_INSTALLED', 'The Appium XCUITest driver is not installed on this host.', 'ios', 'Run on the Mac hosting Appium: appium driver install xcuitest'));
    }
    if (process.platform !== 'darwin') {
      result.issues.push(issue('IOS_REQUIRES_MACOS', `Local iOS discovery requires macOS with Xcode; this host is ${process.platform}.`, 'ios',
        'Run Appium + XCUITest on a Mac and point this inspector at that server URL, then enter the device/simulator UDID manually.'));
      return result;
    }
    const xcrun = which('xcrun');
    if (!xcrun) {
      result.issues.push(issue('XCODE_NOT_FOUND', 'xcrun was not found; Xcode command line tools are required.', 'ios', 'Install Xcode and run: sudo xcode-select -s /Applications/Xcode.app'));
      return result;
    }
    const sims = await run(xcrun, ['simctl', 'list', 'devices', 'available', '-j'], { timeoutMs: 30_000 });
    if (sims.code === 0) result.devices.push(...parseSimctl(sims.stdout));
    else result.issues.push(issue('XCODE_NOT_FOUND', `simctl failed: ${sims.stderr.trim()}`, 'ios'));

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'elementiq-'));
    try {
      const out = path.join(tmp, 'devices.json');
      const r = await run(xcrun, ['devicectl', 'list', 'devices', '--json-output', out], { timeoutMs: 30_000 });
      if (r.code === 0) {
        const physical = parseDevicectl(readFileSync(out, 'utf8'));
        result.devices.push(...physical);
        for (const d of physical) {
          if (d.notes.some((n) => n.includes('Trust'))) result.issues.push(issue('IOS_DEVICE_NOT_TRUSTED', `${d.name} has not trusted this Mac.`, 'ios', 'Unlock the device and accept "Trust This Computer".'));
          if (d.notes.some((n) => n.includes('Developer Mode'))) result.issues.push(issue('IOS_DEVELOPER_MODE_DISABLED', `${d.name} has Developer Mode disabled.`, 'ios', 'Settings > Privacy & Security > Developer Mode, then restart the device.'));
        }
      } else {
        result.issues.push(issue('XCODE_NOT_FOUND', 'devicectl is unavailable (requires Xcode 15+); physical devices were not listed.', 'ios', 'Update Xcode, or enter the device UDID manually.'));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return result;
  }

  buildCapabilities(req: SessionRequest) {
    if (!req.udid) throw new InspectorError('INVALID_INPUT', 'A device or simulator UDID is required.', { platform: 'ios' });
    if (!req.appId && !req.app) throw new InspectorError('INVALID_INPUT', 'Provide the installed bundle identifier (appId) or an .ipa/.app path (app).', { platform: 'ios' });
    if (req.app) checkBinaryForPlatform('ios', req.app, req.deviceKind);
    const warnings: string[] = [];
    const capabilities: Record<string, unknown> = {
      platformName: 'iOS',
      'appium:automationName': this.automationName,
      ...commonCapabilities(req),
      'appium:wdaLaunchTimeout': 240_000,
      'appium:showXcodeLog': true,
      'appium:includeSafariInWebviews': true,
    };
    if (req.appId) capabilities['appium:bundleId'] = req.appId;
    const sign = req.ios ?? {};
    if (req.deviceKind === 'physical') {
      if (sign.webDriverAgentUrl) {
        capabilities['appium:webDriverAgentUrl'] = sign.webDriverAgentUrl;
      } else if (sign.usePrebuiltWDA) {
        capabilities['appium:usePrebuiltWDA'] = true;
      } else if (sign.xcodeOrgId) {
        capabilities['appium:xcodeOrgId'] = sign.xcodeOrgId;
        capabilities['appium:xcodeSigningId'] = sign.xcodeSigningId ?? 'Apple Development';
        if (sign.updatedWDABundleId) capabilities['appium:updatedWDABundleId'] = sign.updatedWDABundleId;
      } else {
        warnings.push('No WebDriverAgent signing configured (xcodeOrgId / usePrebuiltWDA / webDriverAgentUrl). Session creation will fail with xcodebuild code 65 unless WDA is already signed for this device.');
      }
      if (req.app?.toLowerCase().endsWith('.app')) warnings.push('A .app on a physical device must be a device build signed with a profile that includes this device.');
    } else if (req.ios?.xcodeOrgId) {
      warnings.push('Signing options are not needed for simulators and were ignored.');
    }
    Object.assign(capabilities, req.extraCapabilities);
    return { capabilities, warnings };
  }

  classifySessionError(message: string): InspectorError {
    const p = { platform: 'ios' as const, detail: message };
    if (/No profiles for|provisioning profile|doesn't include the currently selected device|requires a provisioning profile/i.test(message)) {
      return new InspectorError('IOS_PROVISIONING_PROFILE', 'No valid provisioning profile covers WebDriverAgent or the app on this device.', { ...p, hint: 'Register the device UDID in your Apple Developer team, set updatedWDABundleId to a bundle id your team can sign, and regenerate the profile.' });
    }
    if (/Developer Mode/i.test(message)) {
      return new InspectorError('IOS_DEVELOPER_MODE_DISABLED', 'Developer Mode is disabled on the device.', { ...p, hint: 'Settings > Privacy & Security > Developer Mode (iOS 16+).' });
    }
    if (/not trusted|Untrusted Developer|InvalidHostID|PasswordProtected|pairing|not paired/i.test(message)) {
      return new InspectorError('IOS_DEVICE_NOT_TRUSTED', 'The device does not trust this host, or the WDA developer certificate is not trusted on the device.', { ...p, hint: 'Accept "Trust This Computer"; then Settings > General > VPN & Device Management > trust the developer certificate.' });
    }
    if (/xcodebuild failed with code 65|Signing for .* requires a development team|code ?sign/i.test(message)) {
      return new InspectorError('IOS_SIGNING_FAILED', 'WebDriverAgent could not be code-signed (xcodebuild code 65).', { ...p, hint: 'Set xcodeOrgId (Team ID), xcodeSigningId ("Apple Development"), and a unique updatedWDABundleId; or use a prebuilt, signed WDA.' });
    }
    if (/xcode-select|Xcode .*not (found|installed)|xcrun: error/i.test(message)) {
      return new InspectorError('XCODE_NOT_FOUND', 'Xcode is not installed or not selected on the Appium host.', { ...p, hint: 'sudo xcode-select -s /Applications/Xcode.app' });
    }
    if (/Could not find a driver|automationName .* not installed|driver .*xcuitest/i.test(message)) {
      return new InspectorError('DRIVER_NOT_INSTALLED', 'XCUITest driver is not installed on the Appium server.', { ...p, hint: 'appium driver install xcuitest (on the Mac running Appium).' });
    }
    if (/WebDriverAgent|WDA|Unable to launch|wdaLaunchTimeout/i.test(message)) {
      return new InspectorError('IOS_WDA_FAILED', 'WebDriverAgent failed to build or launch.', { ...p, hint: 'Check the Xcode log (showXcodeLog), signing settings, and that the device is unlocked.' });
    }
    if (/Unknown device or simulator UDID|udid .* not found|device .* not (found|connected)/i.test(message)) {
      return new InspectorError('DEVICE_NOT_FOUND', 'The iOS device or simulator UDID is not known to the Appium host.', { ...p, hint: 'Check `xcrun xctrace list devices` on the Mac running Appium.' });
    }
    if (/bundle ?id|App with bundle identifier .* (unknown|not installed)|is not installed/i.test(message)) {
      return new InspectorError('IOS_APP_NOT_FOUND', 'The bundle identifier is not installed on the target.', { ...p, hint: 'Install the app or provide an .ipa/.app build appropriate for the target.' });
    }
    return new InspectorError('SESSION_CREATE_FAILED', `iOS session could not be created: ${message.split('\n')[0]}`, p);
  }
}
