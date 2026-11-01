/**
 * Order sinks that write every exchange call to the audit log (db.ts): what
 * was sent - side, size, price, time in force, reduce-only, the builder fee -
 * and what SoDEX answered (its order id, its refusal, or no readable answer).
 * One row before the call goes out and one with the answer, so a crash between
 * the two still shows the order was on its way.
 *
 * Only the executor's own sinks are wrapped: paper copies and paper algos
 * trade nothing, and their simulated fills are in the activity log.
 */
import type { AlgoRecord, AlgoSink, ChildRequest, ChildResult, Intent, MarginChoice, MarketInfo, OrderSink, SendResult, StopOrder, StopRequest } from '../../../packages/copy-engine/src/index.ts';
import type { BuilderParams } from '../../../packages/sodex-core/src/index.ts';
import type { ExecutorDb } from './db.ts';

const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const intentRow = (i: Intent) => ({ clOrdID: i.clOrdID, side: i.side, quantity: i.quantity, limitPrice: i.limitPrice, reduceOnly: i.reduceOnly, leg: i.leg, notionalUsd: i.notionalUsd, clampedBy: i.clampedBy });
const resultRow = (r: SendResult | ChildResult) => ({ clOrdID: r.clOrdID, ok: r.ok, orderId: r.orderId, error: r.error, outcomeUnknown: r.outcomeUnknown });
const builderRow = (b: BuilderParams | null) => (b ? { id: b.id, fee: b.fee } : null);

/** A copy's sink (KeySink), every call written down. */
export function auditedOrderSink(inner: OrderSink, db: ExecutorDb, owner: string, subId: string): OrderSink {
  return {
    paper: inner.paper,
    async place(accountId: number, market: MarketInfo, intents: Intent[], builder: BuilderParams | null, reference: number) {
      db.audit('order', owner, subId, { via: 'copy', step: 'send', accountId, symbol: market.name, reference, builder: builderRow(builder), orders: intents.map(intentRow) });
      try {
        const out = await inner.place(accountId, market, intents, builder, reference);
        db.audit('order', owner, subId, { via: 'copy', step: 'answer', symbol: market.name, results: out.map(resultRow) });
        return out;
      } catch (e) {
        db.audit('order', owner, subId, { via: 'copy', step: 'error', symbol: market.name, error: said(e) });
        throw e;
      }
    },
    async setLeverage(accountId: number, market: MarketInfo, leverage: number, margin: MarginChoice) {
      try {
        await inner.setLeverage(accountId, market, leverage, margin);
        db.audit('leverage', owner, subId, { via: 'copy', accountId, symbol: market.name, leverage, margin, ok: true });
      } catch (e) {
        db.audit('leverage', owner, subId, { via: 'copy', accountId, symbol: market.name, leverage, margin, ok: false, error: said(e) });
        throw e;
      }
    },
    async placeStop(accountId: number, market: MarketInfo, stop: StopOrder, builder: BuilderParams | null) {
      db.audit('stop', owner, subId, { via: 'copy', step: 'send', accountId, symbol: market.name, builder: builderRow(builder), stop });
      try {
        const r = await inner.placeStop(accountId, market, stop, builder);
        db.audit('stop', owner, subId, { via: 'copy', step: 'answer', symbol: market.name, result: resultRow(r) });
        return r;
      } catch (e) {
        db.audit('stop', owner, subId, { via: 'copy', step: 'error', symbol: market.name, clOrdID: stop.clOrdID, error: said(e) });
        throw e;
      }
    },
    async cancel(accountId: number, market: MarketInfo, clOrdID: string) {
      try {
        await inner.cancel(accountId, market, clOrdID);
        db.audit('cancel', owner, subId, { via: 'copy', accountId, symbol: market.name, clOrdIDs: [clOrdID], ok: true });
      } catch (e) {
        db.audit('cancel', owner, subId, { via: 'copy', accountId, symbol: market.name, clOrdIDs: [clOrdID], ok: false, error: said(e) });
        throw e;
      }
    },
  };
}

/** An algo's sink (KeyAlgoSink), every call written down. */
export function auditedAlgoSink(inner: AlgoSink, db: ExecutorDb, builderOf?: (a: AlgoRecord) => Promise<BuilderParams | null>): AlgoSink {
  // The builder the sink names (the same lookup, cached by the service): written on every send, as a copy's is.
  const builderNow = async (a: AlgoRecord) => (builderOf ? builderRow(await builderOf(a).catch(() => null)) : undefined);
  return {
    paper: inner.paper,
    async place(a: AlgoRecord, market: MarketInfo, orders: ChildRequest[]) {
      db.audit('order', a.owner, a.id, { via: 'algo', kind: a.spec.kind, step: 'send', accountId: a.accountId, symbol: market.name, builder: await builderNow(a), orders });
      try {
        const out = await inner.place(a, market, orders);
        db.audit('order', a.owner, a.id, { via: 'algo', step: 'answer', symbol: market.name, results: out.map(resultRow) });
        return out;
      } catch (e) {
        db.audit('order', a.owner, a.id, { via: 'algo', step: 'error', symbol: market.name, error: said(e) });
        throw e;
      }
    },
    async placeStops(a: AlgoRecord, market: MarketInfo, stops: StopRequest[]) {
      db.audit('stop', a.owner, a.id, { via: 'algo', step: 'send', accountId: a.accountId, symbol: market.name, builder: await builderNow(a), stops });
      try {
        const out = await inner.placeStops(a, market, stops);
        db.audit('stop', a.owner, a.id, { via: 'algo', step: 'answer', symbol: market.name, results: out.map(resultRow) });
        return out;
      } catch (e) {
        db.audit('stop', a.owner, a.id, { via: 'algo', step: 'error', symbol: market.name, error: said(e) });
        throw e;
      }
    },
    async cancel(a: AlgoRecord, market: MarketInfo, clOrdIDs: string[]) {
      try {
        await inner.cancel(a, market, clOrdIDs);
        db.audit('cancel', a.owner, a.id, { via: 'algo', accountId: a.accountId, symbol: market.name, clOrdIDs, ok: true });
      } catch (e) {
        db.audit('cancel', a.owner, a.id, { via: 'algo', accountId: a.accountId, symbol: market.name, clOrdIDs, ok: false, error: said(e) });
        throw e;
      }
    },
    async setLeverage(a: AlgoRecord, market: MarketInfo, leverage: number, margin: MarginChoice) {
      try {
        await inner.setLeverage(a, market, leverage, margin);
        db.audit('leverage', a.owner, a.id, { via: 'algo', accountId: a.accountId, symbol: market.name, leverage, margin, ok: true });
      } catch (e) {
        db.audit('leverage', a.owner, a.id, { via: 'algo', accountId: a.accountId, symbol: market.name, leverage, margin, ok: false, error: said(e) });
        throw e;
      }
    },
  };
}
