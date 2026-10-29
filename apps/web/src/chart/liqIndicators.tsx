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
import { useEffect } from 'react';
import type { Chart as KChart } from 'klinecharts';
import type { LiqHeatmap as HeatApi, LiqHistory } from '@sign/indexer/liqRead.js';
import type { Engine } from '../api';
import { SCAN_VENUES, vsApi } from '../vsApi';
import { usePolled } from '../components/explore/cohorts/parts';
import { LIQ_HEAT, heatScale, type HeatData } from './liqHeatIndicator';
import { LIQ_MAP, coinOfSymbol, mapData } from './liqMap';

/**
 * Feeds the two layers while they are on the chart: the history every 5 minutes, the levels
 * now every 30 s. `ids` changes whenever the chart's studies are mounted again (a rebuild, a
 * restore), so each new layer gets the data held at once.
 */
export function LiqIndicatorFeed({ chart, engine, symbol, names, ids }: { chart: KChart | null; engine: Engine; symbol: string; names: readonly string[]; ids: string }) {
  const coin = engine === 'perps' ? coinOfSymbol(symbol) : null;
  const heatOn = !!chart && !!coin && names.includes(LIQ_HEAT);
  const mapOn = !!chart && !!coin && names.includes(LIQ_MAP);
  const hist = usePolled<LiqHistory>(heatOn ? `${coin}|liq-hist` : null, (s) => vsApi.liquidationHistory(coin!, SCAN_VENUES, '30d', s), 5 * 60_000);
  const now = usePolled<HeatApi>(mapOn ? `${coin}|liq-now` : null, (s) => vsApi.liquidations(coin!, SCAN_VENUES, 'fine', s, []), 30_000);
  useEffect(() => {
    if (!chart || !heatOn) return;
    const points = hist.data?.points ?? [];
    const data: HeatData = { points, side: 'both', scale: heatScale(points) };
    chart.overrideIndicator({ name: LIQ_HEAT, extendData: data });
  }, [chart, heatOn, hist.data, ids]);
  useEffect(() => {
    if (!chart || !mapOn) return;
    chart.overrideIndicator({ name: LIQ_MAP, extendData: mapData(now.data) });
  }, [chart, mapOn, now.data, ids]);
  return null;
}
