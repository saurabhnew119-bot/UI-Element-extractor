import type { Platform } from './types.ts';

export type ErrorCode =
  // host / tooling
  | 'APPIUM_UNREACHABLE'
  | 'DRIVER_NOT_INSTALLED'
  | 'TOOL_NOT_FOUND'
  // android
  | 'ADB_NOT_FOUND'
  | 'ANDROID_SDK_MISSING'
  | 'ANDROID_DEVICE_UNAUTHORIZED'
  | 'ANDROID_DEVICE_OFFLINE'
  | 'ANDROID_INSTALL_FAILED'
  | 'ANDROID_APP_NOT_FOUND'
  // ios
  | 'IOS_REQUIRES_MACOS'
  | 'XCODE_NOT_FOUND'
  | 'IOS_SIGNING_FAILED'
  | 'IOS_PROVISIONING_PROFILE'
  | 'IOS_DEVICE_NOT_TRUSTED'
  | 'IOS_DEVELOPER_MODE_DISABLED'
  | 'IOS_WDA_FAILED'
  | 'IOS_APP_NOT_FOUND'
  // shared
  | 'WRONG_PLATFORM_BINARY'
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_BUSY'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CREATE_FAILED'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_ACCESSIBLE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INVALID_INPUT'
  | 'CONFIG_ERROR'
  | 'WEBDRIVER_ERROR';

/**
 * Every failure surfaced to the user goes through this type so that missing devices, signing problems
 * and unsupported capabilities are reported explicitly instead of turning into empty or invented results.
 */
export class InspectorError extends Error {
  readonly code: ErrorCode;
  readonly platform: Platform | null;
  readonly hint: string | null;
  readonly detail: string | null;

  constructor(code: ErrorCode, message: string, opts: { platform?: Platform | null; hint?: string; detail?: string } = {}) {
    super(message);
    this.name = 'InspectorError';
    this.code = code;
    this.platform = opts.platform ?? null;
    this.hint = opts.hint ?? null;
    this.detail = opts.detail ?? null;
  }

  toJSON() {
    return { code: this.code, platform: this.platform, message: this.message, hint: this.hint, detail: this.detail };
  }
}

export function toInspectorError(err: unknown, platform: Platform | null = null): InspectorError {
  if (err instanceof InspectorError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new InspectorError('WEBDRIVER_ERROR', message, { platform });
}
