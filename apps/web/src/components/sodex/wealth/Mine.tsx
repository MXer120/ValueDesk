/**
 * Wealth, version "Mine" (localhost switch): the wallet's Wealth first, like a bank account. Its value or PnL over
 * time, where the money sits, each request on its way with its steps and SoDEX's expected delivery, the history by
 * month, and below, the funds to add to it. Without a wallet the page says what it will show and how to start.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { openConnectDialog } from '../../account/connect';
import { Button, EmptyState, Icon, Panel, RollingNumber, Segmented, SegmentedBar, Shell, ShellHeader, Skeleton, StatusPill } from '../../bots/kit/kit';
import { DASH, fmtUsd } from '../../../format';
import { useAsync } from '../../../hooks';
import { Private, useMask, usePrivacy } from '../../../privacy';
import { readPnlHistory, sodexFundUrl, type PnlRange, type WealthEntry } from '../../../trading/wealth';
import { useLedger } from '../../portfolio/useWealth';
import { SodexMark } from '../../funds/ui';
import { SODEX_SITE } from '../../../sodexProgrammes';
import { useNow } from '../parts';
import { SHELVES, KIND, dayTime, expectedDelivery, isMoving, pctText, useFundViews, val, whenMs, type FundView, type PricePoint } from './data';
import {
  ChannelPill, EntryRow, FundAct, FundMark, FundSheet, HoldingRow, MaintNote, PlanRow, PriceChart, Signed, pledgedValue, signedUsd,
  type VersionProps, type WealthCtx,
} from './parts';

const RANGES: ReadonlyArray<{ value: PnlRange; label: string }> = [
  { value: '1W', label: '7d' }, { value: '1M', label: '30d' }, { value: '3M', label: '90d' }, { value: '1Y', label: '1y' }, { value: 'All', label: 'All' },
];
/** Allocation colours: the app's signal green, then the landing's blues and violets, then warm. Never a meaning. */
const PALETTE = ['var(--wv-c1)', 'var(--wv-c2)', 'var(--wv-c3)', 'var(--wv-c4)', 'var(--wv-c5)', 'var(--wv-c6)'];

function ValueHero({ w, value, slp, ctx, maint }: VersionProps) {
  const [range, setRange] = useState<PnlRange>('1M');
  const [view, setView] = useState<'value' | 'pnl'>('value');
  const priv = usePrivacy();
  const maskEquity = useMask('equity');
  const maskPnl = useMask('pnl');
  const maskFunds = useMask('funds');
  const history = useAsync(() => readPnlHistory(ctx.address!, range), [ctx.address, range, ctx.refreshToken], { enabled: !!ctx.address });
  const points = useMemo((): PricePoint[] | null => {
    if (!history.data) return null;
    const pts = history.data
      .map((p) => ({ t: whenMs(p.ts) ?? NaN, v: val(view === 'value' ? p.totalValue : p.pnl) }))
      .filter((p): p is PricePoint => Number.isFinite(p.t) && p.v !== null);
    if (view === 'value' || pts.length === 0) return pts;
    // PnL reads as the change from the start of the range (the Original's chart).
    const first = pts[0]!.v;
    return pts.map((p) => ({ t: p.t, v: p.v - first }));
  }, [history.data, view]);
  const p = w.pnl;
  const d24 = val(p?.totalPnl24h);
  const pnl = val(p?.totalPnl);
  const pledged = pledgedValue(w.holdings);
  // What SoDEX says the wallet holds in Wealth, the level its value chart ends at. The Portfolio's Wealth bucket
  // (value) leaves out shares pledged as Perps margin; the row under the chart says so when the two differ.
  const held = val(p?.totalValue) ?? value;
  const change = points && points.length > 1 ? points[points.length - 1]!.v - points[0]!.v : null;
  const kv: Array<[string, number | null, boolean, 'pnl' | 'funds']> = [
    ['Realized', val(p?.totalRealizedPnl), true, 'pnl'],
    ['Unrealized', val(p?.totalUnrealizedPnl), true, 'pnl'],
    ['Cost', val(p?.totalCost), false, 'funds'],
    ['On its way', val(p?.inFlightValue), false, 'funds'],
  ];
  return (
    <section className="wv-hero">
      <header className="wv-hero__k">
        <SodexMark size={20} />
        <h1>Your Wealth</h1>
        {maint?.state === 'maintenance' && <StatusPill tone="warning" size="sm" dot>Maintenance</StatusPill>}
        <a className="wv-hero__link" href={SODEX_SITE.wealth} target="_blank" rel="noopener noreferrer">SoDEX Wealth<Icon name="up" size={12} /></a>
      </header>
      {!ctx.address ? (
        <div className="wv-hero__none">
          <p className="wv-hero__big is-dim" aria-hidden="true">{DASH}</p>
          <p>Connect a wallet to see what it holds in SoDEX Wealth: its value over time, each request on its way and its history.</p>
          <Button variant="primary" size="md" onClick={() => openConnectDialog()}>Connect wallet</Button>
        </div>
      ) : (
        <>
          <div className="wv-hero__fig">
            <div>
              {priv.isHidden('equity') || held === null ? <p className="wv-hero__big">{maskEquity(held === null ? DASH : fmtUsd(held))}</p> : <RollingNumber value={fmtUsd(held)} className="wv-hero__big" />}
              <p className="wv-hero__sub">
                <Signed v={d24}>{maskPnl(d24 === null ? DASH : signedUsd(d24))}</Signed><span>today</span>
                <i aria-hidden="true" />
                <Signed v={pnl}>{maskPnl(pnl === null ? DASH : signedUsd(pnl))}</Signed><span>all-time PnL</span>
              </p>
            </div>
            <div className="wv-hero__ctl">
              <Segmented size="sm" label="Chart" value={view} onChange={setView} options={[{ value: 'value', label: 'Value' }, { value: 'pnl', label: 'PnL' }]} />
              <Segmented size="sm" label="Range" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />
            </div>
          </div>
          <Private k="charts">
            {history.error && !history.data ? <div className="wv-chart is-empty" style={{ height: 230 }}><p>SoDEX did not send your Wealth history just now.</p><Button size="sm" onClick={history.refresh}>Try again</Button></div>
              : !points ? <Skeleton className="wv-chart is-skel" style={{ height: 230 }} />
              : points.length < 2 ? <div className="wv-chart is-empty" style={{ height: 230 }}><p>Nothing to chart in this range yet.</p></div>
              : <PriceChart points={points} height={230} tone={view === 'value' ? 'neutral' : 'sign'} mask={view === 'value' ? maskFunds : maskPnl} label={view === 'value' ? 'Wealth value' : 'Wealth PnL'} pctReadout={view === 'value'} fmtY={view === 'value' ? (x, dp) => fmtUsd(x, dp) : (x, dp) => `${x > 0 ? '+' : ''}${fmtUsd(x, dp)}`} />}
          </Private>
          <dl className="wv-hero__kv">
            {change !== null && <div><dt>{view === 'value' ? 'Change' : 'PnL'}, {RANGES.find((r) => r.value === range)?.label}</dt><dd><Signed v={view === 'pnl' ? change : null}>{(view === 'value' ? maskFunds : maskPnl)(signedUsd(change))}</Signed></dd></div>}
            {kv.map(([k, x, sg, m]) => <div key={k}><dt>{k}</dt><dd><Signed v={sg ? x : null}>{(m === 'pnl' ? maskPnl : maskFunds)(x === null || (k === 'On its way' && x === 0) ? DASH : sg ? signedUsd(x) : fmtUsd(x))}</Signed></dd></div>)}
            {pledged > 0 && <div title="Fund shares pledged as Perps margin count under Perps in your Portfolio, each dollar once."><dt>Pledged as Perps margin</dt><dd>{maskFunds(fmtUsd(pledged))}</dd></div>}
            {value !== null && held !== null && Math.abs(held - value) >= 0.005 && <div title="Your Portfolio's Wealth bucket: every dollar once, so shares pledged as Perps margin count under Perps."><dt>Wealth in your Portfolio</dt><dd>{maskEquity(fmtUsd(value))}</dd></div>}
            {slp !== null && <div title="MAG7.ssi or sMAG7.ssi in the liquidity vault: SoDEX's account-value series minus what it is known to hold."><dt>SLP vault, inferred</dt><dd>{maskFunds(fmtUsd(slp))}</dd></div>}
          </dl>
          {p?.complete === false && <p className="wv-note">SoDEX could not price every fund, so the figures leave those out.</p>}
        </>
      )}
    </section>
  );
}

/** Where the money sits: one bar by fund, then the holdings. */
function Holdings({ w, views, ctx }: { w: VersionProps['w']; views: FundView[] | null; ctx: WealthCtx }) {
  const maskFunds = useMask('funds');
  const priv = usePrivacy();
  const byId = useMemo(() => new Map((views ?? []).map((v) => [v.id, v])), [views]);
  const priced = (w.holdings ?? []).filter((h) => (h.marketValue ?? 0) > 0);
  const total = priced.reduce((s, h) => s + (h.marketValue ?? 0), 0);
  return (
    <Shell className="wv-mine__card">
      <ShellHeader icon="coins" title="Holdings" subtitle={w.holdings ? `${w.holdings.length} fund${w.holdings.length === 1 ? '' : 's'}` : undefined} />
      <Panel className="wv-mine__p">
        {!ctx.address ? <EmptyState icon="wallet" title="No wallet connected" description="Your funds show here." compact />
          : w.error && !w.holdings ? <EmptyState icon="warning" tone="error" title="SoDEX did not send your holdings" description={w.error} compact actions={<Button onClick={w.refresh}>Try again</Button>} />
          : !w.holdings ? <Skeleton className="wv-bone is-tall" />
          : w.holdings.length === 0 ? <EmptyState icon="coins" title="Nothing held yet" description="Pick a fund below to start." compact />
          : (
            <>
              {total > 0 && !priv.isHidden('funds') && (
                <div className="wv-alloc">
                  <SegmentedBar size="lg" max={total} label="Wealth by fund" segments={priced.map((h, i) => ({ id: h.fundId, value: h.marketValue ?? 0, label: h.name, color: PALETTE[i % PALETTE.length]! }))} />
                  <ul className="wv-alloc__k">
                    {priced.map((h, i) => <li key={h.fundId}><i style={{ background: PALETTE[i % PALETTE.length] }} />{h.name}<b>{pctText(((h.marketValue ?? 0) / total) * 100, false, 1)}</b></li>)}
                  </ul>
                </div>
              )}
              <ul className="wv-rows">{w.holdings.map((h) => <HoldingRow key={h.fundId} h={h} v={byId.get(h.fundId) ?? null} ctx={ctx} />)}</ul>
              {priced.length === 0 && <p className="wv-note">{maskFunds('SoDEX has not priced these holdings yet.')}</p>}
            </>
          )}
      </Panel>
    </Shell>
  );
}

const STEPS = ['Requested', 'Processing', 'Delivered'] as const;

/** A request on its way: where it is in SoDEX's three steps, and when SoDEX expects it. */
function Request({ e, v, now }: { e: WealthEntry; v: FundView | null; now: number }) {
  const maskFunds = useMask('funds');
  const due = expectedDelivery(e, v?.status ?? null);
  const at = e.claimable ? 2 : 1;
  const amount = e.cost ?? e.proceeds;
  return (
    <li className="wv-req">
      <div className="wv-req__h">
        <FundMark v={v ?? { icon: e.fundId }} size={32} />
        <span className="wv-row__t"><b>{v?.name ?? e.fundId}</b><small>{KIND[e.kind] ?? e.kind} · {dayTime(e.requestedAt ?? e.at)}</small></span>
        <b className="wv-req__amt">{maskFunds(amount !== undefined ? `${e.costEstimated ? '≈ ' : ''}${fmtUsd(val(amount) ?? 0)}` : DASH)}</b>
      </div>
      <ol className="wv-steps" aria-label="Request steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i < at ? 'is-done' : i === at ? 'is-now' : ''}>
            <i aria-hidden="true">{i < at ? <Icon name="check" size={11} /> : null}</i>
            <span>{i === 2 && e.claimable ? 'Ready to claim' : i === 1 && e.delayedPending ? 'Delayed' : s}</span>
          </li>
        ))}
      </ol>
      <div className="wv-req__f">
        {due ? <span title="SoDEX's expected delivery for this batch">Expected {dayTime(due)}{due > now ? ` · in ${Math.max(1, Math.round((due - now) / 3_600_000))} h` : ''}</span> : <span>SoDEX gives no delivery time for this request</span>}
        {e.claimable === true && <a className="tf-btn is-primary is-sm" href={sodexFundUrl(e.fundId)} target="_blank" rel="noopener noreferrer">Claim on SoDEX</a>}
      </div>
    </li>
  );
}

/** The history by month, newest first, and the recurring buys. */
function Timeline({ entries, plans, views, ctx, error }: { entries: WealthEntry[] | null; plans: ReturnType<typeof useLedger>['plans']; views: FundView[] | null; ctx: WealthCtx; error: string | null }) {
  const byId = useMemo(() => new Map((views ?? []).map((v) => [v.id, v])), [views]);
  const months = useMemo(() => {
    const out: Array<{ key: string; label: string; rows: WealthEntry[] }> = [];
    for (const e of entries ?? []) {
      const ms = whenMs(e.requestedAt ?? e.at);
      const d = ms === null ? null : new Date(ms);
      const key = d ? `${d.getFullYear()}-${d.getMonth()}` : 'x';
      const label = d ? d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'Undated';
      const last = out[out.length - 1];
      if (last?.key === key) last.rows.push(e); else out.push({ key, label, rows: [e] });
    }
    return out;
  }, [entries]);
  let body: ReactNode;
  if (!ctx.address) body = <EmptyState icon="wallet" title="No wallet connected" description="Deposits, redemptions and airdrops show here." compact />;
  else if (error && !entries) body = <EmptyState icon="warning" tone="error" title="SoDEX did not send your Wealth history" description={error} compact />;
  else if (!entries) body = <Skeleton className="wv-bone is-tall" />;
  else if (entries.length === 0) body = <EmptyState icon="clock" title="No Wealth history yet" description="Deposits, redemptions and airdrops show here." compact />;
  else {
    body = months.map((m) => (
      <section key={m.key} className="wv-month">
        <h3 className="wv-h3">{m.label}<span>{m.rows.length}</span></h3>
        <ul className="wv-rows">{m.rows.map((e, i) => <EntryRow key={`${e.txHash ?? e.at}-${i}`} e={e} name={byId.get(e.fundId)?.name ?? e.fundId} ticker={byId.get(e.fundId)?.ticker ?? ''} v={byId.get(e.fundId) ?? null} />)}</ul>
      </section>
    ));
  }
  return (
    <Shell className="wv-mine__card">
      <ShellHeader icon="list" title="History" subtitle={entries ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` : undefined} />
      <Panel className="wv-mine__p">
        {body}
        {plans && plans.length > 0 && (
          <section className="wv-month">
            <h3 className="wv-h3">Recurring buys<span>{plans.length}</span></h3>
            <ul className="wv-rows">{plans.map((p) => <PlanRow key={p.planIndex} p={p} name={byId.get(p.fundId ?? '')?.name ?? p.share?.coin ?? p.target} icon={byId.get(p.fundId ?? '')?.icon ?? p.share?.coin ?? p.target} />)}</ul>
          </section>
        )}
      </Panel>
    </Shell>
  );
}

/** The funds to add, one slim row each, by shelf. A row opens the fund. */
function AddMore({ views, ctx, now, onOpen }: { views: FundView[] | null; ctx: WealthCtx; now: number; onOpen: (id: string) => void }) {
  return (
    <section className="wv-more" aria-label="Funds">
      <div className="wv-more__h">
        <h2 className="wv-h2">Add to your Wealth</h2>
        <p>{views ? `${views.length} funds on SoDEX Wealth` : 'Reading'}</p>
      </div>
      <div className="wv-more__cols">
        {SHELVES.map((s) => {
          const funds = (views ?? []).filter((v) => v.shelf === s);
          return (
            <Shell key={s} className="wv-more__shelf">
              <ShellHeader title={s} subtitle={`${funds.length} fund${funds.length === 1 ? '' : 's'}`} />
              <Panel className="wv-more__p">
                {!views ? <Skeleton className="wv-bone is-tall" /> : (
                  <ul className="wv-rows">
                    {funds.map((v) => {
                      const roi = v.head.kind === 'roi';
                      return (
                        <li key={v.id} className="wv-row wv-row--open">
                          <button type="button" className="wv-row__open" onClick={() => onOpen(v.id)} aria-label={`${v.name}, open the fund`} />
                          <FundMark v={v} size={32} />
                          <span className="wv-row__t"><b>{v.name}</b><small><ChannelPill v={v} now={now} /></small></span>
                          <span className="wv-row__n"><Signed v={roi ? v.head.value : null}><b>{pctText(v.head.value, roi)}</b></Signed><small>{v.head.label}</small></span>
                          <span className="wv-row__a"><FundAct v={v} ctx={ctx} /></span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>
            </Shell>
          );
        })}
      </div>
    </section>
  );
}

export function Mine(props: VersionProps) {
  const { w, ctx, maint } = props;
  const views = useFundViews(w);
  const now = useNow(15_000);
  const [open, setOpen] = useState<string | null>(null);
  const { entries, plans, error } = useLedger(ctx.address, ctx.refreshToken);
  const byId = useMemo(() => new Map((views ?? []).map((v) => [v.id, v])), [views]);
  const moving = entries ? entries.filter(isMoving) : null;
  return (
    <div className="wv-col">
      <ValueHero {...props} />
      {maint?.state === 'maintenance' && <MaintNote message={maint.message} />}
      {ctx.address && <div className="wv-mine__grid">
        <Holdings w={w} views={views} ctx={ctx} />
        <Shell className="wv-mine__card">
          <ShellHeader icon="clock" title="On its way" subtitle={moving && moving.length > 0 ? `${moving.length} request${moving.length === 1 ? '' : 's'}` : undefined} />
          <Panel className="wv-mine__p">
            {!ctx.address ? <EmptyState icon="wallet" title="No wallet connected" description="Requests show here until they settle." compact />
              : error && !entries ? <EmptyState icon="warning" tone="error" title="SoDEX did not send your requests" description={error} compact />
              : !moving ? <Skeleton className="wv-bone is-tall" />
              : moving.length === 0 ? <EmptyState icon="check" title="Nothing on its way" description="Batch and quote requests show here, step by step, until they settle." compact />
              : <ul className="wv-reqs">{moving.map((e, i) => <Request key={`${e.txHash ?? e.at}-${i}`} e={e} v={byId.get(e.fundId) ?? null} now={now} />)}</ul>}
          </Panel>
        </Shell>
      </div>}
      {ctx.address && <Timeline entries={entries} plans={plans} views={views} ctx={ctx} error={error} />}
      <AddMore views={views} ctx={ctx} now={now} onOpen={setOpen} />
      <FundSheet v={views?.find((v) => v.id === open) ?? null} onClose={() => setOpen(null)} ctx={ctx} now={now} />
    </div>
  );
}
