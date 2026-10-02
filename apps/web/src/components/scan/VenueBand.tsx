/**
 * Scan's "Positions, orders and history" band for every venue but SoDEX.
 *
 * Built from the SoDEX band's own parts - `.acct-table.acct-t`, SortTh,
 * MarketCell with its side pill, StatusCell, Unit, the signed-money cells -
 * so a Hyperliquid, trade.xyz, Lighter or Arcus account reads exactly like a
 * SoDEX one. Only the source differs: each venue's public reads through
 * /api/vs/trader, /fills and /account.
 *
 * Tabs are the SoDEX band's, minus what the venue does not publish without
 * the account's own key (Lighter's orders and funding): a missing tab says
 * "not public", a present-but-empty one says "none".
 */
import { useMemo, type ReactNode } from 'react';
import { PanelTabs, type PanelTab } from '../../dashboard/Panel';
import { DASH, fmtDateTime, fmtPrice, fmtQty, fmtUsd } from '../../format';
import { Private, usePrivacy } from '../../privacy';
import { vsApi, type Venue, type VsBalance, type VsFill, type VsFunding, type VsOrder, type VsPosition } from '../../vsApi';
import { LoadFailed } from '../LoadFailed';
import { Card } from '../portfolio/parts';
import { CoinIcon } from '../CoinIcon';
import { FilteredEmpty, FilteredHint, MarketCell, Note, Pill, SidePill, StatusCell, Unit, signedPct, signedUsd } from '../accountTables/cells';
import { FilterBar, NO_META, type BandMeta } from '../accountTables/FilterBar';
import {
  DEFAULT_FILTER, TAB_CAPS, applyFilter, directionOfSide, hasView, readFilter, type BandTab, type RowFacts, type TabCaps,
} from '../accountTables/filters';
import { useSharedStored } from '../../hooks';
import { SortTh, sortRows, useTableSort } from '../accountTables/sort';
import type { HlState } from './HlCards';
import { useVsRead, type VsRead } from './useVs';

const POLL_MS = 30_000;

const when = (ms: number | null | undefined) => (ms ? fmtDateTime(ms) : DASH);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? '' : v > 0 ? 'pos' : 'neg');
const px = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? DASH : fmtPrice(v));
const sz = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? DASH : fmtQty(v));

/** Spot markets are pairs (BTC/USDC); everything else here is a perp. */
const engineOf = (symbol: string): 'spot' | 'perps' => (symbol.includes('/') ? 'spot' : 'perps');
/** The coin a row's size is in: xyz:AAPL -> AAPL, BTC-USD -> BTC, HYPE/USDC -> HYPE. */
const baseOf = (symbol: string) => (symbol.split(':').pop() ?? symbol).split(/[-/]/)[0] ?? symbol;

/** The venue's lower-case status as SoDEX's enum, so StatusCell draws the same icon. */
function sodexStatus(o: VsOrder): string {
  const s = o.status.toLowerCase();
  const part = (o.filled ?? 0) > 0 && (o.filled ?? 0) < o.size;
  if (s === 'open' || s === 'new' || s === 'resting') return part ? 'PARTIALLY_FILLED' : 'NEW';
  if (s === 'filled') return 'FILLED';
  if (s.includes('cancel')) return 'CANCELED';
  if (s.includes('reject')) return 'REJECTED';
  if (s === 'triggered') return 'TRIGGERED';
  if (s.includes('expire')) return 'EXPIRED';
  return s.toUpperCase();
}

function Section<T>({ read, what, empty, children }: { read: VsRead<T[]>; what: string; empty: string; children: (rows: T[]) => ReactNode }) {
  if (read.unavailable) return <Note>{`${what} are not public on this venue without the account's own key.`}</Note>;
  if (read.error) return <LoadFailed what={what} onRetry={read.refresh} />;
  if (!read.settled) return <Note>Loading…</Note>;
  const rows = read.data ?? [];
  if (!rows.length) return <Note>{empty}</Note>;
  return <>{children(rows)}</>;
}

// --- tables ------------------------------------------------------------------------------

function PositionsTable({ rows }: { rows: VsPosition[] }) {
  const { sort, toggle } = useTableSort({ key: 'value', dir: 'desc' });
  const shown = sortRows(rows, sort, (p, k) =>
    k === 'market' ? p.symbol : k === 'size' ? p.size : k === 'value' ? Math.abs(p.notional) : k === 'entry' ? p.entryPx
      : k === 'mark' ? p.markPx : k === 'liq' ? p.liqPx : k === 'upnl' ? p.uPnl : k === 'margin' ? marginOf(p) : null);
  return (
    <table className="acct-table acct-t">
      <thead>
        <tr>
          <SortTh k="market" label="Market" sort={sort} onSort={toggle} />
          <SortTh k="size" label="Size" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="value" label="Value" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="entry" label="Entry" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="mark" label="Mark" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="liq" label="Liq." numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="upnl" label="Unreal. PnL" numeric sort={sort} onSort={toggle} className="num" title="As the venue reports it; the % is against the position's margin (value ÷ leverage)." />
          <SortTh k="margin" label="Margin" numeric sort={sort} onSort={toggle} className="num" title="Value ÷ leverage." />
        </tr>
      </thead>
      <tbody>
        {shown.map((p, i) => {
          const margin = marginOf(p);
          const roe = p.uPnl != null && margin ? p.uPnl / margin : null;
          return (
            <tr key={`${p.symbol}-${i}`}>
              <td>
                <MarketCell symbol={p.symbol} sym={undefined} engine="perps" full={p.symbol.includes(':')}>
                  <SidePill dir={p.side} prefix={p.marginMode === 'isolated' ? 'Isolated' : p.marginMode === 'cross' ? 'Cross' : undefined} />
                  {p.leverage ? <span className="acct-lev">{p.leverage}x</span> : null}
                </MarketCell>
              </td>
              <td className="num"><Unit value={sz(p.size)} unit={baseOf(p.symbol)} /></td>
              <td className="num">{fmtUsd(Math.abs(p.notional))}</td>
              <td className="num">{px(p.entryPx)}</td>
              <td className="num">{px(p.markPx)}</td>
              <td className="num acct-dim">{px(p.liqPx)}</td>
              <td className={`num ${tone(p.uPnl)}`}>
                {p.uPnl == null ? DASH : <>{signedUsd(p.uPnl)}{roe !== null && <span className="acct-sub"> {signedPct(roe)}</span>}</>}
              </td>
              <td className="num">{margin ? fmtUsd(margin) : DASH}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const marginOf = (p: VsPosition): number | null => (p.leverage ? Math.abs(p.notional) / p.leverage : null);

function OrdersTable({ rows, open }: { rows: VsOrder[]; open: boolean }) {
  const { sort, toggle } = useTableSort({ key: 'time', dir: 'desc' });
  const shown = sortRows(rows, sort, (o, k) =>
    k === 'market' ? o.symbol : k === 'status' ? o.status : k === 'type' ? o.type : k === 'price' ? o.price
      : k === 'size' ? o.size : k === 'filled' ? o.filled : k === 'value' ? (o.price ?? 0) * o.size : k === 'time' ? o.time : null);
  return (
    <table className="acct-table acct-t">
      <thead>
        <tr>
          <SortTh k="market" label="Market" sort={sort} onSort={toggle} />
          {!open && <SortTh k="status" label="Status" sort={sort} onSort={toggle} />}
          <SortTh k="type" label="Type" sort={sort} onSort={toggle} />
          <SortTh k="price" label="Price" numeric sort={sort} onSort={toggle} className="num" />
          <th className="num">Trigger</th>
          <SortTh k="size" label="Size" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="filled" label="Filled" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="value" label="Value" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="time" label={open ? 'Placed' : 'Updated'} numeric sort={sort} onSort={toggle} className="num" />
        </tr>
      </thead>
      <tbody>
        {shown.map((o) => {
          const engine = engineOf(o.symbol);
          const unit = baseOf(o.symbol);
          return (
            <tr key={o.id}>
              <td>
                <MarketCell symbol={o.symbol} sym={undefined} engine={engine} full={o.symbol.includes(':')}>
                  <SidePill dir={o.side === 'buy' ? 'long' : 'short'} spot={engine === 'spot'} />
                </MarketCell>
              </td>
              {!open && (
                <td>
                  <StatusCell
                    o={{ status: sodexStatus(o), executedQty: o.filled ?? undefined, origQty: o.size }}
                    qtyText={(v) => sz(Number(v))}
                    unit={unit}
                    priceText={null}
                  />
                </td>
              )}
              <td className="acct-word">
                {o.type}
                {o.tif && <span className="acct-sub"> · {o.tif}</span>}
                {o.reduceOnly && <Pill tone="muted">Reduce</Pill>}
              </td>
              <td className="num">{o.price ? px(o.price) : <span className="acct-dim">Market</span>}</td>
              <td className="num acct-dim">{px(o.trigger)}</td>
              <td className="num"><Unit value={sz(o.size)} unit={unit} /></td>
              <td className="num">{o.filled ? sz(o.filled) : <span className="acct-dim">0</span>}</td>
              <td className="num">{o.price ? fmtUsd(o.price * o.size) : DASH}</td>
              <td className="num acct-time">{when(o.time)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TradesTable({ rows }: { rows: VsFill[] }) {
  const { sort, toggle } = useTableSort({ key: 'time', dir: 'desc' });
  const shown = sortRows(rows, sort, (f, k) =>
    k === 'market' ? f.symbol : k === 'price' ? f.px : k === 'size' ? f.sz : k === 'value' ? f.notional
      : k === 'fee' ? f.fee : k === 'pnl' ? f.closedPnl : k === 'time' ? f.time : null);
  return (
    <table className="acct-table acct-t">
      <thead>
        <tr>
          <SortTh k="market" label="Market" sort={sort} onSort={toggle} />
          <SortTh k="price" label="Price" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="size" label="Size" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="value" label="Value" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="fee" label="Fee" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="pnl" label="Closed PnL" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="time" label="Time" numeric sort={sort} onSort={toggle} className="num" />
        </tr>
      </thead>
      <tbody>
        {shown.map((f) => {
          const engine = engineOf(f.symbol);
          return (
            <tr key={f.id}>
              <td>
                <MarketCell symbol={f.symbol} sym={undefined} engine={engine} full={f.symbol.includes(':')}>
                  <SidePill dir={f.side === 'buy' ? 'long' : 'short'} spot={engine === 'spot' || !f.dir} />
                  {f.dir && engine === 'perps' && <span className="acct-sub">{f.dir}</span>}
                </MarketCell>
              </td>
              <td className="num">{px(f.px)}</td>
              <td className="num"><Unit value={sz(f.sz)} unit={baseOf(f.symbol)} /></td>
              <td className="num">{fmtUsd(f.notional)}</td>
              <td className={`num${(f.fee ?? 0) < 0 ? ' pos' : ''}`}>{f.fee == null ? DASH : fmtUsd(f.fee)}</td>
              <td className={`num ${tone(f.closedPnl)}`}>{f.closedPnl ? signedUsd(f.closedPnl) : DASH}</td>
              <td className="num acct-time">{when(f.time)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FundingTable({ rows }: { rows: VsFunding[] }) {
  const { sort, toggle } = useTableSort({ key: 'time', dir: 'desc' });
  const shown = sortRows(rows, sort, (f, k) => (k === 'market' ? f.symbol : k === 'payment' ? f.amount : k === 'rate' ? f.rate : k === 'time' ? f.time : null));
  return (
    <table className="acct-table acct-t">
      <thead>
        <tr>
          <SortTh k="market" label="Market" sort={sort} onSort={toggle} />
          <SortTh k="payment" label="Payment" numeric sort={sort} onSort={toggle} className="num" title="Positive is received, negative is paid." />
          <SortTh k="rate" label="Rate" numeric sort={sort} onSort={toggle} className="num" />
          <th className="num">Position</th>
          <SortTh k="time" label="Time" numeric sort={sort} onSort={toggle} className="num" />
        </tr>
      </thead>
      <tbody>
        {shown.map((f, i) => (
          <tr key={`${f.symbol}-${f.time}-${i}`}>
            <td>
              <MarketCell symbol={f.symbol} sym={undefined} engine="perps" full={f.symbol.includes(':')}>
                {f.size != null && <SidePill dir={f.size >= 0 ? 'long' : 'short'} />}
              </MarketCell>
            </td>
            <td className={`num ${tone(f.amount)}`}>{signedUsd(f.amount)}</td>
            <td className="num acct-dim">{f.rate == null ? DASH : `${(f.rate * 100).toFixed(4)}%`}</td>
            <td className="num"><Unit value={f.size == null ? DASH : sz(Math.abs(f.size))} unit={baseOf(f.symbol)} /></td>
            <td className="num acct-time">{when(f.time)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BalancesTable({ rows }: { rows: VsBalance[] }) {
  const { sort, toggle } = useTableSort({ key: 'usd', dir: 'desc' });
  const shown = sortRows(rows, sort, (b, k) => (k === 'coin' ? b.coin : k === 'total' ? b.total : k === 'avail' ? b.available : k === 'usd' ? b.usd : null));
  return (
    <table className="acct-table acct-t">
      <thead>
        <tr>
          <SortTh k="coin" label="Coin" sort={sort} onSort={toggle} />
          <SortTh k="total" label="Total" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="avail" label="Available" numeric sort={sort} onSort={toggle} className="num" />
          <SortTh k="usd" label="Value" numeric sort={sort} onSort={toggle} className="num" />
        </tr>
      </thead>
      <tbody>
        {shown.map((b) => (
          <tr key={b.coin}>
            <td>
              <span className="acct-mkt">
                <CoinIcon coin={b.coin} size={18} />
                <span className="acct-mkt__n">{b.coin}</span>
              </span>
            </td>
            <td className="num">{sz(b.total)}</td>
            <td className="num">{sz(b.available)}</td>
            <td className="num">{b.usd == null ? DASH : fmtUsd(b.usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Close {
  id: string;
  symbol: string;
  /** The side of the position the order closed. */
  dir: 'long' | 'short';
  size: number;
  avgPx: number;
  pnl: number;
  fee: number | null;
  time: number;
}

/** Closing fills grouped by order: one row per closing order, PnL summed. */
function closesOf(fills: VsFill[]): Close[] {
  const by = new Map<string, Close>();
  for (const f of fills) {
    if (!f.closedPnl) continue;
    const k = f.oid ?? `${f.symbol}|${f.time}|${f.side}`;
    const c = by.get(k) ?? { id: k, symbol: f.symbol, dir: f.side === 'sell' ? 'long' : 'short', size: 0, avgPx: 0, pnl: 0, fee: null, time: 0 };
    c.avgPx = (c.avgPx * c.size + f.px * f.sz) / (c.size + f.sz || 1);
    c.size += f.sz;
    c.pnl += f.closedPnl;
    if (f.fee != null) c.fee = (c.fee ?? 0) + f.fee;
    c.time = Math.max(c.time, f.time);
    by.set(k, c);
  }
  return [...by.values()];
}

function ClosesTable({ rows }: { rows: Close[] }) {
  const { sort, toggle } = useTableSort({ key: 'time', dir: 'desc' });
  const shown = sortRows(rows, sort, (c, k) => (k === 'market' ? c.symbol : k === 'size' ? c.size : k === 'pnl' ? c.pnl : k === 'time' ? c.time : null));
  return (
    <table className="acct-table acct-t">
      <thead>
        <tr>
          <SortTh k="market" label="Market" sort={sort} onSort={toggle} />
          <SortTh k="size" label="Closed size" numeric sort={sort} onSort={toggle} className="num" />
          <th className="num">Avg. close</th>
          <SortTh k="pnl" label="Realised PnL" numeric sort={sort} onSort={toggle} className="num" />
          <th className="num">Fees</th>
          <SortTh k="time" label="Closed" numeric sort={sort} onSort={toggle} className="num" />
        </tr>
      </thead>
      <tbody>
        {shown.map((c) => (
          <tr key={c.id}>
            <td>
              <MarketCell symbol={c.symbol} sym={undefined} engine={engineOf(c.symbol)} full={c.symbol.includes(':')}>
                <SidePill dir={c.dir} prefix="Close" />
              </MarketCell>
            </td>
            <td className="num"><Unit value={sz(c.size)} unit={baseOf(c.symbol)} /></td>
            <td className="num">{px(c.avgPx)}</td>
            <td className={`num ${tone(c.pnl)}`}>{signedUsd(c.pnl)}</td>
            <td className="num acct-dim">{c.fee == null ? DASH : fmtUsd(c.fee)}</td>
            <td className="num acct-time">{when(c.time)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- the band ------------------------------------------------------------------------------

/** This band's tab keys as the portfolio band names them (its filters and caps). */
const TAB_OF: Record<string, BandTab> = {
  positions: 'positions', orders: 'orders', balances: 'balances', 'order-history': 'order-history',
  'trade-history': 'trade-history', 'funding-history': 'funding-history', closed: 'position-history',
};

/** The portfolio's caps, minus what these venues' rows cannot answer. */
function capsOf(t: BandTab): TabCaps {
  const c = TAB_CAPS[t];
  return { ...c, market: false, source: false, margin: t === 'positions' && c.margin };
}

const positionFacts = (p: VsPosition): RowFacts => ({ symbol: p.symbol, side: p.side, margin: p.marginMode ?? null });
const orderFacts = (o: VsOrder): RowFacts => ({ symbol: o.symbol, side: directionOfSide(o.side), time: o.time });
const fillFacts = (f: VsFill): RowFacts => ({ symbol: f.symbol, side: directionOfSide(f.side), time: f.time });
const fundingFacts = (f: VsFunding): RowFacts => ({
  symbol: f.symbol, side: f.size == null || f.size === 0 ? null : f.size > 0 ? 'long' : 'short', time: f.time,
});
const closeFacts = (c: Close): RowFacts => ({ symbol: c.symbol, side: c.dir, time: c.time });

/** Which tabs each venue can fill (the rest are not public without the account's key). */
const HAS: Record<Venue, { orders: boolean; funding: boolean; balances: boolean }> = {
  sodex: { orders: true, funding: true, balances: true },
  hyperliquid: { orders: true, funding: true, balances: true },
  tradexyz: { orders: true, funding: true, balances: false },
  arcus: { orders: true, funding: true, balances: true },
  lighter: { orders: false, funding: false, balances: true },
};

export function VenueBand({ hl }: { hl: HlState }) {
  const venue = hl.venue;
  const a = hl.address?.toLowerCase() ?? null;
  const has = HAS[venue];
  const open = useVsRead(a && has.orders ? `open:${venue}:${a}` : null, () => vsApi.openOrders(venue, a!), POLL_MS);
  const history = useVsRead(a && has.orders ? `ohist:${venue}:${a}` : null, () => vsApi.orderHistory(venue, a!));
  const funding = useVsRead(a && has.funding ? `fund:${venue}:${a}` : null, () => vsApi.funding(venue, a!));
  const balances = useVsRead(a && has.balances ? `bal:${venue}:${a}` : null, () => vsApi.balances(venue, a!), POLL_MS);
  const hideCounts = usePrivacy().isHidden('counts');
  const count = (n: number | undefined) => (n === undefined || hideCounts ? '' : ` (${n})`);

  /*
   * The portfolio band's View settings, shared with it (same stored key): a
   * Short filter chosen there narrows these tables too. No "current market"
   * here, and no copy-trade source (that reads SoDEX's clOrdID prefix).
   */
  const [rawFilter, setRawFilter] = useSharedStored<unknown>('vs.acct.filter', null);
  const filter = useMemo(() => readFilter(rawFilter), [rawFilter]);
  const [hideDust, setHideDust] = useSharedStored('vs.balances.hideDust', false);
  const resetView = () => setRawFilter({ ...DEFAULT_FILTER });
  const now = Date.now();
  const view = <T,>(tab: BandTab, rows: T[], facts: (r: T) => RowFacts, render: (rows: T[]) => ReactNode): ReactNode => {
    const shown = applyFilter(rows, facts, filter, capsOf(tab), { market: null, now });
    if (!shown.length) return <FilteredEmpty onReset={resetView} />;
    return <>{render(shown)}<FilteredHint shown={shown.length} total={rows.length} onReset={resetView} /></>;
  };
  const oldest = (times: number[] | undefined): BandMeta => {
    const t = (times ?? []).filter((x) => Number.isFinite(x) && x > 0);
    return { oldest: t.length ? Math.min(...t) : null, staleAt: null, more: false };
  };
  const metaOf = (t: BandTab): BandMeta =>
    t === 'order-history' ? oldest(history.data?.map((o) => o.time))
      : t === 'trade-history' || t === 'position-history' ? oldest(hl.fills.data?.map((f) => f.time))
      : t === 'funding-history' ? oldest(funding.data?.map((f) => f.time))
      : NO_META;
  const actions = (active: string): ReactNode => {
    const t = TAB_OF[active] ?? 'positions';
    if (t === 'balances') {
      return (
        <label className="bal-dust">
          <input type="checkbox" checked={hideDust} onChange={(e) => setHideDust(e.target.checked)} />
          Hide dust
        </label>
      );
    }
    const caps = capsOf(t);
    if (!hasView(caps)) return null;
    return (
      <FilterBar
        caps={caps}
        filter={filter}
        onFilter={(f) => setRawFilter(f)}
        marketLabel={null}
        currentOnly={false}
        onCurrentOnly={() => {}}
        meta={metaOf(t)}
      />
    );
  };

  const positions = hl.trader.data?.positions;
  const noAddress = !a;
  const note = (text: string) => <Note>{text}</Note>;
  const traderBlock = noAddress ? note('Scan an address to see its account.')
    : hl.trader.unavailable ? note('Not available on this venue yet.')
    : hl.trader.error ? <LoadFailed what="Account" onRetry={hl.trader.refresh} />
    : !hl.trader.settled ? note('Loading…')
    : null;

  const tabs: PanelTab[] = [
    {
      key: 'positions',
      label: `Positions${count(positions?.length)}`,
      content: (
        <Private k="positions">
          <section className="panel acct">
            {traderBlock ?? (positions?.length
              ? view('positions', positions, positionFacts, (rows) => <PositionsTable rows={rows} />)
              : note('No open positions.'))}
          </section>
        </Private>
      ),
    },
    ...(has.orders
      ? [{
          key: 'orders',
          label: `Open Orders${count(open.data?.length)}`,
          content: (
            <section className="panel acct">
              {noAddress ? note('Scan an address to see its orders.')
                : <Section read={open} what="Open orders" empty="No open orders.">{(rows) => view('orders', rows, orderFacts, (r) => <OrdersTable rows={r} open />)}</Section>}
            </section>
          ),
        }]
      : []),
    ...(has.balances
      ? [{
          key: 'balances',
          label: 'Balances',
          content: (
            <Private k="funds">
              <section className="panel acct">
                {noAddress ? note('Scan an address to see its balances.')
                  : <Section read={balances} what="Balances" empty="No balances.">
                    {(rows) => {
                      const kept = hideDust ? rows.filter((b) => !(b.usd !== null && b.usd < 1)) : rows;
                      return kept.length ? <BalancesTable rows={kept} /> : note('Nothing above 1 USD.');
                    }}
                  </Section>}
              </section>
            </Private>
          ),
        }]
      : []),
    ...(has.orders
      ? [{
          key: 'order-history',
          label: 'Order History',
          content: (
            <section className="panel acct">
              {noAddress ? note('Scan an address to see its orders.')
                : <Section read={history} what="Order history" empty="No orders on record.">{(rows) => view('order-history', rows, orderFacts, (r) => <OrdersTable rows={r} open={false} />)}</Section>}
            </section>
          ),
        }]
      : []),
    {
      key: 'trade-history',
      label: 'Trade History',
      content: (
        <Private k="history">
          <section className="panel acct">
            {noAddress ? note('Scan an address to see its fills.')
              : <Section read={hl.fills} what="Fills" empty="No fills on record.">{(rows) => view('trade-history', rows, fillFacts, (r) => <TradesTable rows={r} />)}</Section>}
          </section>
        </Private>
      ),
    },
    ...(has.funding
      ? [{
          key: 'funding-history',
          label: 'Funding History',
          content: (
            <section className="panel acct">
              {noAddress ? note('Scan an address to see its funding.')
                : <Section read={funding} what="Funding payments" empty="No funding payments in the last 30 days.">{(rows) => view('funding-history', rows, fundingFacts, (r) => <FundingTable rows={r} />)}</Section>}
            </section>
          ),
        }]
      : []),
    {
      key: 'closed',
      label: 'Closed Trades',
      content: (
        <Private k="history">
          <section className="panel acct">
            {noAddress ? note('Scan an address to see its closed trades.')
              : (
                <Section read={hl.fills} what="Fills" empty="No closing fills in the loaded history.">
                  {(rows) => {
                    const closes = closesOf(rows);
                    return closes.length ? view('position-history', closes, closeFacts, (r) => <ClosesTable rows={r} />) : note('No closing fills in the loaded history.');
                  }}
                </Section>
              )}
          </section>
        </Private>
      ),
    },
  ];

  return (
    <Card className="pf-card--band">
      <div className="dash pf-band">
        <PanelTabs tabs={tabs} actions={actions} />
      </div>
    </Card>
  );
}
