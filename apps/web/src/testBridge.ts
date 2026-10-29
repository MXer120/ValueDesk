/**
 * `window.__vsTest`: the dev server's handle on this browser's algo runner and
 * copier, for the UI specs (e2e/ui) and a later live-suite "browser target".
 *
 * DEV ONLY. main.tsx imports this module inside `if (import.meta.env.DEV)`: a
 * production build replaces that with `if (false)`, drops the import, and no
 * chunk of this file is emitted (testBridge.test.ts proves the guard and that
 * nothing else imports it). Here it is also refused outside dev.
 *
 * A STABLE SEAM. `version` changes only when a call changes shape; everything
 * returned is plain JSON (cloned), so it crosses Playwright's `page.evaluate`
 * as it is. Nothing loads until a call needs it: browserAlgos and browserCopier
 * are imported on first use (importing the algo runner marks it loaded, which
 * a page that never used it must not do).
 *
 *   algos.start(spec, seed?)   follows the wallet (or the paper book) and starts
 *                              it in this tab, exactly as the ticket's Start does
 *   algos.check(spec)          the engine's parser (checkAlgoSpec): { spec, errors by field }
 *   algos.list / role / pause / resume / cancel / cancelAll / update / events
 *   copier.start(settings)     the UI's start (copy/live.ts startCopy 'browser'):
 *                              the wallet, ValueDesk's terms and the copy terms first
 *   copier.list / role / key / pause / resume / stop / stopAll / events
 *   copier.confirms / answer   the "copy this trade?" prompts
 *
 * Live (non-paper) algos and copies stay behind the same gates as the UI's own
 * buttons (liveAlgos.ts, the copy key): this bridge adds no way around them.
 */
import type { AlgoEvent, AlgoView, CopySettings, CopyView } from '@copy-engine';

export const TEST_BRIDGE_VERSION = 1;

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

export interface VsTestCopier {
  role(): Promise<string>;
  owner(): Promise<string | null>;
  key(): Promise<{ address: string; name: string; expiresAt: number; accountId: number } | null>;
  start(settings: CopySettings): Promise<string>;
  list(): Promise<CopyView[]>;
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
const connected = async (): Promise<string | null> => (await import('./walletconnect')).getWalletSnapshot().address;

export function createTestBridge(): VsTestBridge {
  const follow = async (owner?: string | null): Promise<string> => {
    const { algoOwner } = await import('./algo/algoBus');
    const o = algoOwner(owner === undefined ? await connected() : owner);
    await (await algoRunner()).follow(o);
    return o;
  };
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
  const copy: VsTestCopier = {
    role: async () => (await copier()).role,
    owner: async () => (await copier()).owner,
    key: async () => clone((await copier()).key),
    async start(settings) {
      const c = await copier();
      const before = new Set(c.views.map((v) => v.subscription.id));
      await (await import('./copy/live')).startCopy('browser', settings);
      const added = c.views.find((v) => !before.has(v.subscription.id));
      if (!added) throw new Error('the copier started no copy');
      return added.subscription.id;
    },
    list: async () => clone((await copier()).views),
    pause: async (id) => void (await (await copier()).pause(id)),
    resume: async (id) => void (await (await copier()).resume(id)),
    stop: async (id, close = false) => void (await (await copier()).stop(id, close)),
    stopAll: async (close = false) => void (await (await copier()).stopAll(close)),
    events: async (id, limit) => clone(await (await copier()).activity(id, limit)),
    confirms: async () =>
      (await copier()).confirms.map((q) => ({ id: q.id, subId: q.sub.id, symbol: q.event.symbol, expiresAt: q.expiresAt })),
    answer: async (id, yes) => (await copier()).answer(id, yes),
  };
  return { version: TEST_BRIDGE_VERSION, algos, copier: copy };
}

/** Put the bridge on `window.__vsTest`. Refused outside the dev server. */
export function installTestBridge(target: { __vsTest?: VsTestBridge } = window, dev = import.meta.env.DEV): boolean {
  if (!dev) return false;
  if (!target.__vsTest) target.__vsTest = createTestBridge();
  return true;
}
