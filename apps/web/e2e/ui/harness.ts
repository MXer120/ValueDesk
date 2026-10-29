/**
 * What every UI spec shares: one Edge per spec file, a fresh context per test,
 * the test wallet, the welcome gate, and waits that poll (playwright-core has no
 * `expect`).
 *
 * A spec file:
 *   const h = uiSuite();
 *   h.test('Market hides the price box', async ({ page }) => { ... });
 *
 * The runner (run.ts) hands the settings over in the environment:
 *   VS_E2E_UI_WEB      the dev web's origin (run.ts found it)
 *   VS_E2E_UI_LIVE     '1': the wallet is VS_E2E_KEY and live-only tests run
 *   VS_E2E_UI_HEADED   '1': show the browser;  VS_E2E_UI_SLOWMO  ms per action
 * Run on its own (`node --import tsx --test e2e/ui/x.spec.ts`) a spec finds the
 * dev web itself and uses a throwaway wallet.
 *
 * A failed test leaves a screenshot and the page's console errors in
 * e2e/ui/.out/<file>--<test>.png / .log.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { after, before, test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { findDevWeb, launchEdge } from './browser';
import { createTestWallet, type TestWallet } from './wallet';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '.out');

export const LIVE = process.env.VS_E2E_UI_LIVE === '1';
const HEADED = process.env.VS_E2E_UI_HEADED === '1';
const SLOWMO = Number(process.env.VS_E2E_UI_SLOWMO) || undefined;

export interface OpenOptions {
  /** Connect the test wallet through the app's own Connect dialog (default false). */
  connect?: boolean;
  /** Accept the welcome gate with "Only necessary" (default true). */
  welcome?: boolean;
  /** localStorage set before the app's first script runs. */
  storage?: Record<string, string>;
  /** Before the first navigation: routes, init scripts. */
  setup?: (ctx: BrowserContext, page: Page) => Promise<void>;
}

export interface TestEnv {
  origin: string;
  ctx: BrowserContext;
  page: Page;
  wallet: TestWallet;
  /** Console errors and uncaught page errors seen so far. */
  errors: string[];
  /** Open another path of the app in this context (a new page with the same wallet and storage). */
  open(path: string, o?: Omit<OpenOptions, 'setup'>): Promise<Page>;
  /** Mark the test skipped from inside it (what it needs turned out not to be there); return right after. */
  skip(reason: string): void;
}

export interface UiTestOptions {
  /** Only with --live (VS_E2E_KEY, a funded wallet). Skipped otherwise, with this reason. */
  live?: string;
  /** Only with the throwaway wallet (no funds). Skipped under --live, with this reason. */
  throwaway?: string;
  timeout?: number;
}

/**
 * esbuild (tsx) wraps named functions in `__name(fn, "name")`; a function handed to
 * the page keeps that call, and the page has no `__name`. Defined first in every page.
 */
const NAME_SHIM = 'globalThis.__name = globalThis.__name || ((f) => f);';

export function uiSuite(file = process.argv[1] ?? 'spec') {
  let browser: Browser | null = null;
  let origin = '';
  const stem = basename(file).replace(/\.spec\.ts$/, '');

  before(async () => {
    origin = process.env.VS_E2E_UI_WEB?.trim() || (await findDevWeb());
    browser = await launchEdge({ headed: HEADED, slowMo: SLOWMO });
  });
  after(async () => {
    await browser?.close();
    const total = [...internet.values()].reduce((a, b) => a + b, 0);
    const top = [...internet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h, n]) => `${h} ${(n / 1e6).toFixed(1)} MB`);
    console.log(`ui-e2e: ${stem}: ${(total / 1e6).toFixed(1)} MB from the internet (${top.join(', ') || 'none'})`);
  });

  /** Bytes each page received from hosts other than this machine: responses and WebSocket frames, by host. */
  const internet = new Map<string, number>();
  async function meter(p: Page): Promise<void> {
    const local = (u: string) => /^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(u) || /^(data|blob|chrome|edge|about):/.test(u);
    const host = (u: string) => {
      try {
        return new URL(u).host;
      } catch {
        return '?';
      }
    };
    const add = (u: string | undefined, n: number) => {
      if (!u || local(u) || !(n > 0)) return;
      internet.set(host(u), (internet.get(host(u)) ?? 0) + n);
    };
    try {
      const cdp = await p.context().newCDPSession(p);
      const urls = new Map<string, string>();
      cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
      cdp.on('Network.loadingFinished', (e) => add(urls.get(e.requestId), e.encodedDataLength));
      cdp.on('Network.webSocketCreated', (e) => urls.set(e.requestId, e.url));
      cdp.on('Network.webSocketFrameReceived', (e) => add(urls.get(e.requestId), e.response.payloadData.length));
      await cdp.send('Network.enable');
    } catch {
      /* metering is best-effort */
    }
  }

  async function newEnv(path: string, o: OpenOptions): Promise<TestEnv> {
    if (!browser) throw new Error('the browser did not start');
    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'dark',
      serviceWorkers: 'block',
    });
    ctx.setDefaultTimeout(15_000);
    await ctx.addInitScript({ content: NAME_SHIM });
    // Vite's HMR socket answered here and never forwarded: other sessions editing the shared dev
    // tree must not hot-swap modules (or remount the app) under a running test.
    await ctx.routeWebSocket(
      (u) => u.pathname === '/' && u.searchParams.has('token'),
      (ws) => {
        ws.send(JSON.stringify({ type: 'connected' }));
        ws.onMessage(() => {});
      },
    );
    const key = LIVE ? process.env.VS_E2E_KEY?.trim() : undefined;
    if (LIVE && !key) throw new Error('--live needs VS_E2E_KEY');
    const wallet = createTestWallet({ privateKey: key });
    await wallet.install(ctx);
    const errors: string[] = [];
    const watch = (p: Page) => {
      p.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 400)}`);
      });
      p.on('pageerror', (e) => errors.push(`pageerror: ${String(e?.message ?? e).slice(0, 400)}`));
    };
    const page = await ctx.newPage();
    watch(page);
    ctx.on('page', watch);
    await meter(page);
    ctx.on('page', (p) => void meter(p));
    {
      const seed = { 'vs.numberFormat': NUM_STYLE, ...o.storage };
      await ctx.addInitScript((s: Record<string, string>) => {
        // Only on the first load of each origin: a later reload keeps what the app wrote.
        if (sessionStorage.getItem('vs.e2e.seeded')) return;
        sessionStorage.setItem('vs.e2e.seeded', '1');
        for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
      }, seed);
    }
    await o.setup?.(ctx, page);
    const env: TestEnv = {
      origin,
      ctx,
      page,
      wallet,
      errors,
      async open(p, oo = {}) {
        const pg = await ctx.newPage();
        await goto(pg, origin, p, oo);
        return pg;
      },
      skip: () => {},
    };
    await goto(page, origin, path, o);
    return env;
  }

  async function goto(page: Page, at: string, path: string, o: Omit<OpenOptions, 'setup'>): Promise<void> {
    await page.goto(at + path, { waitUntil: 'domcontentloaded' });
    if (o.welcome !== false) await acceptWelcome(page);
    await hideDevPanel(page);
    if (o.connect) await connectWallet(page);
  }

  /** One test: a fresh context on `path` (default /trade), closed afterwards; a failure leaves a screenshot. */
  function test(name: string, fn: (env: TestEnv) => Promise<void>, o: UiTestOptions & OpenOptions & { path?: string } = {}): void {
    const skip = o.live && !LIVE ? `live only (--live): ${o.live}` : o.throwaway && LIVE ? `throwaway wallet only: ${o.throwaway}` : false;
    nodeTest(name, { skip, timeout: o.timeout ?? 90_000 }, async (t) => {
      const env = await newEnv(o.path ?? '/trade', o);
      env.skip = (reason) => t.skip(reason);
      try {
        await fn(env);
      } catch (e) {
        try {
          mkdirSync(OUT, { recursive: true });
          const slug = `${stem}--${name}`.replace(/[^a-z0-9]+/gi, '-').slice(0, 120);
          await env.page.screenshot({ path: join(OUT, `${slug}.png`) }).catch(() => {});
          writeFileSync(join(OUT, `${slug}.log`), [`url: ${env.page.url()}`, ...env.errors].join('\n'));
        } catch {
          /* the failure itself matters more than its screenshot */
        }
        throw e;
      } finally {
        await env.ctx.close().catch(() => {});
      }
    });
  }

  return { test, get origin() { return origin; } };
}

/* ------------------------------------------------------------------ the app's gates ----- */

/** The welcome gate (legal/LegalGate.tsx): tick the confirmation, "Only necessary". A no-op when it is not up. */
export async function acceptWelcome(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Welcome to ValueDesk' });
  try {
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    return;
  }
  await dialog.getByRole('checkbox', { name: /^I confirm that/ }).check();
  await dialog.getByRole('button', { name: 'Only necessary' }).click();
  await dialog.waitFor({ state: 'hidden' });
}

/** The dev build's Developer dock (components/dev/DevPanel.tsx) folded to its chip: it floats over the page's left half. */
export async function hideDevPanel(page: Page): Promise<void> {
  const hide = page.getByRole('complementary', { name: 'Developer' }).getByRole('button', { name: 'Hide', exact: true });
  try {
    await hide.waitFor({ state: 'visible', timeout: 5_000 });
    await hide.click();
  } catch {
    /* not shown */
  }
}

/**
 * Connect > "MetaMask Installed": the extension route (walletconnect.ts connectVia),
 * answered by the test wallet. Then "Explore while we set up" on the setup sheet.
 */
export async function connectWallet(page: Page): Promise<void> {
  const rail = page.getByRole('complementary', { name: 'Tools' });
  await rail.getByRole('button', { name: 'Connect wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect' });
  await dialog.waitFor({ state: 'visible' });
  // The test wallet announced itself over EIP-6963 as io.metamask: the row says so.
  await dialog.getByRole('button', { name: 'MetaMask Installed' }).click();
  await rail.getByRole('button', { name: /^Wallet / }).waitFor({ state: 'visible', timeout: 30_000 });
  await dismissSetup(page);
}

/** The "Setting up your account" sheet a first connect opens: "Explore while we set up". A no-op when it is not up. */
export async function dismissSetup(page: Page, waitMs = 5_000): Promise<void> {
  const setup = page.getByRole('dialog', { name: 'Setting up your account' });
  try {
    await setup.waitFor({ state: 'visible', timeout: waitMs });
  } catch {
    return;
  }
  await setup.getByRole('button', { name: 'Explore while we set up' }).click();
  await setup.waitFor({ state: 'hidden' });
}

/* ------------------------------------------------------------------ waits ----- */

/** Poll `cond` until it holds (or throw `what` after `ms`). */
export async function until(page: Page, cond: () => Promise<boolean> | boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    try {
      if (await cond()) return;
      last = null;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}${last ? ` (last error: ${String((last as Error)?.message ?? last)})` : ''}`);
    await page.waitForTimeout(100);
  }
}

/** Wait until the locator's value (inputs) or text matches. Returns it. */
export async function waitValue(loc: Locator, want: RegExp | ((v: string) => boolean), what = 'a value', ms = 10_000): Promise<string> {
  const test = typeof want === 'function' ? want : (v: string) => want.test(v);
  let v = '';
  const end = Date.now() + ms;
  for (;;) {
    try {
      v = await readValue(loc);
      if (test(v)) return v;
    } catch {
      /* not there yet */
    }
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what} (last: ${JSON.stringify(v)})`);
    await loc.page().waitForTimeout(100);
  }
}

/** An input's value, else the element's text. */
export async function readValue(loc: Locator): Promise<string> {
  return loc.evaluate((el) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? '')).trim());
}

/**
 * The app's number format in every spec context: its default, "." groups and "," marks
 * decimals (numStyle.ts 'dot-comma'), pinned so a change of default cannot shift a spec.
 */
export const NUM_STYLE = 'dot-comma';

/** "80.173,5" / "$1.234" / "-12,5%" -> number in the app's format (NaN when there is none). */
export function num(s: string): number {
  const m = s.replace(/[−–]/g, '-').replace(/[\s'’]/g, '').replace(/\./g, '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : Number.NaN;
}

/** A number as a person types it in the app's format: "0,01" (no grouping). */
export const dec = (n: number | string): string => String(n).replace('.', ',');

/** Fill an input the way a person types: clear, type, and let React see every key. */
export async function typeInto(loc: Locator, text: string): Promise<void> {
  await loc.click();
  await loc.press('Control+A');
  await loc.press('Backspace');
  if (text) await loc.pressSequentially(text, { delay: 15 });
}
