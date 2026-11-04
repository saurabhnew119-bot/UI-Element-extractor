import os from 'node:os';
import path from 'node:path';
import { InspectorError } from '../core/errors.ts';
import type { DeviceInfo } from '../core/types.ts';
import { run, which } from '../util/exec.ts';
import { checkBinaryForPlatform, commonCapabilities, installedAppiumDrivers, issue, type Discovery, type PlatformAdapter, type SessionRequest } from './common.ts';

export function adbPath(): string | null {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter((d): d is string => !!d);
  return which('adb', sdkRoots.map((r) => path.join(r, 'platform-tools')));
}

/** Parses `adb devices -l`. Exported for tests. */
export function parseAdbDevices(out: string): { serial: string; state: string; props: Record<string, string> }[] {
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'))
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const props: Record<string, string> = {};
      for (const kv of rest) {
        const i = kv.indexOf(':');
        if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return { serial, state, props };
    });
}

export class AndroidAdapter implements PlatformAdapter {
  readonly platform = 'android' as const;
  readonly appiumDriver = 'uiautomator2' as const;
  readonly automationName = 'UiAutomator2' as const;

  async discover(): Promise<Discovery> {
    const result: Discovery = { platform: 'android', devices: [], issues: [] };
    const drivers = await installedAppiumDrivers();
    if (drivers && !drivers.uiautomator2) {
      result.issues.push(issue('DRIVER_NOT_INSTALLED', 'The Appium UiAutomator2 driver is not installed on this host.', 'android', 'Run: appium driver install uiautomator2'));
    }
    const adb = adbPath();
    if (!adb) {
      result.issues.push(issue('ADB_NOT_FOUND', 'adb was not found, so local Android devices cannot be discovered.', 'android',
        'Install Android SDK platform-tools and set ANDROID_HOME. You can still connect through a remote Appium server by entering the device UDID manually.'));
      return result;
    }
    const list = await run(adb, ['devices', '-l'], { timeoutMs: 20_000 });
    if (list.code !== 0) {
      result.issues.push(issue('ADB_NOT_FOUND', `adb devices failed: ${list.stderr.trim() || list.stdout.trim()}`, 'android'));
      return result;
    }
    for (const d of parseAdbDevices(list.stdout)) {
      const info: DeviceInfo = {
        platform: 'android', udid: d.serial, name: d.props.model?.replace(/_/g, ' ') ?? d.serial,
        model: d.props.model ?? 'unknown', osVersion: 'unknown',
        kind: d.serial.startsWith('emulator-') ? 'emulator' : 'physical',
        state: d.state, usable: d.state === 'device', notes: [],
      };
      if (d.state === 'unauthorized') {
        info.notes.push('USB debugging authorization is pending: accept the RSA key prompt on the device.');
        result.issues.push(issue('ANDROID_DEVICE_UNAUTHORIZED', `Device ${d.serial} has not authorized this computer.`, 'android', 'Unlock the device and accept the "Allow USB debugging" prompt.'));
      } else if (d.state === 'offline') {
        info.notes.push('Device is offline: reconnect the cable or restart adb (adb kill-server).');
        result.issues.push(issue('ANDROID_DEVICE_OFFLINE', `Device ${d.serial} is offline.`, 'android'));
      } else if (d.state === 'device') {
        const props = await run(adb, ['-s', d.serial, 'shell', 'getprop ro.build.version.release; getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.kernel.qemu'], { timeoutMs: 15_000 });
        const [release, maker, model, qemu] = props.stdout.split(/\r?\n/).map((s) => s.trim());
        if (release) info.osVersion = `Android ${release}`;
        if (model) {
          info.model = model;
          info.name = maker ? `${maker} ${model}` : model;
        }
        if (qemu === '1') info.kind = 'emulator';
      }
      result.devices.push(info);
    }
    return result;
  }

  async listPackages(udid: string): Promise<string[]> {
    const adb = adbPath();
    if (!adb) throw new InspectorError('ADB_NOT_FOUND', 'adb is required to list installed packages.', { platform: 'android' });
    const r = await run(adb, ['-s', udid, 'shell', 'pm', 'list', 'packages', '-3'], { timeoutMs: 30_000 });
    if (r.code !== 0) throw this.classifySessionError(r.stderr || r.stdout);
    return r.stdout.split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean).sort();
  }

  buildCapabilities(req: SessionRequest) {
    if (!req.udid) throw new InspectorError('INVALID_INPUT', 'A device UDID/serial is required.', { platform: 'android' });
    if (!req.appId && !req.app) throw new InspectorError('INVALID_INPUT', 'Provide the installed package name (appId) or an .apk path (app).', { platform: 'android' });
    if (req.app) checkBinaryForPlatform('android', req.app, req.deviceKind);
    if (req.appId && !/^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/.test(req.appId)) {
      throw new InspectorError('INVALID_INPUT', `"${req.appId}" is not a valid Android package name.`, { platform: 'android', hint: 'iOS bundle identifiers and Android package names are separate; use the Android package (e.g. com.example.app).' });
    }
    const warnings: string[] = [];
    if (req.ios) warnings.push('iOS signing options were ignored for an Android session.');
    const capabilities: Record<string, unknown> = {
      platformName: 'Android',
      'appium:automationName': this.automationName,
      ...commonCapabilities(req),
      'appium:autoGrantPermissions': true,
      'appium:ensureWebviewsHavePages': true,
    };
    if (req.appId) capabilities['appium:appPackage'] = req.appId;
    if (req.appActivity) capabilities['appium:appActivity'] = req.appActivity;
    Object.assign(capabilities, req.extraCapabilities);
    return { capabilities, warnings };
  }

  classifySessionError(message: string): InspectorError {
    const p = { platform: 'android' as const, detail: message };
    const install = /INSTALL_(FAILED|PARSE_FAILED)_[A-Z_]+/.exec(message);
    if (install) return new InspectorError('ANDROID_INSTALL_FAILED', `APK installation failed: ${install[0]}`, { ...p, hint: 'Check signature conflicts with an installed build, minSdk, and ABI compatibility.' });
    if (/ANDROID_HOME|ANDROID_SDK_ROOT/.test(message)) return new InspectorError('ANDROID_SDK_MISSING', 'Appium cannot locate the Android SDK.', { ...p, hint: 'Set ANDROID_HOME for the Appium server process and restart it.' });
    if (/unauthorized/i.test(message)) return new InspectorError('ANDROID_DEVICE_UNAUTHORIZED', 'The device has not authorized USB debugging for this host.', { ...p, hint: 'Accept the RSA prompt on the device.' });
    if (/device .* not found|Could not find a connected Android device|offline/i.test(message)) return new InspectorError('DEVICE_NOT_FOUND', 'The Android device is not connected or is offline.', { ...p, hint: 'Check `adb devices`.' });
    if (/Could not find a driver|automationName .* not installed|driver .*uiautomator2/i.test(message)) return new InspectorError('DRIVER_NOT_INSTALLED', 'UiAutomator2 driver is not installed on the Appium server.', { ...p, hint: 'appium driver install uiautomator2' });
    if (/does not exist or is not accessible|package .* (does not exist|not found)|Cannot start the '.*' application|never started/i.test(message)) return new InspectorError('ANDROID_APP_NOT_FOUND', 'The app package could not be found or started on the device.', { ...p, hint: 'Verify the package with `adb shell pm list packages` and the activity name.' });
    return new InspectorError('SESSION_CREATE_FAILED', `Android session could not be created: ${message.split('\n')[0]}`, p);
  }
}
