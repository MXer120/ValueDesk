/**
 * Nonce management for SoDEX signing keys.
 *
 * THE RULES (api-keys-and-nonces doc, 2026-09):
 *   - Nonces are tracked per SIGNING ADDRESS: the API key's address for trading
 *     actions, the master wallet's address for addAPIKey / revokeAPIKey.
 *   - The 100 highest nonces per signer are kept; a new nonce must be larger
 *     than the smallest of them and never used before. (Opentrade's code still
 *     says "strictly increasing" - the docs relaxed that, but strictly
 *     increasing remains the simplest way to satisfy "unique and above the
 *     floor", so that is what this module hands out.)
 *   - Nonces must be within (T - 2 days, T + 1 day), T = the block time in ms.
 *
 * THE PROBLEM IN A BROWSER: the same key can sign from several tabs of one
 * origin, so a per-tab counter can hand out the same millisecond twice. This
 * manager makes allocation exclusive across tabs and monotone per key:
 *
 *   1. Web Locks (`navigator.locks.request`) serialise allocation across tabs.
 *      Inside the lock the next nonce is max(now, memoryHWM + 1, storedHWM + 1).
 *   2. The high-water mark (HWM) is shared two ways: localStorage (survives a
 *      tab closing) and a BroadcastChannel (works when storage is blocked).
 *   3. A CLOCK FENCE: before releasing the lock the manager waits until the
 *      clock has passed the nonce it just issued (normally < 1 ms). Storage and
 *      broadcast propagate between tabs ASYNCHRONOUSLY - Chrome's localStorage
 *      is a per-renderer cache - so a tab that takes the lock next could read a
 *      stale HWM. With the fence, its `now` is already past every issued nonce,
 *      so it cannot collide even then. Cost: at most ~1000 nonces/s per key,
 *      far above SoDEX's 20 orders/s per account.
 *
 * Without Web Locks (old browsers, most non-browser runtimes) the same logic
 * runs under an in-realm mutex: correct for one tab/process, which is the case
 * it degrades to. `createMemoryNonceManager` is that mode, explicitly.
 */
import { DAY_MS } from './keys.ts';

/** Documented window around the block time T: (T - 2d, T + 1d), exclusive. */
export const NONCE_WINDOW = { pastMs: 2 * DAY_MS, futureMs: DAY_MS } as const;

/**
 * Safety margin applied at both ends of the window, to absorb skew between this
 * machine's clock and the chain's block time (a German test machine measured
 * ~+420 ms; phones can be much worse).
 */
export const DEFAULT_NONCE_WINDOW_MARGIN_MS = 60_000;

export class NonceWindowError extends RangeError {
  override name = 'NonceWindowError';
}

/** Why `nonce` falls outside the (now - 2d, now + 1d) window (shrunk by `marginMs`), or null. */
export function nonceWindowProblem(
  nonce: bigint | number,
  now: number,
  marginMs: number = DEFAULT_NONCE_WINDOW_MARGIN_MS,
): string | null {
  const n = BigInt(nonce);
  const t = BigInt(Math.floor(now));
  const lo = t - BigInt(NONCE_WINDOW.pastMs) + BigInt(marginMs);
  const hi = t + BigInt(NONCE_WINDOW.futureMs) - BigInt(marginMs);
  if (n <= lo) return `nonce ${n} is more than 2 days (minus margin) behind the clock`;
  if (n >= hi) return `nonce ${n} is more than 1 day (minus margin) ahead of the clock - check the system clock`;
  return null;
}

export function assertNonceInWindow(
  nonce: bigint | number,
  now: number,
  marginMs: number = DEFAULT_NONCE_WINDOW_MARGIN_MS,
): bigint {
  const p = nonceWindowProblem(nonce, now, marginMs);
  if (p) throw new NonceWindowError(p);
  return BigInt(nonce);
}

/**
 * The key a nonce sequence is tracked under: one per signing address PER
 * NETWORK (mainnet and testnet are separate chains with separate nonce sets).
 */
export const nonceKey = (signerAddress: string, chainId: number): string =>
  `${chainId}:${signerAddress.trim().toLowerCase()}`;

// ---------------------------------------------------------------------------
// Minimal structural types for the browser APIs (this package has no DOM lib)
// ---------------------------------------------------------------------------

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BroadcastLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  close(): void;
}

export interface LockManagerLike {
  request<T>(name: string, callback: (lock: unknown) => Promise<T> | T): Promise<T>;
}

export interface NonceManagerOptions {
  /** Clock in ms. Default Date.now. */
  now?: () => number;
  /**
   * Added to `now()` - e.g. server time minus local time, measured from a
   * response `timestamp`. Default 0.
   */
  clockOffsetMs?: number;
  /** See DEFAULT_NONCE_WINDOW_MARGIN_MS. */
  windowMarginMs?: number;
  /** Shared HWM store. Default: globalThis.localStorage when usable; null disables. */
  storage?: KeyValueStore | null;
  /** Cross-tab HWM broadcast. Default: a BroadcastChannel when available; null disables. */
  channel?: BroadcastLike | null;
  /** Cross-tab lock. Default: navigator.locks when available; null disables. */
  locks?: LockManagerLike | null;
  /** Prefix for lock names, storage keys and the channel name. */
  namespace?: string;
  /**
   * Longest the clock fence may hold the lock, in ms. If the issued nonce is
   * further ahead of the clock than this (the HWM is ahead - clock stepped
   * back, or a burst), the fence is skipped and uniqueness relies on the
   * shared HWM alone. Default 5. 0 disables the fence (single-realm tests).
   */
  maxFenceWaitMs?: number;
  /** Timer used by the fence. Default setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
}

export interface NonceManager {
  /** Allocate the next nonce for `key` (see `nonceKey`). */
  next(key: string): Promise<bigint>;
  /**
   * Allocate a nonce and run `fn` while still holding the allocation lock, so
   * nothing else can take a nonce for `key` until `fn` settles. Use when the
   * ORDER on the wire matters; plain `next` is enough for uniqueness. Do NOT
   * allocate for the same key inside `fn` - that waits on itself forever.
   */
  withNonce<T>(key: string, fn: (nonce: bigint) => Promise<T> | T): Promise<T>;
  /** The highest nonce this manager knows of for `key` (issued here or seen from another tab). */
  highWater(key: string): bigint | undefined;
  /** Forget `key`'s HWM locally and in storage (e.g. after a system-clock fix). */
  reset(key: string): void;
  /** Whether allocation is coordinated across tabs (Web Locks present). */
  readonly crossTab: boolean;
  /** Stop listening to the broadcast channel. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

interface BrowserGlobals {
  navigator?: { locks?: LockManagerLike };
  localStorage?: KeyValueStore;
  BroadcastChannel?: new (name: string) => BroadcastLike;
}

function detectLocks(): LockManagerLike | null {
  try {
    const l = (globalThis as unknown as BrowserGlobals).navigator?.locks;
    return l && typeof l.request === 'function' ? l : null;
  } catch {
    return null;
  }
}

function detectStorage(): KeyValueStore | null {
  try {
    const s = (globalThis as unknown as BrowserGlobals).localStorage;
    if (!s) return null;
    // Probe: private modes and sandboxed frames expose an object that throws.
    const probe = '__sodex_core_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function detectChannel(name: string): BroadcastLike | null {
  try {
    const BC = (globalThis as unknown as BrowserGlobals).BroadcastChannel;
    return BC ? new BC(name) : null;
  } catch {
    return null;
  }
}

/** setTimeout, reached structurally: this package compiles without DOM or Node typings. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const st = (globalThis as unknown as { setTimeout?: (cb: () => void, ms: number) => unknown }).setTimeout;
    if (st) st(r, ms);
    else r();
  });

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DIGITS_RE = /^\d{1,20}$/;

/** Upper bound on clock reads while spinning in the fence (~1-3 ms of CPU at most). */
const FENCE_SPIN_LIMIT = 100_000;

class Manager implements NonceManager {
  private readonly hwm = new Map<string, bigint>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly clock: () => number;
  private readonly margin: number;
  private readonly storage: KeyValueStore | null;
  private readonly channel: BroadcastLike | null;
  private readonly locks: LockManagerLike | null;
  private readonly ns: string;
  private readonly maxFence: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** True when the caller injected `sleep` (tests): then the fence never spins. */
  private readonly sleepInjected: boolean;
  private closed = false;

  constructor(o: NonceManagerOptions, detect: boolean) {
    const now = o.now ?? Date.now;
    const offset = o.clockOffsetMs ?? 0;
    this.clock = () => now() + offset;
    this.margin = o.windowMarginMs ?? DEFAULT_NONCE_WINDOW_MARGIN_MS;
    this.ns = o.namespace ?? 'sodex-core.nonce';
    this.maxFence = o.maxFenceWaitMs ?? 5;
    this.sleep = o.sleep ?? defaultSleep;
    this.sleepInjected = o.sleep !== undefined;
    this.storage = o.storage !== undefined ? o.storage : detect ? detectStorage() : null;
    this.locks = o.locks !== undefined ? o.locks : detect ? detectLocks() : null;
    this.channel = o.channel !== undefined ? o.channel : detect ? detectChannel(this.ns) : null;
    this.channel?.addEventListener('message', (ev) => this.onMessage(ev.data));
  }

  get crossTab(): boolean {
    return this.locks !== null;
  }

  private onMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const m = data as { v?: unknown; key?: unknown; nonce?: unknown; reset?: unknown };
    if (m.v !== 1 || typeof m.key !== 'string') return;
    if (m.reset === true) {
      this.hwm.delete(m.key);
      return;
    }
    if (typeof m.nonce !== 'string' || !DIGITS_RE.test(m.nonce)) return;
    this.bump(m.key, BigInt(m.nonce));
  }

  private bump(key: string, n: bigint): void {
    const cur = this.hwm.get(key);
    if (cur === undefined || n > cur) this.hwm.set(key, n);
  }

  private storageKey(key: string): string {
    return `${this.ns}:${key}`;
  }

  private readStored(key: string): bigint {
    if (!this.storage) return 0n;
    try {
      const v = this.storage.getItem(this.storageKey(key));
      return v !== null && DIGITS_RE.test(v) ? BigInt(v) : 0n;
    } catch {
      return 0n;
    }
  }

  private writeStored(key: string, n: bigint): void {
    if (!this.storage) return;
    try {
      // Re-read inside the lock so a concurrent writer is never moved backwards.
      if (this.readStored(key) < n) this.storage.setItem(this.storageKey(key), n.toString());
    } catch {
      /* storage full or blocked: the broadcast and the clock fence still hold */
    }
  }

  /** Serialise `fn` per key: in-realm first, then across tabs via Web Locks. */
  private async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('nonce manager is closed');
    const prev = this.tails.get(key) ?? Promise.resolve();
    let done!: () => void;
    const mine = new Promise<void>((r) => (done = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return this.locks ? await this.locks.request(`${this.ns}:${key}`, () => fn()) : await fn();
    } finally {
      done();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Must run inside `exclusive`. */
  private allocate(key: string): bigint {
    const now = BigInt(Math.floor(this.clock()));
    let n = now;
    const mem = this.hwm.get(key);
    if (mem !== undefined && mem >= n) n = mem + 1n;
    const stored = this.readStored(key);
    if (stored >= n) n = stored + 1n;
    assertNonceInWindow(n, Number(now), this.margin);
    this.bump(key, n);
    this.writeStored(key, n);
    try {
      this.channel?.postMessage({ v: 1, key, nonce: n.toString() });
    } catch {
      /* a closed channel must not fail the allocation */
    }
    return n;
  }

  /** Hold the lock until the clock has passed `n` (bounded; see maxFenceWaitMs). */
  private async fence(n: bigint): Promise<void> {
    if (this.maxFence <= 0) return; // fence disabled
    const deadline = Number(n);
    const ahead = deadline - Math.floor(this.clock());
    if (ahead < 0 || ahead > this.maxFence) return;
    if (!this.sleepInjected) {
      // The common case: the clock ticks past `n` within a millisecond. Spin for
      // it (bounded) instead of yielding to a timer - hidden tabs throttle
      // timers to ~1 s, which would stall every allocation of a background tab.
      for (let i = 0; i < FENCE_SPIN_LIMIT && Math.floor(this.clock()) <= deadline; i++) {
        /* spin */
      }
    }
    // Coarse clocks (privacy-hardened browsers round Date.now) or a nonce a few
    // ms ahead: fall back to short timer waits, still bounded.
    for (let i = 0; i < this.maxFence + 5 && Math.floor(this.clock()) <= deadline; i++) {
      await this.sleep(1);
    }
  }

  next(key: string): Promise<bigint> {
    return this.exclusive(key, async () => {
      const n = this.allocate(key);
      await this.fence(n);
      return n;
    });
  }

  withNonce<T>(key: string, fn: (nonce: bigint) => Promise<T> | T): Promise<T> {
    return this.exclusive(key, async () => {
      const n = this.allocate(key);
      try {
        return await fn(n);
      } finally {
        await this.fence(n);
      }
    });
  }

  highWater(key: string): bigint | undefined {
    const mem = this.hwm.get(key);
    const stored = this.readStored(key);
    if (mem === undefined && stored === 0n) return undefined;
    return mem !== undefined && mem > stored ? mem : stored;
  }

  reset(key: string): void {
    this.hwm.delete(key);
    try {
      this.storage?.removeItem(this.storageKey(key));
    } catch {
      /* ignore */
    }
    try {
      this.channel?.postMessage({ v: 1, key, reset: true });
    } catch {
      /* ignore */
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * The browser nonce manager: Web Locks + localStorage HWM + BroadcastChannel,
 * each auto-detected and individually overridable. Falls back to the in-realm
 * mutex (single tab/process correctness) when Web Locks are missing.
 */
export const createNonceManager = (opts: NonceManagerOptions = {}): NonceManager => new Manager(opts, true);

/**
 * A pure in-memory manager: no storage, no broadcast, no Web Locks. Correct
 * within one JS realm (one tab, one worker, one Node process) only.
 */
export const createMemoryNonceManager = (
  opts: Omit<NonceManagerOptions, 'storage' | 'channel' | 'locks'> = {},
): NonceManager => new Manager({ ...opts, storage: null, channel: null, locks: null }, false);
