/**
 * The builder's numbers for the admin suite, from the builder ledger
 * (builder/store.ts, `builder.db`) - read-only here, the verifier stays its only
 * writer - and admin.db's copy of its counted orders.
 *
 * WHAT THE NUMBERS ARE (docs/BUILDER-TIERS.md §5): counted volume is the notional
 * of fills that paid OUR builder fee on orders the explorer showed to name our
 * builder at the fee owed. A fee earned is, per counted order, its counted
 * notional x the fee it names / 100 000 - exactly what SoDEX charges (counting.ts
 * readFill). Nothing here is estimated: a wallet the verifier has not counted
 * yet shows nothing, not a guess.
 *
 * WHY A COPY OF THE ORDERS: the ledger keeps at most 2,000 orders a wallet
 * (verifier.ts MAX_ORDER_ROWS) - enough to count volume, not to add up fees over
 * months. syncFeeOrders copies every counted order into admin.db (fee_orders),
 * which keeps them all; it runs every few minutes, far more often than a wallet
 * places 2,000 orders.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { decide } from '../builder/tiers.js';
import { dayOf } from '../builder/counting.js';
import type { TiersConfig } from '../builder/config.js';
import type { AdminStore, FeeOrder } from './store.js';

const COUNTED = 1; // counting.ts OrderState.counted
const DAY = 86_400_000;
/** An order counted earlier may still grow: each sync reads back this far before the newest it has seen. */
const SYNC_OVERLAP_MS = 2 * DAY;

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v ?? 0) || 0);

/** The ledger, read-only; null while it does not exist (the builder feature is off). */
export function openLedger(path: string): DatabaseSync | null {
  if (!existsSync(path)) return null;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    return db;
  } catch {
    return null;
  }
}

/** Copy the counted orders changed since the last sync into admin.db. How many rows were new or grew. */
export function syncFeeOrders(ledger: DatabaseSync, admin: AdminStore, builder: number): number {
  const key = `fee_orders.cursor.${builder}`;
  const cursor = Number(admin.getMeta(key) ?? 0);
  const rows = ledger.prepare(
    `SELECT address, engine, order_key, symbol, t, last_t, counted_micro, rate FROM orders
     WHERE builder = ? AND state = ? AND counted_micro > 0 AND last_t >= ?`,
  ).all(builder, COUNTED, Math.max(0, cursor - SYNC_OVERLAP_MS)) as Row[];
  const orders: FeeOrder[] = rows.map((r) => ({
    builder, address: String(r.address), engine: String(r.engine), orderKey: String(r.order_key), symbol: String(r.symbol),
    t: num(r.t), lastT: num(r.last_t), countedMicro: num(r.counted_micro), rate: num(r.rate),
  }));
  const n = admin.putFeeOrders(orders);
  const newest = orders.reduce((m, o) => Math.max(m, o.lastT), cursor);
  admin.setMeta(key, String(newest));
  return n;
}

export interface VolumeDay {
  day: number;
  /** micro-USD */
  perps: number;
  spot: number;
  feePerps: number;
  feeSpot: number;
  wallets: number;
}

export interface BuilderOverview {
  builderId: number;
  /** Counted volume, micro-USD: lifetime (since each wallet's row was made) and the last 1, 7 and 30 UTC days. */
  volume: { lifetime: { perps: number; spot: number }; d1: number; d7: number; d30: number };
  /** Fees earned, micro-USD, same windows. */
  fees: { lifetime: { perps: number; spot: number }; d1: number; d7: number; d30: number };
  wallets: { total: number; traded7d: number; traded30d: number; flagged: number };
  /** Wallets per tier index (the tier the volume window puts them on). */
  tiers: Array<{ index: number; minVolumeUsd: number; perps: number; spot: number; wallets: number }>;
  days: VolumeDay[];
  ledgerSince: number | null;
}

/** The overview for `cfg.builderId`: totals, windows, a day series of `days` UTC days. */
export function builderOverview(ledger: DatabaseSync, admin: AdminStore, cfg: TiersConfig, now: number, days = 30): BuilderOverview {
  const b = cfg.builderId;
  const today = dayOf(now);
  const life = ledger.prepare('SELECT COUNT(*) AS n, SUM(perps_micro) AS p, SUM(spot_micro) AS s, SUM(underpaid_n + tampered_n > 0) AS f FROM wallets WHERE builder = ?').get(b) as Row;
  const dayRows = ledger.prepare('SELECT day, engine, SUM(micro) AS m, COUNT(DISTINCT address) AS w FROM days WHERE builder = ? AND day >= ? GROUP BY day, engine').all(b, today - Math.max(days, 30) + 1) as Row[];
  const active = (fromDay: number): number =>
    num((ledger.prepare('SELECT COUNT(DISTINCT address) AS n FROM days WHERE builder = ? AND day >= ? AND micro > 0').get(b, fromDay) as Row).n);
  const fees = admin.feesByDay(b, today - Math.max(days, 30) + 1);
  const series = new Map<number, VolumeDay>();
  const at = (d: number): VolumeDay => {
    let v = series.get(d);
    if (!v) series.set(d, (v = { day: d, perps: 0, spot: 0, feePerps: 0, feeSpot: 0, wallets: 0 }));
    return v;
  };
  for (const r of dayRows) {
    const v = at(num(r.day));
    if (r.engine === 'spot') v.spot += num(r.m);
    else v.perps += num(r.m);
    v.wallets = Math.max(v.wallets, num(r.w));
  }
  for (const f of fees) {
    const v = at(f.day);
    v.feePerps += f.perps;
    v.feeSpot += f.spot;
  }
  const all = [...series.values()];
  const sumVol = (from: number) => all.filter((d) => d.day >= from).reduce((s, d) => s + d.perps + d.spot, 0);
  const sumFee = (from: number) => all.filter((d) => d.day >= from).reduce((s, d) => s + d.feePerps + d.feeSpot, 0);
  const lifeFees = { perps: 0, spot: 0 };
  for (const w of admin.feesByWallet(b).values()) {
    lifeFees.perps += w.perps;
    lifeFees.spot += w.spot;
  }
  const tiers = cfg.tiers.map((t, index) => ({ index, minVolumeUsd: t.minVolumeUsd, perps: t.perps, spot: t.spot, wallets: 0 }));
  for (const u of builderUsers(ledger, admin, cfg, now)) tiers[u.tier.index]!.wallets += 1;
  const since = ledger.prepare("SELECT value FROM meta WHERE key = 'since'").get() as Row | undefined;
  const from = today - days + 1;
  return {
    builderId: b,
    volume: { lifetime: { perps: num(life.p), spot: num(life.s) }, d1: sumVol(today), d7: sumVol(today - 6), d30: sumVol(today - 29) },
    fees: { lifetime: lifeFees, d1: sumFee(today), d7: sumFee(today - 6), d30: sumFee(today - 29) },
    wallets: { total: num(life.n), traded7d: active(today - 6), traded30d: active(today - 29), flagged: num(life.f) },
    tiers,
    days: Array.from({ length: days }, (_, i) => series.get(from + i) ?? { day: from + i, perps: 0, spot: 0, feePerps: 0, feeSpot: 0, wallets: 0 }),
    ledgerSince: since ? num(since.value) || null : null,
  };
}

export interface BuilderUser {
  address: string;
  accountId: number;
  /** When the verifier took the wallet on, and last verified it. */
  firstSeen: number;
  verifiedAt: number;
  /** micro-USD, lifetime counted volume. */
  volume: { perps: number; spot: number };
  /** The tier window's volume (cfg.volumeDays, or lifetime), and the last 30 days. */
  windowVolume: number;
  volume30d: number;
  /** micro-USD, fees paid to the builder, lifetime. */
  fees: { perps: number; spot: number };
  orders: number;
  lastTradeAt: number | null;
  /** The tier the window puts it on and the fee that gives (tenths of a basis point). */
  tier: { index: number; fee: { perps: number; spot: number }; nextAtUsd: number | null };
  /** The fee last signed for it (terms), if any. */
  signedFee: { perps: number; spot: number; at: number } | null;
  flags: string[];
  /** Orders the explorer still has to look at. */
  pending: number;
}

/** Every wallet the ledger holds for `cfg.builderId`, with what it traded and paid. */
export function builderUsers(ledger: DatabaseSync, admin: AdminStore, cfg: TiersConfig, now: number): BuilderUser[] {
  const b = cfg.builderId;
  const today = dayOf(now);
  const windowFrom = cfg.volumeDays === null ? null : today - cfg.volumeDays + 1;
  const wallets = ledger.prepare('SELECT * FROM wallets WHERE builder = ?').all(b) as Row[];
  const windows = new Map<string, { w: number; d30: number; last: number }>();
  for (const r of ledger.prepare('SELECT address, day, SUM(micro) AS m FROM days WHERE builder = ? AND day >= ? GROUP BY address, day').all(b, Math.min(today - 29, windowFrom ?? today)) as Row[]) {
    const a = String(r.address);
    const v = windows.get(a) ?? { w: 0, d30: 0, last: 0 };
    const d = num(r.day);
    if (windowFrom !== null && d >= windowFrom) v.w += num(r.m);
    if (d >= today - 29) v.d30 += num(r.m);
    if (num(r.m) > 0) v.last = Math.max(v.last, d);
    windows.set(a, v);
  }
  const lastDay = new Map<string, number>();
  for (const r of ledger.prepare('SELECT address, MAX(day) AS d FROM days WHERE builder = ? AND micro > 0 GROUP BY address').all(b) as Row[]) lastDay.set(String(r.address), num(r.d));
  const fees = admin.feesByWallet(b);
  const signed = new Map<string, { perps: number; spot: number; at: number }>();
  for (const r of ledger.prepare('SELECT address, at, perps, spot FROM fees WHERE builder = ? AND address != ? ORDER BY at').all(b, '*') as Row[]) {
    signed.set(String(r.address), { perps: num(r.perps), spot: num(r.spot), at: num(r.at) });
  }
  return wallets.map((r) => {
    const address = String(r.address);
    const win = windows.get(address);
    const life = { perps: num(r.perps_micro), spot: num(r.spot_micro) };
    const windowVolume = windowFrom === null ? life.perps + life.spot : win?.w ?? 0;
    const facts = {
      perpsMicro: windowFrom === null ? life.perps : windowVolume, spotMicro: windowFrom === null ? life.spot : 0,
      underpaidAt: num(r.underpaid_at), tamperedAt: num(r.tampered_at), noBuilderAt: num(r.nobuilder_at),
    };
    const d = decide(cfg, address, facts, now);
    const f = fees.get(address);
    const ld = lastDay.get(address);
    const lastTradeAt = f?.lastAt ? f.lastAt : ld !== undefined ? ld * DAY : null;
    return {
      address,
      accountId: num(r.account_id),
      firstSeen: num(r.created_at),
      verifiedAt: num(r.verified_at),
      volume: life,
      windowVolume,
      volume30d: win?.d30 ?? 0,
      fees: { perps: f?.perps ?? 0, spot: f?.spot ?? 0 },
      orders: f?.orders ?? 0,
      lastTradeAt,
      tier: { index: d.tier.index, fee: d.fee, nextAtUsd: d.tier.next?.atUsd ?? null },
      signedFee: signed.get(address) ?? null,
      flags: d.flags,
      pending: num(r.open_n),
    };
  });
}
