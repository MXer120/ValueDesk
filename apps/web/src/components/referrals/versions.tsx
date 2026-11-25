/**
 * The Referrals page's five openings (owner 2026-11-25: "give me a switch just like we did on the landing page"), one
 * per reference the owner sent, each in the home page's language: ink, chrome type, the V's green, the liquidation heat
 * through ribbed glass. Drawings carry no figures; every figure is the wallet's own or a constant of the programme.
 *
 *   1 Card     a share card on a field of heat
 *   2 Orbit    the traders you brought, one after another, with the credits each earned you
 *   3 Steps    three cards: share, they join, you earn
 *   4 Gift     an invite sheet with a present, the figures beside it
 *   5 Tiers    three coins, one per tier
 */
import { lazy, Suspense, useEffect, useId, useState, type ReactNode } from 'react';
import { CREDIT_FEE, TIER_SHARES, WELCOME_USD } from '@sign/invites/claim';
import { DASH } from '../../format';
import { BrandMark } from '../BrandMark';
import { Icon, StatusPill, type IconName } from '../bots/kit/kit';
import { Benefits, Face, LinkButton, LinkMore, LinkPills, LinkText, StatStrip, Tables, welcomeText, WelcomeBar, compact, credit, earnedOfTier, pct, signedUsd, usd2, useLink, type RefView } from './parts';

const HeatGlass = lazy(() => import('../landing/v4/heat').then((m) => ({ default: m.HeatGlass })));
const Heat = ({ layout, className, rib }: { layout: 'wide' | 'card' | 'stage'; className: string; rib: number }) => (
  <Suspense fallback={null}><HeatGlass layout={layout} rib={rib} className={className} every={90} scale={0.75} /></Suspense>
);
const How = ({ v }: { v: RefView }) => <button type="button" className="rf-ghost" onClick={v.how}>How it works</button>;

/** The V's five blocks, in a paint of the caller's. */
function VBlocks({ fill, point }: { fill: string; point: string }) {
  return <>{[[0, 0], [4, 0], [1, 1], [3, 1], [2, 2]].map(([c, r]) => <rect key={`${c}${r}`} x={c! * 20} y={r! * 26} width="17" height="23" rx="4.6" fill={r === 2 ? point : fill} />)}</>;
}

/* ----------------------------------------------------------------------------------------------- 1 card ----- */

export function V1Card({ v }: { v: RefView }) {
  const l = useLink(v);
  const id = useId();
  const rows: Array<[IconName, ReactNode]> = [
    ['share', 'Share your invite link'],
    ['bolt', <>They pay <b>$0</b> ValueDesk fee on their first <b>{welcomeText()}</b></>],
    ['coins', <>You receive <b>{pct(TIER_SHARES[0])}</b> of the fees they pay, for life</>],
  ];
  return (
    <>
      <section className="rf-stage rf-v1">
        <Heat layout="wide" rib={30} className="rf-heat" />
        <div className="rf-v1__card">
          <div className="rf-v1__ban">
            <span className="rf-v1__pill">Earn {pct(TIER_SHARES[0])} of their fees</span>
            <h1>Refer &amp; Earn</h1>
            <p>for every trader you bring</p>
            <svg className="rf-v1__art" viewBox="-4 -4 105 83" aria-hidden="true">
              <defs>
                <linearGradient id={`${id}a`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="97" y2="70">
                  <stop offset="0" stopColor="#8a5cf0" /><stop offset="0.4" stopColor="#5d7fd8" /><stop offset="0.75" stopColor="#21918c" /><stop offset="1" stopColor="#5ec962" />
                </linearGradient>
                <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5cf0c0" /><stop offset="1" stopColor="#00b481" /></linearGradient>
                <linearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity="0.75" /><stop offset="0.5" stopColor="#fff" stopOpacity="0.05" /><stop offset="1" stopColor="#fff" stopOpacity="0.3" /></linearGradient>
              </defs>
              <g stroke={`url(#${id}c)`} strokeWidth="1"><VBlocks fill={`url(#${id}a)`} point={`url(#${id}b)`} /></g>
            </svg>
          </div>
          <span className="rf-k">How it works</span>
          <ul className="rf-v1__how">{rows.map(([i, t]) => <li key={i}><Icon name={i} size={20} /><span>{t}</span></li>)}</ul>
          <span className="rf-k">Your invite link</span>
          <div className="rf-field"><Icon name="share" size={16} /><LinkText l={l} /><LinkButton l={l} /></div>
          <div className="rf-v1__foot"><LinkMore l={l} /><How v={v} /></div>
          <LinkPills me={v.me} />
        </div>
      </section>
      <StatStrip me={v.me} loading={v.loading && !v.absent} />
      <WelcomeBar me={v.me} />
      <Tables v={v} />
      <Benefits />
    </>
  );
}

/* ---------------------------------------------------------------------------------------------- 2 orbit ----- */

export function V2Orbit({ v }: { v: RefView }) {
  const l = useLink(v);
  const rs = v.me?.referrals ?? [];
  // Five places at least, so the row stands before anyone joined: the empty ones are drawn as places.
  const n = Math.max(rs.length, 5);
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (rs.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') setAt((x) => x + 1); }, 2600);
    return () => window.clearInterval(t);
  }, [rs.length]);
  const cur = rs.length ? rs[at % rs.length]! : null;
  return (
    <>
      <section className="rf-stage rf-v2">
        <header>
          <div><h1>Refer traders</h1><p>Earn fee credits from everyone you bring, three tiers deep.</p></div>
          <div className="rf-v2__marks" aria-hidden="true">
            <span><i className="is-d" /></span><span><svg viewBox="0 0 20 20"><path d="M10 4 17 16H3z" /></svg></span><span><i /></span>
            <b><BrandMark size={22} /></b>
          </div>
        </header>
        <div className="rf-v2__mid">
          <strong key={cur ? cur.wallet : 'none'} className={cur ? 'pos' : undefined}>{cur ? (cur.earnedUsd > 0 ? `+${credit(cur.earnedUsd)}` : credit(0)) : pct(TIER_SHARES[0])}</strong>
          <small>{cur ? <>credits from {cur.wallet} <span className={`rf-tier is-${cur.tier}`}>T{cur.tier}</span></> : 'of the ValueDesk fees they pay'}</small>
          <div className="rf-v2__row">
            <span className="rf-v2__ticks" aria-hidden="true"><i /><i /><i /><i /></span>
            {Array.from({ length: n }, (_, i) => {
              let d = (i - (rs.length ? at % rs.length : 2)) % n;
              if (d > n / 2) d -= n; else if (d < -n / 2) d += n;
              const r = rs[i];
              const a = Math.abs(d);
              return (
                <button key={i} type="button" tabIndex={a > 2 || !r ? -1 : 0} aria-label={r ? `Show ${r.wallet}` : 'An open place'} aria-hidden={a > 2 || !r || undefined} disabled={!r} onClick={() => setAt(i)}
                  className={`rf-v2__p${d === 0 ? ' is-on' : ''}${r ? '' : ' is-open'}`}
                  style={{ transform: `translateX(${d * 92}px) translateY(${d === 0 ? -10 : 10}px) scale(${d === 0 ? 1.24 : 1})`, opacity: a === 0 ? 1 : a === 1 ? 0.75 : a === 2 ? 0.28 : 0 }}>
                  {r ? <Face seed={r.wallet} size={84} /> : d === 0 && v.address ? <Face seed={v.address} size={84} /> : <span className="rf-v2__empty"><Icon name="plus" size={22} /></span>}
                </button>
              );
            })}
          </div>
        </div>
        <div className="rf-v2__foot">
          <LinkButton l={l} label="Copy your link" className="is-dark" />
          {l.code && <LinkText l={l} />}
          <div className="rf-v2__more"><LinkMore l={l} /><How v={v} /></div>
          <LinkPills me={v.me} />
        </div>
      </section>
      <StatStrip me={v.me} loading={v.loading && !v.absent} />
      <WelcomeBar me={v.me} />
      <Tables v={v} />
      <Benefits />
    </>
  );
}

/* ---------------------------------------------------------------------------------------------- 3 steps ----- */

export function V3Steps({ v }: { v: RefView }) {
  const l = useLink(v);
  const c = v.me?.credits;
  return (
    <>
      <header className="rf-head">
        <h1>Bring traders.<br /><span>Pay less for life.</span></h1>
        <div className="rf-head__r"><LinkPills me={v.me} /><How v={v} /></div>
      </header>
      <div className="rf-v3">
        <article>
          <h2><i>1.</i> Share your link</h2>
          <p>It is your SoDEX code: one link for both.</p>
          <div className="rf-v3__art">
            <div className="rf-ticket">
              <div><span className="rf-tile"><Icon name="share" size={18} /></span><b>{pct(TIER_SHARES[0])}</b></div>
              <svg viewBox="0 0 20 160" preserveAspectRatio="none" aria-hidden="true"><path d="M4 0v56l12 14v50L4 134v26" /></svg>
              <dl>{TIER_SHARES.map((x, i) => <div key={x}><dt>{['Your traders', 'Their traders', 'One further'][i]}</dt><dd>{pct(x)}</dd></div>)}</dl>
            </div>
            <div className="rf-field is-float"><Icon name="share" size={16} /><LinkText l={l} /><LinkButton l={l} label="Copy" className="is-dark is-sm" /></div>
          </div>
        </article>
        <article>
          <h2><i>2.</i> They join</h2>
          <p>One free signature, nothing to pay.</p>
          <div className="rf-v3__art">
            <div className="rf-prev">
              <div className="rf-prev__pic"><Heat layout="card" rib={16} className="rf-heat" /><BrandMark size={58} /></div>
              <div className="rf-prev__t"><b>$0 ValueDesk fee on your first ${WELCOME_USD / 1000}K</b><span>valuedesk.so</span><Icon name="up" size={18} /></div>
            </div>
            <LinkMore l={l} />
          </div>
        </article>
        <article>
          <h2><i>3.</i> You earn</h2>
          <p>Credits pay your own ValueDesk fee.</p>
          <div className="rf-v3__art">
            <div className="rf-wal">
              <div className="rf-wal__h"><span className="rf-k">Credit balance</span>{c && <StatusPill size="sm" tone={c.paying ? 'positive' : 'neutral'} dot>{c.paying ? 'Paying your fees' : c.balanceUsd > 0 ? 'Collecting' : 'Empty'}</StatusPill>}</div>
              <b className="rf-wal__v">{c ? usd2(c.balanceUsd) : DASH}</b>
              <dl>
                <div><dt>Earned</dt><dd className={c && c.earnedUsd > 0 ? 'pos' : undefined}>{c ? signedUsd(c.earnedUsd) : DASH}</dd></div>
                <div><dt>Spent on fees</dt><dd>{c ? usd2(c.spentUsd) : DASH}</dd></div>
                <div><dt>Your fee while it pays</dt><dd>{(CREDIT_FEE / 10).toFixed(1)} bp</dd></div>
              </dl>
            </div>
          </div>
        </article>
      </div>
      <StatStrip me={v.me} loading={v.loading && !v.absent} />
      <WelcomeBar me={v.me} />
      <Tables v={v} />
      <Benefits />
    </>
  );
}

/* ----------------------------------------------------------------------------------------------- 4 gift ----- */

/** A present in chrome with the V's green ribbon, its lid up and a coin coming out. */
function Gift() {
  const id = useId();
  const g = (k: string) => `url(#${id}${k})`;
  return (
    <svg className="rf-gift" viewBox="0 0 220 210" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}l`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fafaf8" /><stop offset="1" stopColor="#8d8d8a" /></linearGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a4a4a1" /><stop offset="1" stopColor="#3a3a39" /></linearGradient>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#c4c4c0" /></linearGradient>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5cf0c0" /><stop offset="1" stopColor="#00875f" /></linearGradient>
        <radialGradient id={`${id}i`}><stop offset="0" stopColor="#5cf0c0" stopOpacity="0.95" /><stop offset="0.6" stopColor="#00b481" stopOpacity="0.5" /><stop offset="1" stopColor="#00b481" stopOpacity="0" /></radialGradient>
      </defs>
      <ellipse cx="110" cy="198" rx="74" ry="9" fill="#000" opacity="0.45" />
      <path d="M44 104 110 130v66L52 170q-6-3-6-9z" fill={g('l')} />
      <path d="M176 104 110 130v66l58-26q6-3 6-9z" fill={g('r')} />
      <path d="M44 104 110 80l66 24-66 26z" fill="#0b1d17" />
      <ellipse cx="110" cy="104" rx="60" ry="22" fill={g('i')} />
      <path d="M68 113.500 86 120.500v65L68 177z" fill={g('g')} /><path d="M152 113.500 134 120.500v65L152 177z" fill={g('g')} opacity="0.75" />
      <g className="rf-gift__coin"><ellipse cx="112" cy="88" rx="23" ry="25" fill={g('r')} /><ellipse cx="109" cy="87" rx="22" ry="25" fill={g('t')} /><g transform="translate(95.500 75) scale(0.285)"><VBlocks fill="#1b1b1b" point="#00b481" /></g></g>
      <g className="rf-gift__lid">
        <path d="M36 66 118 34l70 32-74 30z" fill={g('t')} /><path d="M36 66v18l78 30V96z" fill={g('l')} /><path d="M188 66v18l-74 30V96z" fill={g('r')} />
        <path d="M70 52.700 89 45.300 160 78l-18 7z" fill={g('g')} /><path d="M151 50 134 42 62 75l19 8z" fill={g('g')} opacity="0.85" />
        <path d="M112 60C92 22 58 26 64 46c4 13 30 14 48 14z" fill={g('g')} /><path d="M112 60c14-40 52-40 50-18-2 14-32 18-50 18z" fill={g('g')} /><path d="M112 60C98 38 78 34 76 44c0 9 22 14 36 16zM112 60c10-22 34-28 38-18 1 10-24 16-38 18z" fill="#064d38" />
        <ellipse cx="112" cy="60" rx="9" ry="7" fill="#5cf0c0" />
      </g>
      {[[26, 60, 1], [196, 34, 1.2], [40, 140, 0.8], [204, 128, 0.7]].map(([x, y, s]) => <path key={x} className="rf-gift__sp" transform={`translate(${x} ${y}) scale(${s})`} d="M0-9 2.300-2.300 9 0 2.300 2.300 0 9-2.300 2.300-9 0-2.300-2.300z" fill="#f4f4f2" />)}
    </svg>
  );
}

export function V4Gift({ v }: { v: RefView }) {
  const l = useLink(v);
  const steps: Array<[string, string]> = [
    ['Share your invite', 'Send your link to a trader.'],
    ['They join ValueDesk', `One free signature; $0 ValueDesk fee on their first ${welcomeText()}.`],
    ['You earn', `${pct(TIER_SHARES[0])} of the ValueDesk fees they pay, as credits, for as long as they trade.`],
  ];
  return (
    <>
      <div className="rf-v4">
        <section className="rf-stage rf-v4__sheet">
          <span className="rf-v4__ribs" aria-hidden="true" />
          <Gift />
          <h1>Invite traders</h1>
          <p>They start at zero. You pay less.</p>
          <ol>{steps.map(([t, s], i) => <li key={t}><i aria-hidden="true">{i + 1}</i><div><b>{t}</b><small>{s}</small></div></li>)}</ol>
          <div className="rf-v4__link"><LinkText l={l} /></div>
          <LinkButton l={l} share className="is-green" icon="share" />
          <div className="rf-v1__foot"><LinkMore l={l} copy={l.canShare} /><How v={v} /></div>
        </section>
        <div className="rf-v4__side">
          <LinkPills me={v.me} />
          <StatStrip me={v.me} loading={v.loading && !v.absent} />
          <WelcomeBar me={v.me} />
          <Benefits />
        </div>
      </div>
      <Tables v={v} />
    </>
  );
}

/* ---------------------------------------------------------------------------------------------- 5 tiers ----- */

const COINS = [
  { name: 'TIER 1', hi: '#ffffff', mid: '#b9b9b6', lo: '#4a4a49', glow: '244 244 242', line: 'of the ValueDesk fees your traders pay' },
  { name: 'TIER 2', hi: '#c3d0f4', mid: '#5d78bd', lo: '#202d54', glow: '93 127 216', line: 'of the fees their traders pay' },
  { name: 'TIER 3', hi: '#e0b8f2', mid: '#8a3fa5', lo: '#2c0138', glow: '150 70 190', line: 'of the fees one level further' },
] as const;

function Coin({ c }: { c: (typeof COINS)[number] }) {
  const id = useId();
  return (
    <svg viewBox="0 0 240 240" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}a`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={c.hi} /><stop offset="0.35" stopColor={c.mid} /><stop offset="0.55" stopColor={c.hi} /><stop offset="1" stopColor={c.lo} /></linearGradient>
        <linearGradient id={`${id}b`} x1="1" y1="0" x2="0" y2="1"><stop offset="0" stopColor={c.mid} /><stop offset="1" stopColor={c.lo} /></linearGradient>
        <linearGradient id={`${id}v`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor={c.hi} /></linearGradient>
      </defs>
      <g transform="rotate(-18 120 120)">
        {[16, 12, 8, 4].map((x) => <ellipse key={x} cx={120 + x} cy="120" rx="92" ry="104" fill={c.lo} />)}
        <ellipse cx="136" cy="120" rx="92" ry="104" fill={`url(#${id}a)`} opacity="0.55" />
        <ellipse cx="116" cy="120" rx="92" ry="104" fill={`url(#${id}a)`} />
        <ellipse cx="116" cy="120" rx="79" ry="91" fill={`url(#${id}b)`} />
        <ellipse cx="116" cy="120" rx="79" ry="91" fill="none" stroke={c.hi} strokeOpacity="0.5" strokeWidth="1.500" />
        <g transform="translate(71 86) scale(0.95)"><g transform="translate(3 4)" opacity="0.45"><VBlocks fill="#000" point="#000" /></g><VBlocks fill={`url(#${id}v)`} point="#00b481" /></g>
      </g>
    </svg>
  );
}

export function V5Tiers({ v }: { v: RefView }) {
  const l = useLink(v);
  const [t, setT] = useState(0);
  const c = COINS[t]!;
  const me = v.me;
  const total = me ? me.referrals.reduce((x, r) => x + r.earnedUsd, 0) : 0;
  const mine = earnedOfTier(me, t + 1);
  const n = me ? me.stats.referred[t]! : null;
  const vol = (me?.referrals ?? []).filter((r) => r.tier === t + 1).reduce((x, r) => x + r.perpsUsd + r.spotUsd, 0);
  return (
    <>
      <section className="rf-stage rf-v5" style={{ '--glow': c.glow } as React.CSSProperties}>
        <p className="rf-v5__k">You earn three tiers deep</p>
        <h1 key={c.name}>{c.name}</h1>
        <div className="rf-v5__coins">
          <span className="rf-v5__glow" aria-hidden="true" />
          {COINS.map((x, i) => { const d = ((i - t + 4) % 3) - 1; return (
            <button key={x.name} type="button" className={i === t ? 'is-on' : ''} style={{ transform: `translateX(${d * 78}%) scale(${d ? 0.72 : 1})`, opacity: d ? 0.42 : 1, zIndex: i === t ? 2 : 1 }} aria-label={x.name} aria-pressed={i === t} onClick={() => setT(i)}><Coin c={x} /></button>
          ); })}
        </div>
        <div className="rf-v5__card">
          <b>{pct(TIER_SHARES[t]!)} <small>{c.line}</small></b>
          <div className="rf-v5__bar"><span><i style={{ width: `${total > 0 ? (mine / total) * 100 : 0}%` }} /></span><em>{me ? `${mine > 0 ? `+${credit(mine)}` : credit(0)} / ${credit(total)}` : DASH}</em></div>
          <p>{n === null ? 'Connect a wallet to see your tiers' : `${n} ${n === 1 ? 'trader' : 'traders'} · ${compact(vol)} volume`}</p>
        </div>
        <div className="rf-v5__dots" role="group" aria-label="Tier">{COINS.map((x, i) => <button key={x.name} type="button" className={i === t ? 'is-on' : ''} aria-label={x.name} onClick={() => setT(i)} />)}</div>
        <div className="rf-field"><Icon name="share" size={16} /><LinkText l={l} /><LinkButton l={l} /></div>
        <div className="rf-v1__foot"><LinkMore l={l} /><How v={v} /></div>
        <LinkPills me={me} />
      </section>
      <StatStrip me={me} loading={v.loading && !v.absent} />
      <WelcomeBar me={me} />
      <Benefits />
      <Tables v={v} />
    </>
  );
}
