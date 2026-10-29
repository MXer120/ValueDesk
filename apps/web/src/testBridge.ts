/**
 * `window.__vsTest`: the dev server's handle on this browser's algo runner and
 * copier, for the UI specs (e2e/ui) and the live suite's browser target
 * (apps/executor/tools/live-test, through e2e/ui/bridgeSession.ts).
 *
 * DEV ONLY. main.tsx imports this module inside `if (import.meta.env.DEV)`: a
 * production build replaces that with `if (false)`, drops the import, and no
 * chunk of this file is emitted (testBridge.test.ts proves the guard and that
 * nothing else imports it). Here it is also refused outside dev.
 *
 * A STABLE SEAM. `version` changes only when a call changes shape or is added;
 * everything returned is plain JSON (cloned), so it crosses Playwright's
 * `page.evaluate` as it is. Nothing loads until a call needs it: browserAlgos
 * and browserCopier are imported on first use (importing the algo runner marks
 * it loaded, which a page that never used it must not do).
 *
 *   about()                    what this page runs with: the wallet, the network,
 *                              the builder and its fees, the brake, the copy terms,
 *                              the region, whether real algos are on for the wallet
 *   algos.start(spec, seed?)   follows the wallet (or the paper book) and starts
 *                              it in this tab, exactly as the ticket's Start does
 *   algos.check(spec)          the engine's parser (checkAlgoSpec): { spec, errors by field }
 *   algos.list / role / pause / resume / cancel / cancelAll / update / events
 *   copier.acceptTerms(country) the copy terms as copy setup's "Sign and accept"
 *                              signs them (ValueDesk's own terms popup first)
 *   copier.start(settings)     the UI's start (copy/live.ts startCopy 'browser'):
 *                              the wallet, ValueDesk's terms and the copy terms first
 *   copier.makeKey / verifyKey a copy key made in this page; once SoDEX lists it
 *                              (the wallet registered it), kept in this browser's
 *                              vault as copy setup's Approve keeps it
 *   copier.list / role / key / terms / update / pause / resume / stop / stopAll / events
 *   copier.confirms / answer   the "copy this trade?" prompts
 *
 * Version 2 added about, copier.acceptTerms, terms, update, makeKey and verifyKey.
 *
 * Live (non-paper) algos and copies stay behind the same gates as the UI's own
 * buttons (liveAlgos.ts, the copy key): this bridge adds no way around them. A
 * key made here is kept only once the wallet has registered it on SoDEX.
 */
import type { AlgoEvent, AlgoView, CopySettings, CopyView, RegionPolicy } from '@copy-engine';

export const TEST_BRIDGE_VERSION = 2;

export interface VsTestAbout {
  /** The connected wallet (lower-case), or null. */
  wallet: string | null;
  network: 'mainnet' | 'testnet';
  /** This build's name (buildInfo.ts). */
  build: string;
  /**
   * The builder this page's orders carry, and what they carry, in tenths of a bp: an algo's
   * children the wallet's trading fee (0 when the builder charges nothing), a copy's orders the
   * copy ladder's top step (browserCopier.ts). null: this build names no builder.
   */
  builder: { id: number; algoFee: number; copyFee: number } | null;
  /** The operator's emergency brake (/api/health), or null. */
  brake: { trading: boolean; copies: boolean; algos: boolean; reason: string } | null;
  /** The copy terms this page shows and signs. */
  copyTerms: { version: string; hash: string };
  /** The country ValueDesk's executor sees this browser in, or null (a dev server's executor sees none). */
  viewerCountry: string | null;
  /** The region rules the wallet's live algos and copies run under here: its declared country (the copy terms) and the one seen. */
  policy: RegionPolicy;
  /** Real algo orders may start for this wallet here (liveAlgos.ts). */
  liveAlgos: boolean;
  /** Trading in this browser (trading/session.ts): 'enabled' once a trading key is registered for the wallet. */
  trading: { status: string; owner: string | null; accountId: number | null };
  /** The copy key this browser registers: its name and longest life. */
  copyKey: { name: string; maxDays: number };
}

export interface VsTestAlgos {
  role(): Promise<string>;
  /** The wallet (lower-case) or 'paper' the runner follows; null when it follows none. */
  owner(): Promise<string | null>;
  /** Follow `owner` (default: the connected wallet, else the paper book). */
  follow(owner?: string | null): Promise<string>;
  /** errors: field -> problem (empty when the spec is valid). */
  check(spec: unknown): Promise<{ spec: unknown; errors: Record<string, string> }>;
  start(spec: unknown, seed?: number): Promise<string>;
  list(): Promise<AlgoView[]>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  cancelAll(): Promise<void>;
  update(id: string, patch: Record<string, unknown>): Promise<void>;
  events(id: string, limit?: number): Promise<AlgoEvent[]>;
}

/** The copy terms the wallet accepted here (copy/terms.ts LocalTerms, without the signed request). */
export interface VsTestTerms {
  termsVersion: string;
  termsHash: string;
  country: string;
  acceptedAt: number;
  /** ValueDesk's executor has the record. */
  recorded: boolean;
}

export interface VsTestCopier {
  role(): Promise<string>;
  owner(): Promise<string | null>;
  key(): Promise<{ address: string; name: string; expiresAt: number; accountId: number } | null>;
  /** The copy terms as copy setup signs them: ValueDesk's own terms first (their popup), then one signature. */
  acceptTerms(country: string): Promise<VsTestTerms>;
  terms(): Promise<VsTestTerms | null>;
  /** A copy key made here for the wallet to register on SoDEX under `name`; kept in this page until verifyKey finds it listed. */
  makeKey(): Promise<{ address: string; name: string }>;
  /**
   * The key made here, once SoDEX lists it under its name for the wallet: kept in this browser's
   * vault (registered: true). Not listed yet: registered false. Without one made: the vault's key as
   * SoDEX lists it now. null: no key at all.
   */
  verifyKey(): Promise<{ address: string; name: string; expiresAt: number | null; registered: boolean } | null>;
  start(settings: CopySettings): Promise<string>;
  list(): Promise<CopyView[]>;
  /** Change a copy's rules, as the copy window's Save does (copy/live.ts updateCopy 'browser'). */
  update(id: string, settings: CopySettings): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  stop(id: string, close?: boolean): Promise<void>;
  stopAll(close?: boolean): Promise<void>;
  events(id: string, limit?: number): Promise<unknown[]>;
  confirms(): Promise<Array<{ id: string; subId: string; symbol: string; expiresAt: number }>>;
  answer(id: string, yes: boolean): Promise<void>;
}

export interface VsTestBridge {
  version: number;
  about(): Promise<VsTestAbout>;
  algos: VsTestAlgos;
  copier: VsTestCopier;
}

declare global {
  interface Window {
    __vsTest?: VsTestBridge;
  }
}

/** Plain JSON: what crosses page.evaluate, and nothing the caller could mutate in place. */
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

const algoRunner = async () => (await import('./algo/browserAlgos')).browserAlgos;
const copier = async () => (await import('./copy/browserCopier')).browserCopier;
const connected = async (): Promise<string | null> => (await import('./walletconnect')).getWalletSnapshot().address?.toLowerCase() ?? null;

const termsOf = (t: VsTestTerms | null): VsTestTerms | null =>
  t ? { termsVersion: t.termsVersion, termsHash: t.termsHash, country: t.country, acceptedAt: t.acceptedAt, recorded: t.recorded } : null;

export function createTestBridge(): VsTestBridge {
  const follow = async (owner?: string | null): Promise<string> => {
    const { algoOwner } = await import('./algo/algoBus');
    const o = algoOwner(owner === undefined ? await connected() : owner);
    await (await algoRunner()).follow(o);
    return o;
  };
  async function about(): Promise<VsTestAbout> {
    const [{ tradingConfig }, { activeBuilder }, { feeNow }, live, terms, { liveAlgosFor }, { getTradingState }, { BUILD_ID }, engine, { browserCopyFee, BROWSER_KEY_NAME }, { MAX_BROWSER_KEY_DAYS }] = await Promise.all([
      import('./trading/config'),
      import('./trading/builder'),
      import('./trading/terms'),
      import('./copy/live'),
      import('./copy/terms'),
      import('./algo/liveAlgos'),
      import('./trading/session'),
      import('./buildInfo'),
      import('@copy-engine'),
      import('./copy/browserCopier'),
      import('./copy/sodexSetup'),
    ]);
    const wallet = await connected();
    const cfg = tradingConfig();
    const s = live.getLiveCopy();
    const t = getTradingState();
    return clone({
      wallet,
      network: cfg.network,
      build: BUILD_ID,
      // As the runners charge it: an algo child activeBuilder's fee for the wallet (browserAlgos.ts), a copy the ladder's top step.
      builder: cfg.builder ? { id: cfg.builder.id, algoFee: activeBuilder(cfg.builder) ? feeNow('perps', wallet) : 0, copyFee: browserCopyFee() } : null,
      brake: cfg.brake,
      copyTerms: { version: engine.COPY_TERMS_VERSION, hash: terms.COPY_TERMS_HASH },
      viewerCountry: s.viewerCountry,
      // As browserAlgos.ts policyFor decides it for a new algo.
      policy: engine.regionPolicy(terms.localTerms(wallet)?.country ?? null, s.viewerCountry),
      liveAlgos: liveAlgosFor(wallet),
      trading: { status: t.status, owner: t.owner, accountId: t.accountId },
      copyKey: { name: BROWSER_KEY_NAME, maxDays: MAX_BROWSER_KEY_DAYS },
    });
  }
  const algos: VsTestAlgos = {
    role: async () => (await algoRunner()).role,
    owner: async () => (await algoRunner()).owner,
    follow,
    async check(spec) {
      const { checkAlgoSpec } = await import('@copy-engine');
      const r = checkAlgoSpec(spec);
      return clone({ spec: r.spec, errors: r.errors });
    },
    async start(spec, seed) {
      await follow();
      const id = await (await algoRunner()).start(spec, seed);
      if (!id) throw new Error('the runner started no algo');
      return id;
    },
    list: async () => clone((await algoRunner()).getSnapshot().views),
    pause: async (id) => void (await (await algoRunner()).pause(id)),
    resume: async (id) => void (await (await algoRunner()).resume(id)),
    cancel: async (id) => void (await (await algoRunner()).cancel(id)),
    cancelAll: async () => void (await (await algoRunner()).cancelAll()),
    update: async (id, patch) => void (await (await algoRunner()).update(id, patch)),
    events: async (id, limit) => clone(await (await algoRunner()).events(id, limit)),
  };
  // A key made by makeKey: in this page only (never the vault) until SoDEX lists it.
  let made: { owner: string; address: string; privateKey: Uint8Array } | null = null;
  const copy: VsTestCopier = {
    role: async () => (await copier()).role,
    owner: async () => (await copier()).owner,
    key: async () => clone((await copier()).key),
    async acceptTerms(country) {
      const live = await import('./copy/live');
      await live.acceptTerms(country);
      const t = termsOf(live.getLiveCopy().terms);
      if (!t) throw new Error('the copy terms were not recorded in this browser');
      return t;
    },
    terms: async () => termsOf((await import('./copy/live')).getLiveCopy().terms),
    async makeKey() {
      const c = await copier();
      if (!c.owner) throw new Error('Connect your wallet first.');
      made?.privateKey.fill(0);
      const k = c.newKey();
      made = { owner: c.owner, address: k.address, privateKey: k.privateKey };
      const { BROWSER_KEY_NAME } = await import('./copy/browserCopier');
      return { address: k.address, name: BROWSER_KEY_NAME };
    },
    async verifyKey() {
      const c = await copier();
      const [{ copyKeyRegistered }, { BROWSER_KEY_NAME }, { sodexAccountId }] = await Promise.all([import('./copy/sodexSetup'), import('./copy/browserCopier'), import('./trading/session')]);
      if (made && made.owner === c.owner) {
        const r = await copyKeyRegistered(made.owner, BROWSER_KEY_NAME, made.address);
        if (!r.ok) return { address: made.address, name: BROWSER_KEY_NAME, expiresAt: r.expiresAt, registered: false };
        if (r.expiresAt === null) throw new Error('SoDEX lists the copy key without an expiry: this browser keeps only keys that expire');
        const k = made;
        made = null;
        // As copy setup's Approve does once the wallet registered it (copy/live.ts approveKey): kept, and the key bytes wiped.
        await c.adoptKey(k.owner, k, { expiresAt: r.expiresAt, accountId: await sodexAccountId(k.owner) });
      }
      const k = c.key;
      if (!k || !c.owner) return null;
      const r = await copyKeyRegistered(c.owner, k.name, k.address);
      return clone({ address: k.address, name: k.name, expiresAt: r.expiresAt ?? k.expiresAt, registered: r.ok });
    },
    async start(settings) {
      const c = await copier();
      const before = new Set(c.views.map((v) => v.subscription.id));
      await (await import('./copy/live')).startCopy('browser', settings);
      const added = c.views.find((v) => !before.has(v.subscription.id));
      if (!added) throw new Error('the copier started no copy');
      return added.subscription.id;
    },
    list: async () => clone((await copier()).views),
    update: async (id, settings) => (await import('./copy/live')).updateCopy('browser', id, settings),
    pause: async (id) => void (await (await copier()).pause(id)),
    resume: async (id) => void (await (await copier()).resume(id)),
    stop: async (id, close = false) => void (await (await copier()).stop(id, close)),
    stopAll: async (close = false) => void (await (await copier()).stopAll(close)),
    events: async (id, limit) => clone(await (await copier()).activity(id, limit)),
    confirms: async () =>
      (await copier()).confirms.map((q) => ({ id: q.id, subId: q.sub.id, symbol: q.event.symbol, expiresAt: q.expiresAt })),
    answer: async (id, yes) => (await copier()).answer(id, yes),
  };
  return { version: TEST_BRIDGE_VERSION, about, algos, copier: copy };
}

/** Put the bridge on `window.__vsTest`. Refused outside the dev server. */
export function installTestBridge(target: { __vsTest?: VsTestBridge } = window, dev = import.meta.env.DEV): boolean {
  if (!dev) return false;
  if (!target.__vsTest) target.__vsTest = createTestBridge();
  return true;
}
