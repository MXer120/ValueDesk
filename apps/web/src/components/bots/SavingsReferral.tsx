/**
 * Bots > Savings: referrals and fee credits in one card (owner 2026-11-15: "add a referral/fee credit element on the
 * savings page"). Credits pay the wallet's own ValueDesk builder fee on every product - futures, spot, copy trading and
 * bots (the server's fee programs, invites/service.ts programsFor) - so the card says so, with the link that earns them.
 * Every figure is the wallet's own from GET /api/vs/invites/me; the rates are the server's (sharesFor).
 */
import { CREDIT_FEE, sharesFor, type InviteMe } from '@sign/invites/claim';
import { DASH, fmtUsd } from '../../format';
import { notify } from '../../toast';
import { track } from '../../analytics/usage';
import { prefersNativeShare, shareNative } from '../../share/nativeShare';
import { inviteLink, inviteLinkShown, isVipMe, useOwnCode } from '../../invites/invites';
import { Button, Panel, ProgressBar, Shell, ShellHeader, StatusPill } from './kit/kit';

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

export function SavingsReferral({ address, me, onOpen }: { address: string; me: InviteMe | null; onOpen: () => void }) {
  const own = useOwnCode(address);
  const code = own.state === 'ok' ? own.code : null;
  const c = me?.credits ?? null;
  const w = me?.welcome?.active ? me.welcome : null;
  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(inviteLink(code));
      notify('ok', 'Link copied.');
      track('invite.copy', { how: 'savings' });
    } catch {
      notify('warn', 'This browser did not allow copying. Open Referrals to copy the link.');
    }
  };
  /* A phone: its share sheet (share/nativeShare.ts) first; refused or missing, the link is copied. */
  const phone = prefersNativeShare();
  const share = async () => {
    if (!code) return;
    const r = await shareNative({ url: inviteLink(code), text: 'Trade on ValueDesk with my link.' });
    if (r === 'shared') track('invite.copy', { how: 'savings-share' });
    else if (r === 'failed' || r === 'unsupported') void copy();
  };
  const now = w ? { fee: '0 bp', words: 'Welcome' } : c?.paying ? { fee: `${CREDIT_FEE / 10} bp`, words: 'Credits pay the rest' } : null;
  return (
    <Shell className="bots-listcard">
      <ShellHeader icon="star" title="Referrals and fee credits" subtitle="Credits pay your ValueDesk fee on everything: futures, spot, copy trading and bots" />
      <Panel className="sv-ref">
        <div className="sv-ref__link">
          <span className="sv-ref__k">Your link</span>
          <code>{code ? inviteLinkShown(code) : own.state === 'loading' ? 'Reading your SoDEX code…' : own.state === 'none' ? 'Your link appears once this wallet has a SoDEX account' : DASH}</code>
          <span className="sv-ref__act">
            {phone && <Button variant="primary" size="sm" icon="share" disabled={!code} onClick={() => void share()}>Share</Button>}
            <Button variant={phone ? 'secondary' : 'primary'} size="sm" disabled={!code} onClick={() => void copy()}>Copy link</Button>
            <Button variant="secondary" size="sm" onClick={onOpen}>Referrals</Button>
          </span>
        </div>
        <div className="sv-ref__rates" aria-label="What you earn">
          {sharesFor(isVipMe(me)).map((r, i) => (
            <span key={i} className="sv-ref__rate"><span className={`sv-ref__tier is-${i + 1}`}>T{i + 1}</span><b>{pct(r)}</b><small>{i === 0 ? 'of what your referrals pay' : i === 1 ? 'of what theirs pay' : 'one level further'}</small></span>
          ))}
        </div>
        <div className="bots-rc__tiles sv-ref__tiles">
          <div className="bots-rc__tile"><span>Credit balance</span><b className={c && c.balanceUsd > 0 ? 'pos' : ''}>{c ? fmtUsd(c.balanceUsd, 2) : DASH}</b></div>
          <div className="bots-rc__tile"><span>Earned from referrals</span><b>{c ? fmtUsd(c.earnedUsd, 2) : DASH}</b></div>
          <div className="bots-rc__tile"><span>Referred</span><b>{me ? me.stats.referred.reduce((x, y) => x + y, 0) : DASH}</b></div>
          <div className="bots-rc__tile"><span>Your ValueDesk fee now</span><b>{now ? now.fee : 'Your tier'}</b></div>
        </div>
        {me?.vipUntil && <StatusPill size="sm" icon="star" className="vip-pill">VIP fee until {new Date(me.vipUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</StatusPill>}
        {w && (
          <div className="sv-ref__welcome">
            <span>Welcome: no ValueDesk fee until {fmtUsd(w.limitUsd, 0)} of volume · {fmtUsd(w.leftUsd, 0)} left</span>
            <ProgressBar value={w.usedUsd} max={w.limitUsd} tone="positive" size="sm" label="Welcome volume used" />
          </div>
        )}
        <p className="sv-ref__fine">Credits are never paid out: they lower your own fee to {CREDIT_FEE / 10} bp while they last, and switch on by themselves.</p>
      </Panel>
    </Shell>
  );
}
