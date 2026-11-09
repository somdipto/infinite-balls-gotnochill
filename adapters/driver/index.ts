import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import type { BrowserContext, Locator, Page } from 'playwright';
import { atomicWrite } from '../../skill/files.js';
import { acquireProfile } from './profile.js';
import { createOriginProxy } from './origin-proxy.js';
import type { OriginProxy } from './origin-proxy.js';
import type { Driver, DriverOptions } from './types.js';

export type { Driver, DriverOptions } from './types.js';
export type DriverKind = 'computer-use' | 'playwright';

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function originsFrom(options: DriverOptions): Set<string> {
  if (options.allowedOrigins.length === 0) throw new Error('At least one allowed browser origin is required.');
  return new Set(options.allowedOrigins.map((value) => {
    const parsed = new URL(value);
    const origin = originOf(value);
    if (origin === undefined || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('Allowed origins must be HTTP(S) origins without credentials, paths, queries, or fragments.');
    }
    return origin;
  }));
}

function milliseconds(value: number | undefined, fallback: number, name: string, minimum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > 120_000) {
    throw new Error(`${name} must be an integer between ${minimum} and 120000 milliseconds.`);
  }
  return result;
}

// This is deterministic coordinate-based browser control, not a model-backed vision agent.
// DOM locators find targets; the computer-use backend acts with actual mouse/keyboard APIs.
export async function createDriver(kind: DriverKind, options: DriverOptions): Promise<Driver> {
  if (kind !== 'computer-use' && kind !== 'playwright') throw new Error('Unknown browser driver kind.');
  const origins = originsFrom(options);
  const timeoutMs = milliseconds(options.timeoutMs, 15_000, 'timeoutMs', 1);
  const paceMs = milliseconds(options.paceMs, 80, 'paceMs', 0);
  const profile = await acquireProfile(options.profilePath);
  let context: BrowserContext;
  let proxy: OriginProxy | undefined;
  try {
    proxy = await createOriginProxy(origins);
    context = await chromium.launchPersistentContext(profile.path, {
      headless: options.headless ?? true,
      viewport: { width: 1100, height: 760 },
      acceptDownloads: false,
      serviceWorkers: 'block',
      proxy: { server: proxy.server, bypass: '<-loopback>' },
      // Avoid cross-origin HTTP/2 connection coalescing inside HTTPS CONNECT
      // tunnels and prevent non-proxied UDP transports; these are not stealth.
      args: ['--disable-http2', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
  } catch (cause) {
    try {
      await proxy?.close();
    } finally {
      await profile.release();
    }
    throw new Error('Unable to launch owned Chromium. Install it with: npx playwright install chromium', { cause });
  }

  let closed = false;
  let violation: string | undefined;
  const rejectOrigin = (): void => {
    violation ??= 'Browser origin policy blocked a request or navigation outside allowedOrigins.';
  };
  const allowed = (url: string): boolean => {
    const origin = originOf(url);
    return origin !== undefined && origins.has(origin);
  };

  try {
    context.setDefaultTimeout(timeoutMs);
    context.setDefaultNavigationTimeout(timeoutMs);
    // Reject ordinary page traffic here for immediate errors. The owned proxy
    // independently blocks redirect hops, which Playwright routing skips.
    await context.route('**/*', async (route) => {
      if (!allowed(route.request().url())) {
        rejectOrigin();
        await route.abort('blockedbyclient');
      } else {
        await route.continue();
      }
    });
    await context.routeWebSocket('**/*', (route) => {
      violation ??= 'Browser WebSockets are unsupported by the origin-restricted driver.';
      route.close({ code: 1008, reason: 'WebSockets unsupported' });
    });
    const page: Page = context.pages()[0] ?? await context.newPage();
    for (const extra of context.pages()) {
      if (extra !== page) await extra.close();
    }
    context.on('request', (request) => {
      if (!allowed(request.url())) rejectOrigin();
    });
    context.on('page', (popup) => {
      violation ??= 'Unexpected popup blocked; this driver controls only its own primary page.';
      void popup.close().catch(() => undefined);
    });
    page.on('framenavigated', (frame) => {
      if (!allowed(frame.url()) && frame.url() !== 'about:blank') {
        rejectOrigin();
        void page.close().catch(() => undefined);
      }
    });

    const assertReady = (requireDocument = true): void => {
      if (closed) throw new Error('Browser driver is closed.');
      if (violation !== undefined) throw new Error(violation);
      if (page.isClosed()) throw new Error('Owned browser page has been closed.');
      if (requireDocument && !allowed(page.url())) throw new Error('Navigate to an allowed HTTP(S) origin first.');
    };
    const settle = async (): Promise<void> => {
      if (paceMs > 0) await delay(paceMs);
      assertReady();
    };
    const target = async (selector: string): Promise<Locator> => {
      assertReady();
      const locator = page.locator(selector);
      await locator.waitFor({ state: 'visible' });
      if (await locator.count() !== 1) throw new Error('Browser target must match exactly one visible element.');
      return locator;
    };
    const coordinateClick = async (locator: Locator): Promise<void> => {
      if (!await locator.isEnabled()) throw new Error('Cannot click a disabled browser target.');
      await locator.scrollIntoViewIfNeeded();
      const bounds = await locator.boundingBox();
      if (bounds === null || bounds.width <= 0 || bounds.height <= 0) throw new Error('Browser target has no clickable bounds.');
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      const unobstructed = await locator.evaluate((element, point) => {
        const hit = element.ownerDocument.elementFromPoint(point.x, point.y);
        return hit !== null && (hit === element || element.contains(hit));
      }, { x, y });
      if (!unobstructed) throw new Error('Browser target is obscured; refusing to click a different element.');
      assertReady();
      await page.mouse.move(x, y, { steps: 6 });
      await page.mouse.click(x, y, { delay: Math.min(paceMs, 75) });
    };
    const perform = async <T>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (cause) {
        if (violation !== undefined) throw new Error(violation);
        // Playwright error messages can include filled values and page snippets. Keep
        // credential-bearing input and DOM text out of this driver's public errors.
        if (cause instanceof Error && cause.message.startsWith('Browser ')) throw cause;
        throw new Error(`Browser ${kind} action failed; check the selector, page state, and timeout.`);
      }
    };

    return {
      async goto(url): Promise<void> {
        assertReady(false);
        if (!allowed(url)) throw new Error('Browser navigation URL is outside allowedOrigins or contains credentials.');
        await perform(async () => {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await settle();
        });
      },
      async fill(selector, value): Promise<void> {
        await perform(async () => {
          const locator = await target(selector);
          if (kind === 'playwright') {
            await locator.fill(value);
          } else {
            if (!await locator.isEditable()) throw new Error('Browser target is not editable.');
            await coordinateClick(locator);
            await page.keyboard.press('ControlOrMeta+A');
            await page.keyboard.press('Backspace');
            await page.keyboard.type(value, { delay: Math.min(paceMs, 100) });
          }
          await settle();
        });
      },
      async click(selector): Promise<void> {
        await perform(async () => {
          const locator = await target(selector);
          if (kind === 'playwright') await locator.click();
          else await coordinateClick(locator);
          await settle();
        });
      },
      async read(selector): Promise<string> {
        return perform(async () => {
          const locator = await target(selector);
          const text = await locator.innerText();
          assertReady();
          return text;
        });
      },
      async screenshot(path): Promise<string> {
        return perform(async () => {
          assertReady();
          const hostname = new URL(page.url()).hostname;
          if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
            throw new Error('Browser screenshots are restricted to local fixture/nonsecret surfaces.');
          }
          const destination = resolve(path);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          const image = await page.screenshot({
            type: 'png',
            fullPage: true,
            // Never record credential/form values even on local pages.
            mask: [page.locator('input, textarea, [contenteditable]')],
          });
          assertReady();
          await atomicWrite(destination, image);
          return destination;
        });
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          await context.close();
        } finally {
          try {
            await proxy?.close();
          } finally {
            await profile.release();
          }
        }
      },
    };
  } catch (error) {
    try {
      await context.close();
    } finally {
      try {
        await proxy?.close();
      } finally {
        await profile.release();
      }
    }
    throw error;
  }
}
