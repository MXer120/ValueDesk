/**
 * The live suite's browser target, its page: ValueDesk in the installed Microsoft Edge
 * on the local dev web, with the follower's wallet, driven through the test bridge
 * (window.__vsTest, src/testBridge.ts). apps/executor/tools/live-test/browserDriver.ts
 * loads this module (through tsx, with this app's tsconfig) and maps the executor's API
 * onto `call`; nothing here knows the suite's scenarios.
 *
 * THE SAME BROWSER AS THE UI SPECS. launchEdge (browser.ts: Edge as installed, never a
 * download), a context as every spec gets one (harness.ts newUiContext: Vite's HMR socket
 * answered here, so another session's edit cannot hot-swap a module under a run), and the
 * test wallet (wallet.ts) with its signing policy: the key stays in Node, the page sees
 * addresses and signatures only. The app's own gates are walked as a person walks them:
 * the welcome gate, Connect > MetaMask, ValueDesk's terms when a call opens their popup,
 * and (live) Enable trading on the order ticket - the one signature that registers the
 * trading key a live algo's children are signed with.
 *
 * THE PAGE GOES AWAY AND COMES BACK (leave, reopen), in the same profile (its storage, its
 * IndexedDB): 'reload' navigates the tab away and back, which the web app takes as a reload
 * (its algos go on: src/algo/tabLife.ts); 'close' closes the tab and opens a new one later,
 * which it takes as the tab closed once more than tabLife's 20 s went by.
 */
import type { BrowserContext, Page } from 'playwright-core';
import { TEST_BRIDGE_VERSION } from '../../src/testBridge';
import { launchEdge } from './browser';
import { acceptWelcome, connectWallet, hideDevPanel, newUiContext, until } from './harness';
import { ticket } from './ticket';
import { runUiStep } from './uiSteps';
import { createTestWallet, type WalletRecord } from './wallet';

export interface BridgeSessionOptions {
  /** The dev web (browser.ts findDevWeb). */
  origin: string;
  /** The wallet's private key, 0x and 64 hex digits: the follower's (a throwaway one for a dry run). It stays in Node. */
  privateKey: string;
  /** Live: trading is enabled in the page (a trading key registered on SoDEX), as Enable trading on the order ticket does. */
  live: boolean;
  headed?: boolean;
  log?: (line: string) => void;
  /** Where a failed step saves a screenshot of the page (none: no screenshot). */
  shotDir?: string;
}

export interface BridgeSession {
  /** The wallet's address, lower-case. */
  readonly address: string;
  /** One bridge call: `path` names it (`algos.start`, `about`). While it runs, ValueDesk's terms popup is signed if it opens. */
  call(path: string, args?: unknown[]): Promise<unknown>;
  /**
   * One step a person takes on the page (uiSteps.ts: the order ticket, the account tables, the copy
   * window, Manage copies, the copy prompt, the algo ticket, the Algos table), by name, with its args.
   * ValueDesk's terms popup is signed the same way if it opens meanwhile.
   */
  ui(step: string, args?: unknown): Promise<unknown>;
  /** The page is there and its bridge answers. */
  ready(): Promise<boolean>;
  /** The page goes away: 'reload' navigates the tab away (a reload's first half), 'close' closes the tab. */
  leave(how: 'reload' | 'close'): Promise<void>;
  /** The app open again after leave() (the same tab, or a new one), the wallet reconnected and the bridge answering. */
  reopen(): Promise<void>;
  /** Set when the browser went away on its own (Edge closed, the page crashed): why. */
  gone(): string | null;
  /** What the wallet signed, refused or was asked, in order. */
  walletLog(): WalletRecord[];
  /** The page's console errors and uncaught errors so far, the newest last. */
  errors(): string[];
  close(): Promise<void>;
}

/** The page's own words of a failed page.evaluate: "page.evaluate: Error: Held..." -> "Held...". */
export function pageError(e: unknown): string {
  const m = String((e as Error)?.message ?? e).replace(/^page\.evaluate:\s*/, '').replace(/^[A-Za-z]*Error:\s*/, '');
  return m.split(/\n\s+at /)[0]!.trim();
}

async function callIn(page: Page, path: string, args: unknown[]): Promise<unknown> {
  try {
    return await page.evaluate(async ([p, a]) => {
      const b = window.__vsTest;
      if (!b) throw new Error('this page has no window.__vsTest (it is not the dev server)');
      let self: unknown = b;
      let fn: unknown = b;
      for (const k of p.split('.')) {
        self = fn;
        fn = (fn as Record<string, unknown> | undefined)?.[k];
      }
      if (typeof fn !== 'function') throw new Error(`window.__vsTest.${p} is not a call of this bridge (version ${b.version})`);
      return (fn as (...x: unknown[]) => unknown).apply(self, a);
    }, [path, args] as const);
  } catch (e) {
    throw new Error(pageError(e));
  }
}

/** ValueDesk's own terms (legal/LegalGate.tsx), when a call opened their popup: confirmed, "Only necessary". */
async function signSiteTermsIfAsked(page: Page): Promise<boolean> {
  const site = page.getByRole('dialog', { name: 'Sign the terms to continue' });
  if (!(await site.isVisible().catch(() => false))) return false;
  await site.getByRole('checkbox', { name: /^I confirm that/ }).check();
  await site.getByRole('button', { name: 'Only necessary', exact: true }).click();
  await site.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  return true;
}

export async function openBridgeSession(o: BridgeSessionOptions): Promise<BridgeSession> {
  const log = o.log ?? (() => {});
  const wallet = createTestWallet({ privateKey: o.privateKey });
  const browser = await launchEdge({ headed: o.headed });
  let ctx: BrowserContext;
  try {
    ctx = await newUiContext(browser, wallet);
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
  let page: Page | null = null;
  let left = false;
  let closing = false;
  let lost: string | null = null;
  const errors: string[] = [];
  browser.on('disconnected', () => {
    if (!closing) lost = 'Edge closed';
  });
  ctx.on('page', (p) => {
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 400)}`);
    });
    p.on('pageerror', (e) => errors.push(`pageerror: ${String(e?.message ?? e).slice(0, 400)}`));
    p.on('crash', () => {
      if (!closing) lost = 'the page crashed';
    });
  });

  const about = async (p: Page) => (await callIn(p, 'about', [])) as { wallet: string | null; trading: { status: string } };

  /** The app at /trade, its bridge answering this checkout's version, the wallet connected, both runners following it. */
  async function load(first: boolean): Promise<void> {
    if (!page || page.isClosed()) page = await ctx.newPage();
    const p = page;
    await p.goto(`${o.origin}/trade`, { waitUntil: 'domcontentloaded' });
    if (first) {
      await acceptWelcome(p);
      await hideDevPanel(p);
      await connectWallet(p);
    }
    await until(p, async () => (await p.evaluate(() => window.__vsTest?.version ?? 0)) > 0, 'the test bridge (window.__vsTest) on the page', 30_000);
    const version = await p.evaluate(() => window.__vsTest!.version);
    if (version !== TEST_BRIDGE_VERSION) throw new Error(`the dev web's test bridge is version ${version}, this checkout's is ${TEST_BRIDGE_VERSION}: it serves another checkout, or an older one`);
    // A reload reconnects the wallet silently (walletconnect.ts) and the copier follows it (copy/live.ts setCopyWallet).
    await until(p, async () => (await about(p)).wallet === wallet.address && (await callIn(p, 'copier.owner', [])) === wallet.address, 'the wallet to be connected again', 30_000);
    await callIn(p, 'algos.follow', []);
    if (o.live && (await about(p)).trading.status !== 'enabled') await enableTrading(p);
  }

  /** Enable trading on the order ticket: one `trading-key` signature (and the builder approval, if the app asks for it). */
  async function enableTrading(p: Page): Promise<void> {
    const t = ticket(p);
    await t.g.waitFor({ state: 'visible', timeout: 30_000 });
    const enable = t.g.getByRole('button', { name: 'Enable trading' });
    await enable.waitFor({ state: 'visible', timeout: 30_000 });
    await enable.click();
    const seen = errors.length;
    try {
      // A fresh profile has not signed ValueDesk's terms: Enable trading asks for them first (requireTerms).
      let termsSigned = false;
      await until(p, async () => {
        if (!termsSigned && (await signSiteTermsIfAsked(p))) {
          termsSigned = true;
          log('ValueDesk\'s terms signed in the page');
          if (await enable.isVisible().catch(() => false)) await enable.click().catch(() => {});
        }
        return (await about(p)).trading.status === 'enabled';
      }, 'trading to be enabled in the page', 90_000);
    } catch (e) {
      // What the page said and what the wallet was asked: "timed out" alone does not say why.
      const said = errors.slice(seen).slice(-4).join(' | ') || 'no console error';
      const status = await about(p).then((a) => a.trading.status).catch(() => 'unreadable');
      const asked = wallet.log.slice(-3).map((r) => `${r.kind ?? r.method} ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`).join(', ') || 'nothing';
      const shot = o.shotDir ? `${o.shotDir}/enable-trading-${Date.now()}.png` : null;
      if (shot) await p.screenshot({ path: shot }).catch(() => {});
      const dialogs = await p.locator('[role="dialog"]').allInnerTexts().catch(() => [] as string[]);
      const open = dialogs.map((d) => d.replace(/\s+/g, ' ').slice(0, 160)).join(' || ') || 'no dialog open';
      throw new Error(`${String((e as Error)?.message ?? e)} - trading ${status}; page: ${said}; wallet asked: ${asked}; on screen: ${open}${shot ? `; screenshot ${shot}` : ''}`);
    }
    log('trading enabled in the page (its trading key registered on SoDEX by the wallet)');
  }

  const need = (): Page => {
    if (lost) throw new Error(lost);
    if (!page || page.isClosed() || left) throw new Error('the page is not open (it was left for a reload or a closed tab)');
    return page;
  };

  try {
    await load(true);
  } catch (e) {
    closing = true;
    await browser.close().catch(() => {});
    throw e;
  }

  /** Run `fn` on the page while ValueDesk's terms popup is signed whenever it opens. */
  async function withTerms<V>(fn: (p: Page) => Promise<V>): Promise<V> {
    const p = need();
    let running = true;
    const terms = (async () => {
      while (running) {
        if (await signSiteTermsIfAsked(p).catch(() => false)) log('signed ValueDesk\'s terms in their popup, as a person does');
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    try {
      return await fn(p);
    } finally {
      running = false;
      await terms;
    }
  }

  return {
    address: wallet.address,
    call: (path, args = []) => withTerms((p) => callIn(p, path, args)),
    async ui(step, args) {
      return withTerms(async (p) => {
        try {
          return await runUiStep(p, step, args);
        } catch (e) {
          // What was on screen, for the log: "timed out" alone does not say why.
          const shot = o.shotDir ? `${o.shotDir}/ui-${step.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}.png` : null;
          if (shot) await p.screenshot({ path: shot }).catch(() => {});
          throw new Error(`${String((e as Error)?.message ?? e).split('\n')[0]}${shot ? ` (screenshot ${shot})` : ''}`);
        }
      });
    },
    async ready() {
      if (lost || left || !page || page.isClosed()) return false;
      return page.evaluate(() => !!window.__vsTest).catch(() => false);
    },
    async leave(how) {
      const p = page;
      left = true;
      if (!p || p.isClosed()) return;
      if (how === 'close') {
        await p.close();
        page = null;
      } else await p.goto('about:blank');
    },
    async reopen() {
      if (lost) throw new Error(lost);
      await load(false);
      left = false;
    },
    gone: () => lost,
    walletLog: () => wallet.log.slice(),
    errors: () => errors.slice(),
    async close() {
      closing = true;
      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
