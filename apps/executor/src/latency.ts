/**
 * How long a signed write to SoDEX takes, send to answer (time in the send queue + on the wire), for every order and
 * cancel this executor sends: copies, algos, bots. Read by GET /api/copy/v1/bots/latency (docs/BOTS-UI.md).
 *
 * Kept per region and 10-minute bucket as a histogram per kind (place, cancel): 1 ms bins below 100 ms, then bins
 * 1 % wide (log-spaced) up to 120 s. A percentile is the middle of the bin it falls in: off by at most 0.5 ms below
 * 100 ms and 0.5 % above (2 ms at 400 ms, 5 ms at 1 s). A closed bucket is written to the executor's database, the
 * open one on stop; 48 h are read back on start, so a restart does not wipe the chart. Rows are never deleted here.
 *
 * Each write is kept twice: in its region and in its SoDEX account's own log (region id "tokyo:<accountId>"). A
 * user reads only their account's (GET /bots/latency needs their session); the region-wide view is for operators
 * and never leaves the executor through that route.
 *
 * Recording never throws: it runs on the write path (SodexClient onWrite), after the answer.
 */

export const LATENCY_BUCKET_MS = 600_000;
/** The window of the "now" figure (view): the last minute's writes. */
export const LATENCY_NOW_MS = 60_000;
export const LATENCY_KEEP_MS = 48 * 3_600_000;
export type WriteKind = 'place' | 'cancel';
const KINDS: readonly WriteKind[] = ['place', 'cancel'];

/** A signed write as SodexClient reports it (onWrite). */
export interface WriteTiming {
  method: string;
  path: string;
  queueMs: number;
  wireMs: number;
  status: number;
  /** The SoDEX account the write was for (0 when unknown). */
  accountId?: number;
  /** Its market's SoDEX id (0 when unknown): one live bot per account and market, so this is a bot's own log. */
  symbolId?: number;
}

/** The store id of one account's log in a region. */
export const accountLogId = (regionId: string, accountId: number, symbolId?: number): string => (symbolId ? `${regionId}:${accountId}:${symbolId}` : `${regionId}:${accountId}`);

/** Place: POST .../trade/orders (and its batch, modify, replace). Cancel: DELETE .../trade/orders (and batch), schedule-cancel. Else null (leverage, margin). */
export function classifyWrite(method: string, path: string): WriteKind | null {
  const m = method.toUpperCase();
  const p = path.split('?')[0]!.toLowerCase();
  if (!/\/trade\/orders(\/|$)/.test(p)) return null;
  if (m === 'DELETE' || /cancel/.test(p)) return 'cancel';
  if (m === 'POST') return 'place';
  return null;
}

/* ------------------------------------------------------------- histogram ----- */

const LINEAR = 100; // 1 ms bins below this
const RATIO = Math.log(1.01);
const MAX_MS = 120_000;
const MAX_BIN = LINEAR + Math.ceil(Math.log(MAX_MS / LINEAR) / RATIO);

export function binOf(ms: number): number {
  const v = Number.isFinite(ms) ? Math.max(0, Math.min(MAX_MS, ms)) : MAX_MS;
  if (v < LINEAR) return Math.floor(v);
  return Math.min(MAX_BIN, LINEAR + Math.floor(Math.log(v / LINEAR) / RATIO));
}

/** The value a bin stands for: its middle (geometric above 100 ms). */
export function binValue(b: number): number {
  if (b < LINEAR) return b + 0.5;
  return LINEAR * Math.exp((b - LINEAR + 0.5) * RATIO);
}

/** Sparse counts per bin. */
export class Hist {
  readonly bins = new Map<number, number>();
  n = 0;

  add(ms: number): void {
    const b = binOf(ms);
    this.bins.set(b, (this.bins.get(b) ?? 0) + 1);
    this.n++;
  }

  merge(o: Hist): this {
    for (const [b, c] of o.bins) this.bins.set(b, (this.bins.get(b) ?? 0) + c);
    this.n += o.n;
    return this;
  }

  /** Nearest rank: the bin holding the ceil(p * n)-th sample, in ms to 0.1; null when empty. */
  quantile(p: number): number | null {
    if (!this.n) return null;
    const rank = Math.max(1, Math.ceil(p * this.n));
    let seen = 0;
    for (const b of [...this.bins.keys()].sort((x, y) => x - y)) {
      seen += this.bins.get(b)!;
      if (seen >= rank) return Math.round(binValue(b) * 10) / 10;
    }
    return null;
  }

  /** "bin:count,bin:count" (compact, for the database). */
  encode(): string {
    return [...this.bins].sort((x, y) => x[0] - y[0]).map(([b, c]) => `${b}:${c}`).join(',');
  }

  static decode(s: string): Hist {
    const h = new Hist();
    for (const part of s.split(',')) {
      const [b, c] = part.split(':').map(Number);
      if (!Number.isSafeInteger(b) || !Number.isSafeInteger(c) || b! < 0 || c! <= 0) continue;
      h.bins.set(b!, (h.bins.get(b!) ?? 0) + c!);
      h.n += c!;
    }
    return h;
  }
}

/* ----------------------------------------------------------------- store ----- */

export interface LatencyRow {
  region: string;
  t: number;
  kind: WriteKind;
  n: number;
  hist: string;
}

/** Where buckets are kept (ExecutorDb). */
export interface LatencyStore {
  saveLatency(rows: LatencyRow[]): void;
  loadLatency(since: number): LatencyRow[];
}

export interface LatencyRegion {
  id: string;
  label: string;
  where: string;
}

/** GET /api/copy/v1/bots/latency (docs/BOTS-UI.md). */
export interface BotLatencyResponse {
  at: number;
  bucketMs: number;
  regions: Array<{
    id: string;
    label: string;
    where: string;
    buckets: Array<{ t: number; n: number; p50: number | null; p95: number | null; p99: number | null }>;
    now: { p50: number | null; p95: number | null; p99: number | null; n: number };
    kinds: { place: { p50: number | null; n: number }; cancel: { p50: number | null; n: number } };
  }>;
}

/** hours from a query string: a whole number 1..48 (clamped), 24 when missing or unreadable. */
export function clampHours(v: string | null | undefined): number {
  const n = v === null || v === undefined || v.trim() === '' ? NaN : Number(v);
  if (!Number.isFinite(n)) return 24;
  return Math.max(1, Math.min(48, Math.round(n)));
}

type Bucket = Record<WriteKind, Hist>;
const emptyBucket = (): Bucket => ({ place: new Hist(), cancel: new Hist() });

/** The last 10 minutes as raw samples (the "now" figures), capped. */
const RECENT_CAP = 50_000;

class RegionLog {
  readonly buckets = new Map<number, Bucket>();
  /** The open bucket's start; buckets before it are closed. */
  open = 0;
  readonly recent: Array<{ at: number; ms: number }> = [];
  constructor(readonly region: LatencyRegion) {}
}

export class WriteLatency {
  private readonly logs = new Map<string, RegionLog>();
  /** Per account, keyed by accountLogId: created on its first write (or read back from the store). */
  private readonly accounts = new Map<string, RegionLog>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    regions: readonly LatencyRegion[],
    private readonly store: LatencyStore | null,
    private readonly now: () => number = Date.now,
    private readonly onError: (e: unknown) => void = () => {},
  ) {
    const open = Math.floor(this.now() / LATENCY_BUCKET_MS) * LATENCY_BUCKET_MS;
    for (const r of regions) {
      const log = new RegionLog(r);
      log.open = open;
      this.logs.set(r.id, log);
    }
    this.load();
  }

  /** Read the last 48 h back from the store. */
  private load(): void {
    if (!this.store) return;
    try {
      const since = this.now() - LATENCY_KEEP_MS;
      for (const row of this.store.loadLatency(since)) {
        const log = this.logs.get(row.region) ?? this.accountLog(row.region);
        if (!log || !KINDS.includes(row.kind)) continue;
        let b = log.buckets.get(row.t);
        if (!b) log.buckets.set(row.t, (b = emptyBucket()));
        b[row.kind] = Hist.decode(row.hist);
      }
    } catch (e) {
      this.onError(e);
    }
  }

  /** An account's log for a store id "region:accountId" (created when its region exists), or null. */
  private accountLog(id: string, create = true): RegionLog | null {
    const have = this.accounts.get(id);
    if (have || !create) return have ?? null;
    const m = /^([^:]+):(\d+)(?::(\d+))?$/.exec(id);
    const region = m ? this.logs.get(m[1]!) : undefined;
    if (!region || Number(m![2]) <= 0) return null;
    const log = new RegionLog({ ...region.region, id });
    log.open = region.open;
    this.accounts.set(id, log);
    return log;
  }

  /** One answered write. Never throws. */
  record(regionId: string, w: WriteTiming): void {
    try {
      const kind = classifyWrite(w.method, w.path);
      const log = this.logs.get(regionId);
      if (!kind || !log) return;
      const ms = Math.max(0, (Number(w.queueMs) || 0) + (Number(w.wireMs) || 0));
      const at = this.now();
      this.add(log, kind, ms, at);
      const aid = Number(w.accountId) || 0;
      if (aid > 0) {
        const own = this.accountLog(accountLogId(regionId, aid));
        if (own) this.add(own, kind, ms, at);
        const sid = Number(w.symbolId) || 0;
        const bot = sid > 0 ? this.accountLog(accountLogId(regionId, aid, sid)) : null;
        if (bot) this.add(bot, kind, ms, at);
      }
    } catch (e) {
      this.onError(e);
    }
  }

  private add(log: RegionLog, kind: WriteKind, ms: number, at: number): void {
    this.roll(log, at);
    let b = log.buckets.get(log.open);
    if (!b) log.buckets.set(log.open, (b = emptyBucket()));
    b[kind].add(ms);
    log.recent.push({ at, ms });
    while (log.recent.length && log.recent[0]!.at <= at - LATENCY_BUCKET_MS) log.recent.shift();
    if (log.recent.length > RECENT_CAP) log.recent.splice(0, log.recent.length - RECENT_CAP);
  }

  /** Move the open bucket to now: the ones that closed are written, the ones older than 48 h leave memory. */
  private roll(log: RegionLog, at: number): void {
    const open = Math.floor(at / LATENCY_BUCKET_MS) * LATENCY_BUCKET_MS;
    if (open === log.open) return;
    const closed = [...log.buckets.keys()].filter((t) => t >= log.open && t < open);
    this.save(log, closed);
    log.open = open;
    for (const t of log.buckets.keys()) if (t < at - LATENCY_KEEP_MS - LATENCY_BUCKET_MS) log.buckets.delete(t);
  }

  private save(log: RegionLog, ts: number[]): void {
    if (!this.store || !ts.length) return;
    try {
      const rows: LatencyRow[] = [];
      for (const t of ts) {
        const b = log.buckets.get(t);
        if (!b) continue;
        for (const kind of KINDS) if (b[kind].n) rows.push({ region: log.region.id, t, kind, n: b[kind].n, hist: b[kind].encode() });
      }
      if (rows.length) this.store.saveLatency(rows);
    } catch (e) {
      this.onError(e);
    }
  }

  /** A minute timer that writes buckets that closed while no write came. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref?.();
  }

  tick(): void {
    try {
      const at = this.now();
      for (const log of this.logs.values()) this.roll(log, at);
      for (const [id, log] of this.accounts) {
        this.roll(log, at);
        // Nothing left in 48 h: the account's log leaves memory (its rows stay in the store).
        if (!log.buckets.size && !log.recent.length) this.accounts.delete(id);
      }
    } catch (e) {
      this.onError(e);
    }
  }

  /** Write what closed and the open bucket (a stop or restart keeps it). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tick();
    for (const log of this.logs.values()) this.save(log, [log.open]);
    for (const log of this.accounts.values()) this.save(log, [log.open]);
  }

  /**
   * The chart's answer. With accountIds: only those accounts' writes, per region (a user's own bots); without: the
   * whole region (operators, tests).
   */
  view(hours: number, accountIds?: readonly number[], symbolId?: number): BotLatencyResponse {
    const at = this.now();
    const h = Math.max(1, Math.min(48, Math.round(hours) || 24));
    const open = Math.floor(at / LATENCY_BUCKET_MS) * LATENCY_BUCKET_MS;
    const slots = h * (3_600_000 / LATENCY_BUCKET_MS);
    const regions: BotLatencyResponse['regions'] = [];
    for (const base of this.logs.values()) {
      const log = accountIds ? mergeLogs(base, accountIds.map((a) => this.accountLog(accountLogId(base.region.id, a, symbolId), false)).filter((x): x is RegionLog => !!x)) : base;
      const buckets: BotLatencyResponse['regions'][number]['buckets'] = [];
      for (let i = slots - 1; i >= 0; i--) {
        const t = open - i * LATENCY_BUCKET_MS;
        const b = log.buckets.get(t);
        const all = b ? new Hist().merge(b.place).merge(b.cancel) : new Hist();
        buckets.push({ t, n: all.n, p50: all.quantile(0.5), p95: all.quantile(0.95), p99: all.quantile(0.99) });
      }
      // "Now" is the last minute (owner 2026-11-09: the figure did not move); with fewer than 5 writes in it, the
      // last 10 minutes, so a quiet bot still shows a figure.
      let recent = new Hist();
      for (const s of log.recent) if (s.at > at - LATENCY_NOW_MS) recent.add(s.ms);
      if (recent.n < 5) {
        recent = new Hist();
        for (const s of log.recent) if (s.at > at - LATENCY_BUCKET_MS) recent.add(s.ms);
      }
      const hour = emptyBucket();
      for (const [t, b] of log.buckets) {
        if (t + LATENCY_BUCKET_MS <= at - 3_600_000) continue;
        hour.place.merge(b.place);
        hour.cancel.merge(b.cancel);
      }
      regions.push({
        id: base.region.id,
        label: base.region.label,
        where: base.region.where,
        buckets,
        now: { p50: recent.quantile(0.5), p95: recent.quantile(0.95), p99: recent.quantile(0.99), n: recent.n },
        kinds: { place: { p50: hour.place.quantile(0.5), n: hour.place.n }, cancel: { p50: hour.cancel.quantile(0.5), n: hour.cancel.n } },
      });
      // The raw samples older than 10 minutes are no longer needed.
      if (!accountIds) {
        const keepFrom = log.recent.findIndex((s) => s.at > at - LATENCY_BUCKET_MS);
        if (keepFrom > 0) log.recent.splice(0, keepFrom);
        else if (keepFrom < 0) log.recent.length = 0;
      }
    }
    return { at, bucketMs: LATENCY_BUCKET_MS, regions };
  }
}

/** One view over several accounts' logs in a region (a wallet with more than one account); the one log as it is. */
function mergeLogs(base: RegionLog, logs: RegionLog[]): RegionLog {
  if (logs.length === 1) return logs[0]!;
  const out = new RegionLog(base.region);
  out.open = base.open;
  for (const l of logs) {
    for (const [t, b] of l.buckets) {
      let o = out.buckets.get(t);
      if (!o) out.buckets.set(t, (o = emptyBucket()));
      for (const k of KINDS) o[k].merge(b[k]);
    }
    out.recent.push(...l.recent);
  }
  return out;
}
