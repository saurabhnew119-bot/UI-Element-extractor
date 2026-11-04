import { InspectorError } from './errors.ts';
import type { LocatorStrategy, Rect } from './types.ts';

const ELEMENT_KEY = 'element-6066-11e4-a23c-4b9b0c3c3e7a';

export class WebDriverRequestError extends Error {
  readonly status: number;
  readonly wdError: string;
  constructor(status: number, wdError: string, message: string) {
    super(message);
    this.status = status;
    this.wdError = wdError;
  }
}

/** Thin W3C WebDriver client for an Appium 2/3 server. One instance per Appium server URL. */
export class WebDriverClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new InspectorError('APPIUM_UNREACHABLE', `Cannot reach Appium at ${this.baseUrl}: ${(e as Error).message}`, {
        hint: 'Start Appium with `appium` (default http://127.0.0.1:4723) or set the correct server URL.',
      });
    }
    const text = await res.text();
    let json: { value?: unknown } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new WebDriverRequestError(res.status, 'invalid response', `Non-JSON response from Appium (${res.status}): ${text.slice(0, 300)}`);
    }
    const value = json.value as { error?: string; message?: string } | undefined;
    if (!res.ok || (value && typeof value === 'object' && 'error' in value && value.error)) {
      throw new WebDriverRequestError(res.status, value?.error ?? 'unknown error', value?.message ?? text.slice(0, 500));
    }
    return json.value as T;
  }

  status() {
    return this.request<{ ready?: boolean; build?: { version?: string } }>('GET', '/status', undefined, 5000);
  }

  async createSession(capabilities: Record<string, unknown>): Promise<{ sessionId: string; capabilities: Record<string, unknown> }> {
    // Session creation can take minutes on iOS real devices while WebDriverAgent is built and signed.
    return this.request('POST', '/session', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, 15 * 60_000);
  }

  deleteSession(sid: string) {
    return this.request<null>('DELETE', `/session/${sid}`);
  }

  pageSource(sid: string) {
    return this.request<string>('GET', `/session/${sid}/source`);
  }

  screenshot(sid: string) {
    return this.request<string>('GET', `/session/${sid}/screenshot`);
  }

  windowRect(sid: string) {
    return this.request<Rect>('GET', `/session/${sid}/window/rect`);
  }

  async findElements(sid: string, using: LocatorStrategy, value: string): Promise<string[]> {
    const els = await this.request<Record<string, string>[]>('POST', `/session/${sid}/elements`, { using, value });
    return els.map((e) => e[ELEMENT_KEY] ?? e.ELEMENT);
  }

  click(sid: string, elementId: string) {
    return this.request<null>('POST', `/session/${sid}/element/${elementId}/click`, {});
  }

  sendKeys(sid: string, elementId: string, text: string) {
    return this.request<null>('POST', `/session/${sid}/element/${elementId}/value`, { text });
  }

  clear(sid: string, elementId: string) {
    return this.request<null>('POST', `/session/${sid}/element/${elementId}/clear`, {});
  }

  elementText(sid: string, elementId: string) {
    return this.request<string>('GET', `/session/${sid}/element/${elementId}/text`);
  }

  elementDisplayed(sid: string, elementId: string) {
    return this.request<boolean>('GET', `/session/${sid}/element/${elementId}/displayed`);
  }

  back(sid: string) {
    return this.request<null>('POST', `/session/${sid}/back`, {});
  }

  contexts(sid: string) {
    return this.request<string[]>('GET', `/session/${sid}/contexts`);
  }

  currentContext(sid: string) {
    return this.request<string>('GET', `/session/${sid}/context`);
  }

  setContext(sid: string, name: string) {
    return this.request<null>('POST', `/session/${sid}/context`, { name });
  }

  execute(sid: string, script: string, args: unknown[] = []) {
    return this.request<unknown>('POST', `/session/${sid}/execute/sync`, { script, args });
  }
}
