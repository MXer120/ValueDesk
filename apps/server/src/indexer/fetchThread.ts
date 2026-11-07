/**
 * THE INDEXER'S HTTP ON A THREAD OF ITS OWN.
 *
 * On the indexer's thread a request needs several turns of a loop that lags seconds, and a timeout's timer runs before the
 * socket that already holds the answer. Measured 2026-11-06, an hour after a restart on v0.2.179 with the thread busy 99%:
 * the SoDEX data lane did 125 reads of the 4,700 its budget allows, its failures all "aborted due to timeout", and each one
 * backed the lane off for up to 5 minutes; Arcus's market list timed out for 40 minutes, and with no list its socket closed
 * each time (1006, "subscribing failed").
 *
 * So `fetch` here sends the request to a worker, which does the connection, TLS and the body, and hands back the bytes. What
 * times out now is the request, not this thread: the caller's signal fires on this thread, possibly late, and only asks the
 * worker to stop. Whatever the worker had already answered arrives first (a port keeps its order), so an answer that was
 * there in time is never thrown away. A request that really took too long still fails, with the caller's own reason.
 *
 * Budgets are untouched: lanes, pacers and clients count as before, this only changes on which thread the bytes move.
 * A request this cannot carry over (a Request object, a stream as the body, an option it does not know) goes the old way.
 */
import { Worker } from 'node:worker_threads';
import { currentLabel, resumed } from './busy.js';

const CODE = `
const { parentPort } = require('node:worker_threads');
const running = new Map();
parentPort.on('message', async (m) => {
  if (m.cancel !== undefined) { running.get(m.cancel)?.abort(); return; }
  const stop = new AbortController();
  running.set(m.id, stop);
  try {
    const res = await fetch(m.url, { ...m.init, signal: stop.signal });
    const body = await res.arrayBuffer();
    parentPort.postMessage({ id: m.id, status: res.status, statusText: res.statusText, headers: [...res.headers], url: res.url, redirected: res.redirected, body }, [body]);
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String((e && e.message) || e), name: e && e.name, cause: e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : undefined });
  } finally {
    running.delete(m.id);
  }
});
`;

/** A cancelled request the worker does not answer: only if the worker itself hangs. */
const CANCEL_ANSWER_MS = 30_000;
/** A larger body comes in pieces with the loop let in between, as it did off the socket: the leaderboard's file is parsed as it arrives. */
const WHOLE_BODY_MAX = 1 << 20;
const PIECE = 1 << 16;
const NULL_BODY = new Set([101, 204, 205, 304]);
const KNOWN_INIT = new Set(['method', 'headers', 'body', 'signal', 'redirect', 'cache', 'mode', 'credentials', 'referrer', 'referrerPolicy', 'integrity', 'keepalive']);

interface Waiting { ok: (r: Response) => void; no: (e: unknown) => void; reason?: unknown; timer?: NodeJS.Timeout; done: () => void }
interface Answer { id: number; status?: number; statusText?: string; headers?: Array<[string, string]>; url?: string; redirected?: boolean; body?: ArrayBuffer; error?: string; name?: string; cause?: string }

function bodyOf(buf: ArrayBuffer): ArrayBuffer | ReadableStream<Uint8Array> {
  if (buf.byteLength <= WHOLE_BODY_MAX) return buf;
  let off = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      await new Promise<void>((r) => setImmediate(r));
      const n = Math.min(PIECE, buf.byteLength - off);
      c.enqueue(new Uint8Array(buf, off, n));
      off += n;
      if (off >= buf.byteLength) c.close();
    },
  });
}

function responseOf(m: Answer): Response {
  const status = m.status ?? 500;
  const res = new Response(NULL_BODY.has(status) ? null : bodyOf(m.body ?? new ArrayBuffer(0)), { status, statusText: m.statusText ?? '', headers: m.headers ?? [] });
  Object.defineProperty(res, 'url', { value: m.url ?? '' });
  Object.defineProperty(res, 'redirected', { value: !!m.redirected });
  return res;
}

function errorOf(m: Answer): Error {
  const e = m.name === 'TimeoutError' || m.name === 'AbortError' ? new Error(m.error) : new TypeError(m.error);
  if (m.name) e.name = m.name;
  // As undici's: the reason a request failed sits in `cause`, its message is "fetch failed".
  if (m.cause) (e as Error & { cause?: unknown }).cause = Object.assign(new Error(m.cause), { code: m.cause });
  return e;
}

export class FetchThread {
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, Waiting>();

  constructor(private readonly fallback: typeof fetch = globalThis.fetch) {}

  private thread(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(CODE, { eval: true, execArgv: [] });
    w.unref();
    w.on('message', (m: Answer) => {
      const r = this.waiting.get(m.id);
      if (!r) return;
      this.waiting.delete(m.id);
      r.done();
      try {
        if (m.error !== undefined) r.no(r.reason ?? errorOf(m));
        else r.ok(responseOf(m));
      } catch (e) {
        r.no(e);
      }
    });
    const gone = (why: string) => {
      if (this.worker === w) this.worker = null;
      for (const r of this.waiting.values()) { r.done(); r.no(new TypeError('fetch failed', { cause: new Error(why) })); }
      this.waiting.clear();
    };
    w.on('error', (e) => gone(String(e)));
    w.on('exit', () => gone('the fetch thread stopped'));
    this.worker = w;
    return w;
  }

  /** Requests the worker has not answered yet. */
  get pending(): number {
    return this.waiting.size;
  }

  stop(): void {
    void this.worker?.terminate();
    this.worker = null;
  }

  fetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
    const body = init?.body;
    const carried = url !== null && (body === undefined || body === null || typeof body === 'string' || body instanceof Uint8Array)
      && Object.keys(init ?? {}).every((k) => KNOWN_INIT.has(k));
    if (!carried) return this.fallback(input, init);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const { signal: _signal, ...rest } = init ?? {};
    const sent = { ...rest, ...(rest.headers ? { headers: [...new Headers(rest.headers)] } : {}) };
    return new Promise<Response>((ok, no) => {
      const id = ++this.seq;
      // Whoever asked resumes when the answer is handed over: named again then (busy.ts), not after the last timer.
      const label = currentLabel();
      const entry: Waiting = {
        ok: (v) => { resumed(label); ok(v); },
        no: (e) => { resumed(label); no(e); },
        done: () => {
          signal?.removeEventListener('abort', onAbort);
          if (entry.timer) clearTimeout(entry.timer);
        },
      };
      const onAbort = (): void => {
        // Late or not, the time is up: the worker stops if it has not answered. An answer it already sent comes first.
        entry.reason = signal!.reason;
        this.worker?.postMessage({ cancel: id });
        entry.timer = setTimeout(() => {
          if (this.waiting.delete(id)) no(entry.reason);
        }, CANCEL_ANSWER_MS);
        entry.timer.unref?.();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(id, entry);
      this.thread().postMessage({ id, url, init: sent });
    });
  };
}

/** Every `fetch` of this thread from now on through a FetchThread. `VALUESCAN_INDEX_FETCH_THREAD=0`: as it was. */
export function installFetchThread(): FetchThread | null {
  if (process.env.VALUESCAN_INDEX_FETCH_THREAD === '0') return null;
  const t = new FetchThread(globalThis.fetch);
  globalThis.fetch = t.fetch;
  return t;
}
