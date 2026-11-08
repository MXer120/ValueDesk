/**
 * The UI specs' wallet: a browser extension as the page sees one, with the key in Node.
 *
 * IN THE PAGE (an init script, before any of the app's code runs): an EIP-1193
 * provider on `window.ethereum` (`isMetaMask: true`) that is also announced over
 * EIP-6963 as `io.metamask` - so the app's discovery (src/wallet.ts
 * discoverWallets) and AppKit's both find it, and Connect > MetaMask takes the
 * extension route (walletconnect.ts connectVia). Its `request()` does nothing
 * itself: every call crosses to Node through `page.exposeFunction`.
 *
 * IN NODE: e2e/live/provider.ts createKeyProvider answers it, exactly as MetaMask
 * would. THE KEY NEVER ENTERS THE PAGE - only addresses, chain ids, signatures and
 * refusals do. By default it is a throwaway random key (no funds, no SoDEX
 * account); `--live` uses VS_E2E_KEY.
 *
 * THE POLICY signs exactly what the app's setup flows ask for, and nothing else:
 *   trading-key   UserSignedAddAPIKeyAction    (Enable trading, the copy key)
 *   builder       ApproveBuilderFeeAction       (the builder-fee approval)
 *   site-terms    CopyRequest 'accept-site-terms' (ValueDesk's terms)
 *   copy-terms    CopyRequest 'accept-terms'    (the copy terms)
 *   copy-sign-in  CopyRequest 'session'         (signing in to an executor)
 *   algo          CopyRequest 'algo-start' / 'algo-action' (a practice algo or bot on an executor: start, pause, edit, stop)
 *   day-key       CopyRequest 'delegate'        (once a day: the browser key that then signs sign-in, starts, stops...)
 *   copy-key      CopyRequest 'create-key'      (an executor makes the copy key it
 *                                                then asks SoDEX to register: copy/live.ts approveKey)
 * Every transaction, every personal_sign and any other typed data is refused
 * (EIP-1193 4100) and recorded, so a spec can assert both what was signed and
 * that nothing else was asked for. A kind in `reject` is answered as a user
 * clicking Reject would (4001): the flow runs to the wallet, and nothing is signed.
 */
import type { BrowserContext, Page } from 'playwright-core';
import { generatePrivateKey } from 'viem/accounts';
import { createKeyProvider, type KeyProvider, type ProviderEvent, type TypedDataSeen } from '../live/provider';

export type Signable = 'trading-key' | 'builder' | 'site-terms' | 'copy-terms' | 'copy-sign-in' | 'copy-key' | 'algo' | 'username' | 'vip-move' | 'day-key';
export const SIGNABLE: readonly Signable[] = ['trading-key', 'builder', 'site-terms', 'copy-terms', 'copy-sign-in', 'copy-key', 'algo', 'username', 'vip-move', 'day-key'];

/** Which of the allowed signatures this typed data is, or null. */
export function signableOf(td: Pick<TypedDataSeen, 'primaryType' | 'message'>): Signable | null {
  if (td.primaryType === 'UserSignedAddAPIKeyAction') return 'trading-key';
  if (td.primaryType === 'ApproveBuilderFeeAction') return 'builder';
  if (td.primaryType === 'UsernameChange') return 'username';
  if (td.primaryType === 'CopyRequest') {
    const action = (td.message as { action?: unknown }).action;
    if (action === 'accept-site-terms') return 'site-terms';
    if (action === 'accept-terms') return 'copy-terms';
    if (action === 'session') return 'copy-sign-in';
    if (action === 'create-key') return 'copy-key';
    if (action === 'algo-start' || action === 'algo-action') return 'algo';
    if (action === 'vip-move') return 'vip-move';
    // The day key (owner 2026-11-08): the one wallet signature a day; the browser's key signs the everyday actions.
    if (action === 'delegate') return 'day-key';
  }
  return null;
}

export interface WalletRecord {
  at: number;
  method: string;
  /** The allowed signature it was (typed data only). */
  kind?: Signable;
  primaryType?: string;
  action?: string;
  outcome: 'answered' | 'signed' | 'refused' | 'rejected';
  reason?: string;
}

export interface TestWallet {
  readonly address: string;
  readonly throwaway: boolean;
  /** Every wallet call that signs or would sign, in order (reads are left out). */
  readonly log: WalletRecord[];
  /** Allowed signatures answered as Reject (4001) instead of signed. */
  reject: Set<Signable>;
  /** Narrow the policy for one step (default: all of SIGNABLE). */
  allow: Set<Signable>;
  /** Install the wallet in a context: every page opened in it from now on has it. */
  install(ctx: BrowserContext): Promise<void>;
  /** The records since `mark()` (or all), optionally only signatures. */
  since(mark?: number): WalletRecord[];
  mark(): number;
}

const SIGNING = new Set(['eth_signTypedData_v4', 'personal_sign', 'eth_sendTransaction', 'eth_sign', 'eth_signTransaction', 'eth_signTypedData', 'eth_signTypedData_v3']);

const ICON =
  'data:image/svg+xml;base64,' +
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#f6851b"/></svg>').toString('base64');

/** What runs in the page, before the app: the provider, its announcement, and the event hook Node calls. */
function pageScript({ icon, uuid }: { icon: string; uuid: string }): void {
  type Listener = (...args: unknown[]) => void;
  const w = window as unknown as Record<string, unknown>;
  const listeners = new Map<string, Set<Listener>>();
  const bridge = w.__vsE2eWallet as (method: string, params: string) => Promise<{ ok: boolean; result?: unknown; code?: number; message?: string }>;
  const provider = {
    isMetaMask: true,
    isVsE2e: true,
    async request(args: { method: string; params?: unknown }) {
      const r = await bridge(String(args?.method ?? ''), JSON.stringify(args?.params ?? []));
      if (r.ok) return r.result;
      const err = new Error(r.message ?? 'wallet error') as Error & { code?: number };
      err.code = r.code;
      throw err;
    },
    on(event: string, fn: Listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn);
      return provider;
    },
    removeListener(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
      return provider;
    },
  };
  Object.assign(provider, { addListener: provider.on, off: provider.removeListener });
  w.__vsE2eWalletEmit = (event: string, ...args: unknown[]) => {
    for (const fn of listeners.get(event) ?? []) {
      try {
        fn(...args);
      } catch {
        /* a listener must not break the wallet */
      }
    }
  };
  Object.defineProperty(window, 'ethereum', { value: provider, configurable: true, writable: false });
  const detail = Object.freeze({ info: Object.freeze({ uuid, name: 'MetaMask', icon, rdns: 'io.metamask' }), provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}

export function createTestWallet(o: { privateKey?: string } = {}): TestWallet {
  const throwaway = !o.privateKey;
  const log: WalletRecord[] = [];
  const pages = new Set<Page>();
  let provider: KeyProvider;
  const wallet: TestWallet = {
    get address() {
      return provider.address;
    },
    throwaway,
    log,
    reject: new Set(),
    allow: new Set(SIGNABLE),
    since: (mark = 0) => log.slice(mark),
    mark: () => log.length,
    async install(ctx) {
      await ctx.exposeFunction('__vsE2eWallet', async (method: string, paramsJson: string) => {
        let params: unknown[] = [];
        try {
          const p = JSON.parse(paramsJson) as unknown;
          params = Array.isArray(p) ? p : [p];
        } catch {
          /* no params */
        }
        const signing = SIGNING.has(method);
        const rec: WalletRecord = { at: Date.now(), method, outcome: 'answered' };
        if (method === 'eth_signTypedData_v4') {
          try {
            const raw = params[1];
            const td = (typeof raw === 'string' ? JSON.parse(raw) : raw) as TypedDataSeen;
            rec.primaryType = td?.primaryType;
            const action = (td?.message as { action?: unknown } | undefined)?.action;
            if (typeof action === 'string') rec.action = action;
            const kind = td ? signableOf(td) : null;
            if (kind) rec.kind = kind;
            if (kind && wallet.allow.has(kind) && wallet.reject.has(kind)) {
              rec.outcome = 'rejected';
              log.push(rec);
              return { ok: false, code: 4001, message: 'User rejected the request.' };
            }
          } catch {
            /* the provider reports malformed typed data itself */
          }
        }
        try {
          const result = await provider.request({ method, params });
          if (signing) {
            rec.outcome = 'signed';
            log.push(rec);
          }
          return { ok: true, result };
        } catch (e) {
          const code = typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -32603;
          const message = provider.redact(String((e as Error)?.message ?? e));
          if (signing) {
            rec.outcome = code === 4100 ? 'refused' : 'rejected';
            rec.reason = message;
            log.push(rec);
          }
          return { ok: false, code, message };
        }
      });
      await ctx.addInitScript(pageScript, { icon: ICON, uuid: `e2e-${provider.address.slice(2, 10)}` });
      ctx.on('page', (p) => {
        pages.add(p);
        p.on('close', () => pages.delete(p));
      });
      for (const p of ctx.pages()) pages.add(p);
    },
  };
  const emitToPages = (event: string, ...args: unknown[]) => {
    for (const p of pages) void p.evaluate(([e, a]) => (window as unknown as { __vsE2eWalletEmit?: (e: string, ...a: unknown[]) => void }).__vsE2eWalletEmit?.(e, ...a), [event, args] as const).catch(() => {});
  };
  provider = createKeyProvider({
    privateKey: o.privateKey ?? generatePrivateKey(),
    onEvent: (e: ProviderEvent) => void e,
    policy: {
      typedData: (td) => {
        const kind = signableOf(td);
        if (!kind) return `${td.primaryType}${typeof td.message?.action === 'string' ? ` '${td.message.action}'` : ''} is not one of the signatures the UI specs allow (${SIGNABLE.join(', ')})`;
        if (!wallet.allow.has(kind)) return `${kind} is not allowed in this step`;
        return null;
      },
      message: () => 'the UI specs never sign a personal_sign message',
      tx: () => 'the UI specs never send a transaction',
    },
  });
  provider.on?.('chainChanged', (id: unknown) => emitToPages('chainChanged', id));
  provider.on?.('accountsChanged', (a: unknown) => emitToPages('accountsChanged', a));
  return wallet;
}
