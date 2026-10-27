/**
 * The account feeds (accountFeeds.ts) from the wallet's `accountState` stream.
 *
 * SoDEX pushes a wallet's whole state about once a second on `accountState`
 * (verified live 2026-10-27: a snapshot every ~1 s while the account holds
 * anything): balances `B`, open orders `O`, positions `P`, in the compact keys
 * REST /state answers with. These turn one push into exactly what the REST
 * reads the panels already consume return - /state as is, /orders and
 * /positions in their long field names - so a panel cannot tell which one it
 * got, only that it is now a second old instead of up to twenty.
 *
 * Where the push cannot stand in for REST, the answer is `null` and the feed
 * reads REST once: more than the 100 orders the state carries, or a position
 * REST has not described yet (its funding total is REST-only).
 */
import type { Engine } from '../api';

export type LiveKey =
  | { kind: 'state'; engine: Engine; user: string }
  | { kind: 'orders'; engine: Engine; user: string }
  | { kind: 'pos'; engine: 'perps'; user: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The feeds a push can fill: `state:<engine>:<addr>`, `orders:<engine>:<addr>`, `pos:<addr>`. */
export function liveKeyOf(key: string): LiveKey | null {
  const p = key.split(':');
  const engine = (e: string | undefined): Engine | null => (e === 'perps' || e === 'spot' ? e : null);
  if ((p[0] === 'state' || p[0] === 'orders') && p.length === 3 && engine(p[1]) && ADDRESS.test(p[2]!)) return { kind: p[0], engine: engine(p[1])!, user: p[2]! };
  if (p[0] === 'pos' && p.length === 2 && ADDRESS.test(p[1]!)) return { kind: 'pos', engine: 'perps', user: p[1]! };
  return null;
}

/** /state carries the latest 100 open orders; with that many there may be more, which only REST lists. */
export const STATE_ORDER_CAP = 100;

type Row = Record<string, unknown>;

/** What account.state() answers, from a push. */
export function stateFromPush(engine: Engine, address: string, d: Row) {
  const aid = Number(d.aid ?? 0);
  return { engine, address, accountId: aid, userId: Number(d.uid ?? 0), exists: aid !== 0, state: d };
}

/** One open order as /orders lists it. */
export function restOrder(o: Row): Row {
  const out: Row = {
    symbol: o.s,
    orderID: o.i,
    clOrdID: o.c,
    side: o.S,
    type: o.o,
    timeInForce: o.f,
    price: o.p,
    origQty: o.q,
    status: o.X,
    executedQty: o.z,
    executedValue: o.v,
    marginFrozen: o.M,
    createdAt: o.ct,
    updatedAt: o.ut,
  };
  if (o.b && typeof o.b === 'object') {
    const b = o.b as { i?: number; f?: number };
    out.builder = { builderID: b.i, feeRate: b.f };
  }
  if (o.ps !== undefined) out.positionSide = o.ps;
  if (o.R !== undefined) out.reduceOnly = o.R;
  if (o.sp !== undefined && o.sp !== null) out.stopPrice = o.sp;
  if (o.st !== undefined && o.st !== null) out.stopType = o.st;
  if (o.tt !== undefined && o.tt !== null) out.triggerType = o.tt;
  if (o.pid !== undefined && o.pid !== null) out.positionID = o.pid;
  if (o.poid !== undefined && o.poid !== null) out.primaryOrderID = o.poid;
  if (Array.isArray(o.aoids)) out.attachedOrderIDs = o.aoids;
  return out;
}

/** What account.openOrders() answers, or null when the push may not hold them all. */
export function ordersFromPush(engine: Engine, d: Row): { engine: Engine; orders: Row[] } | null {
  const o = Array.isArray(d.O) ? (d.O as Row[]) : null;
  if (!o || o.length >= STATE_ORDER_CAP) return null;
  return { engine, orders: o.map(restOrder) };
}

/**
 * What account.positions() answers, or null when a position is new to REST.
 *
 * REST-only fields come from REST's last answer for the same position id: the
 * funding total, the take-over flags, and the initial margin while size and
 * entry are unchanged (after a change it is size x entry / leverage, which is
 * what SoDEX reports for a cross position - an isolated one uses its own margin).
 */
export function positionsFromPush(d: Row, prev: { positions?: Row[] } | null): { positions: Row[] } | null {
  const ps = Array.isArray(d.P) ? (d.P as Row[]) : null;
  if (!ps) return null;
  const before = new Map((prev?.positions ?? []).map((p) => [Number(p.id), p]));
  const out: Row[] = [];
  for (const p of ps) {
    if (!(Math.abs(Number(p.sz)) > 0)) continue;
    const was = before.get(Number(p.i));
    if (!was) return null;
    const same = String(was.size) === String(p.sz) && String(was.avgEntryPrice) === String(p.ep);
    const lev = Number(p.l) || Number(was.leverage) || 1;
    const margin = same
      ? was.initialMargin
      : p.m === 'ISOLATED' && p.iw !== undefined && p.iw !== null
        ? p.iw
        : String((Math.abs(Number(p.sz)) * Number(p.ep)) / lev);
    out.push({
      ...was,
      id: p.i,
      symbol: p.s,
      marginMode: p.m,
      positionSide: p.ps,
      size: p.sz,
      initialMargin: margin,
      avgEntryPrice: p.ep,
      cumOpenCost: p.co,
      cumTradingFee: p.cf,
      cumClosedSize: p.cc,
      avgClosePrice: p.cp,
      maxSize: p.ms,
      realizedPnL: p.cr,
      leverage: p.l,
      active: true,
      createdAt: p.ct ?? was.createdAt,
      updatedAt: p.ut ?? was.updatedAt,
    });
  }
  return { positions: out };
}
