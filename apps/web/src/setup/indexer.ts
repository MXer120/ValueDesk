/**
 * Walk SoDEX history into the local aggregate index.
 *
 * Pages go through the existing readers (accountData.ts): gateway history via
 * the backend, deposits and withdrawals via alpha-biz account_flow. Pacing is
 * vs.setup.indexSpeed. The gap between starts is at least the preset delay and
 * at least budgetGapMs(), so a rolling minute never spends more than the
 * documented 1,200 weight. A 429 pushes the next start out (2s, doubled, cap
 * 30s) and does not tighten that loop.
 *
 * Ledger rows that are still pending or in review are not consumed: the catch-up
 * stops at the newest terminal row already folded, so a deposit that completes
 * later is still newer than `h` and gets counted. A pending row already older
 * than `h` is not revisited (no trade ids to match it by).
 */
import {
  LEDGER_PAGE, fetchAccountFlows, fetchHistoryPage, ledgerAvailable,
  type HistoryEngine, type HistoryKind, type LedgerRow,
} from '../accountData';
import {
  SPEEDS, WEIGHT_PER_MIN, budgetGapMs, emptyIndex, foldFlows, foldPage, historyWeight, indexKey,
  parseIndex, readSpeed, saveIndex, type SpeedId,
  type FlowRow, type GwStream, type Pass, type SpeedPreset, type StoredIndex,
} from './stats';

export interface IndexProgress {
  running: boolean;
  pages: number;
  /** Stream the latest page belonged to. */
  stream: string;
  /** Oldest ms still being walked, or the newest folded once that stream is caught up. */
  cursorMs: number | null;
  done: boolean;
  notice: string | null;
}

export const IDLE_PROGRESS: IndexProgress = {
  running: false, pages: 0, stream: '', cursorMs: null, done: false, notice: null,
};

const GW: Record<GwStream, { kind: HistoryKind; engine: HistoryEngine; label: string; field: 'f' | 'ts' | 'tp' | 'os' | 'op' }> = {
  funding: { kind: 'funding', engine: 'perps', label: 'Funding', field: 'f' },
  'trades-spot': { kind: 'trades', engine: 'spot', label: 'Spot trades', field: 'ts' },
  'trades-perps': { kind: 'trades', engine: 'perps', label: 'Futures trades', field: 'tp' },
  'orders-spot': { kind: 'orders', engine: 'spot', label: 'Spot orders', field: 'os' },
  'orders-perps': { kind: 'orders', engine: 'perps', label: 'Futures orders', field: 'op' },
};

const STREAMS = Object.keys(GW) as GwStream[];

/** Every gateway stream and the ledger have walked back to their start. */
function caughtUp(index: StoredIndex): boolean {
  return STREAMS.every((s) => index.c[GW[s].field].x) && index.c.l.x;
}
const STABLE = /^(v)?(usdc|usdt|dai|usd)$/i;
/** alpha-biz is a different host. 5 matches the gateway's flat account-read weight. */
const LEDGER_WEIGHT = 5;

let progress: IndexProgress = IDLE_PROGRESS;
const listeners = new Set<(p: IndexProgress) => void>();
let run: { address: string; abort: AbortController } | null = null;

let nextAt = 0;
let penaltyMs = 0;
const stamps: { at: number; w: number }[] = [];
let paceChain: Promise<void> = Promise.resolve();

let inFlight = 0;
const waiters: Array<(ok: boolean) => void> = [];

function publish(patch: Partial<IndexProgress>): void {
  progress = { ...progress, ...patch };
  for (const fn of listeners) {
    try { fn(progress); } catch { /* a listener must not stop the walk */ }
  }
}

export function subscribeIndex(fn: (p: IndexProgress) => void): () => void {
  listeners.add(fn);
  fn(progress);
  return () => { listeners.delete(fn); };
}

export function startIndexer(address: string): void {
  const addr = address.trim();
  if (!addr) return;
  if (run && run.address.toLowerCase() === addr.toLowerCase()) return;
  stopIndexer();
  const abort = new AbortController();
  run = { address: addr, abort };
  void main(addr, abort.signal).finally(() => {
    if (run?.abort === abort) run = null;
  });
}

export function stopIndexer(): void {
  run?.abort.abort();
  run = null;
  if (progress.running) publish({ running: false });
}

/** Drop this browser's aggregate and walk again from the start. */
export function resetIndex(address: string): void {
  const addr = address.trim();
  if (!addr) return;
  const resume = indexEnabled() || run?.address.toLowerCase() === addr.toLowerCase();
  stopIndexer();
  try { saveIndex(localStorage, emptyIndex(addr)); }
  catch { /* private mode: the walk still restarts from an empty memory copy */ }
  publish({ running: false, pages: 0, stream: '', cursorMs: null, done: false, notice: null });
  if (resume) startIndexer(addr);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) { resolve(); return; }
    const t = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function budgetWait(weight: number, now: number): number {
  const cutoff = now - 60_000;
  while (stamps.length > 0 && stamps[0]!.at <= cutoff) stamps.shift();
  let used = 0;
  for (const s of stamps) used += s.w;
  if (used + weight <= WEIGHT_PER_MIN) return 0;
  const oldest = stamps[0];
  return oldest ? Math.max(0, oldest.at + 60_000 - now) : 0;
}

/** Serialized start gate. Weight is charged only if the request is actually sent. */
function pace(weight: number, delayMs: number, signal: AbortSignal): Promise<void> {
  const job = paceChain.then(async () => {
    while (!signal.aborted) {
      const now = Date.now();
      const wait = Math.max(0, nextAt - now, budgetWait(weight, now));
      if (wait <= 0) break;
      await sleep(wait, signal);
    }
    if (signal.aborted) return;
    const at = Date.now();
    stamps.push({ at, w: weight });
    nextAt = at + delayMs;
  });
  paceChain = job.then(() => undefined, () => undefined);
  return job;
}

function on429(): void {
  penaltyMs = Math.min(30_000, penaltyMs === 0 ? 2_000 : penaltyMs * 2);
  nextAt = Math.max(nextAt, Date.now() + penaltyMs);
}

function onOk(): void {
  penaltyMs = 0;
}

function acquire(concurrency: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (inFlight < concurrency) {
    inFlight += 1;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (ok) inFlight += 1;
      resolve(ok);
    };
    const onAbort = () => {
      const i = waiters.indexOf(finish);
      if (i >= 0) waiters.splice(i, 1);
      finish(false);
    };
    waiters.push(finish);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function release(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next(true);
}

function currentPreset(): SpeedPreset {
  try { return SPEEDS[readSpeed((k) => localStorage.getItem(k))]; }
  catch { return SPEEDS.default; }
}

const SPEED_KEY = 'vs.setup.indexSpeed';

/** The pace chosen on the portfolio prompt. The walk reads it on the next page. */
export function setIndexSpeed(id: SpeedId): void {
  try { localStorage.setItem(SPEED_KEY, id); }
  catch { /* the next page still uses Default */ }
}

const INDEX_ON = 'vs.setup.indexOn';

export function indexEnabled(): boolean {
  try { return localStorage.getItem(INDEX_ON) === '1'; }
  catch { return false; }
}

/** Portfolio switch. Same-tab listeners hear `vs-index`; storage events do not fire here. */
export function setIndexEnabled(on: boolean, address: string | null): void {
  try { localStorage.setItem(INDEX_ON, on ? '1' : '0'); }
  catch { /* the walk still starts or stops for this page */ }
  if (on && address) startIndexer(address);
  else stopIndexer();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('vs-index'));
}

function is429(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /\b429\b|too many requests|rate limit/i.test(m);
}

function isFatal(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  const code = /HTTP (\d+)/.exec(m);
  if (!code) return false;
  const n = Number(code[1]);
  return n >= 400 && n < 500 && n !== 429;
}

function normFlow(row: LedgerRow): FlowRow | null {
  if (!row.time) return null;
  if (row.state === 'pending' || row.state === 'review') return null;
  if ((row.kind === 'deposit' || row.kind === 'withdraw') && row.state === 'completed' && STABLE.test(row.coin)) {
    const amount = Number(row.amount);
    if (Number.isFinite(amount) && amount > 0) return { time: row.time, kind: row.kind, amount };
  }
  return { time: row.time, kind: 'mark', amount: 0 };
}

async function main(address: string, signal: AbortSignal): Promise<void> {
  let index: StoredIndex;
  try { index = parseIndex(localStorage.getItem(indexKey(address)), address); }
  catch { index = emptyIndex(address); }
  const state = { index, pages: 0 };
  let write: Promise<void> = Promise.resolve();
  const exclusive = <T>(fn: () => T): Promise<T> => {
    const run = write.then(fn);
    write = run.then(() => undefined, () => undefined);
    return run;
  };

  const note = (stream: string, cursorMs: number | null, notice: string | null) => {
    // A caught-up index still checks for newer rows. That check is not a new
    // walk, so the toast stays finished instead of reopening at 100%.
    publish({ running: true, pages: state.pages, stream, cursorMs, done: caughtUp(state.index), notice });
  };

  const drainGateway = async (stream: GwStream): Promise<void> => {
    const spec = GW[stream];
    const cur = () => state.index.c[spec.field];
    const walk = async (pass: Pass, start: number | null) => {
      let endTime = start;
      let fails = 0;
      while (!signal.aborted) {
        const preset = currentPreset();
        const gap = Math.max(preset.delayMs, budgetGapMs(preset.limit));
        let page: Awaited<ReturnType<typeof fetchHistoryPage>> | null | undefined;
        try {
          page = await (async () => {
            const got = await acquire(preset.concurrency, signal);
            if (!got) return null;
            try {
              await pace(historyWeight(preset.limit), gap, signal);
              if (signal.aborted) return null;
              return await fetchHistoryPage(spec.kind, spec.engine, address, endTime, preset.limit);
            } finally { release(); }
          })();
        } catch (err) {
          if (signal.aborted) return;
          if (is429(err)) {
            on429();
            note(spec.label, cur().b, 'SoDEX is rate limiting. Slowing down.');
            continue;
          }
          fails += 1;
          if (isFatal(err) || fails >= 3) {
            note(spec.label, cur().b, 'History did not load. It will be tried again shortly.');
            return;
          }
          continue;
        }
        if (signal.aborted) return;
        if (!page) return;
        onOk();
        fails = 0;
        const requested = endTime;
        const limit = preset.limit;
        const folded = await exclusive(() => {
          const res = foldPage(state.index, stream, page!.rows, { limit, pass, endTime: requested });
          try { state.index = saveIndex(localStorage, res.index); }
          catch { state.index = res.index; }
          state.pages += 1;
          return res;
        });
        const c = folded.index.c[spec.field];
        note(spec.label, c.b ?? (c.h > 0 ? c.h : null), null);
        if (folded.stop) return;
        endTime = folded.nextEndTime;
      }
    };

    if (cur().h > 0) await walk('newer', null);
    if (signal.aborted) return;
    if (!cur().x) await walk('older', cur().b);
    else if (cur().h === 0) await walk('older', null);
  };

  const drainFlows = async (): Promise<void> => {
    if (!ledgerAvailable()) {
      await exclusive(() => {
        if (!state.index.c.l.x) {
          state.index.c.l.x = true;
          try { state.index = saveIndex(localStorage, state.index); } catch { /* keep memory */ }
        }
      });
      return;
    }
    const walk = async (pass: Pass, startOffset: number) => {
      let offset = startOffset;
      let fails = 0;
      while (!signal.aborted) {
        const preset = currentPreset();
        const gap = Math.max(preset.delayMs, budgetGapMs(preset.limit));
        let page: Awaited<ReturnType<typeof fetchAccountFlows>> | null | undefined;
        try {
          page = await (async () => {
            const got = await acquire(preset.concurrency, signal);
            if (!got) return null;
            try {
              await pace(LEDGER_WEIGHT, gap, signal);
              if (signal.aborted) return null;
              return await fetchAccountFlows(address, offset, LEDGER_PAGE);
            } finally { release(); }
          })();
        } catch (err) {
          if (signal.aborted) return;
          if (is429(err)) {
            on429();
            note('Deposits', state.index.c.l.b, 'SoDEX is rate limiting. Slowing down.');
            continue;
          }
          fails += 1;
          if (isFatal(err) || fails >= 3) {
            note('Deposits', state.index.c.l.b, 'Deposits did not load. They will be tried again shortly.');
            return;
          }
          continue;
        }
        if (signal.aborted || !page) return;
        onOk();
        fails = 0;
        const rows = page.rows.map(normFlow).filter((r): r is FlowRow => r !== null);
        // Pending / in-review rows are omitted. An open-only page must not freeze
        // the older walk (the completed history is behind it) and must not move
        // `h`, so a deposit that later completes is still newer than the cursor.
        if (rows.length === 0) {
          if (!page.done && pass === 'older' && page.raw > 0) {
            offset += page.raw;
            continue;
          }
          if (!page.done) return;
        }
        const requested = offset;
        const folded = await exclusive(() => {
          const res = foldFlows(state.index, rows, page!.raw, { limit: LEDGER_PAGE, pass, offset: requested });
          if (page!.done) {
            res.index.c.l.x = true;
            res.stop = true;
          }
          try { state.index = saveIndex(localStorage, res.index); }
          catch { state.index = res.index; }
          state.pages += 1;
          return res;
        });
        const c = folded.index.c.l;
        note('Deposits', c.b ?? (c.h > 0 ? c.h : null), null);
        if (folded.stop) return;
        offset = folded.nextOffset;
      }
    };

    if (state.index.c.l.h > 0) await walk('newer', 0);
    if (signal.aborted) return;
    if (!state.index.c.l.x) await walk('older', state.index.c.l.o);
    else if (state.index.c.l.h === 0) await walk('older', 0);
  };

  publish({ running: true, pages: 0, stream: '', cursorMs: null, done: caughtUp(state.index), notice: null });
  while (!signal.aborted) {
    await Promise.all([...STREAMS.map((s) => drainGateway(s)), drainFlows()]);
    if (signal.aborted) break;
    const caught = caughtUp(state.index);
    let cursorMs: number | null = null;
    for (const s of STREAMS) {
      const c = state.index.c[GW[s].field];
      const t = c.b ?? (c.h > 0 ? c.h : 0);
      if (t > 0 && (cursorMs === null || t < cursorMs)) cursorMs = t;
    }
    publish({ running: false, done: caught, pages: state.pages, cursorMs, notice: null });
    await sleep(caught ? 60_000 : 5_000, signal);
    // Only an unfinished walk looks busy again. A caught index keeps `done`
    // through the quiet minute and the next newer-row check.
    if (!signal.aborted && !caught) publish({ running: true, done: false });
  }
}
