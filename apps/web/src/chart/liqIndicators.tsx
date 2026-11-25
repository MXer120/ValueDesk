/**
 * The liquidation heatmap's layers as indicators of the main chart (owner, 2026-10-29: "add
 * liquidity heatmap and liquidity map etc as an indicator"), in its Indicators menu with the
 * studies:
 *
 *   Liquidation heatmap   the levels over time behind the candles (liqHeatIndicator.ts, the
 *                         historical view's layer): the indexer's snapshots, 15-minutely for
 *                         3 days and hourly to 30.
 *   Liquidation map       the levels now as bars along the price scale (liqMap.ts), as the
 *                         heatmap's Chart view draws them.
 *
 * Both read every venue the indexer scans, for the coin of the market on the chart (perps only:
 * a spot market has no liquidations). The chart mounts and stores them as it does any study;
 * LiqIndicatorFeed reads their data while one is on and hands it to the layer (extendData).
 */
import { useIndexerView } from '../status/indexerViews';
import { useEffect } from 'react';
import type { Chart as KChart } from 'klinecharts';
import type { LiqHeatmap as HeatApi } from '@sign/indexer/liqRead.js';
import type { Engine } from '../api';
import { SCAN_VENUES, vsApi } from '../vsApi';
import { usePolled } from '../components/explore/cohorts/parts';
import { useChartWindow, useHistTiles } from '../components/liqmap/histTiles';
import { LIQ_HEAT, boxed, type HeatData } from './liqHeatIndicator';
import { LEV_BANDS } from './liqLev';
import { LIQ_MAP, coinOfSymbol, mapData } from './liqMap';

/**
 * Feeds the two layers while they are on the chart: the history's tiles for the window shown, the levels
 * now every 30 s. `ids` changes whenever the chart's studies are mounted again (a rebuild, a
 * restore), so each new layer gets the data held at once.
 */
export function LiqIndicatorFeed({ chart, engine, symbol, names, ids }: { chart: KChart | null; engine: Engine; symbol: string; names: readonly string[]; ids: string }) {
  const coin = engine === 'perps' ? coinOfSymbol(symbol) : null;
  const heatOn = !!chart && !!coin && names.includes(LIQ_HEAT);
  const mapOn = !!chart && !!coin && names.includes(LIQ_MAP);
  useIndexerView(heatOn || mapOn);
  // The snapshots of the window on the chart, in tiles, and the scale over the 30 days (components/liqmap/histTiles.ts):
  // nothing read before the chart reports its window, by side with every band (slim rows), the snapshot each bar draws.
  const view = useChartWindow(chart, heatOn);
  const hist = useHistTiles(heatOn ? coin : null, SCAN_VENUES, view, [], { waitForView: true, slim: true, draw: view?.draw ?? null });
  // The levels now summed to the Fine bar the map draws, on the server (bar=fine: a third of the buckets, the same bars).
  const now = usePolled<HeatApi>(mapOn ? `${coin}|liq-now|fine` : null, (s) => vsApi.liquidations(coin!, SCAN_VENUES, 'fine', s, [], undefined, 'fine'), 30_000);
  useEffect(() => {
    if (!chart || !heatOn) return;
    const data: HeatData = { points: hist.points, side: 'both', scale: hist.scale('both', LEV_BANDS) };
    chart.overrideIndicator({ name: LIQ_HEAT, extendData: boxed(data) });
  }, [chart, heatOn, hist.points, hist.scale, ids]);
  useEffect(() => {
    if (!chart || !mapOn) return;
    chart.overrideIndicator({ name: LIQ_MAP, extendData: boxed(mapData(now.data)) });
  }, [chart, mapOn, now.data, ids]);
  return null;
}
