/**
 * The run's own book of what it did on the engines: every order that left the
 * process (read from the request body by the network guard - not from what the
 * app says it sent), SoDEX's answer to it, what the account stream then
 * reported about it, and every fill.
 *
 * It is the evidence the checks are judged on and what the final cross-check
 * reconciles SoDEX's order history and fills against.
 */
import { fillKey, type Engine, type Fill } from './fees';
import type { SentWrite } from './guard';

export interface BuilderRef {
  id: number;
  fee: number;
}

export type OrderOrigin =
  /** Sent by the app's own code (placeOrder ...). */
  | 'app'
  /** Built and signed by the runner itself, standing in for a modified client (labelled in the report). */
  | 'direct'
  /** Created by SoDEX (a triggered stop's child order) - seen on the stream only. */
  | 'sodex';

export interface LedgerOrder {
  /** The check (scenario) this order belongs to. */
  tag: string;
  label: string;
  engine: Engine;
  symbolID: number | null;
  symbol: string | null;
  clOrdID: string | null;
  orderID: number | null;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  /** 1 GTC, 2 FOK, 3 IOC, 4 GTX. */
  timeInForce: number | null;
  price: string | null;
  quantity: string | null;
  funds: string | null;
  reduceOnly: boolean;
  stopPrice: string | null;
  stopType: number | null;
  /** 1 NORMAL, 2 STOP, 3 BRACKET, 4 ATTACHED_STOP (perps). */
  modifier: number | null;
  /** The builder the order carried when it LEFT; null = it named none. */
  builder: BuilderRef | null;
  origin: OrderOrigin;
  sentAt: number;
  /** SoDEX's answer to the request: true accepted, false rejected, null no answer read. */
  accepted: boolean | null;
  rejection: string | null;
  /** Latest state seen (stream, open orders, or history). */
  status: string | null;
  executedQty: string | null;
  executedValue: string | null;
  /** The builder SoDEX's own record names: undefined = no record seen; null = the record names none. */
  recordBuilder: BuilderRef | null | undefined;
  recordSource: 'stream' | 'open-orders' | 'history' | null;
  /** For a direct order: what it stands in for. */
  purpose: string | null;
  /** For the order a REPLACE request created: the order it replaced. (A replace request has no builder field - `builder` is null.) */
  replaces?: { orderID: number | null; clOrdID: string | null };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
const builderOf = (v: unknown): BuilderRef | null => {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  const id = int(o?.id ?? o?.builderID ?? o?.i);
  const fee = int(o?.fee ?? o?.feeRate ?? o?.f);
  return id !== null && fee !== null ? { id, fee } : null;
};

/** `{id, fee}` | `{builderID, feeRate}` | `{i, f}` -> one shape; null when the record names no builder. */
export const builderRef = builderOf;

export class Ledger {
  readonly orders: LedgerOrder[] = [];
  /** Fills by source, keyed by `fillKey`: what the account stream pushed, and what the fill history lists. */
  readonly streamFills = new Map<string, Fill>();
  readonly historyFills = new Map<string, Fill>();
  private listeners = new Set<() => void>();
  /** Names of the markets by id (engine:id -> symbol), so stream rows (which carry names) meet request bodies (which carry ids). */
  private readonly symbols = new Map<string, string>();

  nameSymbol(engine: Engine, id: number, name: string): void {
    this.symbols.set(`${engine}:${id}`, name);
    for (const o of this.orders) if (o.engine === engine && o.symbolID === id && !o.symbol) o.symbol = name;
  }

  private changed(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* a waiter must not break the book */
      }
    }
  }

  /** Resolve when `done()` holds (checked on every change), or with false after `timeoutMs`. */
  wait(done: () => boolean, timeoutMs: number): Promise<boolean> {
    if (done()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = (): void => {
        if (!done()) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        resolve(done());
      }, timeoutMs);
      this.listeners.add(check);
    });
  }

  // --- orders -------------------------------------------------------------------------------------

  /** An order request that left the process: one entry per order in its batch. */
  noteOrderRequest(w: SentWrite, origin: OrderOrigin, purpose: string | null = null): LedgerOrder[] {
    const engine = w.engine ?? 'perps';
    const b = w.body ?? {};
    const list: any[] = Array.isArray(b.orders) ? b.orders : [];
    const batch = builderOf(b.builder);
    let answers: Array<{ code?: unknown; clOrdID?: unknown; orderID?: unknown; error?: unknown }> = [];
    let envelopeError: string | null = null;
    let answered = false;
    if (w.responseText) {
      try {
        const j = JSON.parse(w.responseText) as { code?: unknown; data?: unknown; error?: unknown; msg?: unknown; message?: unknown };
        answered = true;
        if (j.code === 0 && Array.isArray(j.data)) answers = j.data as typeof answers;
        else if (j.code !== 0) envelopeError = String(j.error ?? j.msg ?? j.message ?? `code ${String(j.code)}`);
      } catch {
        answered = false;
      }
    }
    const out: LedgerOrder[] = [];
    list.forEach((x, i) => {
      const symbolID = int(engine === 'spot' ? x?.symbolID : b.symbolID);
      const clOrdID = str(x?.clOrdID);
      const a = answers.find((r) => r.clOrdID === clOrdID) ?? (answers.length === list.length ? answers[i] : undefined);
      const rejected = envelopeError ?? (a && typeof a.code === 'number' && a.code !== 0 ? String(a.error ?? `code ${a.code}`) : null);
      const o: LedgerOrder = {
        tag: w.tag ?? 'untagged',
        label: i === 0 ? w.label : `${w.label} (leg ${i + 1})`,
        engine,
        symbolID,
        symbol: symbolID !== null ? this.symbols.get(`${engine}:${symbolID}`) ?? null : null,
        clOrdID,
        orderID: a ? int(a.orderID) : null,
        side: x?.side === 2 ? 'SELL' : 'BUY',
        type: x?.type === 2 ? 'MARKET' : 'LIMIT',
        timeInForce: int(x?.timeInForce),
        price: str(x?.price),
        quantity: str(x?.quantity),
        funds: str(x?.funds),
        reduceOnly: x?.reduceOnly === true,
        stopPrice: str(x?.stopPrice),
        stopType: int(x?.stopType),
        modifier: int(x?.modifier),
        // A perps order may override the batch's builder; the app never does, the fragment is read all the same.
        builder: builderOf(x?.builder) ?? batch,
        origin,
        sentAt: w.at,
        accepted: !answered ? null : rejected === null && (w.status ?? 0) < 400,
        rejection: rejected,
        status: null,
        executedQty: null,
        executedValue: null,
        recordBuilder: undefined,
        recordSource: null,
        purpose,
      };
      out.push(this.adopt(o));
    });
    this.changed();
    return out;
  }

  /**
   * Enter an order of the run. The account stream may have reported it before
   * SoDEX's answer to the request came back (the push races the HTTP answer):
   * that entry - made as "an order the run did not send" - becomes this one,
   * keeping what the stream said about its state.
   */
  private adopt(o: LedgerOrder): LedgerOrder {
    const prior = this.orders.find((x) => x.origin === 'sodex' && x.engine === o.engine && ((o.orderID !== null && x.orderID === o.orderID) || (o.clOrdID !== null && x.clOrdID === o.clOrdID)));
    if (!prior) {
      this.orders.push(o);
      return o;
    }
    const seen = { status: prior.status, executedQty: prior.executedQty, executedValue: prior.executedValue, recordBuilder: prior.recordBuilder, recordSource: prior.recordSource, orderID: prior.orderID ?? o.orderID, symbol: prior.symbol ?? o.symbol };
    Object.assign(prior, o, seen);
    return prior;
  }

  /**
   * A replace request that left: SoDEX answers with the order that now stands in
   * the original's place. Where that is a NEW order (another id), it is entered
   * as the run's own - same side and type, the changed price / size, and NO
   * builder of its own (the request cannot name one: whether SoDEX's record of
   * it still does is what the run observes). Where SoDEX kept the id, the
   * original's price / size are updated instead.
   */
  noteReplace(w: SentWrite, origin: OrderOrigin = w.direct ? 'direct' : 'app'): LedgerOrder[] {
    const engine = w.engine ?? 'perps';
    const list: any[] = Array.isArray(w.body?.orders) ? w.body.orders : [];
    let answers: Array<{ code?: unknown; clOrdID?: unknown; orderID?: unknown }> = [];
    let ok = false;
    if (w.responseText) {
      try {
        const j = JSON.parse(w.responseText) as { code?: unknown; data?: unknown };
        ok = j.code === 0 && (w.status ?? 0) < 400;
        const d = j.data as { orders?: unknown } | unknown[] | null;
        answers = (Array.isArray(d) ? d : Array.isArray((d as { orders?: unknown } | null)?.orders) ? (d as { orders: unknown[] }).orders : []) as typeof answers;
      } catch {
        ok = false;
      }
    }
    const out: LedgerOrder[] = [];
    if (!ok) return out;
    list.forEach((x, i) => {
      const orig = this.find(engine, { orderID: int(x?.origOrderID), clOrdID: str(x?.origClOrdID) });
      const clOrdID = str(x?.clOrdID);
      const a = answers.find((r) => r.clOrdID === clOrdID) ?? (answers.length === list.length ? answers[i] : undefined);
      if (a && typeof a.code === 'number' && a.code !== 0) return;
      const orderID = a ? int(a.orderID) : null;
      if (orig && orderID !== null && orderID === orig.orderID) {
        if (str(x?.price)) orig.price = str(x.price);
        if (str(x?.quantity)) orig.quantity = str(x.quantity);
        return;
      }
      const o: LedgerOrder = {
        tag: w.tag ?? orig?.tag ?? 'untagged',
        label: `${orig?.label ?? 'an order'} (after ${w.label})`,
        engine,
        symbolID: int(x?.symbolID) ?? orig?.symbolID ?? null,
        symbol: orig?.symbol ?? null,
        clOrdID,
        orderID,
        side: orig?.side ?? 'BUY',
        type: orig?.type ?? 'LIMIT',
        timeInForce: orig?.timeInForce ?? null,
        price: str(x?.price) ?? orig?.price ?? null,
        quantity: str(x?.quantity) ?? orig?.quantity ?? null,
        funds: null,
        reduceOnly: orig?.reduceOnly ?? false,
        stopPrice: orig?.stopPrice ?? null,
        stopType: orig?.stopType ?? null,
        modifier: orig?.modifier ?? null,
        builder: null,
        origin,
        sentAt: w.at,
        accepted: true,
        rejection: null,
        status: null,
        executedQty: null,
        executedValue: null,
        recordBuilder: undefined,
        recordSource: null,
        purpose: null,
        replaces: { orderID: orig?.orderID ?? int(x?.origOrderID), clOrdID: orig?.clOrdID ?? str(x?.origClOrdID) },
      };
      if (o.symbol === null && o.symbolID !== null) o.symbol = this.symbols.get(`${engine}:${o.symbolID}`) ?? null;
      out.push(this.adopt(o));
    });
    this.changed();
    return out;
  }

  find(engine: Engine, ref: { orderID?: number | null; clOrdID?: string | null }): LedgerOrder | undefined {
    return this.orders.find((o) => o.engine === engine && ((ref.orderID != null && o.orderID === ref.orderID) || (ref.clOrdID != null && ref.clOrdID !== '' && o.clOrdID === ref.clOrdID)));
  }

  /** What SoDEX's own record of an order says (a stream push, an open-orders row or a history row). */
  noteRecord(engine: Engine, row: Record<string, unknown>, source: 'stream' | 'open-orders' | 'history'): LedgerOrder | null {
    const orderID = int(row.orderID ?? row.i);
    const clOrdID = str(row.clOrdID ?? row.c);
    if (orderID === null && clOrdID === null) return null;
    let o = this.find(engine, { orderID, clOrdID });
    if (!o) {
      // An order this run did not send: a triggered stop's child order, or somebody else's activity on the account.
      const side = String(row.side ?? row.S ?? '').toUpperCase();
      const type = String(row.type ?? row.o ?? '').toUpperCase();
      o = {
        tag: 'sodex',
        label: 'an order the run did not send (a triggered stop, or other activity on the account)',
        engine,
        symbolID: null,
        symbol: str(row.symbol ?? row.s),
        clOrdID,
        orderID,
        side: side === 'SELL' ? 'SELL' : 'BUY',
        type: type === 'MARKET' ? 'MARKET' : 'LIMIT',
        timeInForce: null,
        price: str(row.price ?? row.p),
        quantity: str(row.origQty ?? row.q),
        funds: str(row.funds ?? row.F),
        reduceOnly: (row.reduceOnly ?? row.R) === true,
        stopPrice: str(row.stopPrice ?? row.sp),
        stopType: null,
        modifier: null,
        builder: null,
        origin: 'sodex',
        sentAt: Date.now(),
        accepted: true,
        rejection: null,
        status: null,
        executedQty: null,
        executedValue: null,
        recordBuilder: undefined,
        recordSource: null,
        purpose: null,
      };
      this.orders.push(o);
    }
    if (o.orderID === null && orderID !== null) o.orderID = orderID;
    if (!o.symbol) o.symbol = str(row.symbol ?? row.s);
    const status = str(row.status ?? row.X);
    if (status) o.status = status.toUpperCase();
    const z = str(row.executedQty ?? row.z);
    if (z !== null) o.executedQty = z;
    const v = str(row.executedValue ?? row.v);
    if (v !== null) o.executedValue = v;
    // The record's builder: present -> named; an open-order row or a stream update WITHOUT the field names none.
    // A FINISHED order in SoDEX's order history carries no builder field at all (read live, 2026-10-02):
    // there its absence says nothing, and what was seen before is kept.
    const rb = row.builder ?? row.b;
    if (source !== 'history' || (rb !== undefined && rb !== null)) {
      o.recordBuilder = rb === undefined || rb === null ? null : builderOf(rb);
      o.recordSource = source;
    }
    // A resting order's current price and size (they change with replace / modify).
    const p = str(row.price ?? row.p);
    const q = str(row.origQty ?? row.q);
    const sp = str(row.stopPrice ?? row.sp);
    if (source !== 'stream' || status) {
      if (p !== null) o.price = p;
      if (q !== null) o.quantity = q;
      if (sp !== null) o.stopPrice = sp;
    }
    this.changed();
    return o;
  }

  // --- fills ------------------------------------------------------------------------------------------

  /** Add a fill as one source reported it. */
  noteFill(f: Fill): void {
    (f.source === 'history' ? this.historyFills : this.streamFills).set(fillKey(f), f);
    this.changed();
  }

  /** Every fill known, once: the history row where there is one (it names the fee coin), else the stream's. */
  get fills(): Fill[] {
    const out = new Map<string, Fill>(this.streamFills);
    for (const [k, f] of this.historyFills) out.set(k, f);
    return [...out.values()];
  }

  fillsOf(engine: Engine, ref: { orderID?: number | null; clOrdID?: string | null }): Fill[] {
    return this.fills.filter((f) => f.engine === engine && ((ref.orderID != null && f.orderID === ref.orderID) || (ref.clOrdID != null && ref.clOrdID !== '' && f.clOrdID === ref.clOrdID)));
  }

  /** The order a fill belongs to, if the run knows it. */
  orderOf(f: Fill): LedgerOrder | undefined {
    return this.find(f.engine, { orderID: f.orderID, clOrdID: f.clOrdID });
  }
}
