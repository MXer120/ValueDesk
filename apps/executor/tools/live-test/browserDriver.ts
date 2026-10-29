/**
 * THE BROWSER TARGET'S DRIVER (target.ts BrowserDriver): the web app's own runtime of
 * algos and copies (apps/web/src/algo/browserAlgos.ts, copy/browserCopier.ts) in a tab
 * of the installed Microsoft Edge, on the local dev web, with the follower's wallet.
 *
 * THE PAGE is apps/web/e2e/ui/bridgeSession.ts: the UI specs' Edge, context and test
 * wallet, and the test bridge (window.__vsTest, apps/web/src/testBridge.ts). It is
 * loaded here through tsx with the web app's tsconfig (its `@copy-engine` paths), so
 * nothing of apps/web is compiled with this folder's settings, and no browser code
 * lives in this folder. The follower's key goes to the test wallet in this process;
 * the page sees addresses and signatures only.
 *
 * THE MAPPING. Every call the scenarios make of an executor is answered from the page,
 * in the executor's shapes: an algo's or a copy's view is the engine's own (the same
 * runtime), the info and /me are put together from what the page runs with (its
 * `about`). Where a browser differs, it is said once, here:
 *   - no session and no executor id: nothing is signed for an executor;
 *   - the copy key is made in the page (copier.makeKey), registered by the follower's
 *     wallet as the harness registers an executor's key, and kept once SoDEX lists it
 *     (verifyKey); a key the follower made cannot be imported (keyImport: false);
 *   - its fees are no ladder: an algo's children carry the trading fee, a copy's orders
 *     the copy ladder's top step (browserCopier.ts), so its info lists those two, each
 *     "from $0": the fee checks accept exactly them;
 *   - a restart is a reload: the page goes away and comes back in the same profile
 *     (tabLife.ts keeps its algos running when that takes under 20 s); a closed tab is
 *     the same with a longer wait, after which the app stops them for good.
 *
 * THE DEV WEB must be running and serve this checkout (devWebFor): the runner refuses
 * to start otherwise and says how to start it.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  COPY_FEE_WINDOW_DAYS,
  parseSettings,
  type ActivityEntry,
  type AlgoEvent,
  type AlgoView,
  type CopyView,
  type ExecutorInfo,
  type KeyInfo,
  type MeResponse,
  type RegionPolicy,
} from '../../../../packages/copy-engine/src/index.ts';
import { Inconclusive, Unavailable } from './harness.ts';
import type { Mode } from './state.ts';
import type { BrowserDriver } from './target.ts';

/* -------------------------------------------------------- the page's answers ----- */

/** The page's `about` (testBridge.ts VsTestAbout), as far as the mapping reads it. */
export interface PageAbout {
  wallet: string | null;
  network: 'mainnet' | 'testnet';
  build: string;
  builder: { id: number; algoFee: number; copyFee: number } | null;
  brake: { trading: boolean; copies: boolean; algos: boolean; reason: string } | null;
  copyTerms: { version: string; hash: string };
  viewerCountry: string | null;
  policy: RegionPolicy;
  liveAlgos: boolean;
  trading: { status: string; owner: string | null; accountId: number | null };
  copyKey: { name: string; maxDays: number };
}

/** The copy terms the page holds (testBridge.ts VsTestTerms). */
export interface PageTerms {
  termsVersion: string;
  termsHash: string;
  country: string;
  acceptedAt: number;
  recorded: boolean;
}

/** The copy key in the page's vault (copier.key), or one verifyKey answered for. */
export interface PageKey {
  address: string;
  name: string;
  expiresAt: number | null;
  registered?: boolean;
}

/** The page as this driver uses it (bridgeSession.ts BridgeSession). */
export interface WebSession {
  readonly address: string;
  call(path: string, args?: unknown[]): Promise<unknown>;
  ready(): Promise<boolean>;
  leave(how: 'reload' | 'close'): Promise<void>;
  reopen(): Promise<void>;
  gone(): string | null;
  errors(): string[];
  close(): Promise<void>;
}

/** What the web app's algo gate says to a real algo it does not run (apps/web/src/algo/liveAlgos.ts LIVE_ALGOS_OFF). */
export const WEB_LIVE_ALGOS_OFF = /^Real algo orders are off for now\b/;

/* ---------------------------------------------------------------- the mapping ----- */

/**
 * The executor's /info of a browser. Its fees as two "steps from $0" (an algo child's trading
 * fee, a copy's top step): a browser reads no volume, so the ladder's other steps never apply.
 */
export function browserInfo(a: PageAbout, where: string): ExecutorInfo {
  const fees = a.builder ? [...new Set([a.builder.algoFee, a.builder.copyFee])].sort((x, y) => x - y) : [];
  const brake = a.brake && (a.brake.trading || a.brake.copies || a.brake.algos) ? { copies: a.brake.trading || a.brake.copies, algos: a.brake.trading || a.brake.algos, reason: a.brake.reason, since: null } : null;
  return {
    executorId: 'browser',
    // ExecutorInfo names an executor's kind; a browser is none of them: 'browser', as CopyMode calls it.
    kind: 'browser' as unknown as ExecutorInfo['kind'],
    version: a.build,
    network: a.network,
    location: where,
    open: true,
    owner: a.wallet,
    builder: a.builder ? { id: a.builder.id, ladder: fees.map((fee) => ({ fromUsd: 0, fee })), windowDays: COPY_FEE_WINDOW_DAYS } : null,
    termsVersion: a.copyTerms.version,
    viewerCountry: a.viewerCountry,
    keyTtlDaysMax: a.copyKey.maxDays,
    keyName: a.copyKey.name,
    // The browser runs this checkout's engine: counter-trades and size changes; no key import (its key is its own).
    features: ['counter', 'algo-update'],
    brake,
  };
}

/** A key as the executor reports one. `createdAt`: when this driver had the page make it (0: not made in this run). */
export function keyInfoOf(k: PageKey | null, createdAt: number): KeyInfo | null {
  return k ? { address: k.address, name: k.name, expiresAt: k.expiresAt, registered: k.registered ?? true, createdAt } : null;
}

/** /me of a browser: the copy terms it holds (with the country the page is seen in), its region rules, its key, its copies. */
export function browserMe(a: PageAbout, terms: PageTerms | null, key: KeyInfo | null, copies: CopyView[]): MeResponse {
  return {
    owner: a.wallet ?? '',
    terms: terms ? { termsVersion: terms.termsVersion, termsHash: terms.termsHash, country: terms.country, observedCountry: a.viewerCountry, acceptedAt: terms.acceptedAt } : null,
    policy: a.policy,
    key,
    copies,
  };
}

export function findAlgo(list: AlgoView[], id: string): AlgoView {
  const v = list.find((x) => x.algo.id === id);
  if (!v) throw new Error(`the browser does not list algo ${id}`);
  return v;
}

export function findCopy(list: CopyView[], id: string): CopyView {
  const v = list.find((x) => x.subscription.id === id);
  if (!v) throw new Error(`the browser does not list copy ${id}`);
  return v;
}

/**
 * A page's refusal that says the target cannot take this now - not a failure of the code under
 * test: a real algo the dev web does not let this wallet start is inconclusive (as hosted's
 * paper-only), with what to set.
 */
export function pageRefusal(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (WEB_LIVE_ALGOS_OFF.test(msg)) {
    return new Inconclusive('the dev web starts no real algo for this wallet: add the follower\'s address to VITE_LIVE_ALGOS_WALLETS in apps/web/.env.local and restart the dev web (README.md); it runs again next time');
  }
  return e instanceof Error ? e : new Error(msg);
}

/** The op of 'algo-action' as the bridge names it. */
const ALGO_OPS = { pause: 'algos.pause', resume: 'algos.resume', cancel: 'algos.cancel', 'cancel-all': 'algos.cancelAll' } as const;

/* ----------------------------------------------------------------- the driver ----- */

export interface WebDriverOptions {
  mode: Mode;
  /** The dev web's origin. */
  origin: string;
  /** The follower's address (lower-case): the page's wallet must be it. */
  follower: string;
  /** Opens the page (openWebSession; a test hands in its own). */
  session: () => Promise<WebSession>;
  log?: (line: string) => void;
  /** For the tests: the clock. */
  now?: () => number;
}

export class WebBridgeDriver implements BrowserDriver {
  private s: WebSession | null = null;
  private left = false;
  private leftAt = 0;
  private leftHow: 'reload' | 'close' = 'reload';
  private keyMadeAt = 0;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly o: WebDriverOptions) {
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
  }

  get where(): string {
    return `the web app's runtime in Microsoft Edge (${this.o.origin}, the test bridge)`;
  }

  private page(): WebSession {
    if (!this.s || this.left) throw new Error('the page is not open');
    return this.s;
  }

  private call<T>(path: string, args: unknown[] = []): Promise<T> {
    return this.page().call(path, args) as Promise<T>;
  }

  private about(): Promise<PageAbout> {
    return this.call<PageAbout>('about');
  }

  /* ---------------------------------------------------------- the page ----- */

  /** The page open with the follower's wallet (again, after leave), and what a run needs of it there. */
  async open(): Promise<void> {
    if (this.s && !this.left) return;
    if (!this.s) this.s = await this.o.session();
    else {
      // The app takes a page back within 20 s for a reload (tabLife.ts RELOAD_MS): the time away says which it saw.
      const away = this.now() - this.leftAt;
      await this.s.reopen();
      this.log(`    . the page was away ${(away / 1000).toFixed(1)} s, back ${((this.now() - this.leftAt) / 1000).toFixed(1)} s after it left (${this.leftHow})`);
    }
    this.left = false;
    const a = await this.about();
    if (a.wallet !== this.o.follower.toLowerCase()) throw new Error(`the page's wallet is ${a.wallet ?? 'none'}, not the follower ${this.o.follower}`);
    if (this.o.mode === 'live') {
      if (!a.builder) throw new Error('the dev web names no builder (VITE_BUILDER_ID in apps/web/.env.local): its orders would carry no builder fee, which a live run checks. Set the builder lines as deploy/vercel/production.settings has them, restart the dev web, and run again.');
      if (!a.liveAlgos) this.log('! the dev web starts no real algo for this wallet (VITE_LIVE_ALGOS_WALLETS): the algo scenarios are inconclusive, copies run');
    }
  }

  async leave(how: 'reload' | 'close'): Promise<void> {
    if (!this.s || this.left) return;
    this.left = true;
    await this.s.leave(how);
    this.leftAt = this.now();
    this.leftHow = how;
  }

  async close(): Promise<void> {
    const s = this.s;
    this.s = null;
    await s?.close();
  }

  async ready(): Promise<boolean> {
    return !!this.s && !this.left && (await this.s.ready());
  }

  gone(): string | null {
    return this.s?.gone() ?? null;
  }

  /** The country the page's ValueDesk executor sees it in, read where the page reads it (the dev web's /api/copy), page or not. */
  async viewerCountry(): Promise<string | null> {
    try {
      const r = await fetch(`${this.o.origin}/api/copy/v1/info`, { signal: AbortSignal.timeout(5_000) });
      if (!r.ok) return null;
      const c = ((await r.json()) as { viewerCountry?: unknown }).viewerCountry;
      return typeof c === 'string' && c ? c : null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------- the executor API ----- */

  async info(): Promise<ExecutorInfo> {
    return browserInfo(await this.about(), this.where);
  }

  async acceptTerms(country: string, termsHash: string): Promise<MeResponse> {
    const a = await this.about();
    if (a.copyTerms.hash !== termsHash) throw new Error(`the page shows other copy terms (${a.copyTerms.hash}) than this checkout (${termsHash}): the dev web serves another checkout`);
    await this.call('copier.acceptTerms', [country]);
    return this.me();
  }

  async me(): Promise<MeResponse> {
    const [a, terms, key, copies] = await Promise.all([this.about(), this.call<PageTerms | null>('copier.terms'), this.call<PageKey | null>('copier.key'), this.call<CopyView[]>('copier.list')]);
    return browserMe(a, terms, keyInfoOf(key, this.keyMadeAt), copies);
  }

  /** A browser has no session to sign in to (the fee scenarios' new session is the self target's). */
  async signIn(): Promise<void> {}

  /** The page makes the key (kept there until SoDEX lists it); the follower's wallet registers it, as for an executor's. */
  async createKey(days: number): Promise<{ address: string; name: string; maxDays: number; days: number }> {
    const [a, k] = await Promise.all([this.about(), this.call<{ address: string; name: string }>('copier.makeKey')]);
    this.keyMadeAt = this.now();
    return { address: k.address, name: k.name, maxDays: a.copyKey.maxDays, days: Math.max(1, Math.min(days, a.copyKey.maxDays)) };
  }

  async verifyKey(): Promise<MeResponse['key']> {
    return keyInfoOf(await this.call<PageKey | null>('copier.verifyKey'), this.keyMadeAt);
  }

  async importKey(): Promise<MeResponse['key']> {
    throw new Unavailable('a browser makes its own copy key: a key the follower made is not imported into it');
  }

  async algoStart(spec: Record<string, unknown>, seed?: number): Promise<AlgoView> {
    const id = await this.call<string>('algos.start', seed === undefined ? [spec] : [spec, seed]).catch((e) => {
      throw pageRefusal(e);
    });
    // The runner publishes its views as it adds one: listed at once, or after a beat.
    for (let i = 0; ; i++) {
      const list = await this.algos();
      if (list.some((v) => v.algo.id === id) || i >= 20) return findAlgo(list, id);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async algoAct(op: 'pause' | 'resume' | 'cancel' | 'cancel-all', id?: string): Promise<AlgoView[]> {
    await this.call(ALGO_OPS[op], op === 'cancel-all' ? [] : [id]);
    return this.algos();
  }

  async algoUpdate(id: string, patch: Record<string, unknown>): Promise<AlgoView[]> {
    await this.call('algos.update', [id, patch]).catch((e) => {
      throw pageRefusal(e);
    });
    return this.algos();
  }

  algos(): Promise<AlgoView[]> {
    return this.call<AlgoView[]>('algos.list');
  }

  async algo(id: string): Promise<AlgoView> {
    return findAlgo(await this.algos(), id);
  }

  events(id: string, limit = 200): Promise<AlgoEvent[]> {
    return this.call<AlgoEvent[]>('algos.events', [id, limit]);
  }

  /** The rules as the executor reads them (parseSettings: defaults filled, a bad field refused), then started in the page. */
  async subscribe(settings: Record<string, unknown>): Promise<CopyView> {
    const id = await this.call<string>('copier.start', [parseSettings(settings)]);
    return this.copy(id);
  }

  async copyAct(action: 'update' | 'pause' | 'resume' | 'stop' | 'stop-all', payload: Record<string, unknown>): Promise<CopyView[]> {
    const id = typeof payload.id === 'string' ? payload.id : '';
    const close = payload.close === true;
    if (action === 'update') await this.call('copier.update', [id, parseSettings(payload.settings)]);
    else if (action === 'pause' || action === 'resume') await this.call(`copier.${action}`, [id]);
    else if (action === 'stop') await this.call('copier.stop', [id, close]);
    else await this.call('copier.stopAll', [close]);
    return this.call<CopyView[]>('copier.list');
  }

  async copy(id: string): Promise<CopyView> {
    return findCopy(await this.call<CopyView[]>('copier.list'), id);
  }

  activity(id: string, limit = 200): Promise<ActivityEntry[]> {
    return this.call<ActivityEntry[]>('copier.events', [id, limit]);
  }

  /** The kill switch for algos, every copy stopped and closed: what the page has (nothing, when it is not open). */
  async stopEverything(): Promise<void> {
    if (!(await this.ready())) return;
    await this.call('algos.cancelAll').catch((e) => this.log(`  ! the page's kill switch: ${e instanceof Error ? e.message : String(e)}`));
    await this.call('copier.stopAll', [true]).catch(() => undefined);
  }
}

/* ------------------------------------------------------- the dev web, the page ----- */

const webDir = (repo: string) => join(repo, 'apps', 'web');

/** A module of apps/web, through tsx with the web app's tsconfig (its path aliases), in its own namespace. */
async function webModule<T>(repo: string, rel: string): Promise<T> {
  const { tsImport } = (await import('tsx/esm/api')) as { tsImport: (spec: string, o: { parentURL: string; tsconfig: string }) => Promise<unknown> };
  return (await tsImport(pathToFileURL(join(webDir(repo), rel)).href, { parentURL: import.meta.url, tsconfig: join(webDir(repo), 'tsconfig.json') })) as T;
}

/** How to start the dev web, for the refusal. */
export const START_DEV_WEB = 'Start it first: in the Claude app the preview "valuescan-web" (.claude/launch.json), or `npm run dev` in apps/web (it serves http://127.0.0.1:5180); --web <origin> names another one.';

/**
 * The module path the dev web serves the engine under (Vite: /@fs/ and the absolute path) holds
 * this checkout's folder: it runs this checkout's web app, which the hash a pass is tied to covers.
 */
export function servesCheckout(moduleSource: string, repo: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const m = /from\s+"\/@fs\/([^"?]+)\/packages\/copy-engine\/src\/index\.ts/.exec(moduleSource);
  return !!m && norm(m[1]!) === norm(repo);
}

/** The dev web to run in: `explicit` (--web), else VS_E2E_WEB, else the first local Vite port serving ValueDesk (browser.ts); refused, saying how to start it, when there is none or it serves another checkout. */
export async function devWebFor(repo: string, explicit?: string | null): Promise<string> {
  const { findDevWeb } = await webModule<{ findDevWeb: (explicit?: string) => Promise<string> }>(repo, 'e2e/ui/browser.ts');
  let origin: string;
  try {
    origin = await findDevWeb(explicit?.trim() || process.env.VS_E2E_WEB?.trim() || undefined);
  } catch (e) {
    throw new Error(`The browser target runs in the local dev web, and none answers (${e instanceof Error ? e.message : String(e)}).\n${START_DEV_WEB}`);
  }
  let source = '';
  try {
    const r = await fetch(`${origin}/src/algo/browserAlgos.ts`, { signal: AbortSignal.timeout(10_000) });
    source = r.ok ? await r.text() : '';
  } catch {
    source = '';
  }
  if (!servesCheckout(source, repo)) throw new Error(`${origin} does not serve this checkout's web app (${repo}): start this checkout's dev web, or name it with --web. ${START_DEV_WEB}`);
  return origin;
}

/** The page: Edge on the dev web with the follower's wallet (apps/web/e2e/ui/bridgeSession.ts). The key stays in this process. */
export async function openWebSession(repo: string, o: { origin: string; privateKey: string; live: boolean; headed?: boolean; log?: (line: string) => void }): Promise<WebSession> {
  const { openBridgeSession } = await webModule<{ openBridgeSession: (x: typeof o) => Promise<WebSession> }>(repo, 'e2e/ui/bridgeSession.ts');
  return openBridgeSession(o);
}
