/**
 * GETs to ValueDesk's own server - the index API (/api/vs/*): one request per
 * URL at a time, polls that ask the server, a page's first reads on their way
 * before the page is, and the last answer of each kept for a moment.
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
 * KEPT ANSWERS (phone pass, 2026-11-18). Every good answer of a public index
 * read is kept in memory with the time it was made, for exactly as long as the
 * route's own Cache-Control lets any cache hand it out (max-age plus
 * stale-while-revalidate, counted from the answer's Date / Age). A page that
 * opens on a path whose answer is kept may paint it in its FIRST render
 * (`peekAnswer`) - with its as-of time, and only where nothing live is mixed
 * into it - and asks the server for the current one at once (inside
 * `revalidating`), which replaces it. Nothing is kept past that window, and a
 * read with a wallet or a search in it is never kept. Memory only: within that
 * window the browser's HTTP cache already answers a new visit's early read
 * (below) before the page renders, so a copy in IndexedDB would hold the same
 * bytes a second time.
 *
 * FIRST READS. A page asks for its data in an effect: after its code arrived,
 * rendered and committed - seconds after the HTML on a phone, with the
 * connection idle meanwhile. So what a landing page read first is remembered
 * per URL (localStorage, the paths and their sizes), and the next time the app
 * starts on that URL those reads leave at once. A URL never seen in this
 * browser starts the build's defaults (firstReadDefaults.ts: what the page
 * reads with its default view). They are started by the build's route script
 * (tools/route-preload.mjs) while the HTML is still being read; this module
 * adopts them as it boots (`primeFirstReads`, called by App.tsx), or sends
 * them itself when that script did not run. The page's own read then takes
 * that answer - the same request, sent earlier - instead of sending it again.
 * One reader, one time, within ten seconds of the landing page's code being
 * in; a read that failed is not handed over; at most six reads and 64 KB on
 * the wire per page; and a URL that carries a wallet or a search is neither
 * remembered nor started early. A page about to be opened (a tab touched, the
 * phone's More sheet opened) starts its reads the same way (`primeRoute`).
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
/** `readingAhead()` calls on the stack. */
let ahead = 0;

/**
 * Run `fn`; the reads it STARTS (before it returns) are reads ahead of a tap - another window of a board, a page about
 * to open: ordinary reads, but no page's first read (not remembered for the URL, and no early answer is taken).
 */
export function readingAhead<T>(fn: () => T): T {
  ahead += 1;
  try {
    return fn();
  } finally {
    ahead -= 1;
  }
}

/** Reading ahead of a tap is allowed: the tab is shown and the visitor did not ask to save data (nor is on 2G). */
export const mayReadAhead = (): boolean => !serverFetchEnv.hidden() && !serverFetchEnv.saveData();

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

/** What tools/route-preload.mjs leaves on the page (see FIRST READS). */
interface PreloadGlobals {
  /** The landing page's reads it started: path -> its fetch. Set (maybe empty) whenever it chose the reads. */
  __vsEarly?: Record<string, Promise<Response>>;
  /** The build's default first reads, by URL (path + query). */
  __vsReads?: Record<string, string[]>;
  /** A page's reads on intent where nothing is started on landing (firstReadDefaults.ts aheadReads). */
  __vsAhead?: Record<string, string[]>;
  /** Set here as the app boots: a route script that runs later starts nothing. */
  __vsPrimed?: boolean;
}

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
  now: (): number => Date.now(),
  /** The tab was opened in the background. */
  hidden: (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  /** The visitor asked to save data, or the browser rates the link 2G: nothing is read ahead of a tap. */
  saveData: (): boolean => {
    const c = (globalThis as { navigator?: { connection?: { saveData?: boolean; effectiveType?: string } } }).navigator?.connection;
    return !!c && (c.saveData === true || /^(slow-2g|2g)$/.test(c.effectiveType ?? ''));
  },
  /** Bytes on the wire of the last answer for `path` (Resource Timing), or null when the browser does not say. */
  encodedSize: (path: string): number | null => {
    try {
      const href = new URL(path, globalThis.location?.href).href;
      const list = globalThis.performance?.getEntriesByName?.(href) as PerformanceResourceTiming[] | undefined;
      const last = list?.[list.length - 1];
      return last && last.encodedBodySize > 0 ? last.encodedBodySize : null;
    } catch {
      return null;
    }
  },
  /** Where the route script's globals live. */
  globals: (): PreloadGlobals => globalThis as PreloadGlobals,
  /** The page's URL now (path + query), or null without one. */
  route: (): string | null => (globalThis.location ? globalThis.location.pathname + globalThis.location.search : null),
};

/* ---------------------------------------------------------------------------
 * Kept answers.
 * ------------------------------------------------------------------------ */

/** At most this many answers and this many characters are kept; the oldest go first. */
const KEPT_MAX = 64;
const KEPT_CHARS = 2_000_000;

export interface KeptAnswer {
  text: string;
  /** When the answer was made (ms, this device's clock): the Date it was sent with, or less its Age. */
  at: number;
  /** After this (ms) no cache may hand it out (max-age + stale-while-revalidate from `at`): it is dropped. */
  until: number;
}

const keptAnswers = new Map<string, KeptAnswer>();
let keptChars = 0;

/** How long (ms) any cache may hand out an answer with this Cache-Control, or null when none may. */
export function keepWindowMs(cacheControl: string | null): number | null {
  if (!cacheControl) return null;
  const v = cacheControl.toLowerCase();
  if (/(?:^|,)\s*(?:no-store|no-cache|private)\b/.test(v)) return null;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*(\d+)/.exec(v);
  if (!maxAge) return null;
  const swr = /(?:^|,)\s*stale-while-revalidate\s*=\s*(\d+)/.exec(v);
  return (Number(maxAge[1]) + (swr ? Number(swr[1]) : 0)) * 1000;
}

/** How old (ms) an answer is: its Age, or the time since its Date, whichever says older. */
function ageMs(res: Response, now: number): number {
  const age = Number(res.headers.get('age'));
  const date = Date.parse(res.headers.get('date') ?? '');
  return Math.max(0, Number.isFinite(age) ? age * 1000 : 0, Number.isFinite(date) ? now - date : 0);
}

const isFailure = (text: string): boolean => text.startsWith('{"ok":false');

/**
 * Answers held back from the kept store while their path waits for its page's own first read (FIRST READS): the page
 * takes such an answer as its own, fresh read - it must not find it kept, draw it as an older answer and ask again.
 * Moved in once it is taken or let go (`release`).
 */
const deferred = new Map<string, KeptAnswer>();

function keep(path: string, res: Response, text: string): void {
  if (!primeable(path) || res.status !== 200 || isFailure(text)) return;
  const window = keepWindowMs(res.headers.get('cache-control'));
  if (window === null) return;
  const now = serverFetchEnv.now();
  const at = now - ageMs(res, now);
  if (at + window <= now) return;
  const entry: KeptAnswer = { text, at, until: at + window };
  if (early.has(path)) deferred.set(path, entry);
  else store(path, entry);
}

function store(path: string, entry: KeptAnswer): void {
  dropKept(path);
  keptAnswers.set(path, entry);
  keptChars += entry.text.length;
  for (const old of keptAnswers.keys()) {
    if (keptAnswers.size <= KEPT_MAX && keptChars <= KEPT_CHARS) break;
    dropKept(old);
  }
}

/** The early answer of `path` was taken by its page, or let go: from now on it is an ordinary kept answer. */
function release(path: string): void {
  const d = deferred.get(path);
  deferred.delete(path);
  if (d && d.until > serverFetchEnv.now()) store(path, d);
}

function dropKept(path: string): void {
  const k = keptAnswers.get(path);
  if (!k) return;
  keptChars -= k.text.length;
  keptAnswers.delete(path);
}

/**
 * The kept answer for `path` while the route's own cache policy still allows handing it out, else null. A page paints
 * it in its first render with its `at` as the as-of time, and reads again inside `revalidating()` at once.
 */
export function peekAnswer(path: string): KeptAnswer | null {
  const k = keptAnswers.get(path);
  if (!k) return null;
  if (serverFetchEnv.now() >= k.until) {
    dropKept(path);
    return null;
  }
  return k;
}

/** peekAnswer + JSON: the parsed body (a fresh object per call) and its time, or null. */
export function peekJson<T>(path: string): { body: T; at: number; until: number } | null {
  const k = peekAnswer(path);
  if (!k) return null;
  try {
    return { body: JSON.parse(k.text) as T, at: k.at, until: k.until };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Requests.
 * ------------------------------------------------------------------------ */

/** Bytes on the wire of each index answer read in this tab, for the first-read budget. */
const sizes = new Map<string, number>();
/** Index reads still on the wire, by path: a first-read list is written once their sizes are in. */
const pending = new Map<string, Promise<unknown>>();

/** Read a response: its body, kept (above) and sized. */
async function answerOf(path: string, res: Response): Promise<ServerAnswer> {
  const text = await res.text();
  keep(path, res, text);
  if (primeable(path) && res.ok) {
    if (sizes.size >= 256) sizes.delete(sizes.keys().next().value as string);
    sizes.set(path, serverFetchEnv.encodedSize(path) ?? text.length);
  }
  return { status: res.status, ok: res.ok, text };
}

function track(path: string, promise: Promise<ServerAnswer>, list: Map<string, Shared>, entry: Shared): void {
  list.set(path, entry);
  pending.set(path, promise);
  const done = () => {
    if (list.get(path) === entry) list.delete(path);
    if (pending.get(path) === promise) pending.delete(path);
  };
  promise.then(done, done);
}

function start(path: string, ask: boolean): Shared {
  const ac = new AbortController();
  const list = ask ? inflightAsking : inflight;
  const promise = serverFetchEnv
    .fetch(path, { headers: { Accept: 'application/json' }, signal: ac.signal, cache: ask ? 'no-cache' : 'default' })
    .then((res) => answerOf(path, res));
  const entry: Shared = { promise, ac, users: 0, list };
  track(path, promise, list, entry);
  return entry;
}

/** A read the route script started (its fetch), taken in as if this module had started it. */
function adopt(path: string, fetched: Promise<Response>): Shared {
  const promise = Promise.resolve(fetched).then((res) => answerOf(path, res));
  // That fetch was not started with our signal: once nobody waits for it, it runs out unread.
  const entry: Shared = { promise, ac: new AbortController(), users: 0, list: inflight };
  track(path, promise, inflight, entry);
  return entry;
}

/**
 * One read, shared with an identical one in flight. A read that asks the
 * server shares only with another that does (a plain one may be answered by
 * the cache); a plain read takes either.
 */
function read(path: string, signal: AbortSignal | undefined, ask: boolean, entry?: Shared): Promise<ServerAnswer> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const shared = entry ?? inflightAsking.get(path) ?? (ask ? undefined : inflight.get(path)) ?? start(path, ask);
  shared.users += 1;
  return new Promise<ServerAnswer>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      shared.users -= 1;
      if (shared.users === 0) {
        // Nobody wants it any more. Out of the map first, so a new caller
        // never joins a request that is being cancelled.
        if (shared.list.get(path) === shared) shared.list.delete(path);
        shared.ac.abort();
      }
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      shared.users -= 1;
      finish();
    };
    shared.promise.then(
      (answer) => settle(() => resolve(answer)),
      (err: unknown) => settle(() => reject(err)),
    );
  });
}

/* ---------------------------------------------------------------------------
 * First reads, started early.
 * ------------------------------------------------------------------------ */

const FIRST_READS_KEY = 'vs.firstReads';
/** What a landing page reads within this long of its code being in are its first reads. */
const FIRST_READS_WINDOW_MS = 4_000;
/** At most this many per page, at most this many bytes on the wire together, and this many pages remembered. */
export const FIRST_READS_MAX = 6;
export const FIRST_READS_BUDGET = 64 * 1024;
const FIRST_READS_ROUTES = 16;
/** An early answer nobody asked for is dropped after this long. */
const EARLY_KEEP_MS = 10_000;
/** The landing page's code never came in: the window and the early answers end this long after the start anyway. */
const BOOT_GIVE_UP_MS = 60_000;
/** A list is written once its reads' sizes are in, or after this long without them. */
const SIZE_WAIT_MS = 20_000;

/** Answers on their way (or in) for a page's own first read of the path, and until when one is handed over. */
const early = new Map<string, { answer: Promise<ServerAnswer>; until: number }>();
/** The reads the page makes while it starts, to be remembered for its URL. */
let recording: { route: string; paths: string[] } | null = null;
/** primeFirstReads ran: it does so once per page load. */
let primedOnce = false;

/** A wallet (also a wallet filter: wallets=, w=) or a search in a URL is neither stored, kept nor asked for ahead of the page. */
export const PERSONAL = /[?&](address|q|account|accountId|id|find|wallets|w)=/i;
/** An index read that may be started early or kept: our own API, nothing personal in it. */
const primeable = (path: string): boolean => path.startsWith('/api/vs/') && !PERSONAL.test(path);

/** A remembered read: its path and its answer's bytes on the wire (0: not known). */
export type FirstRead = [path: string, bytes: number];
type Remembered = Record<string, FirstRead[]>;

/** One stored entry, in either form written so far (a path; [path, bytes]), or null when it is not one. */
function entryOf(v: unknown): FirstRead | null {
  const path = typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;
  if (!path || !primeable(path)) return null;
  const n = Array.isArray(v) ? Number(v[1]) : 0;
  return [path, Number.isFinite(n) && n > 0 ? n : 0];
}

function remembered(): Remembered {
  try {
    const raw = serverFetchEnv.storage()?.getItem(FIRST_READS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Remembered = {};
    for (const [route, list] of Object.entries(v as Record<string, unknown>)) {
      if (Array.isArray(list)) out[route] = list.map(entryOf).filter((e): e is FirstRead => e !== null).slice(0, FIRST_READS_MAX);
    }
    return out;
  } catch {
    return {};
  }
}

function remember(route: string, reads: FirstRead[]): void {
  try {
    const all = remembered();
    if (JSON.stringify(all[route] ?? null) === JSON.stringify(reads)) return;
    delete all[route];
    // An empty list too: the page read nothing, so the build's defaults are not started for it either.
    all[route] = reads; // newest last
    const routes = Object.keys(all);
    for (const old of routes.slice(0, Math.max(0, routes.length - FIRST_READS_ROUTES))) delete all[old];
    serverFetchEnv.storage()?.setItem(FIRST_READS_KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked: nothing is started early next time */
  }
}

/**
 * The reads to start for a page, in order: at most FIRST_READS_MAX, and no more than FIRST_READS_BUDGET bytes on the
 * wire together (a read whose size is not known counts as nothing). tools/route-preload.mjs picks the same way.
 */
export function pickFirstReads(list: readonly FirstRead[]): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const [path, b] of list) {
    if (out.length >= FIRST_READS_MAX) break;
    if (!primeable(path) || out.includes(path) || bytes + b > FIRST_READS_BUDGET) continue;
    out.push(path);
    bytes += b;
  }
  return out;
}

/** The build says nothing is started early for this URL (its page waits on reads that are not ours): none, ever. */
const noneEarly = (route: string): boolean => {
  const d = serverFetchEnv.globals().__vsReads?.[route];
  return Array.isArray(d) && d.length === 0;
};

/**
 * The reads `route` starts: none where the build says so; else what this browser remembers for it (also an empty
 * list), else the build's defaults.
 */
function firstReadsOf(route: string): string[] {
  if (noneEarly(route)) return [];
  const mine = remembered();
  if (Object.prototype.hasOwnProperty.call(mine, route)) return pickFirstReads(mine[route]!);
  const defaults = serverFetchEnv.globals().__vsReads?.[route];
  return Array.isArray(defaults) ? pickFirstReads(defaults.map(entryOf).filter((e): e is FirstRead => e !== null)) : [];
}

function handOver(path: string, answer: Promise<ServerAnswer>, keepMs: number): void {
  answer.catch(() => { /* the page asks again, and reports it */ });
  const entry = { answer, until: serverFetchEnv.now() + keepMs };
  early.set(path, entry);
  // Nobody took it in time: let it go, so its answer counts as kept like any other.
  serverFetchEnv.setTimeout(() => { if (early.get(path) === entry) { early.delete(path); release(path); } }, keepMs);
}

/**
 * The app is starting on `route` (path + query): take the reads the route script started for this page (or send what
 * the page read first the last time it started here), and note what it reads first this time. `booted` resolves when
 * the landing page's code is in (App.tsx `booting`): the page reads once it has rendered, which on a phone is seconds
 * after this module ran, so the recording window and the early answers' life count from then.
 * Call once, as early as the app runs. A tab opened in the background starts nothing early and learns nothing: its
 * pages may not read at all until shown.
 */
export function primeFirstReads(route: string, booted?: PromiseLike<unknown>): void {
  if (primedOnce) return;
  primedOnce = true;
  const g = serverFetchEnv.globals();
  g.__vsPrimed = true;
  const handed = g.__vsEarly;
  g.__vsEarly = undefined;
  if (PERSONAL.test(route)) return;
  const hidden = serverFetchEnv.hidden();
  const sent: string[] = [];
  if (handed && typeof handed === 'object') {
    // The route script chose and started them while the HTML was read: one request each, adopted here (also when the
    // tab has been hidden since: they are on the wire already).
    for (const [path, fetched] of Object.entries(handed)) {
      if (!primeable(path) || early.has(path) || inflight.has(path)) continue;
      const entry = adopt(path, fetched);
      handOver(path, read(path, undefined, false, entry), BOOT_GIVE_UP_MS);
      sent.push(path);
    }
  } else if (!hidden) {
    for (const path of firstReadsOf(route)) {
      if (early.has(path)) continue;
      handOver(path, read(path, undefined, false), BOOT_GIVE_UP_MS);
      sent.push(path);
    }
  }
  if (hidden && !sent.length) return;
  // Nothing to learn where the build starts nothing early whatever is remembered.
  recording = hidden || noneEarly(route) ? null : { route, paths: [] };
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    const seen = recording;
    recording = null;
    // What the page really asked for is what is started early next time - also when that is nothing.
    if (seen) rememberWhenSized(seen.route, seen.paths);
  };
  const mine = new Map(sent.map((p) => [p, early.get(p)]));
  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    // Only the landing page's: a page primed on a touch since keeps its own ten seconds.
    for (const [path, entry] of mine) if (early.get(path) === entry) { early.delete(path); release(path); }
  };
  const fromNow = () => {
    serverFetchEnv.setTimeout(end, FIRST_READS_WINDOW_MS);
    serverFetchEnv.setTimeout(clear, EARLY_KEEP_MS);
  };
  if (booted) {
    Promise.resolve(booted).then(fromNow, fromNow);
    serverFetchEnv.setTimeout(() => { end(); clear(); }, BOOT_GIVE_UP_MS);
  } else {
    fromNow();
  }
}

/** Write the list once the sizes of its reads are in (the budget needs them), or after SIZE_WAIT_MS without. */
function rememberWhenSized(route: string, paths: string[]): void {
  const write = () => remember(route, paths.map((p): FirstRead => [p, sizes.get(p) ?? 0]));
  const open = paths.map((p) => pending.get(p)).filter((p): p is Promise<unknown> => !!p);
  if (!open.length) {
    write();
    return;
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    write();
  };
  void Promise.allSettled(open).then(once);
  serverFetchEnv.setTimeout(once, SIZE_WAIT_MS);
}

/**
 * A page is about to be opened (its tab touched, the phone's More sheet opened): start its first reads now - what this
 * browser remembers for that URL, else the build's defaults - so its data is on the way before its code has rendered.
 * The page's own first read takes each answer once, within ten seconds. Nothing is read for a URL with a wallet or a
 * search in it, for a path whose answer is kept (the page paints that and asks again itself), or for a visitor saving
 * data.
 */
export function primeRoute(route: string): void {
  if (PERSONAL.test(route) || !mayReadAhead()) return;
  const now = serverFetchEnv.now();
  // Where nothing starts on landing (the page waits on SoDEX first), in the app there is no first paint to share with.
  const ahead = serverFetchEnv.globals().__vsAhead?.[route];
  const list = noneEarly(route) ? (Array.isArray(ahead) ? pickFirstReads(ahead.map(entryOf).filter((e): e is FirstRead => e !== null)) : []) : firstReadsOf(route);
  for (const path of list) {
    const sent = early.get(path);
    if ((sent && sent.until > now) || inflight.has(path) || inflightAsking.has(path) || peekAnswer(path)) continue;
    handOver(path, read(path, undefined, false), EARLY_KEEP_MS);
  }
}

/** For tests: forget every in-flight read, early answer, kept answer and recording. */
export function _resetServerFetch(): void {
  inflight.clear();
  inflightAsking.clear();
  asking = 0;
  ahead = 0;
  early.clear();
  recording = null;
  primedOnce = false;
  keptAnswers.clear();
  deferred.clear();
  keptChars = 0;
  sizes.clear();
  pending.clear();
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

/** The page a URL shows: its first path segment ('' is the trade page). */
const pageOf = (route: string): string => {
  const seg = (route.split(/[?#]/)[0]!.split('/')[1] ?? '').toLowerCase();
  return seg === 'trade' ? '' : seg;
};

/** Note a page's first read, while the app is starting on that page's URL. */
function record(path: string): void {
  if (!recording) return;
  // The visitor already moved on to another page: what is read now is that page's, not the landing page's. (The same
  // page tidying its own query - /trade?symbol= cleaned, a cohort filter written - is still the landing page.)
  const here = serverFetchEnv.route();
  if (here !== null && pageOf(here) !== pageOf(recording.route)) return;
  if (recording.paths.length < FIRST_READS_MAX && primeable(path) && !recording.paths.includes(path)) recording.paths.push(path);
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
  // Inside readingAhead(): neither a first read nor the reader of one.
  if (ahead > 0) return read(path, signal, false);
  record(path);
  const sent = early.get(path);
  if (!sent) return read(path, signal, false);
  // Sent ahead of the page, for this read: one reader takes it. Had it failed, the page reads as if it had not been sent.
  early.delete(path);
  release(path);
  if (sent.until <= serverFetchEnv.now()) return read(path, signal, false);
  return abortable(sent.answer.then((answer) => (answer.ok ? answer : read(path, signal, false)), () => read(path, signal, false)), signal);
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
