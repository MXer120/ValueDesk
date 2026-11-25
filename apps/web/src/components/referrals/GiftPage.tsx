/**
 * The Referrals page (owner 2026-11-25: "Gift is the best"): the present on its stage with the link; "How it works"
 * opens the three steps above it; under it the credit card, the earnings and the traders on one ground. Drawings carry
 * no figures but the programme's constants; every other figure is the wallet's own.
 *
 * A VIP (isVipMe) earns the VIP shares and sees them, the credit card and the V's point in gold. What only a VIP's
 * code gives is greyed with a lock until this wallet's code gives it.
 */
import { useId, useState, type CSSProperties } from 'react';
import { CREDIT_FEE, REFERRED_START_USD, VIP_CODE_DAYS, VIP_TIER_SHARES, sharesFor, type InviteMe } from '@sign/invites/claim';
import { DASH, fmtUsd } from '../../format';
import { localize } from '../../numStyle';
import { isVipMe } from '../../invites/invites';
import { WE_GET, YOU_GET } from '../../onboarding/referralRules';
import type { SodexRewards } from '../../invites/useSodexRewards';
import { floorCents } from '../../invites/sodexRewards';
import type { Eip1193Provider } from '../../wallet';
import { BrandMark } from '../BrandMark';
import { Icon } from '../bots/kit/kit';
import { ClaimField } from './Claim';
import { Gift } from './Gift';
import { RewardsPanel, Traders } from './Rewards';
import { UseCodeButton } from './UseCode';
import { LinkButton, LinkIcons, LinkText, compact, credit, day, pct, useLink, usd2, welcomeText, type RefView } from './parts';

const payingText = (me: InviteMe) => (me.credits.paying ? 'Paying your fees now' : me.credits.balanceUsd > 0 ? 'Collecting' : 'Nothing to spend yet');

const Lock = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="7" width="10" height="6.500" rx="1.800" /><path d="M5.200 7V5a2.800 2.800 0 0 1 5.600 0v2" /></svg>
);

/* ------------------------------------------------------------------------------------- how it works ----- */

/** The programme's values, all of them, from the shared rules: the terms name this page for them. */
function Steps({ me, vip }: { me: InviteMe | null; vip: boolean }) {
  const c = me?.credits;
  const rates = sharesFor(vip);
  const gold = vip ? 'vip-text' : undefined;
  const open = me?.vipCode === true;
  return (
    <section className="rf-steps" aria-label="How referrals work">
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
        <p>Claim every Tuesday. Credits cover your own fee.</p>
        <div className="rf-steps__art">
          <div className="rf-meter">
            <div className="rf-meter__ring" style={{ '--p': c && c.earnedUsd > 0 ? Math.min(1, Math.max(0, c.balanceUsd / c.earnedUsd)) : 0 } as CSSProperties}>
              <svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="52" pathLength="1" /><circle className="is-on" cx="60" cy="60" r="52" pathLength="1" /></svg>
              <div><b>{c ? usd2(c.balanceUsd) : DASH}</b><small>to spend</small></div>
            </div>
            <div className="rf-meter__t"><span className={c?.paying ? 'is-on' : undefined}>{me ? payingText(me) : 'No credits yet'}</span><b>{localize((CREDIT_FEE / 10).toFixed(1))} bp</b><small>your fee while they last</small></div>
          </div>
        </div>
      </article>
    </section>
  );
}

/** One benefit in the bar under the present; SoDEX's own carry its mark and link to where SoDEX says so. */
function Pay({ v, t, sodex, gold }: { v: string; t: string; sodex?: string; gold?: boolean }) {
  return (
    <li>
      <b className={gold ? 'vip-text' : undefined}>{v}</b>
      {sodex ? <a href={sodex} target="_blank" rel="noopener noreferrer" title="From SoDEX: see where it says so"><img src="/logos/brand/sodex.svg" width="15" height="15" alt="SoDEX" />{t}</a> : <span>{t}</span>}
    </li>
  );
}

/* ----------------------------------------------------------------------------------------- the page ----- */

export function GiftPage({ v, s, provider }: { v: RefView; s: SodexRewards; provider: Eip1193Provider | null }) {
  const l = useLink(v);
  const id = useId();
  const [how, setHow] = useState(false);
  const me = v.me;
  const vip = isVipMe(me);
  const rates = sharesFor(vip);
  const gold = vip ? 'vip-text' : undefined;
  return (
    <>
      <section className={how ? 'rf-dark rf-g is-how' : 'rf-dark rf-g'}>
        <span className="rf-g__ribs" aria-hidden="true" /><span className="rf-g__light" aria-hidden="true" />
        <div className="rf-g__k">
          <h1>Referrals</h1>
          <button type="button" className="rf-howbtn" aria-expanded={how} aria-controls={id} onClick={() => setHow(!how)}>
            {how ? 'Close' : 'How it works'}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.600" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={how ? 'm4.500 4.500 7 7m0-7-7 7' : 'm4 6 4 4 4-4'} /></svg>
          </button>
          {!v.sample && <UseCodeButton address={v.address} provider={provider} me={me} />}
        </div>
        {/* Both stay in the one cell, so the card keeps its height when the steps take the present's place. */}
        <div className="rf-g__body">
          <div className="rf-g__front" aria-hidden={how} {...(how ? { inert: '' } : {})}>
            <div className="rf-g__t">
              <h2>They start with 0 fees.<br />You earn <span className={gold}>{pct(rates[0])}</span> after.</h2>
              <div className="rf-bar is-big">
                <div className="rf-bar__in"><LinkText l={l} /><LinkButton l={l} label="Copy" /></div>
                <LinkIcons l={l} />
              </div>
            </div>
            <div className="rf-g__art"><Gift /></div>
          </div>
          <div className="rf-g__steps" id={id} aria-hidden={!how} {...(how ? {} : { inert: '' })}><Steps me={me} vip={vip} /></div>
        </div>
        <div className="rf-pays">
          <div className="rf-pays__g is-you">
            <h3>You get</h3>
            <ul>
              <li><b className={gold}>{rates.map(pct).join(' · ')}</b><span>Fee rebate, tier 1 · 2 · 3</span></li>
              <Pay v="10%" t="SoDEX fee rebate" sodex={WE_GET[1]!.source.url} />
              <Pay v="25%" t="SoPoints rebate" sodex={WE_GET[0]!.source.url} />
            </ul>
          </div>
          <div className="rf-pays__g">
            <h3>They get</h3>
            <ul>
              <Pay v="$0" t={`Fees, first ${welcomeText()}`} />
              <Pay v="+5%" t="SoPoints" sodex={YOU_GET[0]!.source.url} />
            </ul>
          </div>
        </div>
      </section>
      <ClaimField v={v} s={s} provider={provider} />
      <div className="rf-g__desk">
        <div className="rf-g__cr">
          <section className="rf-dark rf-cc" aria-label="Your rewards">
            <span className="rf-cc__sheen" aria-hidden="true" />
            <div><BrandMark size={34} /><em>Rewards</em></div>
            <dl>
              <div className="is-usdc" title="USDC you can claim from SoDEX now"><dt>USDC to claim</dt><dd>{s.claimableUsd !== null ? usd2(floorCents(s.claimableUsd)) : DASH}</dd></div>
              <div className="is-credit" title="Fee credits that pay your ValueDesk fees"><dt>Fee credits</dt><dd>{me ? usd2(me.credits.balanceUsd) : DASH}</dd></div>
            </dl>
            <div><span>{me ? payingText(me) : 'Connect a wallet'}</span><span>{v.address && !v.sample ? `${v.address.slice(0, 6)}…${v.address.slice(-4)}` : '0x•••• ••••'}</span></div>
          </section>
          <dl className="rf-kv">
            <div><dt>Your fee while they last</dt><dd>{localize((CREDIT_FEE / 10).toFixed(1))} bp</dd></div>
            <div><dt>Credits spent on fees</dt><dd>{me ? usd2(me.credits.spentUsd) : DASH}</dd></div>
            <div><dt>USDC claimed from SoDEX</dt><dd>{s.claimedUsd !== null ? usd2(s.claimedUsd) : DASH}</dd></div>
            {me?.invites ? <div title="Joins with your code this week. SoDEX's limit, reset every Monday 00:00 UTC"><dt>Joins this week</dt><dd>{me.invites.week} of {me.invites.max}</dd></div>
              : s.stats && s.stats.weekInvitesMax !== null && s.stats.weekInvitesMax > 0 ? <div><dt>SoDEX invites this week</dt><dd>{s.stats.weekInvites} of {s.stats.weekInvitesMax}</dd></div> : null}
            <div><dt>Volume referred</dt><dd>{me ? compact(me.stats.perpsUsd + me.stats.spotUsd) : DASH}</dd></div>
            {me?.welcome?.active && <div><dt>Left at $0 ValueDesk fee</dt><dd>{fmtUsd(me.welcome.leftUsd, 0)}</dd></div>}
            {me?.vipUntil && <div><dt className="vip-text">VIP fee until</dt><dd className="vip-text">{day(me.vipUntil)}</dd></div>}
            {me?.vipCode && <div><dt className="vip-text">Your link gives</dt><dd className="vip-text">{VIP_CODE_DAYS} days of VIP fee</dd></div>}
            {me?.joined ? <div><dt>Referred by</dt><dd>{me.joined.inviter}</dd></div> : s.stats?.referredBy ? <div><dt>Referred by</dt><dd>{s.stats.referredBy}</dd></div> : null}
          </dl>
        </div>
        <RewardsPanel v={v} s={s} provider={provider} />
        <Traders v={v} s={s} />
      </div>
    </>
  );
}
