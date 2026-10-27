/**
 * GETs to ValueDesk's own server - the index API (/api/vs/*): one request per
 * URL at a time, polls that ask the server, and a page's first reads on their
 * way before the page is.
 *
 * DEDUPE. Identical reads that overlap share one fetch: the palette and the
 * page under it asking for the same board, a panel remounting while its last
 * read is still on the wire. Each caller keeps its own abort - the shared
 * request is cancelled only once every caller has gone - and parses its own
 * copy of the body (the TEXT is shared, not the objects), so a caller that
 * sorts its rows in place can never reach another.
 *
 * HTTP CACHE. The server sends an ETag with every index answer, lets caches
 * keep the boards for ten seconds and lets them hand that copy out for twenty
 * more while they fetch the next one (apps/server/src/perf.ts). A page's FIRST
 * read is left to the browser's cache, as any fetch is: a page reopened within
 * that half minute has its rows at once instead of an empty table for a round
 * trip. A POLL is not. Handed the copy the poll before it left behind, a board
 * that asks every 15 s would run one poll late for as long as it stays open
 * (measured: four of the leaderboard's four polls a minute were answered by
 * the cache). So a read made inside `revalidating()` - the polls of hooks.ts
 * `useAsync` and of the cohort pages' `usePolled` - asks the server
 * (`cache: 'no-cache'`): the browser sends If-None-Match, and an answer that
 * has not changed comes back as a 304 with no body.
 *
 * FIRST READS. A page asks for its data in an effect: after its code arrived,
 * rendered and committed - half a second or more after this module ran on a
 * slow laptop, with the connection idle meanwhile. So what a landing page read
 * first is remembered per URL (localStorage, the paths only), and the next time
 * the app starts on that URL those reads leave at once (`primeFirstReads`,
 * called by App.tsx as it boots). The page's own read then takes that answer -
 * the same request, sent earlier - instead of sending it again. One reader, one
 * time, within ten seconds; a read that failed is not handed over; and a URL
 * that carries a wallet or a search is neither remembered nor started early.
 * The first visit to a URL starts nothing early: there is nothing to go by yet.
 */

export interface ServerAnswer {
  status: number;
  ok: boolean;
  /** The raw body; parse it per caller. */
  text: string;
}

interface Shared {
  promise: Promise<ServerAnswer>;
  ac: AbortController;
  /** Callers still waiting for it. */
  users: number;
  /** The list it is in. */
  list: Map<string, Shared>;
}

/** In flight, by path: reads the browser's cache may answer, and reads that ask the server. */
const inflight = new Map<string, Shared>();
const inflightAsking = new Map<string, Shared>();

/** `revalidating()` calls on the stack. */
let asking = 0;

/**
 * Run `fn`; the reads of our server it STARTS (before it returns) ask the
 * server for its current answer - a 304 when nothing changed - instead of
 * taking a copy the HTTP cache holds. For polls: see HTTP CACHE above.
 * Every vsApi call made directly in `fn` is covered; a read `fn` starts later
 * (after an await) is an ordinary read.
 */
export function revalidating<T>(fn: () => T): T {
  asking += 1;
  try {
    return fn();
  } finally {
    asking -= 1;
  }
}

const abortReason = (signal?: AbortSignal): unknown => signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');

/** Test seam. */
export const serverFetchEnv = {
  fetch: (input: string, init: RequestInit): Promise<Response> => fetch(input, init),
  storage: (): Pick<Storage, 'getItem' | 'setItem'> | null => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null; // storage blocked
    }
  },
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  /** The tab was opened in the background. */
  hidden: (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden',
};

function start(path: string, ask: boolean): Shared {
  const ac = new AbortController();
  const list = ask ? inflightAsking : inflight;
  const promise = serverFetchEnv
    .fetch(path, { headers: { Accept: 'application/json' }, signal: ac.signal, cache: ask ? 'no-cache' : 'default' })
    .then(async (res) => ({ status: res.status, ok: res.ok, text: await res.text() }));
  const entry: Shared = { promise, ac, users: 0, list };
  list.set(path, entry);
  const done = () => {
    if (list.get(path) === entry) list.delete(path);
  };
  promise.then(done, done);
  return entry;
}

/**
 * One read, shared with an identical one in flight. A read that asks the
 * server shares only with another that does (a plain one may be answered by
 * the cache); a plain read takes either.
 */
function read(path: string, signal: AbortSignal | undefined, ask: boolean): Promise<ServerAnswer> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const entry = inflightAsking.get(path) ?? (ask ? undefined : inflight.get(path)) ?? start(path, ask);
  entry.users += 1;
  return new Promise<ServerAnswer>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      entry.users -= 1;
      if (entry.users === 0) {
        // Nobody wants it any more. Out of the map first, so a new caller
        // never joins a request that is being cancelled.
        if (entry.list.get(path) === entry) entry.list.delete(path);
        entry.ac.abort();
      }
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      entry.users -= 1;
      finish();
    };
    entry.promise.then(
      (answer) => settle(() => resolve(answer)),
      (err: unknown) => settle(() => reject(err)),
    );
  });
}

/* ---------------------------------------------------------------------------
 * First reads, started early.
 * ------------------------------------------------------------------------ */

const FIRST_READS_KEY = 'vs.firstReads';
/** What a landing page reads within this long of the app starting are its first reads. */
const FIRST_READS_WINDOW_MS = 4_000;
/** At most this many per page, and this many pages remembered. */
const FIRST_READS_MAX = 6;
const FIRST_READS_ROUTES = 16;
/** An early answer nobody asked for is dropped after this long. */
const EARLY_KEEP_MS = 10_000;

/** Answers on their way (or in) for the page's own first read of the path. */
const early = new Map<string, Promise<ServerAnswer>>();
/** The reads the page makes while it starts, to be remembered for its URL. */
let recording: { route: string; paths: string[] } | null = null;
/** primeFirstReads ran: it does so once per page load. */
let primedOnce = false;

/** A wallet or a search in a URL is neither stored nor asked for ahead of the page. */
const PERSONAL = /[?&](address|q|account|accountId|id|find)=/i;
/** An index read that may be started early: our own API, nothing personal in it. */
const primeable = (path: string): boolean => path.startsWith('/api/vs/') && !PERSONAL.test(path);

type Remembered = Record<string, string[]>;

function remembered(): Remembered {
  try {
    const raw = serverFetchEnv.storage()?.getItem(FIRST_READS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Remembered = {};
    for (const [route, paths] of Object.entries(v as Record<string, unknown>)) {
      if (Array.isArray(paths)) out[route] = paths.filter((p): p is string => typeof p === 'string' && primeable(p)).slice(0, FIRST_READS_MAX);
    }
    return out;
  } catch {
    return {};
  }
}

function remember(route: string, paths: string[]): void {
  try {
    const all = remembered();
    if (JSON.stringify(all[route] ?? []) === JSON.stringify(paths)) return;
    delete all[route];
    if (paths.length) all[route] = paths; // newest last
    const routes = Object.keys(all);
    for (const old of routes.slice(0, Math.max(0, routes.length - FIRST_READS_ROUTES))) delete all[old];
    serverFetchEnv.storage()?.setItem(FIRST_READS_KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked: nothing is started early next time */
  }
}

/**
 * The app is starting on `route` (path + query): send what the page read first
 * the last time it started here, and note what it reads first this time.
 * Call once, as early as the app runs. A tab opened in the background starts
 * nothing early and learns nothing: its pages may not read at all until shown.
 */
export function primeFirstReads(route: string): void {
  if (primedOnce) return;
  primedOnce = true;
  if (PERSONAL.test(route) || serverFetchEnv.hidden()) return;
  for (const path of remembered()[route] ?? []) {
    if (early.has(path)) continue;
    const answer = read(path, undefined, false);
    answer.catch(() => { /* the page asks again, and reports it */ });
    early.set(path, answer);
  }
  recording = { route, paths: [] };
  serverFetchEnv.setTimeout(() => {
    const seen = recording;
    recording = null;
    // What the page really asked for is what is started early next time - also when that is nothing.
    if (seen) remember(seen.route, seen.paths);
  }, FIRST_READS_WINDOW_MS);
  serverFetchEnv.setTimeout(() => early.clear(), EARLY_KEEP_MS);
}

/** For tests: forget every in-flight read, early answer and recording. */
export function _resetServerFetch(): void {
  inflight.clear();
  inflightAsking.clear();
  asking = 0;
  early.clear();
  recording = null;
  primedOnce = false;
}

/** `promise`, rejecting with the abort reason the moment `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * GET `path` from our server, sharing the request with any identical one
 * still in flight. Resolves with the status and the body text; rejects like
 * fetch (a network error, or this caller's own abort).
 */
export function serverGet(path: string, signal?: AbortSignal): Promise<ServerAnswer> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  // Inside revalidating(): a poll. It asks the server, and it is no page's first read.
  if (asking > 0) return read(path, signal, true);
  if (recording && recording.paths.length < FIRST_READS_MAX && primeable(path) && !recording.paths.includes(path)) recording.paths.push(path);
  const sent = early.get(path);
  if (!sent) return read(path, signal, false);
  // Sent as the app started, for this read: one reader takes it. Had it failed, the page reads as if it had not been sent.
  early.delete(path);
  return abortable(sent.then((answer) => (answer.ok ? answer : read(path, signal, false)), () => read(path, signal, false)), signal);
}

/** `serverGet` + JSON: the status, and the parsed body (null when it is not JSON). */
export async function serverGetJson<T = unknown>(path: string, signal?: AbortSignal): Promise<{ status: number; ok: boolean; body: T | null }> {
  const a = await serverGet(path, signal);
  let body: T | null = null;
  try {
    body = JSON.parse(a.text) as T;
  } catch {
    body = null;
  }
  return { status: a.status, ok: a.ok, body };
}
