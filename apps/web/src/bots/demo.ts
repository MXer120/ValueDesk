/**
 * Demo data for the Bots section (owner 2026-11-07: "a switch in the top right, on by default, which displays dummy
 * data everywhere so I can see everything styled"). Local builds only (BOTS_ON): a fleet of example bots in every
 * state, their books and series, trades and log, and a latency series with a slow stretch and quiet gaps. Seeded,
 * so a reload shows the same fleet. Nothing here reaches an executor: the page's actions change this list only.
 */
import { parseAlgoSpec, type AlgoEvent, type AlgoRecord, type AlgoView } from '@copy-engine';
import { draftFor, specOf, type Strategy } from './presets';
import type { BotLatencyResponse, LatencyBucket } from './data';

const KEY = 'vd.bots.demo';
export const demoDefault = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
};
export const saveDemo = (on: boolean): void => {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* private mode: for this page only */
  }
};

/** A small seeded random (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Seed {
  id: string;
  name: string;
  symbol: string;
  price: number;
  strategy: Strategy;
  status: AlgoRecord['status'];
  hours: number;
  volH: number;
  costBps: number;
  paper?: boolean;
  gate?: boolean;
  hold?: number;
  reason?: string;
}

const SEEDS: Seed[] = [
  { id: 'demo-btc', name: 'BTC maker', symbol: 'BTC-USD', price: 75_940, strategy: 'market', status: 'running', hours: 52, volH: 2_400, costBps: 1.86, gate: true, hold: 0.4 },
  { id: 'demo-eth', name: 'ETH weekend', symbol: 'ETH-USD', price: 2_244, strategy: 'market', status: 'running', hours: 30, volH: 1_900, costBps: 1.18, hold: -0.25 },
  { id: 'demo-koru', name: 'KORU', symbol: 'KORU-USD', price: 6.99, strategy: 'market', status: 'running', hours: 6, volH: 420, costBps: -3.6, hold: 0.7 },
  { id: 'demo-sol', name: 'SOL maker', symbol: 'SOL-USD', price: 186.2, strategy: 'market', status: 'paused', hours: 20, volH: 800, costBps: 2.1, hold: 0, reason: 'Paused by you.' },
  { id: 'demo-zec', name: 'ZEC grid', symbol: 'ZEC-USD', price: 1_289, strategy: 'grid', status: 'running', hours: 14, volH: 300, costBps: 0.9, hold: 0.35 },
  { id: 'demo-hype', name: 'HYPE', symbol: 'HYPE-USD', price: 78.06, strategy: 'market', status: 'waiting', hours: 1, volH: 0, costBps: 0, hold: 0, reason: 'Waits for the oracle price.' },
  { id: 'demo-lit', name: 'LIT practice', symbol: 'LIT-USD', price: 3.24, strategy: 'market', status: 'running', hours: 9, volH: 260, costBps: 1.4, paper: true, hold: -0.1 },
  { id: 'demo-xrp', name: 'XRP maker', symbol: 'XRP-USD', price: 2.41, strategy: 'market', status: 'cancelled', hours: 40, volH: 1_100, costBps: 2.4, hold: 0, reason: 'Stopped by you.' },
  { id: 'demo-nke', name: 'NKE', symbol: 'NKE-USD', price: 71.3, strategy: 'market', status: 'failed', hours: 3, volH: 150, costBps: 3.1, hold: 0, reason: 'Stopped: the loss limit of $3 was reached.' },
];

function viewOf(s: Seed, now: number): AlgoView {
  const r = rng([...s.id].reduce((x, c) => x * 31 + c.charCodeAt(0), 7));
  const startedAt = now - s.hours * 3_600_000;
  const ended = s.status === 'cancelled' || s.status === 'failed' || s.status === 'done';
  const endedAt = ended ? now - 2 * 3_600_000 : null;
  const d = { ...draftFor(s.strategy, 'balanced', s.symbol), label: s.name, paper: !!s.paper, gate: !!s.gate, orderUsd: 20, maxInventoryUsd: 60, maxLossUsd: s.status === 'failed' ? 3 : 50, ...(s.id === 'demo-btc' ? { volumeTargetUsd: 250_000 } : {}) };
  const spec = parseAlgoSpec(specOf(d, s.price));
  // The book's series: a point every 5 min, volume rising with the hours, PnL a noisy walk toward -cost x volume.
  const series: Array<[number, number, number, number]> = [];
  const span = (endedAt ?? now) - startedAt;
  const n = Math.max(2, Math.min(600, Math.floor(span / 300_000)));
  let vol = 0;
  let pnl = 0;
  for (let i = 0; i <= n; i++) {
    const t = startedAt + (span * i) / n;
    const hour = new Date(t).getUTCHours();
    const busy = 0.6 + 0.8 * Math.max(0, Math.sin(((hour - 6) / 24) * Math.PI * 2));
    const dv = s.status === 'waiting' ? 0 : (s.volH / 12) * busy * (0.4 + r() * 1.2);
    vol += dv;
    pnl += -(s.costBps / 10_000) * dv + (r() - 0.5) * dv * 0.0009;
    series.push([Math.round(t), Math.round(vol * 100) / 100, Math.round(pnl * 10_000) / 10_000, Math.round(vol * 0.00013 * 10_000) / 10_000]);
  }
  const fees = vol * 0.00013;
  const inventoryUsd = ended ? 0 : (s.hold ?? 0) * d.maxInventoryUsd;
  const half = s.price * 0.00006;
  const live = !ended && s.status !== 'paused' && s.status !== 'waiting';
  const algo = {
    id: s.id,
    owner: '0xdemo',
    accountId: 1,
    mode: 'hosted',
    spec,
    status: s.status,
    statusReason: s.reason ?? null,
    createdAt: startedAt - 60_000,
    updatedAt: now,
    startedAt,
    endedAt,
    parentId: null,
    consent: null,
    seed: 1,
    filled: 0,
    filledValue: vol,
    makerQty: 0,
    fees,
    arrival: s.price,
    marketQty: 0,
    marketValue: 0,
    children: [],
    childCount: 0,
    rejects: 0,
    exitOrders: [],
    country: null,
    observedCountry: null,
    k: {},
    book: { buyQty: 0, buyValue: vol / 2, sellQty: 0, sellValue: vol / 2, makerValue: vol, takerValue: 0, tradeFees: vol * 0.00012, builderFees: vol * 0.00001, fills: Math.round(vol / 20), series },
  } as unknown as AlgoRecord;
  return {
    algo,
    target: null, progress: 0, avgPrice: null, vsArrivalBps: null, vsMarketVwapBps: null, marketVwap: null, nextAt: null, endsAt: null,
    working: live ? (s.strategy === 'grid' ? '6 levels resting' : '2 orders working') : null,
    triggerPrice: null, conditions: null, exits: null, legs: null,
    bot: {
      volume: vol,
      inventory: inventoryUsd / s.price,
      inventoryUsd,
      grossPnl: pnl + fees,
      netPnl: pnl,
      tradeFees: vol * 0.00012,
      builderFees: vol * 0.00001,
      makerShare: 1,
      costPerMillion: vol >= 1 ? (-pnl / vol) * 1_000_000 : null,
      fills: Math.round(vol / 20),
      mark: s.price,
      orders: live
        ? s.strategy === 'grid'
          ? [-3, -2, -1, 1, 2, 3].map((k) => ({ side: k < 0 ? ('buy' as const) : ('sell' as const), price: onTick(s.price * (1 + k * 0.004), s.price, k < 0 ? -1 : 1), quantity: Math.round((20 / s.price) * 1e5) / 1e5, tag: `g${k}` }))
          : [{ side: 'buy' as const, price: onTick(s.price - half, s.price, -1), quantity: Math.round((20 / s.price) * 1e5) / 1e5, tag: 'b' }, { side: 'sell' as const, price: onTick(s.price + half, s.price, 1), quantity: Math.round((20 / s.price) * 1e5) / 1e5, tag: 's' }]
        : [],
      closing: false,
      // The Watchdog as a healthy example bot reads it (an oracle maker; a grid or book maker has none).
      health: {
        at: now,
        checks: live
          ? [
            { id: 'loop', label: 'Bot loop', state: 'ok', value: 'last step 0.4 s ago' },
            { id: 'service', label: 'ValueDesk service', state: 'ok', value: 'running' },
            { id: 'book', label: 'SoDEX price', state: 'ok', value: 'live, last change 0.2 s ago' },
            s.strategy === 'grid'
              ? { id: 'oracle', label: 'Oracle price', state: 'off', value: 'not used by this bot' }
              : { id: 'oracle', label: 'Oracle price', state: 'ok', value: 'live, last change 0.1 s ago' },
            { id: 'fills', label: 'Fills booked', state: 'ok', value: '180 ms after the trade' },
            { id: 'orders', label: 'Order updates', state: 'ok', value: 'live from SoDEX, 140 ms late' },
            { id: 'position', label: 'Holding = SoDEX', state: 'ok', value: 'matched 4 s ago' },
            { id: 'key', label: 'Trading key', state: 'ok', value: '164 days left' },
            { id: 'refusals', label: 'SoDEX refusals (1 h)', state: 'ok', value: '3 handled' },
            { id: 'hold', label: 'Quoting', state: 'ok', value: 'quoting' },
          ]
          : [{ id: 'loop', label: 'Bot loop', state: 'off', value: 'stopped' }],
      },
      // Example split: a bot that earns was taken mostly by uninformed flow.
      takers: vol > 0 ? { t1002: vol * (pnl > 0 ? 0.62 : 0.34), t23342: vol * (pnl > 0 ? 0.24 : 0.55), other: vol * (pnl > 0 ? 0.14 : 0.11) } : undefined,
    },
  };
}

/** The example fleet, now. */
export function demoBots(now = Date.now()): AlgoView[] {
  return SEEDS.map((s) => viewOf(s, now));
}

/** A new example bot from a spec the page would have sent (New bot, a restart). */
export function demoStarted(spec: Record<string, unknown>, now = Date.now()): AlgoView {
  const id = `demo-${Math.round(now).toString(36)}`;
  const v = viewOf({ id, name: String(spec.label ?? 'New bot'), symbol: String(spec.symbol ?? 'BTC-USD'), price: 100, strategy: spec.kind === 'grid' ? 'grid' : 'market', status: 'running', hours: 0.02, volH: 0, costBps: 0, paper: !!spec.paper }, now);
  v.algo.spec = parseAlgoSpec(spec);
  return v;
}

/** Its fills and log. */
export function demoEvents(v: AlgoView, now = Date.now()): AlgoEvent[] {
  const r = rng(v.algo.id.length * 977);
  const out: AlgoEvent[] = [];
  const px = v.bot?.mark ?? 100;
  const start = v.algo.startedAt ?? now;
  out.push({ id: `${v.algo.id}-s`, algoId: v.algo.id, owner: v.algo.owner, at: start, kind: 'status', text: 'Started.' } as AlgoEvent);
  for (let i = 0; i < 40; i++) {
    const at = now - i * 7 * 60_000 - Math.round(r() * 300_000);
    if (at < start) break;
    const side = r() > 0.5 ? 'buy' : 'sell';
    const price = onTick(px * (1 + (r() - 0.5) * 0.002), px, 1);
    const qty = Math.round((20 / px) * 1e5) / 1e5;
    if (i % 5 === 3) out.push({ id: `${v.algo.id}-c${i}`, algoId: v.algo.id, owner: v.algo.owner, at, kind: 'cancel', text: `Pulled the ${side} at ${price}: the price moved.` } as AlgoEvent);
    else out.push({ id: `${v.algo.id}-f${i}`, algoId: v.algo.id, owner: v.algo.owner, at, kind: 'fill', side, price, qty, text: `Filled ${side} ${qty} at ${price} (maker).` } as AlgoEvent);
  }
  return out.sort((a, b) => b.at - a.at);
}

/** A demo price on a 5-digit tick, buys rounded down and sells up, so a bid never meets the ask on a cheap coin. */
function onTick(x: number, ref: number, dir: -1 | 1): number {
  const step = 10 ** (Math.floor(Math.log10(ref)) - 3);
  const n = dir < 0 ? Math.floor(x / step) : Math.ceil(x / step);
  return Number((n * step).toPrecision(8));
}

/** 48 h of latency: steady around 300 ms, one slow stretch, a quiet night with no orders. */
export function demoLatency(now = Date.now(), seed = 3): BotLatencyResponse {
  const r = rng(seed);
  const B = 600_000;
  const open = Math.floor(now / B) * B;
  const buckets: LatencyBucket[] = [];
  for (let i = 287; i >= 0; i--) {
    const t = open - i * B;
    const h = (t / 3_600_000) % 24;
    const quiet = (i > 150 && i < 172) || (i > 40 && i < 46);
    const slow = i > 60 && i < 72;
    if (quiet) { buckets.push({ t, n: 0, p50: null, p95: null, p99: null }); continue; }
    const base = 290 + 25 * Math.sin((h / 24) * Math.PI * 2) + r() * 20;
    const k = slow ? 1.9 + r() * 0.6 : 1;
    buckets.push({ t, n: 40 + Math.round(r() * 80), p50: Math.round(base * k), p95: Math.round((base + 90 + r() * 40) * k), p99: Math.round((base + 210 + r() * 120) * k) });
  }
  const last = buckets[buckets.length - 1]!;
  return {
    at: now,
    bucketMs: B,
    regions: [{ id: 'tokyo', label: 'Tokyo · SoDEX', where: 'Tokyo (Contabo)', buckets, now: { p50: last.p50, p95: last.p95, p99: last.p99, n: last.n }, kinds: { place: { p50: last.p50, n: 300 }, cancel: { p50: 34, n: 120 } } }],
  };
}
