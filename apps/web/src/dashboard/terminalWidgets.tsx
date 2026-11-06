/**
 * Terminal widgets the app had the data for but no view of on the trade page:
 * the watchlist (your favourite markets with their last price and day's move,
 * from the same tickers the market strip reads), whale trades (the large fills
 * /api/vs/whales returns, on SoDEX and Hyperliquid) and the price heatmap
 * (Explore's Markets heatmap over the same reads, sized to the panel). Nothing
 * here is made up: a figure the feed does not have is a dash.
 */
import { useMemo, useState } from 'react';
import type { Engine } from '../api';
import { CoinIcon } from '../components/CoinIcon';
import { EmptyState } from '../components/EmptyState';
import { VenueLogo } from '../components/VenueLogo';
import { fmtPx, fmtUsdShort } from '../components/explore/model';
import { coinLabel, fmtPct, fmtTime, shortAddr } from '../format';
import { useAsync, useSharedPoll, useSymbols, useTickers } from '../hooks';
import { vsApi, type Venue } from '../vsApi';
import { Heatmap } from '../components/explore/markets/Heatmap';
import { buildMarkets, type HeldAsset, type HlAsset } from '../components/explore/markets/model';
import { SourcePick, readSource, writeSource, type VenueSource } from './sourceWidgets';
import './terminalWidgets.css';

const tone = (v: number | null | undefined) => (v == null || !Number.isFinite(v) || v === 0 ? '' : v > 0 ? 'pos' : 'neg');

/** The favourites (`perps:BTC-USD` keys, the market strip's), each with its ticker. */
export function Watchlist({ engine, symbol, favorites, onSelect }: {
  engine: Engine;
  symbol: string;
  favorites: readonly string[];
  onSelect: (symbol: string) => void;
}) {
  const tickers = useTickers(engine, { pollMs: 5_000 });
  const mine = favorites.filter((k) => k.startsWith(`${engine}:`)).map((k) => k.slice(engine.length + 1));
  const by = new Map((tickers.data?.tickers ?? []).map((t) => [t.symbol, t]));
  if (!mine.length) {
    return <EmptyState compact icon="coins" title="No favourites yet" line="Star a market in the market strip or the symbol search and it is listed here." />;
  }
  return (
    <div className="tw" role="table" aria-label="Watchlist">
      <div className="tw__row tw__head" role="row">
        <span role="columnheader">Market</span>
        <span role="columnheader">Last</span>
        <span role="columnheader">24h</span>
      </div>
      {mine.map((s) => {
        const t = by.get(s);
        const last = t ? Number(t.lastPx) : null;
        return (
          <button
            key={s}
            type="button"
            role="row"
            className={`tw__row tw__btn${s === symbol ? ' is-on' : ''}`}
            onClick={() => onSelect(s)}
            title={`Open ${coinLabel(s)}`}
          >
            <span className="tw__name" role="cell"><CoinIcon coin={s} size={16} />{coinLabel(s)}</span>
            <span role="cell" className="tw__num">{fmtPx(last)}</span>
            <span role="cell" className={`tw__num ${tone(t?.changePct)}`}>{fmtPct(t?.changePct)}</span>
          </button>
        );
      })}
    </div>
  );
}

const VENUE_OF: Record<Exclude<VenueSource, 'all'>, Venue> = { sodex: 'sodex', hl: 'hyperliquid' };

/** Large fills, newest first, on the venue picked (All by default, remembered per browser). */
export function WhaleTrades({ id, onScan }: { id: string; onScan: (address: string) => void }) {
  const [source, setSource] = useState<VenueSource>(() => readSource(id));
  const venue = source === 'all' ? 'all' : VENUE_OF[source];
  const feed = useSharedPoll(`vs:whales:${venue}`, () => vsApi.whales({ venue, limit: 60 }), { pollMs: 15_000 });
  const rows = feed.data ?? [];
  return (
    <div className="tw tw--whales">
      <div className="tw__bar">
        <SourcePick
          label="Whale trades source"
          value={source}
          onChange={(next) => { setSource(next); writeSource(id, next); }}
        />
      </div>
      {feed.error && !rows.length ? (
        <EmptyState compact icon="alert" title="Whale trades did not load" line={feed.error} />
      ) : !rows.length ? (
        <EmptyState compact icon="history" title={feed.loading ? 'Loading whale trades…' : 'No large trades yet'} />
      ) : (
        <div role="table" aria-label="Whale trades">
          <div className="tw__row tw__row--5 tw__head" role="row">
            <span role="columnheader">Market</span>
            <span role="columnheader">Side</span>
            <span role="columnheader">Size</span>
            <span role="columnheader">Price</span>
            <span role="columnheader">Time</span>
          </div>
          {rows.map((r, i) => (
            <button
              key={`${r.venue}:${r.time}:${r.address}:${i}`}
              type="button"
              role="row"
              className="tw__row tw__row--5 tw__btn"
              onClick={() => r.address && onScan(r.address)}
              title={r.address ? `Scan ${shortAddr(r.address)}` : undefined}
            >
              <span className="tw__name" role="cell"><VenueLogo venue={r.venue} size={14} />{coinLabel(r.symbol.replace(/^xyz:/i, ''))}</span>
              <span role="cell" className={r.side === 'buy' ? 'pos' : 'neg'}>{r.side === 'buy' ? 'Buy' : 'Sell'}</span>
              <span role="cell" className="tw__num">{fmtUsdShort(r.notional)}</span>
              <span role="cell" className="tw__num">{fmtPx(r.px)}</span>
              <span role="cell" className="tw__num tw__dim">{fmtTime(r.time)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const MAP_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];

/** Every market by 24h volume, coloured by its 24h move; a tile SoDEX lists opens it here. */
export function MarketHeat({ onOpenSymbol }: { onOpenSymbol: (symbol: string) => void }) {
  // The same shared reads as Explore's Markets page (one request each, whoever asks).
  const hl = useSharedPoll('vs:screener:assets', () => vsApi.assets(), { pollMs: 30_000 });
  const tickers = useTickers('perps', { pollMs: 30_000 });
  const { symbols } = useSymbols('perps');
  const map = useAsync(() => vsApi.cohortMap(MAP_VENUES, null), [], { pollMs: 5 * 60_000 });
  const held = useMemo<HeldAsset[]>(() => (map.data?.sectors ?? []).flatMap((s) => s.assets ?? []), [map.data]);
  const rows = useMemo(
    // The heat tiles draw no open interest, so nothing is read for it.
    () => buildMarkets(Array.isArray(hl.data?.assets) ? (hl.data.assets as HlAsset[]) : [], tickers.data?.tickers, symbols, held, null).filter((r) => !r.tradfi),
    [hl.data, tickers.data, symbols, held],
  );
  if (!rows.length) {
    return <EmptyState compact icon="chart" title={hl.error ? 'Markets did not load' : 'Loading markets…'} line={hl.error ?? undefined} />;
  }
  return (
    <div className="tw-heat">
      <Heatmap rows={rows} active={null} onPick={(key) => { const r = rows.find((x) => x.key === key); if (r?.sodex) onOpenSymbol(r.sodex); }} />
    </div>
  );
}
