/**
 * Bots > Savings: referrals and fee credits in one card (owner 2026-11-15: "add a referral/fee credit element on the
 * savings page"). Credits pay the wallet's own ValueDesk builder fee on every product - futures, spot, copy trading and
 * bots (the server's fee programs, invites/service.ts programsFor) - so the card says so, with the link that earns them.
 * Every figure is the wallet's own from GET /api/vs/invites/me. Compact since 2026-11-27, beside the VIP card; the rates
 * and the rest are on the Referrals page.
 */
import { CREDIT_FEE, type InviteMe } from '@sign/invites/claim';
import { DASH, fmtUsd } from '../../format';
import { notify } from '../../toast';
import { track } from '../../analytics/usage';
import { prefersNativeShare, shareNative } from '../../share/nativeShare';
import { inviteLink, inviteLinkShown, useOwnCode } from '../../invites/invites';
import { Button, Icon, Panel, ProgressBar, Shell, ShellHeader, StatusPill } from './kit/kit';

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
  const now = w ? '0 bp' : c?.paying ? `${CREDIT_FEE / 10} bp` : null;
  // Compact (owner 2026-11-27: "make it smaller ... so its side by side with vip, details on referral page"): the link,
  // the wallet's credits and its fee now; the rates, who was referred and the history are the Referrals page's.
  return (
    <Shell className="bots-listcard sv-refcard">
      <ShellHeader icon="star" title="Referrals and fee credits" subtitle="Credits pay your ValueDesk fee on everything" />
      <Panel className="sv-ref">
        <div className="sv-ref__link">
          <code title={code ? inviteLinkShown(code) : undefined}>{code ? inviteLinkShown(code) : own.state === 'loading' ? 'Reading your SoDEX code…' : own.state === 'none' ? 'Your link appears once this wallet has a SoDEX account' : DASH}</code>
          {phone && <Button variant="primary" size="sm" icon="share" disabled={!code} onClick={() => void share()}>Share</Button>}
          <Button variant={phone ? 'secondary' : 'primary'} size="sm" disabled={!code} onClick={() => void copy()}>Copy link</Button>
        </div>
        <dl className="sv-ref__figs">
          <div><dt>Credit balance</dt><dd className={c && c.balanceUsd > 0 ? 'pos' : undefined}>{c ? fmtUsd(c.balanceUsd, 2) : DASH}</dd></div>
          <div><dt>Earned</dt><dd>{c ? fmtUsd(c.earnedUsd, 2) : DASH}</dd></div>
          <div><dt>Your fee now</dt><dd>{now ?? 'Your tier'}</dd></div>
        </dl>
        {w && (
          <div className="sv-ref__welcome">
            <span>Welcome: no ValueDesk fee until {fmtUsd(w.limitUsd, 0)} · {fmtUsd(w.leftUsd, 0)} left</span>
            <ProgressBar value={w.usedUsd} max={w.limitUsd} tone="positive" size="sm" label="Welcome volume used" />
          </div>
        )}
        <div className="sv-ref__foot">
          {me?.vipUntil ? <StatusPill size="sm" icon="star" className="vip-pill">VIP fee until {new Date(me.vipUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</StatusPill> : <span>Rates, referred wallets and history</span>}
          <button type="button" className="sv-ref__more" onClick={onOpen}>Referrals<Icon name="arrowRight" size={13} /></button>
        </div>
      </Panel>
    </Shell>
  );
}
