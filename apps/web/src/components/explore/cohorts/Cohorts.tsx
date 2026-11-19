/**
 * Explore > Cohorts: the wallets holding positions on a venue, grouped by
 * all-time PnL and by perp equity, with what each group holds long and short
 * right now and how that lean has moved. As Hyperdash counts a cohort: a
 * wallet with no open position is in no count, figure or list.
 *
 * One venue shows that venue; several are NETTED - a wallet on more than one
 * of them is one wallet, its PnL and perp equity summed into one cohort and
 * its positions added up (apps/server/src/valuedesk/cohorts/model.ts). A
 * sector or an asset narrows every figure on the page to the positions in it.
 *
 * BUILT FROM THE PAGES AROUND IT. The bar, segments and brand chips are the
 * leaderboard's (`.lbp-bar`, `.lbp-seg`, `.lbp-chip`), the tables the account
 * band's `.acct-table.acct-t`, the long / short bars the exposure card's
 * `.pf-split`. Cohorts.css only lays them out.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BIAS_LABEL, COHORT_BY_ID, LEAN_LABEL, PNL_COHORTS, SECTORS, SIZE_COHORTS, biasOf, isBullish, isCohortId, isSector, leanOf, longShare,
  type CohortCard, type CohortDef, type CohortDetailResponse, type CohortFilter, type CohortId, type CohortRange,
  type CohortWalletRow, type CohortWalletsResponse, type CohortsResponse, type Lean, type Sector, type WalletSort,
} from '@sign/valuedesk/cohorts/model.js';
import { SCAN_VENUES, vsApi, vsPaths, type Venue } from '../../../vsApi';
import { useLiveRead } from '../../../live/useLiveRead';
import { useStored, useSymbols } from '../../../hooks';
import { DASH, marketName, shortAddr } from '../../../format';
import { winRateView } from '../../../winRateView';
import { asOfText } from '../../../asOf';
import { fmtFixed } from '../../../numStyle';
import { emptyCohortsLine } from './emptyCopy';
import { CoinIcon } from '../../CoinIcon';
import { LoadFailed } from '../../LoadFailed';
import { PlatformSelect } from '../../PlatformSelect';
import { fmtCount, fmtUsdShort } from '../model';
import { CohortIcon } from './CohortIcon';
import { LeanChart, bandsOf } from './LeanChart';
import { Treemap } from './Treemap';
import { SectorIcon } from './SectorIcon';
import { BiasPill, HeldNote, LeanPill, Meter, POLL_MS, Picker, Split, VenueMarks, pctText, usePolled, OverOiNote } from './parts';
import { CrossFade, FadeView } from '../../motion';
import { scrollPageTop } from '../../../nav';
import { FocusPage, MarketMapPage } from './MarketSection';
import { ExcludedButton } from '../../excluded/ExcludedPage';
import { AllHidden, CohortViewButton, CohortViewProvider, useCohortView, useCohortViewState, type ViewPage } from './view';
import '../../leaderboard/LeaderboardPage.css';
import '../../Account.css';
import './Cohorts.css';

const PAGE = 50;
const RANGES: Array<{ id: CohortRange; label: string }> = [
  { id: '1d', label: '24H' }, { id: '7d', label: '7D' }, { id: '30d', label: '30D' },
];
const RANGE_WORD: Record<CohortRange, string> = { '1d': '24H', '7d': '7D', '30d': '30D' };
const WALLETS_TITLE = 'Wallets in this cohort holding an open position. A wallet with none is not counted. Where a venue reads a sample of its small accounts, an estimate.';
const EQUITY_TITLE = 'Perp equity: what the perps account is worth (a Hyperliquid unified account: its USDC collateral). Size cohorts are by it.';
const SECTOR_LABEL = Object.fromEntries(SECTORS.map((s) => [s.id, s.label])) as Record<Sector, string>;

/* --- URL: ?view=cohorts&cohort=whale&range=7d&sector=memes&coin=BTC --------------------- */

const readParam = (name: string): string | null => new URLSearchParams(window.location.search).get(name);

function writeParams(patch: Record<string, string | null>, push = true): void {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) p.delete(k);
    else p.set(k, v);
  }
  const next = `${window.location.pathname}${p.toString() ? `?${p}` : ''}`;
  if (next === `${window.location.pathname}${window.location.search}`) return;
  if (push) window.history.pushState(null, '', next);
  else window.history.replaceState(null, '', next);
}

type Section = 'cohorts' | 'map';
const sectionFromUrl = (): Section => (readParam('section') === 'map' ? 'map' : 'cohorts');

/** `focus=coin:BTC` / `focus=sector:memes`: the market map's asset or sector page. */
function focusFromUrl(): CohortFilter | null {
  const f = readParam('focus');
  if (!f) return null;
  const [kind, v] = f.split(':');
  if (kind === 'coin' && v && /^[A-Z0-9]{1,20}$/i.test(v)) return { coin: v.toUpperCase() };
  if (kind === 'sector' && isSector(v)) return { sector: v };
  return null;
}
const focusParam = (f: CohortFilter | null): string | null => (f?.coin ? `coin:${f.coin}` : f?.sector ? `sector:${f.sector}` : null);

function filterFromUrl(): CohortFilter {
  const coin = readParam('coin')?.toUpperCase();
  if (coin && /^[A-Z0-9]{1,20}$/.test(coin)) return { coin };
  const sector = readParam('sector');
  return isSector(sector) ? { sector } : {};
}

/** A small popover picker: the sector list, or a searchable asset list. */

function AssetList({
  coins, sector, current, onPick,
}: {
  coins: CohortsResponse['coins'];
  sector: Sector | null;
  current: string | null;
  onPick: (c: string | null) => void;
}) {
  const [q, setQ] = useState('');
  const list = coins.filter((c) => (!sector || c.sector === sector) && (!q || c.coin.includes(q.trim().toUpperCase()))).slice(0, 80);
  return (
    <>
      <input className="coh-pick__search" autoFocus autoComplete="off" spellCheck={false} placeholder="Search asset" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="coh-pick__list">
        {!q && (
          <button type="button" role="option" aria-selected={current === null} className={`coh-pick__opt${current === null ? ' is-on' : ''}`} onClick={() => onPick(null)}>
            <span className="coh-pick__label">All assets</span>
          </button>
        )}
        {list.length > 0 && (
          <div className="coh-pick__head" title="Long plus short position value the tracked wallets hold in each asset right now">
            <span>Asset</span><span>Positions held</span>
          </div>
        )}
        {list.map((c) => (
          <button key={c.coin} type="button" role="option" aria-selected={current === c.coin} className={`coh-pick__opt${current === c.coin ? ' is-on' : ''}`} onClick={() => onPick(c.coin)}>
            <CoinIcon coin={c.coin} size={16} />
            <span className="coh-pick__label">{marketName(c.coin)}</span>
            <i>{fmtUsdShort(c.gross)}</i>
          </button>
        ))}
        {!list.length && <p className="coh-pick__none">No open positions in that asset.</p>}
      </div>
    </>
  );
}

/* --- the overview grid ------------------------------------------------------------------ */

/** `empty`: the chosen venues have no wallet in this cohort - said in words, not drawn as a flat card. */
function Card({ def, card, empty, onOpen }: { def: CohortDef; card: CohortCard | undefined; empty: string | null; onOpen: () => void }) {
  const long = card?.long ?? 0;
  const short = card?.short ?? 0;
  const head = (
    <span className="coh-card__head">
      <span className="coh-card__icon"><CohortIcon id={def.id} /></span>
      <span className="coh-card__name"><b>{def.name}</b><span>{def.range}</span></span>
    </span>
  );
  if (empty) {
    return (
      <button type="button" className="coh-card" onClick={onOpen}>
        {head}
        <span className="coh-card__wallets">{empty}</span>
      </button>
    );
  }
  return (
    <button type="button" className="coh-card" onClick={onOpen}>
      {head}
      <span className="coh-card__mid">
        <span className="coh-card__meta">
          <BiasPill long={long} short={short} />
          <span className="coh-card__wallets" title={card ? WALLETS_TITLE : undefined}>
            {card ? `${fmtCount(card.wallets)} wallets with positions` : DASH}
          </span>
        </span>
        <LeanChart points={card?.spark ?? []} height={52} className="coh-card__spark" />
      </span>
      <Split long={long} short={short} />
    </button>
  );
}

function Overview({ data, onOpen }: { data: CohortsResponse | null; onOpen: (id: CohortId) => void }) {
  const byId = new Map((data?.cohorts ?? []).map((c) => [c.id, c]));
  const v = useCohortView();
  // Counts are exact once the first pass has run (`at` > 0); before that a zero is "not read yet".
  const isEmpty = (d: CohortDef) => !!data && data.at > 0 && byId.get(d.id)?.wallets === 0;
  const section = (title: string, defs: readonly CohortDef[], part: 'pnl' | 'size') => {
    // A cohort the chosen venues leave empty is not drawn: the line above the grid names it.
    const shown = defs.filter((d) => v.cohortOn(d.id) && !isEmpty(d));
    if (!v.show('overview', part) || !shown.length) return null;
    return (
      <section className="coh-sec">
        <h2 className="coh-sec__title">{title}</h2>
        <div className="coh-grid">
          {shown.map((d) => (
            <Card key={d.id} def={d} card={byId.get(d.id)} empty={null} onOpen={() => onOpen(d.id)} />
          ))}
        </div>
      </section>
    );
  };
  const pnl = section('All-time PnL', PNL_COHORTS, 'pnl');
  const size = section('Account size', SIZE_COHORTS, 'size');
  const line = emptyCohortsLine([
    ...(v.show('overview', 'pnl') ? PNL_COHORTS : []),
    ...(v.show('overview', 'size') ? SIZE_COHORTS : []),
  ].filter((d) => v.cohortOn(d.id) && isEmpty(d)));
  const asOf = asOfText(data?.asOf);
  return pnl || size ? <>{line && <p className="lbp-note">{line}</p>}<OverOiNote rows={data?.overOi} />{pnl}{size}{asOf && <p className="lbp-note coh-asof">{asOf}</p>}</> : <AllHidden />;
}

/* --- one cohort ----------------------------------------------------------------------------- */

/** Tabs with an underline that slides to the chosen one. */
function Tabs<T extends string>({ items, value, onChange }: { items: Array<{ id: T; label: string; n: ReactNode }>; value: T; onChange: (v: T) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [ink, setInk] = useState<{ left: number; width: number } | null>(null);
  const sig = items.map((i) => String(i.n)).join('|');
  useLayoutEffect(() => {
    const measure = () => {
      const el = bar.current?.querySelector<HTMLButtonElement>(`[data-tab="${value}"]`);
      if (el) setInk({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (bar.current) ro.observe(bar.current);
    return () => ro.disconnect();
  }, [value, sig]);
  return (
    <div className="coh-d__tabs" role="tablist" ref={bar}>
      {items.map((it) => (
        <button key={it.id} data-tab={it.id} type="button" role="tab" aria-selected={value === it.id} className={value === it.id ? 'is-on' : ''} onClick={() => onChange(it.id)}>
          {it.label} <span className="coh-d__n">{it.n}</span>
        </button>
      ))}
      {ink && <span className="coh-d__ink" style={{ transform: `translateX(${ink.left}px)`, width: ink.width }} aria-hidden="true" />}
    </div>
  );
}

function SortTh({ k, label, sort, dir, onSort, title }: { k: WalletSort; label: string; sort: WalletSort; dir: 'asc' | 'desc'; onSort: (k: WalletSort) => void; title?: string }) {
  const on = sort === k;
  return (
    <th className="num" title={title}>
      <button type="button" className={`coh-th${on ? ' is-on' : ''}`} onClick={() => onSort(k)} aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
        {label}
        <svg viewBox="0 0 8 10" width="7" height="9" aria-hidden="true">
          <path d="M4 1 1.5 4h5z" className={on && dir === 'asc' ? 'is-on' : ''} />
          <path d="M4 9 1.5 6h5z" className={on && dir === 'desc' ? 'is-on' : ''} />
        </svg>
      </button>
    </th>
  );
}

/** `range`: the page's 24H / 7D / 30D - the PnL and win rate columns cover it; membership stays all-time. */
function WalletsTable({ venues, id, filter, range, onScan }: { venues: readonly Venue[]; id: CohortId; filter: CohortFilter; range: CohortRange; onScan: (a: string) => void }) {
  const [sort, setSort] = useState<WalletSort>('equity');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [pages, setPages] = useState(1);
  const key = `${venues.join(',')}|${id}|${filter.sector ?? ''}|${filter.coin ?? ''}|${range}|${sort}|${dir}|${pages}`;
  const ask = { sort, dir, offset: 0, limit: pages * PAGE, range };
  // Its last answer, while the route's cache allows it, under its own as-of line (below) until the current one is in.
  const r = usePolled<CohortWalletsResponse>(key, (signal) => vsApi.cohortWallets(venues, id, filter, ask, signal), 0, vsPaths.cohortWallets(venues, id, filter, ask));
  const [kept, setKept] = useState<CohortWalletsResponse | null>(null);
  useEffect(() => { if (r.data) setKept(r.data); }, [r.data]);
  useEffect(() => { setPages(1); }, [venues, id, filter.sector, filter.coin]);
  const data = r.data ?? kept;
  const busy = r.loading || r.stale;
  const onSort = (k: WalletSort) => {
    if (k === sort) setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSort(k); setDir('desc'); }
    setPages(1);
  };
  const other = COHORT_BY_ID[id].kind === 'pnl' ? 'size' : 'pnl';
  if (r.error && !data) return <LoadFailed what="Wallets" onRetry={r.retry} />;
  if (!data) return <p className="acct-empty">Loading…</p>;
  if (!data.rows.length) return <p className="acct-empty">No wallets in this view yet.</p>;
  return (
    <>
      <div className={`coh-tablewrap${busy ? ' is-stale' : ''}`}>
        <table className="acct-table acct-t coh-wtable">
          <thead>
            <tr>
              <th>Address</th>
              <SortTh k="equity" label="Equity" title={EQUITY_TITLE} sort={sort} dir={dir} onSort={onSort} />
              <SortTh k="value" label="Position value" sort={sort} dir={dir} onSort={onSort} />
              <SortTh k="leverage" label="Leverage" sort={sort} dir={dir} onSort={onSort} />
              <SortTh k="upnl" label="Sum uPnL" sort={sort} dir={dir} onSort={onSort} />
              <SortTh
                k="pnl"
                label={`PnL ${RANGE_WORD[range]}`}
                title="PnL over the selected range. Cohort membership is by all-time PnL (and perp equity for size cohorts)."
                sort={sort}
                dir={dir}
                onSort={onSort}
              />
              <SortTh k="winRate" label="Win rate" sort={sort} dir={dir} onSort={onSort} />
              <th>Bias</th>
              <th>{other === 'size' ? 'Size cohort' : 'PnL cohort'}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((w: CohortWalletRow) => {
              const oc = other === 'size' ? w.sizeCohort : w.pnlCohort;
              // Optional at runtime: an older server sends neither (a dash, never the all-time figure).
              const pr = typeof w.pnlRange === 'number' && Number.isFinite(w.pnlRange) ? w.pnlRange : null;
              const wr = winRateView(w);
              return (
                <tr key={w.address}>
                  <td>
                    <span className="coh-wallet">
                      <button type="button" className="lb-scanlink" onClick={() => onScan(w.address)} title={w.address}>{shortAddr(w.address)}</button>
                      <VenueMarks venues={w.venues} />
                      {w.weight > 1 && <span className="coh-dim" title={`A sampled wallet standing for ${w.weight} in the totals`}>×{w.weight}</span>}
                    </span>
                  </td>
                  <td className="num">{fmtUsdShort(w.equity)}</td>
                  <td className="num">{w.value === null ? <span className="coh-dim" title="Positions not read yet">{DASH}</span> : fmtUsdShort(w.value)}</td>
                  <td className="num">{w.leverage === null ? DASH : `${fmtFixed(w.leverage, 2)}×`}</td>
                  <td className={`num ${(w.upnl ?? 0) > 0 ? 'pos' : (w.upnl ?? 0) < 0 ? 'neg' : ''}`}>{w.upnl === null ? DASH : fmtUsdShort(w.upnl, true)}</td>
                  <td className={`num ${(pr ?? 0) > 0 ? 'pos' : (pr ?? 0) < 0 ? 'neg' : ''}`}>{pr === null ? <span className="coh-dim">{DASH}</span> : fmtUsdShort(pr, true)}</td>
                  <td className={`num ${wr.tone === 'muted' ? '' : wr.tone}`} title={wr.title}>
                    {wr.approx && <span className="coh-dim">≈</span>}
                    {wr.text === DASH ? <span className="coh-dim">{DASH}</span> : wr.text}
                  </td>
                  <td><LeanPill lean={w.lean} /></td>
                  <td>{oc ? <span className="coh-oc"><CohortIcon id={oc} size={14} />{COHORT_BY_ID[oc].name}</span> : <span className="coh-dim">{DASH}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {asOfText(data.asOf) && <p className="lbp-note coh-asof">{asOfText(data.asOf)}</p>}
      {data.rows.length < data.total && (
        <div className="acct-more">
          <button type="button" className="acct-morebtn" disabled={r.loading} onClick={() => setPages((p) => p + 1)}>
            {r.loading && <span className="acct-spin" aria-hidden="true" />}
            {r.loading ? 'Loading…' : `Load more · ${fmtCount(data.total - data.rows.length)} left`}
          </button>
        </div>
      )}
    </>
  );
}

function MarketsTable({ markets, onPick }: { markets: CohortDetailResponse['cohort']['markets']; onPick: (c: string) => void }) {
  if (!markets.length) return <p className="acct-empty">No open positions read in this view yet.</p>;
  return (
    <div className="coh-tablewrap">
      <table className="acct-table acct-t">
        <thead>
          <tr>
            <th>Asset</th><th>Sector</th><th className="num">Long</th><th className="num">Short</th><th className="num">Net</th>
            <th className="num">uPnL</th><th>Long share</th><th>Bias</th><th className="num">Wallets</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => {
            const s = longShare(m.long, m.short);
            const n = m.long - m.short;
            return (
              <tr key={m.coin} className="coh-row-click" onClick={() => onPick(m.coin)}>
                <td><span className="acct-mkt"><CoinIcon coin={m.coin} size={18} /><span className="acct-mkt__n">{marketName(m.coin)}</span></span></td>
                <td className="coh-dim">{SECTOR_LABEL[m.sector]}</td>
                <td className="num pos">{fmtUsdShort(m.long)}</td>
                <td className="num neg">{fmtUsdShort(m.short)}</td>
                <td className={`num ${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}`}>{fmtUsdShort(n, true)}</td>
                <td className={`num ${m.upnl > 0 ? 'pos' : m.upnl < 0 ? 'neg' : ''}`}>{fmtUsdShort(m.upnl, true)}</td>
                <td><span className="coh-mini pf-split"><span className="pf-split__fill" style={{ transform: `scaleX(${s ?? 0.5})` }} /></span></td>
                <td><LeanPill lean={leanOf(s)} /></td>
                <td className="num">{fmtCount(m.holders)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Detail({
  venues, id, range, setRange, filter, setCoin, onScan, chartFor, onOpenChart,
}: {
  venues: readonly Venue[];
  id: CohortId;
  range: CohortRange;
  setRange: (r: CohortRange) => void;
  filter: CohortFilter;
  setCoin: (c: string) => void;
  onScan: (address: string) => void;
  chartFor: (coin: string) => string | null;
  onOpenChart?: (symbol: string) => void;
}) {
  /* The chosen asset picked again (its tile or its row): its chart on the trade page. */
  const pickCoin = (c: string) => {
    const sym = c === filter.coin && onOpenChart ? chartFor(c) : null;
    if (sym) onOpenChart!(sym);
    else setCoin(c);
  };
  const def = COHORT_BY_ID[id];
  const v = useCohortView();
  const showMeters = v.show('detail', 'meters');
  const showChart = v.show('detail', 'chart');
  const showMap = v.show('detail', 'map');
  const showTables = v.show('detail', 'tables');
  const [tab, setTab] = useState<'wallets' | 'markets'>('wallets');
  const key = `${venues.join(',')}|${id}|${range}|${filter.sector ?? ''}|${filter.coin ?? ''}`;
  // Pushed with each new cohort load while the live socket is up (live/useLiveRead.ts); else polled every minute.
  const r = useLiveRead<CohortDetailResponse>(key, vsPaths.cohortDetail(venues, id, range, filter), (signal) => vsApi.cohortDetail(venues, id, range, filter, signal), POLL_MS, undefined, true);
  const [total, setTotal] = useState<number | null>(null);
  const st = r.data?.cohort ?? null;
  const points = useMemo(
    () => (r.data?.series ?? []).flatMap((p) => {
      const s = longShare(p.long, p.short);
      return s === null ? [] : [[p.t, s] as const];
    }),
    [r.data],
  );
  const bands = useMemo(() => bandsOf(r.data?.series ?? []), [r.data]);
  // The wallet count in the tab: the table's total under the filter.
  useEffect(() => {
    let alive = true;
    vsApi.cohortWallets(venues, id, filter, { sort: 'equity', dir: 'desc', offset: 0, limit: 1 }).then((x) => { if (alive) setTotal(x.total); }, () => {});
    return () => { alive = false; };
  }, [venues, id, filter.sector, filter.coin]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = st ? st.inProfit + st.inLoss : 0;
  const lshare = st ? longShare(st.long, st.short) : null;

  return (
    <div className={`coh-d${r.stale ? ' is-stale' : ''}`}>
      <div className="coh-d__head">
        <span key={`i-${id}`} className="coh-card__icon mo-fade"><CohortIcon id={id} size={20} /></span>
        <div key={`t-${id}`} className="coh-d__title mo-fade"><h2>{def.name}</h2><span>{def.range}</span></div>
        {st && <BiasPill long={st.long} short={st.short} />}
        {st && <span className="coh-d__count" title={WALLETS_TITLE}>{fmtCount(st.wallets)} wallets with positions</span>}
      </div>

      {r.error && !r.data ? <LoadFailed what="Cohort" onRetry={r.retry} /> : (
        <>
          {!showMeters && !showChart && !showMap && !showTables && <AllHidden />}
          {showMeters && <div className="coh-d__meters">
            <Meter
              title="Unrealised PnL"
              share={pos > 0 && st ? st.inProfit / pos : null}
              left={<>{pctText(pos > 0 && st ? st.inProfit / pos : null)} in profit · {st ? fmtUsdShort(st.upnlProfit, true) : DASH}</>}
              right={<>{st ? fmtUsdShort(st.upnlLoss, true) : DASH} · {pctText(pos > 0 && st ? st.inLoss / pos : null)} in loss</>}
            />
            <Meter
              title="Notional"
              share={lshare}
              left={<>{st ? fmtUsdShort(st.long) : DASH} · {pctText(lshare)} long</>}
              right={<>{pctText(lshare === null ? null : 1 - lshare)} short · {st ? fmtUsdShort(st.short) : DASH}</>}
            />
          </div>}

          {(showChart || showMap) && <div className={`coh-d__main${showChart && showMap ? '' : ' is-single'}`}>
            {showChart && <section className="coh-d__panel coh-d__chart">
              <div className="coh-d__ph">
                <h3>{def.name} positioning</h3>
                <div className="lbp-seg coh-d__range" role="radiogroup" aria-label="Chart range">
                  {RANGES.map((x) => (
                    <button key={x.id} type="button" role="radio" aria-checked={range === x.id} className={range === x.id ? 'is-on' : ''} onClick={() => setRange(x.id)}>{x.label}</button>
                  ))}
                </div>
              </div>
              <div className="coh-d__plot">
                <LeanChart points={points} height={380} full label={RANGE_WORD[range]} bands={bands} />
                {points.length < 2 && (
                  r.loading && !r.data ? <span className="coh-chart__skel" aria-hidden="true" /> : (
                    <div className="coh-chart__empty" role="status">
                      <b>Not enough history yet</b>
                      <span>
                        {filter.coin || filter.sector
                          ? 'Positioning for a single asset or sector is charted hourly. The first points appear within the hour.'
                          : 'Positioning is charted every 15 minutes. The first points appear shortly.'}
                      </span>
                    </div>
                  )
                )}
              </div>
            </section>}
            {showMap && <section className="coh-d__panel coh-d__tree">
              <Treemap markets={st?.markets ?? []} onPick={setCoin} active={filter.coin ?? null} chartFor={chartFor} onOpenChart={onOpenChart} resetKey={`${venues.join(',')}|${id}|${filter.sector ?? ''}|${filter.coin ?? ''}`} />
            </section>}
          </div>}

          {showTables && <section className="coh-d__panel coh-d__tables">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { id: 'wallets', label: 'Wallets', n: total === null ? DASH : fmtCount(total) },
                { id: 'markets', label: 'Markets', n: st ? fmtCount(st.markets.length) : DASH },
              ]}
            />
            <CrossFade viewKey={tab}>
              {tab === 'wallets'
                ? <WalletsTable venues={venues} id={id} filter={filter} range={range} onScan={onScan} />
                : <MarketsTable markets={st?.markets ?? []} onPick={pickCoin} />}
            </CrossFade>
          </section>}
        </>
      )}
      <HeldNote at={r.heldAt} />
    </div>
  );
}

/* --- the page ------------------------------------------------------------------------------- */

/**
 * The SoDEX perp an asset charts as on the trade page, or null when SoDEX does not
 * list it. Matched on the base the way the Markets page matches (`xyz:GOLD` is GOLD,
 * Hyperliquid's 1000x `kPEPE` also tries PEPE).
 */
function useChartFor(): (coin: string) => string | null {
  const { symbols } = useSymbols('perps');
  return useMemo(() => {
    const byBase = new Map<string, string>();
    for (const s of symbols) {
      if (s.status && s.status !== 'TRADING') continue;
      const base = (s.name.split(/[-_/]/)[0] ?? s.name).trim().toUpperCase();
      if (!byBase.has(base)) byBase.set(base, s.name);
    }
    return (coin: string) => {
      const name = marketName(coin).toUpperCase();
      return byBase.get(name) ?? (/^K[A-Z]/.test(name) ? byBase.get(name.slice(1)) ?? null : null);
    };
  }, [symbols]);
}

/** `embedded`: a widget on another page (the terminal) - its view stays out of that page's URL and scroll. */
export function Cohorts({ onScan, onOpenSymbol, embedded = false }: { onScan: (address: string) => void; onOpenSymbol?: (symbol: string) => void; embedded?: boolean }) {
  const write = (patch: Record<string, string | null>, push = true) => { if (!embedded) writeParams(patch, push); };
  const chartFor = useChartFor();
  const [stored, setStored] = useStored<Venue[]>('vs.cohorts.venues', [...SCAN_VENUES]);
  const venues = useMemo(() => {
    const v = (Array.isArray(stored) ? stored : []).filter((x): x is Venue => (SCAN_VENUES as readonly string[]).includes(x));
    return v.length ? SCAN_VENUES.filter((x) => v.includes(x)) : [...SCAN_VENUES];
  }, [stored]);
  const [cohort, setCohort] = useState<CohortId | null>(() => {
    const c = embedded ? null : readParam('cohort');
    return isCohortId(c) ? c : null;
  });
  const [range, setRangeState] = useState<CohortRange>(() => {
    const r = embedded ? null : readParam('range');
    return r === '1d' || r === '30d' ? r : '7d';
  });
  const [filter, setFilterState] = useState<CohortFilter>(() => (embedded ? {} : filterFromUrl()));
  const [section, setSection] = useState<Section>(() => (embedded ? 'cohorts' : sectionFromUrl()));
  const [focus, setFocus] = useState<CohortFilter | null>(() => (embedded ? null : focusFromUrl()));
  const viewState = useCohortViewState();
  const page: ViewPage = section === 'map' ? (focus ? 'focus' : 'map') : cohort ? 'detail' : 'overview';
  // An asset page has a price, a sector page an asset map - never both.
  const viewOmit = page === 'focus' ? [focus?.coin ? 'assets' : 'price'] : [];
  useEffect(() => {
    if (embedded) return;
    const onPop = () => {
      const c = readParam('cohort');
      setCohort(isCohortId(c) ? c : null);
      setFilterState(filterFromUrl());
      setSection(sectionFromUrl());
      setFocus(focusFromUrl());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open = (id: CohortId | null) => {
    setCohort(id);
    setSection('cohorts');
    setFocus(null);
    write({ cohort: id, section: null, focus: null });
    if (!embedded) scrollPageTop();
  };
  /** The market map, or one of its asset / sector pages. */
  const openMap = (f: CohortFilter | null) => {
    setSection('map');
    setFocus(f);
    write({ section: 'map', focus: focusParam(f), cohort: null });
    if (!embedded) scrollPageTop();
  };
  /** From an asset page: that cohort, filtered to the asset. */
  const openCohortOn = (id: CohortId, f: CohortFilter) => {
    setFilterState(f);
    setCohort(id);
    setSection('cohorts');
    setFocus(null);
    write({ cohort: id, section: null, focus: null, sector: f.sector ?? null, coin: f.coin ?? null });
    if (!embedded) scrollPageTop();
  };
  const setRange = (r: CohortRange) => {
    setRangeState(r);
    write({ range: r === '7d' ? null : r }, false);
  };
  const setFilter = (f: CohortFilter) => {
    setFilterState(f);
    write({ sector: f.sector ?? null, coin: f.coin ?? null }, false);
  };

  const listKey = `${venues.join(',')}|${filter.sector ?? ''}|${filter.coin ?? ''}`;
  // Pushed with each new cohort load while the live socket is up (live/useLiveRead.ts); else polled every minute.
  // A kept answer (serverFetch.ts) is drawn at once on reopening, with its as-of line, until the current one is in.
  const list = useLiveRead<CohortsResponse>(listKey, vsPaths.cohorts(venues, filter), (signal) => vsApi.cohorts(venues, filter, signal), POLL_MS, undefined, true);
  // The asset list outlives a filter change (it is the scope's, unfiltered).
  const [coins, setCoins] = useState<CohortsResponse['coins']>([]);
  useEffect(() => { if (list.data?.coins.length) setCoins(list.data.coins); }, [list.data]);
  const byId = new Map((list.data?.cohorts ?? []).map((c) => [c.id, c]));
  const cov = list.data?.coverage ?? {};
  const members = Object.values(cov).reduce((n, c) => n + (c?.members ?? 0), 0);
  const covered = Object.values(cov).reduce((n, c) => n + (c?.covered ?? 0), 0);

  const railItem = (d: CohortDef) => {
    const c = byId.get(d.id);
    // Empty on the chosen venues (the counts are exact once the first pass has run): not offered.
    if (list.data && list.data.at > 0 && c?.wallets === 0 && cohort !== d.id) return null;
    return (
      <li key={d.id}>
        <button type="button" className={`coh-rail__item${section === 'cohorts' && cohort === d.id ? ' is-on' : ''}`} onClick={() => open(d.id)}>
          <span className="coh-rail__icon"><CohortIcon id={d.id} size={16} /></span>
          <span className="coh-rail__name"><b>{d.name}</b><span>{d.range}</span></span>
          {c && <BiasPill long={c.long} short={c.short} />}
        </button>
      </li>
    );
  };

  return (
    <section className="panel lbp coh" aria-busy={list.loading}>
      <div className="lbp-bar">
        <PlatformSelect options={SCAN_VENUES} value={venues} onChange={setStored} />
        {venues.length > 1 && <span className="coh-net" title="A wallet on several of these venues counts once: PnL, perp equity and positions summed">Netted</span>}
        {section === 'cohorts' && <div className="coh-filters">
          <Picker
            label="Sector"
            value={filter.sector ? <span className="coh-pick__coin"><SectorIcon sector={filter.sector} size={14} />{SECTOR_LABEL[filter.sector]}</span> : null}
            onClear={() => setFilter({})}
          >
            {(close) => (
              <div className="coh-pick__list">
                <button type="button" role="option" aria-selected={!filter.sector} className={`coh-pick__opt${!filter.sector ? ' is-on' : ''}`} onClick={() => { setFilter(filter.coin ? { coin: filter.coin } : {}); close(); }}>
                  <span className="coh-pick__ic">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
                      <rect x="3.5" y="3.5" width="17" height="17" rx="2" /><path d="M12 3.5v17M12 11h8.5M3.5 14H12M16 11v9.5" />
                    </svg>
                  </span>
                  <span className="coh-pick__label">All sectors</span>
                </button>
                {SECTORS.map((s) => (
                  <button key={s.id} type="button" role="option" aria-selected={filter.sector === s.id} className={`coh-pick__opt${filter.sector === s.id ? ' is-on' : ''}`} onClick={() => { setFilter({ sector: s.id }); close(); }}>
                    <span className="coh-pick__ic"><SectorIcon sector={s.id} /></span>
                    <span className="coh-pick__label">{s.label}</span>
                  </button>
                ))}
              </div>
            )}
          </Picker>
          <Picker
            label="Asset"
            value={filter.coin ? <span className="coh-pick__coin"><CoinIcon coin={filter.coin} size={14} />{marketName(filter.coin)}</span> : null}
            onClear={() => setFilter({})}
          >
            {(close) => (
              <AssetList
                coins={coins}
                sector={filter.sector ?? null}
                current={filter.coin ?? null}
                onPick={(c) => { setFilter(c ? { coin: c } : filter.sector ? { sector: filter.sector } : {}); close(); }}
              />
            )}
          </Picker>
        </div>}
        {members > 0 && (
          <span className="coh-cover" title="Wallets whose positions are known: each read once, then kept current by the live trade streams">
            Positions known · {fmtCount(covered)} / {fmtCount(members)}
          </span>
        )}
        <ExcludedButton />
        <CohortViewButton state={viewState} page={page} omit={viewOmit} />
      </div>

      <div className="coh-body">
        <nav className="coh-rail" aria-label="Cohorts">
          <button type="button" className={`coh-rail__item is-top${section === 'cohorts' && cohort === null ? ' is-on' : ''}`} onClick={() => open(null)}>
            <span className="coh-rail__icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c.6-3.2 2.7-5 5.5-5s4.9 1.8 5.5 5M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.3c1.7.7 2.7 2.3 3 4.7" />
              </svg>
            </span>
            <span className="coh-rail__name"><b>All cohorts</b><span>Groups by PnL and size</span></span>
          </button>
          <button type="button" className={`coh-rail__item is-top${section === 'map' ? ' is-on' : ''}`} onClick={() => openMap(null)}>
            <span className="coh-rail__icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
                <rect x="3.5" y="3.5" width="17" height="17" rx="2" /><path d="M12 3.5v17M12 11h8.5M3.5 14H12M16 11v9.5" />
              </svg>
            </span>
            <span className="coh-rail__name"><b>Market map</b><span>Every asset, by sector</span></span>
          </button>
          <h3>All-time PnL</h3>
          <ul>{PNL_COHORTS.map(railItem)}</ul>
          <h3>Account size</h3>
          <ul>{SIZE_COHORTS.map(railItem)}</ul>
        </nav>

        <div className="coh-main">
          <CohortViewProvider value={viewState.view}>
          {list.error && !list.data ? <LoadFailed what="Cohorts" onRetry={list.retry} /> : (
            <FadeView viewKey={section === 'map' ? (focus ? `focus:${focusParam(focus)}` : 'map') : cohort ? 'detail' : 'overview'}>
              {section === 'map'
                ? focus
                  ? <FocusPage venues={venues} focus={focus} onBack={() => openMap(null)} onOpenCohort={openCohortOn} onAsset={(c) => openMap({ coin: c })} chartFor={chartFor} onOpenChart={onOpenSymbol} />
                  : <MarketMapPage venues={venues} onSector={(sec) => openMap({ sector: sec })} onAsset={(c) => openMap({ coin: c })} />
                : cohort
                  ? <Detail venues={venues} id={cohort} range={range} setRange={setRange} filter={filter} setCoin={(c) => setFilter({ coin: c })} onScan={onScan} chartFor={chartFor} onOpenChart={onOpenSymbol} />
                  : <div className={`coh-over${list.stale ? ' is-stale' : ''}`}><Overview data={list.data} onOpen={open} /></div>}
            </FadeView>
          )}
          </CohortViewProvider>
        </div>
      </div>
    </section>
  );
}
