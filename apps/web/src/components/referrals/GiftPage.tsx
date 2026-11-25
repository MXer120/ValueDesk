/**
 * The Referrals page (owner 2026-11-25: "Gift is the best"): the present on its stage with the link; "How it works"
 * opens the three steps above it; under it the credit card, the earnings and the traders on one ground. Drawings carry
 * no figures but the programme's constants; every other figure is the wallet's own.
 *
 * A VIP (isVipMe) earns the VIP shares and sees them, the credit card and the V's point in gold. What only a VIP's
 * code gives is greyed with a lock until this wallet's code gives it.
 */
import { useEffect, useId, useMemo, useState, type CSSProperties } from 'react';
import { CREDIT_FEE, REFERRED_START_USD, VIP_CODE_DAYS, VIP_TIER_SHARES, WELCOME_CAP, WELCOME_CAP_DAYS, sharesFor, type InviteMe } from '@sign/invites/claim';
import { DASH, fmtUsd } from '../../format';
import { isVipMe } from '../../invites/invites';
import { WE_GET, YOU_GET } from '../../onboarding/referralRules';
import { BrandMark } from '../BrandMark';
import { Icon, RollingNumber, Segmented, Skeleton } from '../bots/kit/kit';
import { CreditCalendar } from './CreditCalendar';
import { EarnChart } from './EarnChart';
import { Gift } from './Gift';
import { Face, History, LinkButton, LinkIcons, LinkText, Missing, ReferralTable, compact, credit, day, pct, referredOf, signedUsd, usd2, useLink, welcomeText, type RefView } from './parts';

const payingText = (me: InviteMe) => (me.credits.paying ? 'Paying your fees now' : me.credits.balanceUsd > 0 ? 'Collecting' : 'Nothing to spend yet');

const Lock = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="7" width="10" height="6.500" rx="1.800" /><path d="M5.200 7V5a2.800 2.800 0 0 1 5.600 0v2" /></svg>
);

/* ------------------------------------------------------------------------------------- how it works ----- */

/** The programme's values, all of them, from the shared rules: the terms name this page for them. */
function Steps({ me, vip, onClose }: { me: InviteMe | null; vip: boolean; onClose: () => void }) {
  const c = me?.credits;
  const rates = sharesFor(vip);
  const gold = vip ? 'vip-text' : undefined;
  const open = me?.vipCode === true;
  const sources = [...new Map([...YOU_GET.slice(0, 1), ...WE_GET].map((b) => [b.source.url, b.source])).values()];
  return (
    <section className="rf-steps" aria-label="How referrals work">
      <button type="button" className="rf-steps__x" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button>
      <article>
        <h2><i>1</i>Share your link</h2>
        <p>Your SoDEX code, one link for both.</p>
        <div className="rf-steps__art">
          <div className="rf-pass">
            <div className="rf-pass__l"><BrandMark size={30} /><b className={gold}>{pct(rates[0])}</b><small>of their fees</small></div>
            <svg viewBox="0 0 20 160" preserveAspectRatio="none" aria-hidden="true"><path d="M4 0v56l12 14v50L4 134v26" /></svg>
            <dl>{['Your traders', 'Their traders', 'One further'].map((t, i) => <div key={t}><dt><span className="rf-t">T{i + 1}</span>{t}</dt><dd className={gold}>{pct(rates[i]!)}</dd></div>)}</dl>
          </div>
          <p className="rf-vipnote">{vip ? <span className="vip-text">Your VIP rates</span> : <><Lock />VIP earns {VIP_TIER_SHARES.map(pct).join(' · ')}</>}</p>
        </div>
      </article>
      <article>
        <h2><i>2</i>They join</h2>
        <p>One free signature. Their first trades are on us.</p>
        <div className="rf-steps__art">
          <div className="rf-pass">
            <div className="rf-pass__l"><Icon name="bolt" size={28} /><b>$0</b><small>their fee</small></div>
            <svg viewBox="0 0 20 160" preserveAspectRatio="none" aria-hidden="true"><path d="M4 0v56l12 14v50L4 134v26" /></svg>
            <ul>
              <li className="rf-ok"><Icon name="check" size={16} />First {welcomeText()}</li>
              <li className="rf-ok"><Icon name="check" size={16} />${REFERRED_START_USD / 1000}K fee tier at once</li>
              <li className={open ? 'rf-ok is-vip' : 'rf-ok is-locked'}>{open ? <Icon name="star" size={16} /> : <Lock />}<span className={open ? 'vip-text' : undefined}>VIP {VIP_CODE_DAYS} days{open ? '' : ", with a VIP's code"}</span></li>
            </ul>
          </div>
          <p className="rf-vipnote">{open ? <span className="vip-text">Unlocked by your code</span> : ''}</p>
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
            <div className="rf-meter__t"><span className={c?.paying ? 'is-on' : undefined}>{me ? payingText(me) : 'No credits yet'}</span><b>{(CREDIT_FEE / 10).toFixed(1)} bp</b><small>your fee while they last</small></div>
          </div>
        </div>
      </article>
      <p className="rf-steps__fine">
        <span>{WELCOME_CAP} welcomes per link in {WELCOME_CAP_DAYS} days</span>
        <span>Credits are never cash, for as long as they trade</span>
        <span>On SoDEX: they get {YOU_GET[0]!.title}, you get a {WE_GET.map((b) => b.title).join(' and a ')}</span>
        {sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">{s.label.replace(/^SoDEX (docs, )?/, '')}</a>)}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------------------ earnings and traders ----- */

/** Chart or calendar: kept per browser. */
const VIEW_KEY = 'vs.referrals.credits';
function readView(): 'chart' | 'calendar' {
  try { return localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'chart'; } catch { return 'chart'; }
}

function Earnings({ v }: { v: RefView }) {
  const c = v.me?.credits;
  const [view, setView] = useState<'chart' | 'calendar'>(readView);
  const pick = (x: 'chart' | 'calendar') => { setView(x); try { localStorage.setItem(VIEW_KEY, x); } catch { /* this tab only */ } };
  return (
    <section className="rf-earn" aria-label="Credits earned">
      <div className="rf-earn__h">
        <div><span className="rf-k">Credits earned</span>{v.loading && v.address ? <Skeleton className="rf-skel-big" /> : <b className={c && c.earnedUsd > 0 ? 'pos' : undefined}>{c ? <RollingNumber value={signedUsd(c.earnedUsd)} /> : DASH}</b>}</div>
        <Segmented<'chart' | 'calendar'> label="Credits as" value={view} onChange={pick} options={[{ value: 'chart', label: 'Chart' }, { value: 'calendar', label: 'Calendar' }]} />
      </div>
      {view === 'chart' ? <EarnChart me={v.me} /> : <CreditCalendar me={v.me} />}
    </section>
  );
}

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

/** The traders as a short list: who, on which tier, what they earned you. */
function Traders({ v }: { v: RefView }) {
  const [tab, setTab] = useState<'traders' | 'history'>('traders');
  const [all, setAll] = useState(false);
  const rows = useMemo(() => [...(v.me?.referrals ?? [])].sort((a, b) => b.earnedUsd - a.earnedUsd), [v.me]);
  const n = referredOf(v.me);
  const phone = usePhone();
  return (
    <section className="rf-tr" aria-label="Your traders">
      <div className="rf-tr__h">
        <Segmented<'traders' | 'history'> label="List" value={tab} onChange={setTab} options={[{ value: 'traders', label: `Your traders${n === null ? '' : ` (${n})`}` }, { value: 'history', label: 'Credit history' }]} />
        {tab === 'traders' && rows.length > (phone ? 6 : 0) && <button type="button" className="rf-text" onClick={() => setAll(!all)}>{all ? 'Show less' : phone ? 'Show all' : 'Details'}</button>}
      </div>
      {v.absent || (v.error && !v.me) ? <Missing v={v} />
        : tab === 'history' ? <History me={v.me} loading={v.loading && !!v.address} />
        : all && !phone ? <ReferralTable rows={v.me?.referrals ?? null} />
        : rows.length ? (
          <ul className="rf-list">
            {(all ? rows : rows.slice(0, 6)).map((r) => (
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

/* ----------------------------------------------------------------------------------------- the page ----- */

export function GiftPage({ v }: { v: RefView }) {
  const l = useLink(v);
  const id = useId();
  const [how, setHow] = useState(false);
  const me = v.me;
  const vip = isVipMe(me);
  const rates = sharesFor(vip);
  const gold = vip ? 'vip-text' : undefined;
  return (
    <>
      <div className={how ? 'rf-how is-open' : 'rf-how'} id={id}><div><Steps me={me} vip={vip} onClose={() => setHow(false)} /></div></div>
      <section className="rf-dark rf-g">
        <span className="rf-g__ribs" aria-hidden="true" /><span className="rf-g__light" aria-hidden="true" />
        <div className="rf-g__t">
          <div className="rf-g__k">
            <h1>Referrals</h1>
            <button type="button" className="rf-howbtn" aria-expanded={how} aria-controls={id} onClick={(e) => { setHow(!how); if (!how) e.currentTarget.closest('.rf-page')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>
              How it works<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.600" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
            </button>
          </div>
          <h2>They start with 0 fees.<br />You earn <span className={gold}>{pct(rates[0])}</span> after.</h2>
          <div className="rf-bar is-big">
            <div className="rf-bar__in"><LinkText l={l} /><LinkButton l={l} label="Copy" /></div>
            <LinkIcons l={l} />
          </div>
        </div>
        <div className="rf-g__art"><Gift /></div>
        <ol className="rf-g__steps">
          <li><b>$0</b><span>their ValueDesk fee on the first {welcomeText()}</span></li>
          <li><b className={gold}>{pct(rates[0])}</b><span>of the fees they pay after, yours as credits</span></li>
          <li><b className={gold}>{pct(rates[1])} + {pct(rates[2])}</b><span>from the two tiers behind them</span></li>
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
            <div><dt>Volume referred</dt><dd>{me ? compact(me.stats.perpsUsd + me.stats.spotUsd) : DASH}</dd></div>
            {me?.welcome?.active && <div><dt>Left at $0 ValueDesk fee</dt><dd>{fmtUsd(me.welcome.leftUsd, 0)}</dd></div>}
            {me?.vipUntil && <div><dt className="vip-text">VIP fee until</dt><dd className="vip-text">{day(me.vipUntil)}</dd></div>}
            {me?.vipCode && <div><dt className="vip-text">Your link gives</dt><dd className="vip-text">{VIP_CODE_DAYS} days of VIP fee</dd></div>}
            {me?.joined && <div><dt>Referred by</dt><dd>{me.joined.inviter}</dd></div>}
          </dl>
        </div>
        <Earnings v={v} />
        <Traders v={v} />
      </div>
    </>
  );
}
