import { InspectorError } from '../core/errors.ts';
import type { Platform } from '../core/types.ts';
import { AndroidAdapter } from './android.ts';
import type { PlatformAdapter } from './common.ts';
import { IosAdapter } from './ios.ts';

const adapters: Record<Platform, PlatformAdapter> = { android: new AndroidAdapter(), ios: new IosAdapter() };

export function adapterFor(platform: string): PlatformAdapter {
  if (platform !== 'android' && platform !== 'ios') {
    throw new InspectorError('INVALID_INPUT', `Unknown platform "${platform}". Expected "android" or "ios".`);
  }
  return adapters[platform];
}

export function assertPlatform(p: unknown): Platform {
  return adapterFor(String(p)).platform;
}

export { AndroidAdapter, IosAdapter };
export type { PlatformAdapter };
