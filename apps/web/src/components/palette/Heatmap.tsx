/**
 * Home's market map: every asset the tracked wallets hold, as one compact
 * treemap - the cohort pages' market map (Explore > Cohorts > Market map)
 * without its sector frames, which leave no room for tiles at this size.
 *
 * DATA. /api/vs/cohorts/map for every venue and every wallet
 * (`vsApi.cohortMap(SCAN_VENUES, null)`), read only while Home is on screen,
 * re-read every minute, retried on a backoff after a failure. The last answer
 * is kept for the session, so reopening the palette paints the map at once.
 *
 * DRAWING. The tiles are the cohort map's own pieces (Treemap.tsx: `squarify`
 * lays them out, `MarketTile` draws what fits of logo, name, uPnL and lean,
 * `tone` colours the lean). Size is gross exposure, colour the side the
 * wallets lean to. A tile opens that asset's cohort page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { longShare, type CohortMapResponse, type CohortMarket } from '@sign/valuescan/cohorts/model.js';
import { SCAN_VENUES, vsApi } from '../../vsApi';
import { MarketTile, squarify, tone, type Tile } from '../explore/cohorts/Treemap';
import { fmtUsdShort } from '../explore/model';
import { LoadFailed, logLoadFailure } from '../LoadFailed';
import { IconChevronRight, IconMap } from './icons';
import { flattenMapAssets, mapTotals } from './model';
import { retryDelay } from './usePaletteData';
import { EmptyState, Panel, useBoxSize } from './ui';

const POLL_MS = 60_000;
const TIMEOUT_MS = 45_000;

/** The last good answer, for the whole session: reopening paints at once, then revalidates. */
let lastMap: { at: number; data: CohortMapResponse } | null = null;

export interface CohortMapState {
  data: CohortMapResponse | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** The market map of every wallet on every venue, polled while `enabled`. */
export function useCohortMap(enabled: boolean): CohortMapState {
  const [data, setData] = useState<CohortMapResponse | null>(() => lastMap?.data ?? null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => {
    setError(null);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let ac: AbortController | null = null;
    let timer: number | undefined;
    let failures = 0;
    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, Math.max(0, ms));
    };
    function run() {
      ac?.abort();
      const mine = new AbortController();
      ac = mine;
      const deadline = window.setTimeout(() => mine.abort(), TIMEOUT_MS);
      vsApi.cohortMap(SCAN_VENUES, null, mine.signal)
        .then((d) => {
          if (!alive || mine.signal.aborted) return;
          lastMap = { at: Date.now(), data: d };
          setData(d);
          setError(null);
          failures = 0;
          schedule(POLL_MS);
        })
        .catch((e) => {
          if (!alive) return;
          // Our own deadline aborts too: that is a failure, not a cancel.
          if (mine !== ac) return;
          failures += 1;
          logLoadFailure('Market map (search)', e);
          setError(e instanceof Error ? e.message : String(e));
          schedule(retryDelay(failures));
        })
        .finally(() => window.clearTimeout(deadline));
    }
    const fresh = lastMap && Date.now() - lastMap.at < POLL_MS / 2;
    if (lastMap) setData(lastMap.data);
    if (fresh && nonce === 0) schedule(POLL_MS - (Date.now() - lastMap!.at));
    else run();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      ac?.abort();
      ac = null;
    };
  }, [enabled, nonce]);

  return { data, loading: enabled && !data && !error, error: data ? null : error, retry };
}

/**
 * The last layout, kept for the session: reopening the palette with the same
 * answer at the same size reuses it instead of flattening and squarifying some
 * 360 assets again on the frame the sheet opens.
 */
let lastLayout: { key: string; assets: CohortMarket[]; tiles: Array<Tile<CohortMarket>> } | null = null;

function layoutOf(data: CohortMapResponse | null, w: number, h: number): { assets: CohortMarket[]; tiles: Array<Tile<CohortMarket>> } {
  if (!data) return { assets: [], tiles: [] };
  const key = `${data.at}|${w}x${h}`;
  if (lastLayout?.key === key) return lastLayout;
  const assets = lastLayout && lastLayout.key.startsWith(`${data.at}|`) ? lastLayout.assets : flattenMapAssets(data.sectors);
  const tiles = w > 0 && h > 0 ? squarify(assets.map((m) => ({ value: m.long + m.short, item: m })), { x: 0, y: 0, w, h }) : [];
  lastLayout = { key, assets, tiles };
  return lastLayout;
}

/** Long share's colour: the side it leans to, none when it reads as an even 50.0%. */
const leanClass = (share: number): string => ((share * 100).toFixed(1) === '50.0' ? '' : share > 0.5 ? 'pos' : 'neg');

/** The Home panel: header strip (glyph, title, count and lean, "Open"), then the tiles. */
export function MarketHeatmap({
  enabled, onAsset, onOpenMap,
}: {
  enabled: boolean;
  /** A tile: that asset's cohort page. */
  onAsset: (coin: string) => void;
  /** The header's Open: the whole market map. */
  onOpenMap: () => void;
}) {
  const map = useCohortMap(enabled);
  const [boxRef, size] = useBoxSize<HTMLDivElement>();
  const { assets, tiles } = useMemo(() => layoutOf(map.data, size.w, size.h), [map.data, size.w, size.h]);
  const totals = useMemo(() => mapTotals(assets), [assets]);
  // The tiles are built once per layout; a parent re-render reuses them.
  const pick = useRef(onAsset);
  pick.current = onAsset;
  // Tiles too small to carry even a logo (most of the ~360) are drawn as bare
  // tiles in the same tone - MarketTile would draw nothing more in them - so
  // the map mounts in a fraction of the time.
  const tileEls = useMemo(
    () => tiles.map((t) => (Math.min(t.w, t.h) >= 14
      ? <MarketTile key={t.item.coin} m={t.item} rect={t} active={false} onClick={() => pick.current(t.item.coin)} />
      : (
        <button
          key={t.item.coin}
          type="button"
          className="coh-tree__tile is-t0"
          style={{ left: t.x + 1, top: t.y + 1, width: Math.max(0, t.w - 2), height: Math.max(0, t.h - 2), background: tone(longShare(t.item.long, t.item.short)) }}
          title={`${t.item.coin} · long ${fmtUsdShort(t.item.long)} · short ${fmtUsdShort(t.item.short)} · ${t.item.holders} wallets`}
          onClick={() => pick.current(t.item.coin)}
        />
      ))),
    [tiles],
  );
  const share = totals.longShare;
  const meta = assets.length > 0 ? (
    <>
      <span className="cp-num">{assets.length.toLocaleString('en-US')}</span> assets
      <span className="cp-dot">·</span>
      <span className="cp-num">{fmtUsdShort(totals.long + totals.short)}</span>
      {share !== null && (
        <>
          <span className="cp-dot">·</span>
          <span className={`cp-num ${leanClass(share)}`} title="Share of the notional that is long">{(share * 100).toFixed(1)}% long</span>
        </>
      )}
    </>
  ) : null;

  return (
    <Panel
      title="Market map"
      icon={<IconMap />}
      meta={meta}
      className="cp-panel--map"
      right={
        <button type="button" className="cp-linkbtn" onClick={onOpenMap} title="Open the market map in Explore">
          Open<IconChevronRight size={14} />
        </button>
      }
    >
      <div
        ref={boxRef}
        className={`cp-heat${map.data && !tiles.length ? ' is-empty' : ''}`}
      >
        {tileEls}
        {!map.data && map.loading && <span className="cp-heat__skel cp-shimmer" aria-hidden="true" />}
        {!map.data && map.error && <div className="cp-heat__state"><LoadFailed what="Market map" onRetry={map.retry} /></div>}
        {map.data && !tiles.length && size.w > 0 && (
          <div className="cp-heat__state"><EmptyState title="No open positions">The tracked wallets hold no positions right now.</EmptyState></div>
        )}
      </div>
    </Panel>
  );
}
