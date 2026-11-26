/**
 * Wealth, version "Desk" (localhost switch): a research desk. The wallet's four figures on top; every fund in one
 * list with its 30-day spark and lead figure; the picked fund's chart, figures, channel and times beside it, with its
 * way in and out. On a phone the list opens the fund in a sheet. Holdings and history underneath.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { openConnectDialog } from '../../account/connect';
import { Button, Panel, RollingNumber, Segmented, Shell, ShellHeader, Skeleton, Sparkline, StatusPill } from '../../bots/kit/kit';
import { DASH, fmtUsd } from '../../../format';
import { useAsync, useMediaQuery } from '../../../hooks';
import { useMask, usePrivacy, type PrivacyKey } from '../../../privacy';
import { readPnlHistory, type FundShelf } from '../../../trading/wealth';
import { SodexMark } from '../../funds/ui';
import { SODEX_SITE } from '../../../sodexProgrammes';
import { useNow } from '../parts';
import { SHELVES, pctText, useFundViews, val, whenMs, type FundView } from './data';
import { Activity, FundDetail, FundMark, FundSheet, MaintNote, RowSpark, Signed, pledgedValue, signedUsd, type VersionProps } from './parts';

/** One of the wallet's figures: rolling digits, or the privacy mask when its kind is hidden. */
function Kpi({ label, value, k, tone, spark, sub }: {
  label: string;
  value: string;
  k: PrivacyKey;
  tone?: number | null;
  spark?: number[] | null;
  sub?: ReactNode;
}) {
  const priv = usePrivacy();
  const mask = useMask(k);
  const cls = tone === undefined || tone === null ? '' : tone > 0 ? 'is-positive' : tone < 0 ? 'is-negative' : '';
  return (
    <Panel className="tf-stat wv-kpi">
      <p className="tf-stat__l">{label}</p>
      <div className="tf-stat__row">
        {priv.isHidden(k) || value === DASH ? <span className={`tf-stat__v ${cls}`}>{mask(value)}</span> : <RollingNumber value={value} className={`tf-stat__v ${cls}`} />}
        {spark && spark.length > 1 && !priv.isHidden('charts') && <Sparkline values={spark} tone="neutral" />}
      </div>
      {sub && <div className="tf-stat__meta"><span className="tf-stat__hint">{sub}</span></div>}
    </Panel>
  );
}

type ShelfPick = 'All' | FundShelf;
const SHELF_SHORT: Readonly<Record<FundShelf, string>> = { 'Stable Earn': 'Earn', 'Curated ETF': 'ETFs', Specialty: 'Specialty' };

function FundList({ views, sel, onPick }: { views: FundView[] | null; sel: string | null; onPick: (id: string) => void }) {
  const [shelf, setShelf] = useState<ShelfPick>('All');
  const groups = SHELVES.map((s) => ({ s, funds: (views ?? []).filter((v) => v.shelf === s && (shelf === 'All' || shelf === s)) })).filter((g) => g.funds.length > 0);
  return (
    <Shell className="wv-list">
      <ShellHeader
        title="Funds"
        subtitle={views ? `${views.length} on SoDEX Wealth` : 'Reading'}
        aside={<Segmented size="sm" label="Shelf" value={shelf} onChange={setShelf} options={[{ value: 'All', label: 'All' }, ...SHELVES.map((s) => ({ value: s, label: SHELF_SHORT[s] }))]} />}
      />
      <Panel className="wv-list__p">
        {!views ? [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="wv-list__bone" />) : groups.map((g) => (
          <div key={g.s} role="group" aria-label={g.s}>
            <p className="wv-list__g">{g.s}<span>{g.funds.length}</span></p>
            {g.funds.map((v) => {
              const roi = v.head.kind === 'roi';
              const d = val(v.quote?.roi24h);
              return (
                <button key={v.id} type="button" className={`wv-li${sel === v.id ? ' is-on' : ''}`} aria-current={sel === v.id || undefined} onClick={() => onPick(v.id)}>
                  <FundMark v={v} size={34} />
                  <span className="wv-li__t"><b>{v.name}</b><small>{v.ticker}{v.holding ? <i className="wv-li__held" title="You hold this"> · yours</i> : null}</small></span>
                  <RowSpark v={v} w={64} h={26} />
                  <span className="wv-li__n">
                    <Signed v={roi ? v.head.value : null}><b>{pctText(v.head.value, roi)}</b></Signed>
                    <small>{v.head.short}{d !== null && <> · <Signed v={d}>{pctText(d)}</Signed></>}</small>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </Panel>
    </Shell>
  );
}

export function Desk({ w, value, slp, ctx, maint }: VersionProps) {
  const views = useFundViews(w);
  const now = useNow(15_000);
  const narrow = useMediaQuery('(max-width: 900px)');
  const [pick, setPick] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const selected = views ? (views.find((v) => v.id === pick) ?? views.find((v) => v.holding) ?? views[0] ?? null) : null;
  const sheetView = views?.find((v) => v.id === sheet) ?? null;
  const history = useAsync(() => readPnlHistory(ctx.address!, '1M'), [ctx.address, ctx.refreshToken], { enabled: !!ctx.address });
  // SoDEX's PnL series, under the PnL it adds up to (the value series also holds shares pledged as margin).
  const spark = useMemo(() => (history.data ?? []).filter((p) => whenMs(p.ts) !== null).map((p) => val(p.pnl)).filter((x): x is number => x !== null), [history.data]);
  const p = w.pnl;
  const pnl = val(p?.totalPnl);
  const d24 = val(p?.totalPnl24h);
  const inFlight = val(p?.inFlightValue);
  const realized = val(p?.totalRealizedPnl);
  const unreal = val(p?.totalUnrealizedPnl);
  const cost = val(p?.totalCost);
  const pledged = pledgedValue(w.holdings);

  return (
    <div className="wv-col">
      <header className="wv-head">
        <span className="wv-head__mark"><SodexMark size={30} /></span>
        <div className="wv-head__t">
          <h1>Wealth</h1>
          <p>SoDEX's tokenised funds, vaults and on-chain yield</p>
        </div>
        <div className="wv-head__a">
          {maint?.state === 'maintenance' && <StatusPill tone="warning" size="sm" dot>Maintenance</StatusPill>}
          <a className="tf-btn is-secondary is-sm" href={SODEX_SITE.wealth} target="_blank" rel="noopener noreferrer"><SodexMark size={14} />Open on SoDEX</a>
        </div>
      </header>
      {maint?.state === 'maintenance' && <MaintNote message={maint.message} />}

      {ctx.address ? (
        <section className="wv-kpis" aria-label="Your Wealth">
          <Kpi label="Wealth value" k="equity" value={value === null ? DASH : fmtUsd(value)} sub={pledged > 0 ? <>+{fmtUsd(pledged)} pledged as Perps margin</> : slp !== null ? <>SLP vault, inferred {fmtUsd(slp)}</> : 'Priced by SoDEX'} />
          <Kpi label="Total PnL" k="pnl" tone={pnl} spark={spark} value={pnl === null ? DASH : signedUsd(pnl)} sub={<>Realized {realized === null ? DASH : signedUsd(realized)} · unrealized {unreal === null ? DASH : signedUsd(unreal)}</>} />
          <Kpi label="24h change" k="pnl" tone={d24} value={d24 === null ? DASH : signedUsd(d24)} sub="Since this time yesterday" />
          <Kpi label="On its way" k="funds" value={inFlight ? fmtUsd(inFlight) : DASH} sub={<>Cost basis {cost === null ? DASH : fmtUsd(cost)}</>} />
        </section>
      ) : (
        <Panel className="wv-connect">
          <span className="wv-connect__ic" aria-hidden="true"><SodexMark size={22} /></span>
          <span className="wv-connect__t"><b>Your Wealth, in one place</b><small>Connect a wallet to see its value, PnL, holdings and requests.</small></span>
          <Button variant="primary" onClick={() => openConnectDialog()}>Connect wallet</Button>
        </Panel>
      )}
      {p?.complete === false && <p className="wv-note">SoDEX could not price every fund, so the figures leave those out.</p>}

      <div className="wv-desk">
        <FundList views={views} sel={narrow ? null : selected?.id ?? null} onPick={(id) => (narrow ? setSheet(id) : setPick(id))} />
        {!narrow && (
          <Shell className="wv-pane">
            <Panel className="wv-pane__p">
              {selected ? <FundDetail key={selected.id} v={selected} ctx={ctx} now={now} chartHeight={260} /> : <Skeleton className="wv-pane__bone" />}
            </Panel>
          </Shell>
        )}
      </div>

      {ctx.address && (
        <Shell className="wv-actshell">
          <Panel className="wv-actshell__p"><Activity w={w} views={views} ctx={ctx} title={<h2 className="wv-h2">Your activity</h2>} /></Panel>
        </Shell>
      )}
      {narrow && <FundSheet v={sheetView} onClose={() => setSheet(null)} ctx={ctx} now={now} />}
    </div>
  );
}
