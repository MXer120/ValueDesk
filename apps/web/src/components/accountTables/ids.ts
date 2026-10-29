/**
 * A record's ids, for an incident report - pure, covered by ids.test.ts.
 *
 * The account tables can show each row's SoDEX ids (order ID, clOrdID, trade
 * ID, position ID) and an algo's or a copy's own id: the "IDs" column, switched
 * on in the band's View pop-up (IdCell.tsx). A cell shows an id short (its last 8
 * characters); a click copies it whole. "Copy details" copies a short plain-text
 * block a trader can paste into a support ticket (supportText).
 *
 * Values are copied as the venue sent them - never re-formatted to the reader's
 * number style - so what support reads is what SoDEX holds.
 */
import { pick } from '../../format';
import { directionOfPosition, directionOfSide } from './filters';
import { normaliseStatus } from './orderStatus';

/** The persisted switch (one for every table, like the View filters). */
export const IDS_KEY = 'vs.acct.ids';

/** An id as text, or null when there is none (absent, empty, or SoDEX's 0 for "no order"). */
export function idText(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0 ? String(v) : null;
  if (typeof v === 'string') {
    const s = v.trim();
    return s && s !== '0' ? s : null;
  }
  return null;
}

/** The last `n` characters, after an ellipsis when anything was cut. */
export function shortId(v: unknown, n = 8): string {
  const s = idText(v);
  if (!s) return '';
  return s.length <= n ? s : `…${s.slice(-n)}`;
}

/** `2026-10-29 20:48:55 UTC`, or null for no time. */
export function utcStamp(ms: unknown): string | null {
  const t = typeof ms === 'number' ? ms : typeof ms === 'string' && ms.trim() ? Number(ms) : NaN;
  if (!Number.isFinite(t) || t <= 0) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** What a support ticket needs to find one record. Every field is optional; the empty ones are left out. */
export interface SupportFields {
  market?: string | null;
  engine?: 'spot' | 'perps' | null;
  side?: string | null;
  type?: string | null;
  status?: string | null;
  size?: unknown;
  /** The base coin, after a size. */
  unit?: string | null;
  price?: unknown;
  filled?: unknown;
  /** Lines of its own, in order, after the figures ([label, value]). */
  more?: Array<[string, unknown]>;
  /** ms */
  time?: unknown;
  /** The label of `time` ("Time", "Placed", "Opened"). */
  timeLabel?: string;
  orderId?: unknown;
  clOrdId?: unknown;
  tradeId?: unknown;
  positionId?: unknown;
  algoId?: unknown;
  copyId?: unknown;
  account?: string | null;
}

const ENGINE_WORD = { spot: 'Spot', perps: 'Futures' } as const;

/** A value as a line's text, or null to leave the line out. */
function plain(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * The plain-text block "Copy details" puts on the clipboard:
 *
 *   SoDEX order
 *   Market: BTC-USD (Futures)
 *   Side: Buy
 *   ...
 *   Order ID: 123456789
 *   Client order ID (clOrdID): vs-abc
 *   Account: 0x...
 */
export function supportText(title: string, f: SupportFields): string {
  const lines: string[] = [title];
  const add = (label: string, v: unknown) => {
    const s = plain(v);
    if (s !== null) lines.push(`${label}: ${s}`);
  };
  const market = plain(f.market);
  add('Market', market && f.engine ? `${market} (${ENGINE_WORD[f.engine]})` : market);
  add('Side', f.side);
  add('Type', f.type);
  add('Status', f.status);
  const size = plain(f.size);
  add('Size', size && f.unit ? `${size} ${f.unit}` : size);
  add('Price', f.price);
  add('Filled', f.filled);
  for (const [label, v] of f.more ?? []) add(label, v);
  add(`${f.timeLabel ?? 'Time'} (UTC)`, utcStamp(f.time));
  add('Algo ID', idText(f.algoId));
  add('Copy ID', idText(f.copyId));
  add('Trade ID', idText(f.tradeId));
  add('Order ID', idText(f.orderId));
  add('Client order ID (clOrdID)', idText(f.clOrdId));
  add('Position ID', idText(f.positionId));
  add('Account', f.account);
  return lines.join('\n');
}

// --- per record ------------------------------------------------------------------

/** What the table knows that the row does not say. */
export interface RowContext {
  /** The market as the table names it (display name). */
  market: string;
  engine: 'spot' | 'perps';
  /** The base coin, after a size. */
  unit?: string | null;
  /** The account the table reads. */
  account: string | null;
}

const sideOf = (v: unknown): string | null => {
  const d = directionOfSide(v);
  return d === 'long' ? 'Buy' : d === 'short' ? 'Sell' : null;
};
const positionSideOf = (side: unknown, size?: unknown): string | null => {
  const d = directionOfPosition(side, size);
  return d === 'long' ? 'Long' : d === 'short' ? 'Short' : null;
};
/** A size as sent, without the sign a short position's size carries. */
const unsigned = (v: unknown): unknown => (typeof v === 'string' ? v.replace(/^-/, '') : typeof v === 'number' ? Math.abs(v) : v);
const positive = (v: unknown): unknown => (Number(v) > 0 ? v : null);

/** An open or past order (REST or stream spelling). `type`: the table's words for it ("Limit · GTC"). */
export function orderSupport(o: any, x: RowContext & { type?: string; open?: boolean }): string {
  const filled = pick(o, 'executedQty', 'filledQuantity', 'z');
  const value = Number(pick(o, 'executedValue'));
  // executedValue / executedQty, to 10 significant digits (a division's tail is noise, not data).
  const avg = Number(filled) > 0 && value > 0 ? Number((value / Number(filled)).toPrecision(10)) : null;
  return supportText(x.open ? 'SoDEX open order' : 'SoDEX order', {
    market: x.market,
    engine: x.engine,
    side: sideOf(pick(o, 'side', 'S')),
    type: x.type,
    status: pick(o, 'status', 'X') === undefined ? null : normaliseStatus(pick(o, 'status', 'X')),
    size: pick(o, 'origQty', 'quantity', 'q'),
    unit: x.unit,
    price: positive(pick(o, 'price', 'p')) ?? 'Market',
    filled,
    more: [
      ['Trigger', positive(pick(o, 'stopPrice'))],
      ['Avg. fill', avg],
      ['Reduce-only', pick(o, 'reduceOnly') === true ? 'yes' : null],
    ],
    time: pick(o, 'createdAt', 'T', 'time'),
    timeLabel: 'Placed',
    orderId: pick(o, 'orderID', 'i', 'orderId'),
    clOrdId: pick(o, 'clOrdID', 'c'),
    account: x.account,
  });
}

/** A fill. */
export function tradeSupport(t: any, x: RowContext): string {
  const fee = pick(t, 'fee');
  const feeCoin = pick<string>(t, 'feeCoin');
  const maker = pick<boolean>(t, 'isMaker');
  return supportText('SoDEX fill', {
    market: x.market,
    engine: x.engine,
    side: sideOf(pick(t, 'side')),
    size: pick(t, 'quantity'),
    unit: x.unit,
    price: pick(t, 'price'),
    more: [
      ['Fee', fee === undefined ? null : feeCoin ? `${fee} ${feeCoin}` : fee],
      ['Role', maker === true ? 'Maker' : maker === false ? 'Taker' : null],
    ],
    time: pick(t, 'time'),
    tradeId: pick(t, 'tradeID'),
    orderId: pick(t, 'orderID'),
    clOrdId: pick(t, 'clOrdID'),
    account: x.account,
  });
}

/** An open position. */
export function positionSupport(p: any, x: Omit<RowContext, 'engine'>): string {
  const size = pick(p, 'size', 'positionAmt', 'pa', 'q');
  const lev = Number(pick(p, 'leverage'));
  return supportText('SoDEX position', {
    market: x.market,
    engine: 'perps',
    side: positionSideOf(pick(p, 'positionSide', 'ps'), size),
    size: unsigned(size),
    unit: x.unit,
    more: [
      ['Entry price', pick(p, 'avgEntryPrice')],
      ['Leverage', lev > 0 ? `${lev}x` : null],
      ['Margin mode', pick(p, 'marginMode')],
    ],
    time: pick(p, 'createdAt'),
    timeLabel: 'Opened',
    positionId: pick(p, 'id'),
    account: x.account,
  });
}

/** A closed position (Position History). */
export function closedSupport(p: any, x: Omit<RowContext, 'engine'>): string {
  const lev = Number(pick(p, 'leverage'));
  const open = pick<boolean>(p, 'active') === true;
  return supportText('SoDEX closed position', {
    market: x.market,
    engine: 'perps',
    side: positionSideOf(pick(p, 'positionSide')),
    more: [
      ['Max size', pick(p, 'maxSize') === undefined ? null : x.unit ? `${pick(p, 'maxSize')} ${x.unit}` : pick(p, 'maxSize')],
      ['Entry price', pick(p, 'avgEntryPrice')],
      ['Avg. close price', positive(pick(p, 'avgClosePrice'))],
      ['Closing PnL', pick(p, 'realizedPnL')],
      ['Leverage', lev > 0 ? `${lev}x` : null],
      ['Margin mode', pick(p, 'marginMode')],
      ['Opened (UTC)', utcStamp(pick(p, 'createdAt'))],
    ],
    time: open ? null : pick(p, 'updatedAt'),
    timeLabel: 'Closed',
    positionId: pick(p, 'id'),
    account: x.account,
  });
}

/** A funding payment. */
export function fundingSupport(f: any, x: Omit<RowContext, 'engine' | 'unit'>): string {
  const fee = pick(f, 'fundingFee');
  const coin = pick<string>(f, 'feeCoin');
  return supportText('SoDEX funding payment', {
    market: x.market,
    engine: 'perps',
    side: positionSideOf(pick(f, 'positionSide')),
    more: [['Funding fee', fee === undefined ? null : coin ? `${fee} ${coin}` : fee]],
    time: pick(f, 'timestamp'),
    positionId: pick(f, 'positionID'),
    account: x.account,
  });
}

// --- algos -----------------------------------------------------------------------

/** The algo's facts "Copy details" needs - an AlgoView's, structurally (no runtime import of the engine). */
export interface AlgoFacts {
  algo: {
    id: string;
    owner: string;
    status: string;
    createdAt: number;
    startedAt: number | null;
    filled: number;
    childCount: number;
    spec: { symbol: string; side: 'buy' | 'sell'; paper: boolean; kind: string; legs?: Array<{ symbol: string }> };
    children: AlgoChild[];
    exitOrders?: AlgoChild[];
  };
  target: number | null;
  avgPrice: number | null;
}

/** One child order, as AlgoRecord keeps it. */
export interface AlgoChild {
  clOrdID: string;
  orderId: string | null;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  filled: number;
  state: string;
  tag: string;
  placedAt: number;
  exit?: 'tp' | 'sl';
}

/** The most child orders "Copy details" lists (the record keeps the open ones and the last few done). */
export const ALGO_CHILD_LINES = 20;

/** An algo, and the child orders it holds, newest first. */
export function algoSupport(v: AlgoFacts, x: { name: string; status: string; place: string; account: string | null }): string {
  const a = v.algo;
  const s = a.spec;
  const base = s.symbol.replace(/-USD$/, '');
  const head = supportText('ValueDesk algo', {
    market: s.kind === 'basket' && s.legs?.length ? s.legs.map((l) => l.symbol).join(', ') : s.symbol,
    engine: 'perps',
    side: s.side === 'buy' ? 'Buy' : 'Sell',
    type: s.paper ? `${x.name} (practice run, nothing sent to SoDEX)` : x.name,
    status: x.status,
    size: s.kind === 'basket' ? null : v.target,
    unit: base,
    filled: s.kind === 'basket' ? null : a.filled,
    more: [
      ['Avg. fill', v.avgPrice],
      ['Runs on', x.place],
      ['Child orders sent', a.childCount],
    ],
    time: a.startedAt ?? a.createdAt,
    timeLabel: a.startedAt ? 'Started' : 'Created',
    algoId: a.id,
    account: x.account ?? a.owner,
  });
  const kids = [...a.children, ...(a.exitOrders ?? [])].sort((p, q) => q.placedAt - p.placedAt).slice(0, ALGO_CHILD_LINES);
  if (!kids.length) return head;
  const line = (c: AlgoChild) => {
    const what = c.exit ? (c.exit === 'tp' ? 'take-profit' : 'stop-loss') : c.tag;
    const ids = [`clOrdID ${c.clOrdID}`, idText(c.orderId) ? `order ID ${c.orderId}` : null].filter(Boolean).join(', ');
    return `- ${what}: ${c.side === 'buy' ? 'Buy' : 'Sell'} ${c.quantity} @ ${c.price}, filled ${c.filled}, ${c.state}, ${utcStamp(c.placedAt) ?? ''}; ${ids}`;
  };
  return `${head}\nChild orders (newest first):\n${kids.map(line).join('\n')}`;
}
