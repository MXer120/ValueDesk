/**
 * The Referrals page as three whole pages (owner 2026-11-25, second round: "needs to be a fully page", headers smaller,
 * nothing cluttered; the steps and the present stay). Each is one composition and shows a figure once:
 *
 *   1 Steps    the three steps as one board on a rail, each with its own drawing; under it the earnings and the traders
 *   2 Gift     the present on its stage with the link; a credit card, the earnings and the traders on one ground
 *   3 Network  your traders as rings around you, one per tier, beside the invitation; the lists behind tabs
 *
 * Drawings carry no figures but the programme's constants; every other figure is the wallet's own.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { CREDIT_FEE, REFERRED_START_USD, TIER_SHARES, VIP_CODE_DAYS, type InviteMe, type InviteReferral } from '@sign/invites/claim';
import { DASH, fmtUsd } from '../../format';
import { BrandMark } from '../BrandMark';
import { Icon, RollingNumber, Segmented, Skeleton } from '../bots/kit/kit';
import { EarnChart } from './EarnChart';
import { Gift } from './Gift';
import { Face, History, LinkButton, LinkIcons, LinkText, Missing, ReferralTable, Standing, compact, credit, day, pct, referredOf, signedUsd, usd2, useLink, welcomeText, type LinkState, type RefView } from './parts';

function Head({ v }: { v: RefView }) {
  return (
    <header className="rf-top">
      <h1>Referrals</h1>
      <Standing me={v.me} />
      <button type="button" className="rf-text" onClick={v.how}>How it works</button>
    </header>
  );
}

function LinkBar({ l, big }: { l: LinkState; big?: boolean }) {
  return (
    <div className={`rf-bar${big ? ' is-big' : ''}`}>
      <div className="rf-bar__in"><LinkText l={l} /><LinkButton l={l} label="Copy" /></div>
      <LinkIcons l={l} />
    </div>
  );
}

const Fig = ({ l, v, pos, small }: { l: string; v: ReactNode; pos?: boolean; small?: ReactNode }) => (
  <div className="rf-fig"><dt>{l}</dt><dd className={pos ? 'pos' : undefined}>{v}{small && <small>{small}</small>}</dd></div>
);
const payingText = (me: InviteMe) => (me.credits.paying ? 'Paying your fees now' : me.credits.balanceUsd > 0 ? 'Collecting' : 'Nothing to spend yet');

/** Earnings: the one big figure and its line. */
function Earnings({ v, lean }: { v: RefView; lean?: boolean }) {
  const c = v.me?.credits;
  return (
    <section className="rf-earn" aria-label="Credits earned">
      <div className="rf-earn__h">
        <div><span className="rf-k">Credits earned</span>{v.loading && v.address ? <Skeleton className="rf-skel-big" /> : <b className={c && c.earnedUsd > 0 ? 'pos' : undefined}>{c ? <RollingNumber value={signedUsd(c.earnedUsd)} /> : DASH}</b>}</div>
        <dl>
          {!lean && <Fig l="Spent on fees" v={c ? usd2(c.spentUsd) : DASH} />}
          {lean !== true && <Fig l="Volume referred" v={v.me ? compact(v.me.stats.perpsUsd + v.me.stats.spotUsd) : DASH} />}
        </dl>
      </div>
      <EarnChart me={v.me} />
    </section>
  );
}

/** The traders as a short list: who, on which tier, what they earned you. */
function Traders({ v }: { v: RefView }) {
  const [tab, setTab] = useState<'traders' | 'history'>('traders');
  const [all, setAll] = useState(false);
  const rows = useMemo(() => [...(v.me?.referrals ?? [])].sort((a, b) => b.earnedUsd - a.earnedUsd), [v.me]);
  const n = referredOf(v.me);
  return (
    <section className="rf-tr" aria-label="Your traders">
      <div className="rf-tr__h">
        <Segmented<'traders' | 'history'> label="List" value={tab} onChange={setTab} options={[{ value: 'traders', label: `Your traders${n === null ? '' : ` (${n})`}` }, { value: 'history', label: 'Credit history' }]} />
        {tab === 'traders' && rows.length > 0 && <button type="button" className="rf-text" onClick={() => setAll(!all)}>{all ? 'Show less' : 'Details'}</button>}
      </div>
      {v.absent || (v.error && !v.me) ? <Missing v={v} />
        : tab === 'history' ? <History me={v.me} loading={v.loading && !!v.address} />
        : all ? <ReferralTable rows={v.me?.referrals ?? null} />
        : rows.length ? (
          <ul className="rf-list">
            {rows.slice(0, 6).map((r) => (
              <li key={`${r.wallet}${r.at}`}>
                <Face seed={r.wallet} size={36} />
                <span><b>{r.wallet}</b><small>Tier {r.tier} · {compact(r.perpsUsd + r.spotUsd)}{r.welcome ? ' · in the welcome' : ''}</small></span>
                <em className={r.earnedUsd > 0 ? 'pos' : undefined}>{r.earnedUsd > 0 ? `+${credit(r.earnedUsd)}` : credit(0)}</em>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rf-none">
            <span aria-hidden="true">{[0, 1, 2, 3].map((i) => <i key={i} />)}</span>
            <p>No traders yet</p><small>Each one who joins stands here with what they earned you.</small>
          </div>
        )}
    </section>
  );
}

/* ---------------------------------------------------------------------------------------------- 1 steps ----- */

export function V1Steps({ v }: { v: RefView }) {
  const l = useLink(v);
  const c = v.me?.credits;
  return (
    <>
      <Head v={v} />
      <section className="rf-steps" aria-label="How referrals pay">
        <span className="rf-steps__glow" aria-hidden="true" />
        <article>
          <h2><i>1</i>Share your link</h2>
          <p>Your SoDEX code, one link for both.</p>
          <div className="rf-steps__art">
            <div className="rf-pass">
              <div className="rf-pass__l"><BrandMark size={30} /><b>{pct(TIER_SHARES[0])}</b><small>of their fees</small></div>
              <svg viewBox="0 0 20 160" preserveAspectRatio="none" aria-hidden="true"><path d="M4 0v56l12 14v50L4 134v26" /></svg>
              <dl><div><dt>Your traders</dt><dd>{pct(TIER_SHARES[0])}</dd></div><div><dt>Their traders</dt><dd>{pct(TIER_SHARES[1])}</dd></div><div><dt>One further</dt><dd>{pct(TIER_SHARES[2])}</dd></div></dl>
            </div>
            <LinkBar l={l} />
          </div>
        </article>
        <article>
          <h2><i>2</i>They join</h2>
          <p>One free signature. Their first trades are on us.</p>
          <div className="rf-steps__art is-gift">
            <Gift />
            <ul className="rf-tags"><li><b>$0</b> fee on {welcomeText()}</li><li><b>${REFERRED_START_USD / 1000}K</b> tier at once</li><li className="vip-text"><b>VIP</b> {VIP_CODE_DAYS} days, with a VIP's code</li></ul>
          </div>
        </article>
        <article>
          <h2><i>3</i>You pay less</h2>
          <p>Credits cover your own ValueDesk fee.</p>
          <div className="rf-steps__art">
            <div className="rf-meter">
              <div className="rf-meter__ring" style={{ '--p': c && c.earnedUsd > 0 ? Math.min(1, Math.max(0, c.balanceUsd / c.earnedUsd)) : 0 } as CSSProperties}>
                <svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="52" pathLength="1" /><circle className="is-on" cx="60" cy="60" r="52" pathLength="1" /></svg>
                <div><b>{c ? usd2(c.balanceUsd) : DASH}</b><small>to spend</small></div>
              </div>
              <div className="rf-meter__t"><span className={c?.paying ? 'is-on' : undefined}>{v.me ? payingText(v.me) : 'No credits yet'}</span><b>{(CREDIT_FEE / 10).toFixed(1)} bp</b><small>your fee while they last</small></div>
            </div>
          </div>
        </article>
      </section>
      <div className="rf-duo"><Earnings v={v} /><Traders v={v} /></div>
    </>
  );
}

/* ----------------------------------------------------------------------------------------------- 2 gift ----- */

export function V2Gift({ v }: { v: RefView }) {
  const l = useLink(v);
  const me = v.me;
  return (
    <>
      <section className="rf-dark rf-g">
        <span className="rf-g__ribs" aria-hidden="true" /><span className="rf-g__light" aria-hidden="true" />
        <div className="rf-g__t">
          <div className="rf-g__k"><h1>Referrals</h1><button type="button" className="rf-text" onClick={v.how}>How it works</button></div>
          <h2>They start at zero.<br />You pay less.</h2>
          <LinkBar l={l} big />
        </div>
        <div className="rf-g__art"><Gift /></div>
        <ol className="rf-g__steps">
          <li><b>$0</b><span>their ValueDesk fee on the first {welcomeText()}</span></li>
          <li><b>{pct(TIER_SHARES[0])}</b><span>of the fees they pay after, yours as credits</span></li>
          <li><b>{pct(TIER_SHARES[1])} + {pct(TIER_SHARES[2])}</b><span>from the two tiers behind them</span></li>
        </ol>
      </section>
      <div className="rf-g__desk">
        <div className="rf-g__cr">
        <section className="rf-dark rf-cc" aria-label="Credit balance">
          <span className="rf-cc__sheen" aria-hidden="true" />
          <div><BrandMark size={34} /><em>Fee credits</em></div>
          <b>{me ? usd2(me.credits.balanceUsd) : DASH}</b>
          <div><span>{me ? payingText(me) : 'Connect a wallet'}</span><span>{v.address && !v.sample ? `${v.address.slice(0, 6)}…${v.address.slice(-4)}` : '0x•••• ••••'}</span></div>
        </section>
        <dl className="rf-kv">
          <div><dt>Your fee while they last</dt><dd>{(CREDIT_FEE / 10).toFixed(1)} bp</dd></div>
          <div><dt>Spent on fees</dt><dd>{me ? usd2(me.credits.spentUsd) : DASH}</dd></div>
          {me?.welcome?.active && <div><dt>Left at $0 fee</dt><dd>{fmtUsd(me.welcome.leftUsd, 0)}</dd></div>}
          {me?.vipUntil && <div><dt className="vip-text">VIP fee until</dt><dd className="vip-text">{day(me.vipUntil)}</dd></div>}
          {me?.vipCode && <div><dt className="vip-text">Your link gives</dt><dd className="vip-text">{VIP_CODE_DAYS} days of VIP fee</dd></div>}
          {me?.joined && <div><dt>Referred by</dt><dd>{me.joined.inviter}</dd></div>}
        </dl>
        </div>
        <Earnings v={v} lean />
        <Traders v={v} />
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------------------------- 3 network ----- */

const R = [112, 186, 252] as const;
const MAX = [10, 14, 18] as const;

interface Node { key: string; tier: number; x: number; y: number; r: InviteReferral | null; a: number }

function nodesOf(rs: InviteReferral[]): Node[] {
  return [1, 2, 3].flatMap((t) => {
    const on = rs.filter((r) => r.tier === t).slice(0, MAX[t - 1]);
    // Open places keep each ring drawn before anyone stands on it.
    const n = Math.max(on.length, [5, 7, 9][t - 1]!);
    return Array.from({ length: n }, (_, i): Node => {
      // Round from the rate label at the bottom of the ring, which keeps its place free.
      const gap = [0.8, 0.5, 0.36][t - 1]!;
      const a = Math.PI / 2 + gap / 2 + ((i + 0.5) / n) * (Math.PI * 2 - gap);
      return { key: `${t}-${i}`, tier: t, a, x: 300 + Math.cos(a) * R[t - 1]!, y: 280 + Math.sin(a) * R[t - 1]!, r: on[i] ?? null };
    });
  });
}

function Network({ me, seed }: { me: InviteMe | null; seed: string | null }) {
  const rs = useMemo(() => me?.referrals ?? [], [me]);
  const nodes = useMemo(() => nodesOf(rs), [rs]);
  const [on, setOn] = useState<string | null>(null);
  useEffect(() => setOn(null), [me]);
  const cur = nodes.find((n) => n.key === on && n.r) ?? null;
  const size = [42, 34, 28];
  return (
    <div className="rf-net">
      <svg viewBox="0 0 600 560" aria-hidden="true">
        {R.map((r, i) => <circle key={r} className={`rf-net__ring is-${i + 1}`} cx="300" cy="280" r={r} />)}
        {nodes.filter((n) => n.r && n.r.earnedUsd > 0).map((n, i) => (
          <path key={n.key} className="rf-net__flow" style={{ animationDelay: `${-i * 0.7}s` }} pathLength="1" d={`M${n.x} ${n.y}L${300 + Math.cos(n.a) * 62} ${280 + Math.sin(n.a) * 62}`} />
        ))}
      </svg>
      {R.map((r, i) => <span key={r} className="rf-net__rate" style={{ left: '50%', top: `${((280 + r) / 560) * 100}%` }}>{pct(TIER_SHARES[i]!)}</span>)}
      {nodes.map((n) => {
        const s = size[n.tier - 1]!;
        const at = { left: `${(n.x / 600) * 100}%`, top: `${(n.y / 560) * 100}%`, width: s, height: s };
        return n.r ? (
          <button key={n.key} type="button" className={`rf-net__n${on === n.key ? ' is-on' : ''}`} style={at} aria-label={`${n.r.wallet}, tier ${n.tier}, ${credit(n.r.earnedUsd)} earned`} onPointerEnter={() => setOn(n.key)} onPointerLeave={() => setOn(null)} onFocus={() => setOn(n.key)} onBlur={() => setOn(null)}><Face seed={n.r.wallet} size={s} /></button>
        ) : <i key={n.key} className="rf-net__o" style={{ ...at, width: s * 0.55, height: s * 0.55 }} />;
      })}
      <div className="rf-net__you">{cur?.r ? <><b className={cur.r.earnedUsd > 0 ? 'pos' : undefined}>{cur.r.earnedUsd > 0 ? '+' : ''}{credit(cur.r.earnedUsd)}</b><small>{cur.r.wallet}</small></> : me ? <><b className={me.credits.earnedUsd > 0 ? 'pos' : undefined}>{signedUsd(me.credits.earnedUsd)}</b><small>earned</small></> : seed ? <Face seed={seed} size={64} /> : <BrandMark size={44} />}</div>
    </div>
  );
}

export function V3Network({ v }: { v: RefView }) {
  const l = useLink(v);
  const me = v.me;
  const s = me?.stats;
  return (
    <>
      <div className="rf-n">
        <div className="rf-n__l">
          <div className="rf-n__t">
            <h1>Referrals</h1>
            <p>{pct(TIER_SHARES[0])} of the fees your traders pay, {pct(TIER_SHARES[1])} from theirs, {pct(TIER_SHARES[2])} one further. They pay $0 on their first {welcomeText()}.</p>
            <LinkBar l={l} big />
            <div className="rf-n__m"><button type="button" className="rf-text" onClick={v.how}>How it works</button><Standing me={me} /></div>
          </div>
          <dl className="rf-n__figs">
            <Fig l="Balance" v={me ? usd2(me.credits.balanceUsd) : DASH} small={me ? payingText(me) : 'Pays your ValueDesk fee'} />
            <Fig l="Traders" v={me ? String(referredOf(me)) : DASH} small={s ? `${s.referred[0]} · ${s.referred[1]} · ${s.referred[2]} by tier` : 'On three tiers'} />
            <Fig l="Volume" v={s ? compact(s.perpsUsd + s.spotUsd) : DASH} small="Futures and spot" />
          </dl>
        </div>
        <Network me={me} seed={v.address} />
      </div>
      <div className="rf-duo"><Earnings v={v} lean /><Traders v={v} /></div>
    </>
  );
}
