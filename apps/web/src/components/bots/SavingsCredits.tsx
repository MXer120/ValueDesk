/**
 * Savings > Fee credits and invites (owner 2026-11-14: "Introduce fee credits, and each invite that trades gets you
 * builder fee credits"): the balance and what it pays, the wallet's invite link to copy or share, and the wallets it
 * invited (shortened by the server), each with whether it trades yet and the credit it earned.
 */
import { useEffect } from 'react';
import { CREDIT_MONTHS, CREDIT_SHARE, WELCOME_USD } from '@sign/invites/claim';
import { track } from '../../analytics/usage';
import { notify } from '../../toast';
import { fmtUsd } from '../../format';
import { inviteLink, useInviteMe } from '../../invites/invites';
import { Button, EmptyState, Panel, Shell, ShellHeader, StatusPill } from './kit/kit';

const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const usd2 = (x: number) => `${x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}`;
const SEEN = (a: string) => `vd.credits.seen.${a}`;

export function SavingsCredits({ address }: { address: string }) {
  const me = useInviteMe(address);
  const link = me?.code ? inviteLink(me.code) : null;
  const c = me?.credits ?? null;
  // New credit since the wallet last looked: counted once (analytics, after consent only).
  useEffect(() => {
    if (!c) return;
    try {
      const was = Number(localStorage.getItem(SEEN(address)) ?? '0');
      if (c.earnedUsd > was + 1e-9) {
        if (was > 0 || c.earnedUsd > 0) track('credits.earn', {});
        localStorage.setItem(SEEN(address), String(c.earnedUsd));
      }
    } catch { /* private mode */ }
  }, [address, c]);
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      notify('ok', 'Invite link copied.');
      track('invite.copy', { how: 'copy' });
    } catch {
      notify('warn', 'This browser did not allow copying. Select the link and copy it.');
    }
  };
  const post = () => {
    if (!link) return;
    const text = `Trade on ValueDesk with my invite: ValueDesk's fee is 0.1 bp on your first $${WELCOME_USD.toLocaleString('en-US')}.`;
    window.open(`https://x.com/intent/post?${new URLSearchParams({ text, url: link }).toString()}`, '_blank', 'noopener,noreferrer');
    track('invite.copy', { how: 'x' });
  };
  const share = async () => {
    if (!link || typeof navigator.share !== 'function') return;
    try {
      await navigator.share({ url: link, text: 'Trade on ValueDesk with my invite.' });
      track('invite.copy', { how: 'share' });
    } catch { /* closed */ }
  };
  return (
    <Shell className="bots-listcard sv-credits">
      <ShellHeader
        icon="coins"
        title="Fee credits and invites"
        subtitle={`${Math.round(CREDIT_SHARE * 100)}% of the ValueDesk fees each wallet you invite pays, for ${CREDIT_MONTHS} months, pays your own ValueDesk fees`}
        aside={c ? <StatusPill tone={c.paying ? 'positive' : 'neutral'} dot>{c.paying ? 'Paying your fees' : c.balanceUsd > 0 ? 'Collecting' : 'No credits yet'}</StatusPill> : undefined}
      />
      <div className="sv-credits__grid">
        <Panel className="sv-credits__bal">
          <span className="sv-k">Balance</span>
          <b className={`sv-big${c && c.balanceUsd < 0 ? ' neg' : ''}`}>{c ? usd2(c.balanceUsd) : '—'}</b>
          <div className="sv-credits__kv">
            <span><small>Earned</small><b>{c ? usd2(c.earnedUsd) : '—'}</b></span>
            <span><small>Spent on fees</small><b>{c ? usd2(c.spentUsd) : '—'}</b></span>
            <span><small>Invited</small><b>{me ? me.invitees.length : '—'}</b></span>
          </div>
          <p className="sv-fine">While you have credits, your ValueDesk fee is 0.1 bp on every product and the credits pay the rest of it. SoDEX's fees are not ValueDesk's to pay. Credits are never paid out.</p>
        </Panel>
        <Panel className="sv-credits__link">
          <span className="sv-k">Your invite link</span>
          <div className="sv-linkrow">
            <code className="sv-link" title={link ?? undefined}>{link ? link.replace(/^https:\/\//, '') : 'Making your link…'}</code>
          </div>
          <div className="sv-credits__acts">
            <Button variant="primary" icon="layers" disabled={!link} onClick={() => void copy()}>Copy link</Button>
            <Button variant="secondary" disabled={!link} onClick={post}>Post on X</Button>
            {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && <Button variant="secondary" icon="share" disabled={!link} onClick={() => void share()}>Share</Button>}
          </div>
          <ul className="sv-how">
            <li><b>They get</b> ValueDesk's fee at 0.1 bp on their first ${WELCOME_USD.toLocaleString('en-US')} of volume.</li>
            <li><b>You get</b> {Math.round(CREDIT_SHARE * 100)}% of the ValueDesk fees they pay after that, for {CREDIT_MONTHS} months, as credits.</li>
            <li><b>Who can join</b> a wallet that has not traded on ValueDesk yet; it signs once.</li>
          </ul>
          {me?.joined && <p className="sv-fine">You joined with an invite on {day(me.joined.at)}{me.welcome?.active ? `: 0.1 bp on your next ${fmtUsd(me.welcome.leftUsd, 0)}.` : '.'}</p>}
        </Panel>
      </div>
      <Panel className="sv-invitees">
        {!me ? (
          <EmptyState compact icon="robot" title="Reading your invites…" />
        ) : !me.invitees.length ? (
          <EmptyState compact icon="share" title="No one has joined with your link yet" description="Each wallet that joins shows here, with the credit it earned you." />
        ) : (
          <table className="bots-table sv-inv">
            <thead><tr><th>Wallet</th><th>Joined</th><th>Status</th><th className="right">Credit earned</th><th className="right">Earns until</th></tr></thead>
            <tbody>
              {me.invitees.map((i) => (
                <tr key={`${i.wallet}${i.at}`}>
                  <td className="num">{i.wallet}</td>
                  <td className="dim">{day(i.at)}</td>
                  <td><StatusPill size="sm" tone={i.trading ? 'positive' : 'neutral'} dot>{i.trading ? 'Trading' : 'Joined'}</StatusPill></td>
                  <td className="right num">{usd2(i.earnedUsd)}</td>
                  <td className="right dim">{day(i.until)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </Shell>
  );
}
