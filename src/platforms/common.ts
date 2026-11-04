import { InspectorError } from '../core/errors.ts';
import type { DeviceInfo, Platform } from '../core/types.ts';
import { run, which } from '../util/exec.ts';

export interface SessionRequest {
  platform: Platform;
  udid: string;
  deviceKind?: DeviceInfo['kind'];
  deviceName?: string;
  platformVersion?: string;
  /** Android package name or iOS bundle identifier of an installed app. */
  appId?: string;
  /** Android launch activity (optional; UiAutomator2 resolves the launcher activity otherwise). */
  appActivity?: string;
  /** Path or URL of an .apk/.aab (Android) or .ipa/.app/.app.zip (iOS) to install. */
  app?: string;
  appiumUrl?: string;
  noReset?: boolean;
  ios?: {
    xcodeOrgId?: string;
    xcodeSigningId?: string;
    updatedWDABundleId?: string;
    webDriverAgentUrl?: string;
    usePrebuiltWDA?: boolean;
  };
  extraCapabilities?: Record<string, unknown>;
}

export interface Discovery {
  platform: Platform;
  devices: DeviceInfo[];
  issues: ReturnType<InspectorError['toJSON']>[];
}

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly appiumDriver: 'uiautomator2' | 'xcuitest';
  readonly automationName: 'UiAutomator2' | 'XCUITest';
  discover(): Promise<Discovery>;
  /** Builds capabilities and throws for requests that cannot work (wrong binary type, missing ids). */
  buildCapabilities(req: SessionRequest): { capabilities: Record<string, unknown>; warnings: string[] };
  classifySessionError(message: string): InspectorError;
}

let driverCache: { at: number; drivers: Record<string, { installed?: boolean; version?: string }> } | null = null;

/** Reads `appium driver list --installed --json`. Returns null when the Appium CLI is not on PATH. */
export async function installedAppiumDrivers(): Promise<Record<string, { installed?: boolean; version?: string }> | null> {
  if (driverCache && Date.now() - driverCache.at < 60_000) return driverCache.drivers;
  const appium = which('appium');
  if (!appium) return null;
  const r = await run(appium, ['driver', 'list', '--installed', '--json'], { timeoutMs: 60_000 });
  const text = r.stdout.trim() || r.stderr.trim();
  try {
    const drivers = JSON.parse(text.slice(text.indexOf('{')));
    driverCache = { at: Date.now(), drivers };
    return drivers;
  } catch {
    return null;
  }
}

export function checkBinaryForPlatform(platform: Platform, app: string, deviceKind?: DeviceInfo['kind']): void {
  const lower = app.toLowerCase().split('?')[0];
  if (platform === 'android' && /\.(ipa|app|app\.zip)$/.test(lower)) {
    throw new InspectorError('WRONG_PLATFORM_BINARY', `${app} is an iOS build and cannot be installed on Android.`, {
      platform, hint: 'Provide the Android build of the app (.apk or .aab).',
    });
  }
  if (platform === 'ios' && /\.(apk|aab)$/.test(lower)) {
    throw new InspectorError('WRONG_PLATFORM_BINARY', `${app} is an Android build and cannot be installed on iOS.`, {
      platform, hint: 'Provide the iOS build (.ipa for devices, .app/.app.zip built for the simulator).',
    });
  }
  if (platform === 'ios' && deviceKind === 'simulator' && lower.endsWith('.ipa')) {
    throw new InspectorError('WRONG_PLATFORM_BINARY', `${app} is a device (.ipa) build; simulators need a simulator .app build.`, {
      platform, hint: 'Build the app for the iphonesimulator SDK and provide the .app (or zipped .app).',
    });
  }
}

export function commonCapabilities(req: SessionRequest): Record<string, unknown> {
  const caps: Record<string, unknown> = {
    'appium:udid': req.udid,
    'appium:newCommandTimeout': 600,
    'appium:noReset': req.noReset ?? true,
  };
  if (req.deviceName) caps['appium:deviceName'] = req.deviceName;
  if (req.platformVersion) caps['appium:platformVersion'] = req.platformVersion;
  if (req.app) caps['appium:app'] = req.app;
  return caps;
}

export function issue(code: ConstructorParameters<typeof InspectorError>[0], message: string, platform: Platform, hint?: string) {
  return new InspectorError(code, message, { platform, hint }).toJSON();
}
