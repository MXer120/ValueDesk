/**
 * Rewards on the Referrals page: the panel over time (USDC and fee credits, or SoPoints; chart or calendar), the traders with
 * what each earned, and the history of both kinds. SoDEX's figures show once the wallet signed in to SoDEX; until then they
 * say so, and never as a 0.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { InviteEntry, InviteReferral } from '@sign/invites/claim';
import { DASH } from '../../format';
import type { SodexTrader } from '../../invites/sodexRewards';
import type { SodexRewards } from '../../invites/useSodexRewards';
import { SODEX_POINTS_SIGNIN_LIVE } from '../../sodexProgrammes';
import type { Eip1193Provider } from '../../wallet';
import { EmptyState, Panel, Segmented, Skeleton } from '../bots/kit/kit';
import { HeatGrid } from './CreditCalendar';
import { Empty, PointsChart, RewardsChart } from './EarnChart';
import { creditsLine, pointsGrid, rewardsGrid, scoredWeeks } from './calendar';
import { Face, Missing, Pager, ReferralTable, compact, credit, day, signedUsd, usd2, whole, type RefView } from './parts';

/** The SoDEX sign-in, where SoDEX's figures would be. */
export function SodexSignIn({ s, provider, children }: { s: SodexRewards; provider: Eip1193Provider | null; children: ReactNode }) {
  return (
    <div className="rf-signin">
      <img src="/logos/brand/sodex.svg" width="30" height="30" alt="" />
      <p>{children}</p>
      <small>One free signature, the same as on sodex.com. It moves no funds.</small>
      <button type="button" className="rf-cta" disabled={!provider || s.signingIn || !SODEX_POINTS_SIGNIN_LIVE} onClick={s.signIn}>{s.signingIn ? 'Check wallet…' : 'Sign in to SoDEX'}</button>
      {s.signInError && <span className="neg" role="alert">{s.signInError}</span>}
    </div>
  );
}

type Metric = 'rewards' | 'points';
type View = 'chart' | 'calendar';
const KEY = 'vs.referrals.view';
function readView(): { metric: Metric; view: View } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { metric?: string; view?: string } | null;
    return { metric: v?.metric === 'points' ? 'points' : 'rewards', view: v?.view === 'calendar' ? 'calendar' : 'chart' };
  } catch {
    return { metric: 'rewards', view: 'chart' };
  }
}

export function RewardsPanel({ v, s, provider }: { v: RefView; s: SodexRewards; provider: Eip1193Provider | null }) {
  const [{ metric, view }, set] = useState(readView);
  const [now, setNow] = useState(() => Date.now());
  // The right edge moves on when something new was read.
  useEffect(() => setNow(Date.now()), [v.me, s.line]);
  const pick = (p: { metric: Metric; view: View }) => { set(p); try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* this tab only */ } };
  const c = v.me?.credits;
  const credits = useMemo(() => creditsLine(v.me, now), [v.me, now]);
  const weeks = s.weeks ?? [];
  const scored = useMemo(() => scoredWeeks(s.weeks ?? []), [s.weeks]);
  const invited = scored.reduce((x, w) => x + w.split.referral, 0);
  const waiting = v.loading && !!v.address;
  return (
    <section className="rf-earn" aria-label={metric === 'rewards' ? 'Rewards earned' : 'SoPoints earned'}>
      <div className="rf-earn__bar">
        <Segmented<Metric> label="Show" value={metric} onChange={(m) => pick({ metric: m, view })} options={[{ value: 'rewards', label: 'Rewards' }, { value: 'points', label: 'SoPoints' }]} />
        <Segmented<View> label="As" value={view} onChange={(x) => pick({ metric, view: x })} options={[{ value: 'chart', label: 'Chart' }, { value: 'calendar', label: 'Calendar' }]} />
      </div>
      {metric === 'rewards' ? (
        <>
          <div className="rf-earn__figs">
            <div className="is-usdc"><span><i />USDC earned</span>{s.signedIn && s.loading && s.earnedUsd === null ? <Skeleton className="rf-skel-big" /> : s.earnedUsd !== null ? <b>{signedUsd(s.earnedUsd)}</b> : s.claimedUsd !== null && s.claimedUsd > 0 ? <b>{signedUsd(s.claimedUsd)}<small>claimed</small></b> : v.address ? <button type="button" className="rf-text is-link" disabled={!provider || s.signingIn} onClick={s.signIn}>{s.signingIn ? 'Check wallet…' : 'Sign in to SoDEX'}</button> : <b>{DASH}</b>}</div>
            <div className="is-credit"><span><i />Fee credits earned</span>{waiting ? <Skeleton className="rf-skel-big" /> : <b>{c ? signedUsd(c.earnedUsd) : DASH}</b>}</div>
          </div>
          {view === 'chart' ? <RewardsChart usdc={s.signedIn && s.stats ? s.line : null} credits={credits} now={now} />
            : <HeatGrid caption="Rewards by day" step="day" grid={(cols, offset) => rewardsGrid(v.me, s.claims, now, cols, offset)} />}
        </>
      ) : !s.signedIn ? (
        v.address ? <SodexSignIn s={s} provider={provider}>Your SoPoints week by week, and what your invitees earned you.</SodexSignIn> : <Empty steps>Connect a wallet to see your SoPoints.</Empty>
      ) : (
        <>
          <div className="rf-earn__figs">
            <div className="is-points"><span><i />SoPoints</span>{s.loading && !s.weeks ? <Skeleton className="rf-skel-big" /> : <b>{scored.length || s.weeks ? whole(scored.reduce((x, w) => x + w.split.week.points, 0)) : DASH}</b>}</div>
            <div className="is-referral"><span><i />From invitees</span>{s.loading && !s.weeks ? <Skeleton className="rf-skel-big" /> : <b>{s.weeks ? whole(invited) : DASH}</b>}</div>
          </div>
          {s.loading && !s.weeks ? <div className="rfc"><Skeleton className="rf-skel-chart" /></div>
            : view === 'chart' ? <PointsChart weeks={weeks} />
            : scored.length ? <HeatGrid caption="SoPoints by week" step="week" grid={(cols, offset) => pointsGrid(weeks, cols, offset)} /> : <Empty steps>Your SoPoints draw here from your first scored week.</Empty>}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------ traders, history ----- */

/** A phone's width: the list stays a list there, never a wide table. */
function usePhone(): boolean {
  const [on, setOn] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const m = window.matchMedia('(max-width: 720px)');
    const f = () => setOn(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return on;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export interface TraderRow { key: string; wallet: string; tier: number | null; volumeUsd: number; welcome: boolean; creditUsd: number | null; usdcUsd: number | null; points: number | null }

/** ValueDesk's referrals and SoDEX's invitees as one list: a wallet on both is one row (its short form, tier 1). */
export function mergeTraders(ours: readonly InviteReferral[], theirs: readonly SodexTrader[] | null): TraderRow[] {
  const left = new Map<string, SodexTrader[]>();
  for (const t of theirs ?? []) { const k = short(t.wallet); left.set(k, [...(left.get(k) ?? []), t]); }
  const rows: TraderRow[] = ours.map((r, i) => {
    const same = r.tier === 1 ? left.get(r.wallet)?.shift() : undefined;
    return { key: `${r.wallet}${r.at}${i}`, wallet: r.wallet, tier: r.tier, volumeUsd: r.perpsUsd + r.spotUsd, welcome: r.welcome, creditUsd: r.earnedUsd, usdcUsd: theirs ? same?.rebateUsd ?? 0 : null, points: theirs ? same?.points ?? 0 : null };
  });
  for (const ts of left.values()) for (const t of ts) rows.push({ key: t.wallet, wallet: short(t.wallet), tier: null, volumeUsd: t.volumeUsd, welcome: false, creditUsd: null, usdcUsd: t.rebateUsd, points: t.points });
  return rows.sort((a, b) => (b.creditUsd ?? 0) + (b.usdcUsd ?? 0) - ((a.creditUsd ?? 0) + (a.usdcUsd ?? 0)) || b.volumeUsd - a.volumeUsd);
}

export interface HistoryRow { key: string; at: number; unit: 'usdc' | 'credit'; kind: InviteEntry['kind'] | 'claim'; usd: number | null; tier: number | null; from: string | null; tx: string | null }
/** Both kinds in one list, newest first. */
export function mergeHistory(v: RefView, s: SodexRewards): HistoryRow[] {
  return [
    ...(v.me?.history ?? []).map((h, i): HistoryRow => ({ key: `c${h.at}-${i}`, at: h.at, unit: 'credit', kind: h.kind, usd: h.usd, tier: h.tier, from: h.from, tx: null })),
    ...(s.claims ?? []).map((c, i): HistoryRow => ({ key: `u${c.at}-${i}`, at: c.at, unit: 'usdc', kind: 'claim', usd: c.usd, tier: null, from: null, tx: c.tx })),
  ].sort((a, b) => b.at - a.at);
}

export function Traders({ v, s }: { v: RefView; s: SodexRewards }) {
  const [tab, setTab] = useState<'traders' | 'history'>('traders');
  const [page, setPage] = useState(0);
  const rows = useMemo(() => mergeTraders(v.me?.referrals ?? [], s.traders), [v.me, s.traders]);
  const n = v.me || s.traders ? rows.length : null;
  const phone = usePhone();
  const sum = (r: TraderRow) => (r.creditUsd ?? 0) + (r.usdcUsd ?? 0);
  const pages = Math.max(1, Math.ceil(rows.length / TRADERS_PAGE));
  const at = Math.min(page, pages - 1);
  return (
    <section className="rf-tr" aria-label="Your traders">
      <div className="rf-tr__h">
        <Segmented<'traders' | 'history'> label="List" value={tab} onChange={setTab} options={[{ value: 'traders', label: `Traders${n === null ? '' : ` (${n})`}` }, { value: 'history', label: 'History' }]} />
      </div>
      {tab === 'history' ? <History rows={mergeHistory(v, s)} loading={v.loading && !!v.address} partial={!s.signedIn && !!v.address} />
        : v.absent || (v.error && !v.me) ? <Missing v={v} />
        : rows.length ? (
          <>
          <ul className="rf-list">
            {rows.slice(at * TRADERS_PAGE, at * TRADERS_PAGE + TRADERS_PAGE).map((r) => (
              <li key={r.key}>
                <Face seed={r.wallet} size={36} />
                <span><b>{r.wallet}</b><small>{r.tier === null ? 'SoDEX' : `Tier ${r.tier}`} · {compact(r.volumeUsd)}{r.welcome ? ' · in the welcome' : ''}{!phone && r.points ? ` · ${whole(r.points)} pts` : ''}</small></span>
                <span className="rf-pay" title={[r.usdcUsd !== null ? `${credit(r.usdcUsd)} USDC from SoDEX` : '', r.creditUsd !== null ? `${credit(r.creditUsd)} fee credits` : ''].filter(Boolean).join(', ')}>
                  {r.creditUsd !== null && <em className={r.creditUsd > 0 ? 'is-credit' : undefined}>{r.creditUsd > 0 ? '+' : ''}{credit(r.creditUsd)}</em>}
                  {r.usdcUsd !== null && (r.usdcUsd > 0 || r.creditUsd === null) && <em className="is-usdc">{r.usdcUsd > 0 ? '+' : ''}{credit(r.usdcUsd)} <small>USDC</small></em>}
                  {r.creditUsd === null && sum(r) === 0 && r.usdcUsd === null && DASH}
                </span>
              </li>
            ))}
          </ul>
          {pages > 1 && <Pager page={at} pages={pages} onPage={setPage} />}
          </>
        ) : (
          <div className="rf-none">
            <span aria-hidden="true">{[0, 1, 2, 3].map((i) => <i key={i} />)}</span>
            <p>No traders yet</p><small>Each one who joins stands here with what they earned you.</small>
          </div>
        )}
      {tab === 'traders' && !phone && v.me && v.me.referrals.length > 0 && <details className="rf-more"><summary>Table by tier</summary><ReferralTable rows={v.me.referrals} /></details>}
    </section>
  );
}

const PAGE = 8;
const TRADERS_PAGE = 6;
const TX = 'https://main-scan.valuechain.xyz/tx/';
function History({ rows, loading, partial }: { rows: HistoryRow[]; loading: boolean; partial: boolean }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const at = Math.min(page, pages - 1);
  if (loading) return <div className="rf-skel-rows">{[0, 1, 2].map((i) => <Skeleton key={i} className="rf-skel-row" />)}</div>;
  return (
    <Panel className="rf-hist">
      {!rows.length ? <EmptyState compact icon="clock" title="No rewards yet" description={partial ? 'USDC claims show after the SoDEX sign-in.' : undefined} /> : (
        <>
          <table className="bots-table rf-tbl is-hist">
            <thead><tr><th>Time</th><th>Type</th><th className="right">Reward</th></tr></thead>
            <tbody>
              {rows.slice(at * PAGE, at * PAGE + PAGE).map((h) => (
                <tr key={h.key}>
                  <td className="dim">{day(h.at)}</td>
                  <td><span className="rf-type">{h.unit === 'usdc' ? <><img src="/logos/brand/sodex.svg" width="14" height="14" alt="" />{h.tx ? <a href={`${TX}${h.tx}`} target="_blank" rel="noopener noreferrer">USDC claimed</a> : 'USDC claimed'}</>
                    : h.kind === 'earn' ? <><span className={`rf-tier is-${h.tier ?? 1}`}>T{h.tier ?? 1}</span>{h.from}</> : h.kind === 'grant' ? <b className="vip-text">VIP credit</b> : 'Fees paid'}</span></td>
                  <td className={`right num ${h.unit === 'usdc' ? 'is-usdc' : h.kind === 'spend' ? 'dim' : 'pos'}`}>{h.usd === null ? DASH : <>{h.kind === 'spend' ? '−' : '+'}{h.unit === 'usdc' ? usd2(h.usd) : credit(h.usd)}</>}<small>{h.unit === 'usdc' ? ' USDC' : ' credits'}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
          {partial && <p className="rf-hist__note">USDC claims show after the SoDEX sign-in.</p>}
          {pages > 1 && <Pager page={at} pages={pages} onPage={setPage} />}
        </>
      )}
    </Panel>
  );
}
