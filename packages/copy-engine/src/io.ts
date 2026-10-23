/**
 * What the engine needs from its host, as narrow interfaces.
 *
 * The engine runs in a browser tab and in Node, and is type-checked with no
 * ambient typings at all, so it never names `fetch`, `WebSocket`, timers or
 * `AbortController` directly: the host passes fetch and a WebSocket factory,
 * and timers are read off `globalThis` here, once.
 */

/** The part of a fetch Response the engine reads. */
export interface ResponseLike {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
}

export type FetchLike = (url: string, init?: RequestInitLike) => Promise<ResponseLike>;

/** The part of a WebSocket the feeds use (browser WebSocket, Node 22+ global WebSocket, or `ws`). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const WS_OPEN = 1;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

interface TimerHost {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

const host = globalThis as unknown as TimerHost;

/** A timer that never keeps a Node process alive. */
function unref<T>(h: T): T {
  (h as { unref?: () => void } | null)?.unref?.();
  return h;
}

export const timers = {
  after: (ms: number, fn: () => void): unknown => unref(host.setTimeout(fn, ms)),
  every: (ms: number, fn: () => void): unknown => unref(host.setInterval(fn, ms)),
  cancel: (h: unknown): void => {
    if (h !== undefined && h !== null) {
      host.clearTimeout(h);
      host.clearInterval(h);
    }
  },
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => timers.after(ms, r));

interface AbortControllerLike {
  signal: unknown;
  abort(): void;
}

/** An AbortController where the host has one, else a no-op stand-in. */
export function abortController(): AbortControllerLike {
  const C = (globalThis as unknown as { AbortController?: new () => AbortControllerLike }).AbortController;
  return C ? new C() : { signal: undefined, abort() {} };
}

/** Random bytes from the host's CSPRNG (browser and Node 19+ both expose crypto.getRandomValues). */
export function randomBytes(n: number): Uint8Array {
  const c = (globalThis as unknown as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto;
  if (!c) throw new Error('no secure random source');
  return c.getRandomValues(new Uint8Array(n));
}

/** A short random id: 16 base36 characters. */
export function randomId(prefix = ''): string {
  const b = randomBytes(10);
  let s = '';
  for (const x of b) s += x.toString(36).padStart(2, '0');
  return prefix + s.slice(0, 16);
}
