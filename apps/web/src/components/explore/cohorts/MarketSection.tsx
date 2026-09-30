/**
 * Cohorts > Market map, and the page behind each of its tiles.
 *
 * The map: every asset the chosen venues' wallets hold, grouped by sector
 * (MarketMap.tsx) - for every wallet, or for one cohort.
 *
 * The page (an asset, or a whole sector, across every venue chosen): where
 * each cohort stands on it. Every wallet's totals up top, then one chart with
 * every cohort's long share over time (PnL cohorts or size cohorts), then the
 * cohorts side by side - a row opens that cohort filtered to this asset. A
 * sector's page maps its assets too.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import {
  COHORT_BY_ID, PNL_COHORTS, SECTORS, SIZE_COHORTS, leanOf, longShare, sectorOf,
  type CohortFilter, type CohortFocusResponse, type CohortId, type CohortMapResponse, type CohortRange, type Sector,
} from '@sign/valuescan/cohorts/model.js';
import { vsApi, type Venue } from '../../../vsApi';
import { useStored } from '../../../hooks';
import { DASH, marketName } from '../../../format';
import { CoinIcon } from '../../CoinIcon';
import { LoadFailed } from '../../LoadFailed';
import { fmtCount, fmtUsdShort } from '../model';
import { CohortIcon } from './CohortIcon';
import { COHORT_COLOR } from './cohortStyle';
import { MarketMap } from './MarketMap';
import { MultiLeanChart, shareAt } from './MultiLeanChart';
import { BiasPill, LeanPill, Meter, Picker, pctText, usePolled } from './parts';
import { Treemap } from './Treemap';
import { PriceChart, toCandles, type PriceKind } from './PriceChart';
import { AllHidden, useCohortView } from './view';

const SECTOR_LABEL = Object.fromEntries(SECTORS.map((s) => [s.id, s.label])) as Record<Sector, string>;
const RANGES: Array<{ id: CohortRange; label: string }> = [
  { id: '1d', label: '24H' }, { id: '7d', label: '7D' }, { id: '30d', label: '30D' },
];

/* --- the map --------------------------------------------------------------------------- */

export function MarketMapPage({
  venues, onSector, onAsset,
}: {
  venues: readonly Venue[];
  onSector: (s: Sector) => void;
  onAsset: (coin: string) => void;
}) {
  const [who, setWho] = useState<CohortId | null>(null);
  const key = `${venues.join(',')}|${who ?? 'all'}`;
  const r = usePolled<CohortMapResponse>(key, (signal) => vsApi.cohortMap(venues, who, signal));
  const d = r.data;
  const long = d ? d.sectors.reduce((n, s) => n + s.long, 0) : 0;
  const short = d ? d.sectors.reduce((n, s) => n + s.short, 0) : 0;
  const lshare = longShare(long, short);
  const v = useCohortView();
  const showMeters = v.show('map', 'meters');
  const showMap = v.show('map', 'map');

  return (
    <div className={`coh-mp${r.stale ? ' is-stale' : ''}`}>
      <div className="coh-d__head">
        <span className="coh-card__icon"><MapGlyph /></span>
        <div className="coh-d__title"><h2>Market map</h2><span>Every asset held, by sector · size is position value, colour is lean</span></div>
        <div className="coh-mp__who">
          <Picker
            label="Positions of"
            empty="Every wallet"
            align="right"
            value={who ? <span className="coh-pick__coin"><CohortIcon id={who} size={14} />{COHORT_BY_ID[who].name}</span> : null}
            onClear={() => setWho(null)}
          >
            {(close) => {
              const opt = (id: CohortId | null, label: string) => (
                <button key={id ?? 'all'} type="button" role="option" aria-selected={who === id} className={`coh-pick__opt${who === id ? ' is-on' : ''}`} onClick={() => { setWho(id); close(); }}>
                  {id ? <CohortIcon id={id} size={14} /> : <span className="coh-pick__glyph" aria-hidden="true" />}
                  <span className="coh-pick__label">{label}</span>
                </button>
              );
              return (
                <div className="coh-pick__list is-tall">
                  {opt(null, 'Every wallet')}
                  <div className="coh-pick__head"><span>All-time PnL</span></div>
                  {PNL_COHORTS.map((c) => opt(c.id, c.name))}
                  <div className="coh-pick__head"><span>Account size</span></div>
                  {SIZE_COHORTS.map((c) => opt(c.id, c.name))}
                </div>
              );
            }}
          </Picker>
        </div>
      </div>
      {!showMeters && !showMap && <AllHidden />}
      {showMeters && <div className="coh-d__meters">
        <Meter
          title="Notional"
          share={lshare}
          left={<>{d ? fmtUsdShort(long) : DASH} · {pctText(lshare)} long</>}
          right={<>{pctText(lshare === null ? null : 1 - lshare)} short · {d ? fmtUsdShort(short) : DASH}</>}
        />
        <div className="coh-mp__sectors">
          {(d?.sectors ?? []).slice(0, 6).map((s) => {
            const sh = longShare(s.long, s.short);
            return (
              <button key={s.sector} type="button" className="coh-mp__chip" onClick={() => onSector(s.sector)} title={`${SECTOR_LABEL[s.sector]}: ${pctText(sh)} long`}>
                <span>{SECTOR_LABEL[s.sector]}</span>
                <b className={sh !== null && sh >= 0.5 ? 'pos' : 'neg'}>{pctText(sh)}</b>
              </button>
            );
          })}
        </div>
      </div>}
      {showMap && <section className="coh-d__panel coh-mp__panel">
        {r.error && !d ? <LoadFailed what="Market map" onRetry={r.retry} /> : (
          <MarketMap sectors={d?.sectors ?? []} onSector={onSector} onAsset={onAsset} resetKey={key} height={640} />
        )}
      </section>}
    </div>
  );
}

/* --- one asset or sector ------------------------------------------------------------------ */

export function FocusPage({
  venues, focus, onBack, onOpenCohort, onAsset,
}: {
  venues: readonly Venue[];
  focus: CohortFilter;
  onBack: () => void;
  onOpenCohort: (id: CohortId, f: CohortFilter) => void;
  onAsset: (coin: string) => void;
}) {
  const [range, setRange] = useState<CohortRange>('7d');
  const [group, setGroup] = useState<'pnl' | 'size'>('pnl');
  /** The chart's hovered time: the table shows each cohort as it stood then. */
  const [at, setAt] = useState<number | null>(null);
  const key = `${venues.join(',')}|${focus.coin ?? ''}|${focus.sector ?? ''}|${range}`;
  const r = usePolled<CohortFocusResponse>(key, (signal) => vsApi.cohortFocus(venues, focus, range, signal));
  const d = r.data;
  const t = d?.total;
  const name = focus.coin ? marketName(focus.coin) : SECTOR_LABEL[focus.sector!];
  const sector = focus.coin ? sectorOf(focus.coin) : null;
  const lshare = t ? longShare(t.long, t.short) : null;
  const pos = t ? t.inProfit + t.inLoss : 0;
  const v = useCohortView();
  const shown = (group === 'pnl' ? PNL_COHORTS : SIZE_COHORTS).filter((c) => v.cohortOn(c.id));
  const ids = shown.map((c) => c.id);
  const rows = useMemo(() => {
    const by = new Map((d?.cohorts ?? []).map((c) => [c.id, c]));
    return shown.map((c) => by.get(c.id)).filter((c) => !!c);
  }, [d, shown.map((c) => c.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const showMeters = v.show('focus', 'meters');
  const showChart = v.show('focus', 'chart');
  const showPrice = !!focus.coin && v.show('focus', 'price');
  const showTable = v.show('focus', 'tables');
  const showAssets = !!focus.sector && !focus.coin && v.show('focus', 'assets');
  const noneInGroup = <p className="acct-empty">Every {group === 'pnl' ? 'PnL' : 'size'} cohort is hidden under View.</p>;
  // One asset: its price under the chart (a sector has its map there instead).
  const priceKey = focus.coin ? `${focus.coin}|${range}` : null;
  const price = usePolled(priceKey, (signal) => vsApi.price(focus.coin!, range, signal));
  const candles = useMemo(() => toCandles(price.data?.candles, price.data?.points ?? []), [price.data]);
  const [kindRaw, setKind] = useStored<PriceKind>('vs.cohorts.priceKind', 'candles');
  const kind: PriceKind = kindRaw === 'line' ? 'line' : 'candles';
  const groupSwitch = (
    <div className="lbp-seg" role="radiogroup" aria-label="Cohorts shown">
      <button type="button" role="radio" aria-checked={group === 'pnl'} className={group === 'pnl' ? 'is-on' : ''} onClick={() => setGroup('pnl')}>PnL cohorts</button>
      <button type="button" role="radio" aria-checked={group === 'size'} className={group === 'size' ? 'is-on' : ''} onClick={() => setGroup('size')}>Size cohorts</button>
    </div>
  );

  return (
    <div className={`coh-d${r.stale ? ' is-stale' : ''}`}>
      <div className="coh-d__head">
        <button type="button" className="coh-back" onClick={onBack} aria-label="Back to the market map">
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Market map
        </button>
        <span className="coh-card__icon">{focus.coin ? <CoinIcon coin={focus.coin} size={20} /> : <MapGlyph />}</span>
        <div className="coh-d__title">
          <h2>{name}</h2>
          <span>{focus.coin ? `${SECTOR_LABEL[sector!]} · every cohort` : 'Sector · every cohort'}</span>
        </div>
        {t && <BiasPill long={t.long} short={t.short} />}
        {t && <span className="coh-d__count">{fmtCount(t.holding)} wallets holding</span>}
      </div>

      {r.error && !d ? <LoadFailed what={name} onRetry={r.retry} /> : (
        <>
          {!showMeters && !showChart && !showPrice && !showTable && !showAssets && <AllHidden />}
          {showMeters && <div className="coh-d__meters">
            <Meter
              title="Unrealised PnL"
              share={pos > 0 && t ? t.inProfit / pos : null}
              left={<>{pctText(pos > 0 && t ? t.inProfit / pos : null)} in profit</>}
              right={<>{t ? fmtUsdShort(t.upnl, true) : DASH} total · {pctText(pos > 0 && t ? t.inLoss / pos : null)} in loss</>}
            />
            <Meter
              title="Notional"
              share={lshare}
              left={<>{t ? fmtUsdShort(t.long) : DASH} · {pctText(lshare)} long</>}
              right={<>{pctText(lshare === null ? null : 1 - lshare)} short · {t ? fmtUsdShort(t.short) : DASH}</>}
            />
          </div>}

          {(showChart || showPrice) && <div className={`coh-d__main coh-focus__main${showChart && showPrice ? '' : ' is-single'}`}>
          {showChart && <section className="coh-d__panel coh-d__chart">
            <div className="coh-d__ph">
              <h3>{name} positioning by cohort</h3>
              {groupSwitch}
              <div className="lbp-seg coh-d__range" role="radiogroup" aria-label="Chart range">
                {RANGES.map((x) => (
                  <button key={x.id} type="button" role="radio" aria-checked={range === x.id} className={range === x.id ? 'is-on' : ''} onClick={() => setRange(x.id)}>{x.label}</button>
                ))}
              </div>
            </div>
            <div className="coh-d__plot">
              {r.loading && !d
                ? <span className="coh-chart__skel" aria-hidden="true" />
                : ids.length ? <MultiLeanChart series={d?.series ?? {}} ids={ids} height={400} onHover={setAt} syncT={at} /> : noneInGroup}
            </div>
          </section>}

          {showPrice && (
            <section className="coh-d__panel coh-d__chart">
              <div className="coh-d__ph">
                <h3>{name} price</h3>
                {price.data && <span className="coh-d__src">{price.data.market} · {price.data.source}</span>}
                <div className="lbp-seg coh-d__range" role="radiogroup" aria-label="Price chart">
                  <button type="button" role="radio" aria-checked={kind === 'candles'} className={kind === 'candles' ? 'is-on' : ''} onClick={() => setKind('candles')}>Candles</button>
                  <button type="button" role="radio" aria-checked={kind === 'line'} className={kind === 'line' ? 'is-on' : ''} onClick={() => setKind('line')}>Line</button>
                </div>
              </div>
              <div className={`coh-d__plot${price.stale ? ' is-stale' : ''}`}>
                {candles.length > 1
                  ? <PriceChart candles={candles} kind={kind} height={400} syncT={at} onHover={setAt} />
                  : price.loading
                    ? <span className="coh-chart__skel" aria-hidden="true" />
                    : (
                      <div className="coh-chart__empty" role="status">
                        <b>No price history</b>
                        <span>Hyperliquid has no candles for {name} over this range.</span>
                      </div>
                    )}
              </div>
            </section>
          )}
          </div>}

          {showTable && <section className="coh-d__panel coh-d__tables">
            <div className="coh-d__ph">
              <h3>Cohorts on {name}</h3>
              <span className={`coh-at${at !== null ? ' is-on' : ''}`}>
                {at !== null ? `As of ${new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'Now'}
              </span>
              {groupSwitch}
            </div>
            <div className="coh-tablewrap">
              <table className="acct-table acct-t">
                <thead>
                  <tr>
                    <th>Cohort</th><th className="num">Holding</th><th className="num">Long</th><th className="num">Short</th>
                    <th className="num">Net</th><th>Long share</th><th className="num">uPnL</th><th>Bias</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    // Hovering the chart: long / short as that cohort stood then (the hourly
                    // record holds those); holders and uPnL are only known for now.
                    const then = at !== null ? shareAt(d?.series[c.id] ?? [], at) : null;
                    const past = at !== null;
                    const long = past ? then?.long ?? null : c.long;
                    const short = past ? then?.short ?? null : c.short;
                    const sh = long !== null && short !== null ? longShare(long, short) : null;
                    const net = long !== null && short !== null ? long - short : null;
                    return (
                      <tr key={c.id} className={`coh-row-click${past ? ' is-past' : ''}`} onClick={() => onOpenCohort(c.id, focus)}>
                        <td>
                          <span className="coh-oc" style={{ '--c': COHORT_COLOR[c.id] } as CSSProperties}>
                            <i className="coh-dot" aria-hidden="true" />
                            <CohortIcon id={c.id} size={14} />
                            {COHORT_BY_ID[c.id].name}
                          </span>
                        </td>
                        <td className="num">{past ? <span className="coh-dim" title="Known for now only">{DASH}</span> : fmtCount(c.holding)}</td>
                        <td className="num pos">{fmtUsdShort(long)}</td>
                        <td className="num neg">{fmtUsdShort(short)}</td>
                        <td className={`num ${net !== null && net > 0 ? 'pos' : net !== null && net < 0 ? 'neg' : ''}`}>{fmtUsdShort(net, true)}</td>
                        <td><span className="coh-mini pf-split"><span className="pf-split__fill" style={{ transform: `scaleX(${sh ?? 0.5})` }} /></span></td>
                        <td className={`num ${!past && c.upnl > 0 ? 'pos' : !past && c.upnl < 0 ? 'neg' : ''}`}>{past ? <span className="coh-dim" title="Known for now only">{DASH}</span> : fmtUsdShort(c.upnl, true)}</td>
                        <td><LeanPill lean={leanOf(sh)} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!ids.length && noneInGroup}
            </div>
          </section>}

          {showAssets && (
            <section className="coh-d__panel coh-mp__assets">
              <div className="coh-d__ph"><h3>Assets in {name}</h3></div>
              <div className="coh-mp__assetmap">
                <Treemap markets={d?.assets ?? []} onPick={onAsset} resetKey={key} />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function MapGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" /><path d="M12 3.5v17M12 11h8.5M3.5 14H12M16 11v9.5" />
    </svg>
  );
}
