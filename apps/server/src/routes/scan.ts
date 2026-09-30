/**
 * Backend for the ported Scan page (web/public/scan/) - implements the exact
 * `/api/scan/*` contract that page's own scan.js already calls, unmodified,
 * so the page needed zero changes beyond its colour theme to run standalone
 * against this backend instead of the dashboard it was copied from.
 *
 * Every route here mirrors a specific function in that dashboard's own
 * adapters.py, verified against the live upstream before being written, not
 * guessed from the frontend's usage alone:
 *   scan_wallet        -> GET /api/scan            (CommunityScan mirror + live overlay)
 *   scan_trades        -> GET /api/scan/trades
 *   scan_funding       -> GET /api/scan/funding
 *   scan_prices        -> GET /api/scan/prices
 *   fee_rates          -> GET /api/scan/feerates
 *   scan_windows       -> GET /api/scan/windows
 *   scan_live          -> GET /api/scan/live
 *   fee_schedule       -> GET /api/scan/feeschedule
 *   track_list/series/start/stop -> GET/POST /api/scan/track*
 *   account_lookup     -> GET /api/feed/account     (cmdk.js's own account-id resolver)
 */
import type { FastifyInstance } from 'fastify';
import { sodex, unwrapList, weightFor } from '../sodex/rest.js';
import { enginePath, NET } from '../config.js';
import { depositRegistry, fromBaseUnits, tokenBalance, resolveAccountOnChain } from '../sodex/chain.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DATA_API = process.env.SODEX_DATA_API?.trim() || NET.restBase.replace('-gw.', '-data.');
const SCAN_BASE = process.env.COMMUNITYSCAN_BASE?.trim() || 'https://www.communityscan-sodex.com';
const TIMEOUT_MS = 20_000;

function requireAddress(q: Record<string, string | undefined>): string {
  if (!q.address || !ADDRESS_RE.test(q.address)) {
    throw Object.assign(new Error('a valid 0x wallet address is required'), { statusCode: 400 });
  }
  return q.address;
}

// --- tiny per-route cache, same shape as external.ts's own -------------------
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().then((v) => { cache.set(key, { at: Date.now(), value: v }); return v; }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : null; } catch { throw new Error(`non-JSON response (HTTP ${res.status}) from ${url}`); }
  if (!res.ok) throw new Error(body?.error || body?.message || `HTTP ${res.status} from ${url}`);
  return body as T;
}

/** The one third-party call every wallet-history section depends on - see the
 *  header comment. Cached 45s, matching the source dashboard's own TTL for it. */
function scanWallet(address: string): Promise<any> {
  return cached(`scanwallet:${address.toLowerCase()}`, 45_000, () =>
    fetchJson(`${SCAN_BASE}/api/public/wallet/${address}`));
}

// --- live overlay: what /api/scan and /api/scan/live both merge in ----------

async function vusdcOnChain(address: string): Promise<number | null> {
  try {
    const asset = (await depositRegistry()).assets.find((a) => a.symbol.toLowerCase() === 'vusdc' || a.symbol.toLowerCase() === 'usdc');
    if (!asset || asset.isNative) return null;
    const raw = await tokenBalance(asset.address, address);
    return Number(fromBaseUnits(raw, asset.decimals));
  } catch {
    return null; // best-effort - an RPC hiccup here should not sink the whole page
  }
}

async function livePerps(address: string): Promise<any> {
  const [state, posRaw, ordersRaw, spotBalRaw, marks, evm] = await Promise.all([
    sodex.get<any>(`${enginePath('perps')}/accounts/${address}/state`).catch(() => null),
    sodex.get(`${enginePath('perps')}/accounts/${address}/positions`).then((d) => unwrapList<any>(d, 'positions')).catch(() => []),
    sodex.get(`${enginePath('perps')}/accounts/${address}/orders`).then((d) => unwrapList<any>(d, 'orders')).catch(() => []),
    sodex.get(`${enginePath('spot')}/accounts/${address}/balances`).then((d) => unwrapList<any>(d, 'balances')).catch(() => []),
    sodex.get<any[]>(`${enginePath('perps')}/markets/mark-prices`).catch(() => []),
    vusdcOnChain(address),
  ]);
  const markBySymbol = new Map((Array.isArray(marks) ? marks : []).map((m: any) => [m.symbol ?? m.s, Number(m.markPrice ?? m.p)]));
  const positions = posRaw
    .filter((p: any) => Number(p.positionSize ?? p.size) !== 0)
    .map((p: any) => {
      const size = Number(p.positionSize ?? p.size);
      const side = Number(p.positionSide) === 2 ? 'LONG' : 'SHORT';
      const mark = markBySymbol.get(p.symbol) ?? null;
      const entry = Number(p.entryPrice ?? p.avgEntryPrice) || null;
      const notional = mark != null ? Math.abs(size) * mark : entry != null ? Math.abs(size) * entry : null;
      return {
        symbol: p.symbol, side, size: Math.abs(size), notional, entry, mark,
        leverage: Number(p.leverage) || null,
        upnl: p.unrealizedProfit != null ? Number(p.unrealizedProfit) : null,
        liq: p.liquidationPrice != null ? Number(p.liquidationPrice) : null,
        margin: p.isolatedMargin != null ? Number(p.isolatedMargin) : null,
        funding: null,
      };
    });
  let dailyStats: any[] = [];
  if (state?.aid) {
    try {
      const d = await fetchJson<any>(`${DATA_API}/api/v1/perps/pnl/daily_stats?account_id=${state.aid}`);
      /*
     * The gateway wraps this one as `{code, message, data: {items: [...]}}` -
     * the series is under data.ITEMS, not under data. Reading `d.data` as an
     * array therefore always failed both branches and left dailyStats empty, so
     * the scan page silently fell back to the CommunityScan mirror on every
     * request and the "prefer official /pnl/daily_stats" comment above was
     * never true. routes/stats.ts:173 already reads the correct shape.
     */
    dailyStats = Array.isArray(d?.data?.items)
      ? d.data.items
      : Array.isArray(d?.data) ? d.data
      : Array.isArray(d) ? d
      : [];
    } catch { /* optional overlay - the base scan payload already has a daily series */ }
  }
  const avail = state?.av != null ? Number(state.av) : null;
  const accMargin = state?.am != null ? Number(state.am) : null;
  const grossExposure = positions.reduce((s: number, p: any) => s + Math.abs(p.notional || 0), 0);
  return {
    account: {
      value: accMargin, available: avail, exposure: grossExposure,
      upnl: positions.reduce((s: number, p: any) => s + (p.upnl || 0), 0) || null,
      margin_usage: null, spot_value: null, futures_value: accMargin, evm_value: evm,
    },
    positions, orders: ordersRaw, spot_balances: spotBalRaw, daily: dailyStats,
  };
}

// --- fee schedule (heaviest route: scans recent trades for maker share) -----

async function makerShare(address: string): Promise<{ pct: number | null; sample: number }> {
  try {
    const path = `${enginePath('perps')}/accounts/${address}/trades?limit=1000`;
    const data = await sodex.get(path, weightFor(path, 1000));
    const trades = unwrapList<any>(data, 'trades');
    if (!trades.length) return { pct: null, sample: 0 };
    let makerQ = 0, totalQ = 0;
    for (const t of trades) {
      const q = Number(t.price) * Number(t.quantity) || 0;
      totalQ += q;
      if (t.isMaker) makerQ += q;
    }
    return { pct: totalQ > 0 ? (makerQ / totalQ) * 100 : null, sample: trades.length };
  } catch {
    return { pct: null, sample: 0 };
  }
}

let platformVol14d: { at: number; value: number | null } = { at: 0, value: null };
/**
 * Sum of per-market platform volume over the trailing 14 COMPLETE UTC days
 * (ending yesterday - including today's partial day would undercount).
 * Ported from the source dashboard's `_official_platform_vol14()`; the
 * endpoint double-wraps its payload as `{data: {data: [...]}}` (the outer
 * envelope every gateway response uses, plus this endpoint's own unrelated
 * `data` key for the day list), confirmed against the live response rather
 * than assumed.
 */
async function platformVolume14d(): Promise<number | null> {
  if (Date.now() - platformVol14d.at < 3_600_000) return platformVol14d.value;
  try {
    const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const startDate = fmt(Date.now() - 14 * 86_400_000);
    const endDate = fmt(Date.now() - 86_400_000);
    const resp = await fetchJson<any>(`${DATA_API}/api/v1/dashboard/volume?start_date=${startDate}&end_date=${endDate}`);
    const days: any[] = resp?.data?.data ?? [];
    let total = 0;
    for (const day of days) {
      for (const v of Object.values(day?.markets ?? {})) total += Number(v) || 0;
    }
    platformVol14d = { at: Date.now(), value: total > 0 ? total : null };
  } catch {
    platformVol14d = { at: Date.now(), value: null };
  }
  return platformVol14d.value;
}

/**
 * account_id -> wallet address, from the public leaderboard's own top-500
 * (7D volume) listing - ported from the source dashboard's `_lb_map()`. This
 * is the authoritative source for any account that IS listed there: the
 * address comes straight from SoDEX's own leaderboard data, not inferred
 * from decoded deposit logs. `resolveAccountOnChain` below is only a
 * fallback for accounts absent from this map (typically internal market
 * makers), where no authoritative address exists and a best-effort guess is
 * the only option. Skipping straight to that fallback for a listed account
 * is how a wrong-but-plausible address gets returned instead of the real
 * one - this map exists so `/api/feed/account` never has to.
 */
interface LbEntry { address: string; vol7d: number | null; pnl7d: number | null; rank: number | null }
let lbMapCache: { at: number; map: Map<number, LbEntry> } | null = null;
const LB_MAP_TTL = 600_000;

async function leaderboardMap(): Promise<Map<number, LbEntry>> {
  if (lbMapCache && Date.now() - lbMapCache.at < LB_MAP_TTL) return lbMapCache.map;
  const pages = await Promise.all(
    Array.from({ length: 25 }, (_, i) => i + 1).map((page) => {
      const params = new URLSearchParams({
        window_type: '7D', sort_by: 'volume', sort_order: 'desc', page: String(page), pageSize: '20',
      });
      return fetchJson<any>(`${DATA_API}/api/v1/leaderboard?${params}`).catch(() => null);
    }),
  );
  const map = new Map<number, LbEntry>();
  for (const j of pages) {
    // The gateway wraps every payload as {code, message, data: {...}} - the
    // items array is a level down from where a bare read of `j.items` looks.
    for (const it of j?.data?.items ?? []) {
      const accountId = it?.account_id;
      const addr = it?.wallet_address;
      if (accountId == null || !addr || !ADDRESS_RE.test(addr)) continue; // only trust well-formed addresses
      map.set(Number(accountId), {
        address: addr,
        vol7d: it.volume_usd != null ? Number(it.volume_usd) : null,
        pnl7d: it.pnl_usd != null ? Number(it.pnl_usd) : null,
        rank: it.rank ?? null,
      });
    }
  }
  lbMapCache = { at: Date.now(), map };
  return map;
}

// --- tracker: in-memory sampler (see track routes below) --------------------
interface TrackEntry { address: string; interval: number; started: number; points: Array<[number, number]> }
const TRACK_MAX = 6;
const tracked = new Map<string, TrackEntry>();
const trackTimers = new Map<string, ReturnType<typeof setInterval>>();

async function sampleOnce(address: string): Promise<void> {
  const e = tracked.get(address.toLowerCase());
  if (!e) return;
  try {
    const lv = await livePerps(address);
    const av = Number(lv.account.value) || 0;
    e.points.push([Date.now(), av]);
    if (e.points.length > 5000) e.points.splice(0, e.points.length - 5000);
  } catch { /* one failed sample should not stop tracking */ }
}
function startTracking(address: string, intervalSec: number): void {
  const key = address.toLowerCase();
  const existing = trackTimers.get(key);
  if (existing) clearInterval(existing);
  let e = tracked.get(key);
  if (!e) { e = { address, interval: intervalSec, started: Date.now(), points: [] }; tracked.set(key, e); }
  else e.interval = intervalSec;
  trackTimers.set(key, setInterval(() => void sampleOnce(address), Math.max(5, intervalSec) * 1000));
  void sampleOnce(address);
}
function stopTracking(address: string): void {
  const key = address.toLowerCase();
  const t = trackTimers.get(key);
  if (t) clearInterval(t);
  trackTimers.delete(key);
  // Points stay - matching the source dashboard's own "series file stays on
  // disk, history is kept" behaviour for stop (server/src equivalent here is
  // just in-memory, so history survives only until this process restarts).
}

export async function scanRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/scan', async (req, reply) => {
    const address = requireAddress(req.query as any);
    try {
      const [wallet, live] = await Promise.all([scanWallet(address), livePerps(address).catch(() => null)]);
      const data = { ...wallet };
      if (live) {
        data.data = { ...data.data };
        data.live_account = live.account;
        data.live_positions = live.positions;
        data.live_orders = live.orders;
        data.live_daily = live.daily;
      }
      return { ok: true, data };
    } catch (e) {
      return reply.code(200).send({ ok: false, error: (e as Error).message });
    }
  });

  const engineTrades = async (engine: 'perps' | 'spot', address: string) => {
    const path = `${enginePath(engine)}/accounts/${address}/trades?limit=1000`;
    const data = await sodex.get(path, weightFor(path, 1000));
    return unwrapList<any>(data, 'trades').map((t) => ({
      market: engine, symbol: t.symbol, side: t.side, price: t.price, qty: t.quantity,
      quote: Number(t.price) * Number(t.quantity) || null, fee: t.fee, fee_coin: t.feeCoin,
      maker: !!t.isMaker, time: t.time,
    }));
  };

  app.get('/api/scan/trades', async (req, reply) => {
    const address = requireAddress(req.query as any);
    try {
      const [perps, spot] = await Promise.all([engineTrades('perps', address), engineTrades('spot', address)]);
      return { ok: true, trades: [...perps, ...spot].sort((a, b) => Number(b.time) - Number(a.time)) };
    } catch (e) {
      return reply.code(200).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get('/api/scan/funding', async (req, reply) => {
    const address = requireAddress(req.query as any);
    const hours = Math.max(1, Number.parseInt((req.query as any).hours ?? '24', 10) || 24);
    try {
      const path = `${enginePath('perps')}/accounts/${address}/fundings?limit=1000`;
      const data = await sodex.get(path, weightFor(path, 1000));
      const cutoff = Date.now() - hours * 3_600_000;
      const rows = unwrapList<any>(data, 'fundings')
        .filter((f) => Number(f.timestamp) >= cutoff)
        .map((f) => ({ symbol: f.symbol, side: f.positionSide, fee: f.fundingFee, time: f.timestamp }));
      const net = rows.reduce((s, f) => s + (Number(f.fee) || 0), 0);
      return { ok: true, hours, net, fundings: rows };
    } catch (e) {
      return reply.code(200).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get('/api/scan/prices', async (_req, reply) => {
    try {
      const [marks, tickers] = await Promise.all([
        sodex.get<any[]>(`${enginePath('perps')}/markets/mark-prices`),
        sodex.get<any>(`${enginePath('spot')}/markets/tickers`).then((d) => unwrapList<any>(d, 'tickers')),
      ]);
      const prices: Record<string, number> = {};
      for (const m of Array.isArray(marks) ? marks : []) {
        const sym = String(m.symbol ?? m.s ?? '').split('-')[0];
        const px = Number(m.markPrice ?? m.p);
        if (sym && Number.isFinite(px)) prices[sym] = px;
      }
      for (const t of tickers) {
        const sym = String(t.symbol ?? '').split(/[-_]/)[0]?.replace(/^v/, '');
        const px = Number(t.lastPrice ?? t.close);
        if (sym && Number.isFinite(px) && !(sym in prices)) prices[sym] = px;
      }
      return { ok: true, prices };
    } catch (e) {
      return reply.code(200).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get('/api/scan/feerates', async (req, reply) => {
    const address = requireAddress(req.query as any);
    try {
      const [perps, spot] = await Promise.all([
        sodex.get<any>(`${enginePath('perps')}/accounts/${address}/fee-rate`),
        sodex.get<any>(`${enginePath('spot')}/accounts/${address}/fee-rate`),
      ]);
      const map = (r: any) => (r ? { maker: Number(r.makerFeeRate), taker: Number(r.takerFeeRate), rebate_tier: r.makerRebateTier ?? 0 } : null);
      return { ok: true, perps: map(perps), spot: map(spot) };
    } catch (e) {
      return reply.code(200).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get('/api/scan/windows', async (req, reply) => {
    const address = requireAddress(req.query as any);
    try {
      const rank = async (windowType: '7D' | '30D') => {
        const params = new URLSearchParams({ window_type: windowType, sort_by: 'volume', wallet_address: address });
        const j = await fetchJson<any>(`${DATA_API}/api/v1/leaderboard/rank?${params}`);
        return j?.data?.found ? j.data.item : null;
      };
      const [w7, w30] = await Promise.all([rank('7D'), rank('30D')]);
      return {
        ok: true,
        vol_7d: w7 ? Number(w7.volume_usd) : null, pnl_7d: w7 ? Number(w7.pnl_usd) : null, rank_7d: w7?.rank ?? null,
        vol_30d: w30 ? Number(w30.volume_usd) : null, pnl_30d: w30 ? Number(w30.pnl_usd) : null, rank_30d: w30?.rank ?? null,
      };
    } catch (e) {
      return reply.code(200).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get('/api/scan/live', async (req, reply) => {
    const address = requireAddress(req.query as any);
    try {
      const lv = await cached(`live:${address.toLowerCase()}`, 10_000, () => livePerps(address));
      return { ok: true, account: lv.account, positions: lv.positions, orders: lv.orders, spot_balances: lv.spot_balances, daily: lv.daily };
    } catch (e) {
      return reply.code(200).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get('/api/scan/feeschedule', async (req, reply) => {
    const address = requireAddress(req.query as any);
    try {
      const [feeRaw, windowsRes, maker, platformVol] = await Promise.all([
        Promise.all([
          sodex.get<any>(`${enginePath('perps')}/accounts/${address}/fee-rate`).catch(() => null),
          sodex.get<any>(`${enginePath('spot')}/accounts/${address}/fee-rate`).catch(() => null),
        ]),
        (async () => {
          const params = new URLSearchParams({ window_type: '7D', sort_by: 'volume', wallet_address: address });
          try { const j = await fetchJson<any>(`${DATA_API}/api/v1/leaderboard/rank?${params}`); return j?.data?.found ? j.data.item : null; }
          catch { return null; }
        })(),
        makerShare(address),
        platformVolume14d(),
      ]);
      const [perpsFee, spotFee] = feeRaw;
      return {
        ok: true,
        perps_maker: perpsFee ? Number(perpsFee.makerFeeRate) : null,
        perps_taker: perpsFee ? Number(perpsFee.takerFeeRate) : null,
        spot_maker: spotFee ? Number(spotFee.makerFeeRate) : null,
        spot_taker: spotFee ? Number(spotFee.takerFeeRate) : null,
        fee_tier: null,
        vol_7d: windowsRes ? Number(windowsRes.volume_usd) : null,
        vol_14d_est: windowsRes ? Number(windowsRes.volume_usd) * 2 : null,
        lb_rank: windowsRes?.rank ?? null,
        maker_share: maker.pct, maker_sample: maker.sample,
        platform_vol_14d: platformVol,
        maker_vol_14d: maker.pct != null && platformVol != null ? (maker.pct / 100) * platformVol : null,
        maker_share_of_platform: null,
        rebate_ladder: null,
      };
    } catch (e) {
      return reply.code(200).send({ ok: false, error: (e as Error).message });
    }
  });

  // --- tracker -----------------------------------------------------------
  app.get('/api/scan/track/list', async () => ({
    ok: true,
    wallets: [...tracked.values()].map((e) => ({ address: e.address, interval: e.interval, started: e.started, samples: e.points.length })),
  }));

  app.get('/api/scan/track/series', async (req, reply) => {
    const address = requireAddress(req.query as any);
    const since = Number.parseInt((req.query as any).since ?? '0', 10) || 0;
    const e = tracked.get(address.toLowerCase());
    if (!e) return reply.code(200).send({ ok: true, points: [], label: null, started: null, interval: null });
    const points = since ? e.points.filter(([t]) => t >= since) : e.points;
    return { ok: true, points, label: null, started: e.started, interval: e.interval };
  });

  app.post('/api/scan/track', async (req, reply) => {
    const body = req.body as { address?: string; interval?: number };
    if (!body?.address || !ADDRESS_RE.test(body.address)) return reply.code(400).send({ error: 'a valid 0x wallet address is required' });
    if (tracked.size >= TRACK_MAX && !tracked.has(body.address.toLowerCase())) {
      return reply.code(200).send({ ok: false, error: `at most ${TRACK_MAX} wallets can be tracked at once` });
    }
    startTracking(body.address, Math.max(30, Number(body.interval) || 60));
    return { ok: true };
  });

  app.post('/api/scan/track/stop', async (req, reply) => {
    const body = req.body as { address?: string };
    if (!body?.address || !ADDRESS_RE.test(body.address)) return reply.code(400).send({ error: 'a valid 0x wallet address is required' });
    stopTracking(body.address);
    return { ok: true };
  });

  // --- account id -> wallet (cmdk.js's own resolver, same response shape) ---
  // account_lookup() in the source dashboard checks its leaderboard map
  // FIRST and only falls back to the on-chain resolver when the account
  // isn't listed there - the map is authoritative where it has an answer.
  app.get('/api/feed/account', async (req, reply) => {
    const id = Number.parseInt((req.query as any).id ?? '', 10);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'a positive integer account id is required' });
    try {
      const lb = (await leaderboardMap()).get(id);
      if (lb) {
        return { ok: true, account_id: id, resolved: true, address: lb.address, source: 'leaderboard', verified: true };
      }
      const r = await resolveAccountOnChain(id);
      return { ok: r.ok, account_id: id, resolved: r.verified, address: r.address, source: 'onchain', verified: r.verified, error: r.error };
    } catch (e) {
      return reply.code(200).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get('/api/prefs', async () => ({}));
  app.post('/api/prefs', async () => ({ ok: true }));
}
