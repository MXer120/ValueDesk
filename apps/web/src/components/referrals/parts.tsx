/**
 * What every version of the Referrals page shares: the wallet's link and its actions, the figures, the tables, the
 * benefits and "How it works". Numbers carry the page; words stay to a line.
 */
import { useEffect, useMemo, useState } from 'react';
import { WELCOME_USD, type InviteMe, type InviteReferral } from '@sign/invites/claim';
import { DASH, fmtUsd } from '../../format';
import { localize } from '../../numStyle';
import { track } from '../../analytics/usage';
import { canShareNative, prefersNativeShare, shareNative } from '../../share/nativeShare';
import { notify } from '../../toast';
import { Identicon } from '../Identicon';
import { openConnectDialog } from '../account/connect';
import { Button, EmptyState, Icon, IconButton, Panel, Segmented, Skeleton, StatusPill, type IconName } from '../bots/kit/kit';
import { inviteLink, loadMe, loadOwnCode, useOwnCode } from '../../invites/invites';

const PAGE = 10;
/* Every figure in the reader's own number style (numStyle.ts), as the rest of the app. */
export const pct = (x: number) => localize(`${Number((x * 100).toFixed(1))}%`);
export const whole = (n: number) => localize(Math.round(n).toLocaleString('en-US'));
const grouped = (n: number, d: number) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const usd2 = (n: number) => localize(`${n < 0 ? '−' : ''}$${grouped(Math.abs(n), 2)}`);
/** +$396.32 for something earned, $0.00 for nothing (no plus on zero). */
export const signedUsd = (n: number) => (n > 0 ? `+${usd2(n)}` : usd2(n));
/** A credit: cents from a dollar on, else four places (a referral's first credits are fractions of a cent). */
export const credit = (n: number) => localize(`${n < 0 ? '−' : ''}$${grouped(Math.abs(n), Math.abs(n) >= 1 || n === 0 ? 2 : 4)}`);
/** $53.9M, $2.57M, $48.9K, $140. */
const cut = (x: number) => x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2);
export const compact = (n: number) => localize(n >= 1e9 ? `$${cut(n / 1e9)}B` : n >= 1e6 ? `$${cut(n / 1e6)}M` : n >= 1e3 ? `$${cut(n / 1e3)}K` : `$${n.toFixed(0)}`);
export const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export const welcomeText = () => fmtUsd(WELCOME_USD, 0);

/** What every version draws from. `me` null: no wallet, not read yet, or this server has no referrals. */
export interface RefView { address: string | null; me: InviteMe | null; loading: boolean; error: boolean; absent: boolean; sample: boolean }

/* --------------------------------------------------------------------- the link ----- */

export interface LinkState {
  state: 'connect' | 'loading' | 'ok' | 'none' | 'error';
  code: string | null;
  copy: () => Promise<void>; post: () => void; share: () => Promise<void>; retry: () => void;
  canShare: boolean; phone: boolean;
}

/** The wallet's link (its own SoDEX code) and what can be done with it. */
export function useLink(v: RefView): LinkState {
  const own = useOwnCode(v.sample ? null : v.address);
  const code = v.sample ? 'SAMPLE' : own.state === 'ok' && v.address ? own.code : null;
  const link = code ? inviteLink(code) : null;
  const text = `Trade on ValueDesk with my link: no ValueDesk fee on your first ${welcomeText()}.`;
  const copy = async () => {
    if (!link) return;
    if (v.sample) { notify('warn', 'Sample data: there is no link to copy.'); return; }
    try {
      await navigator.clipboard.writeText(link);
      notify('ok', 'Link copied.');
      track('invite.copy', { how: 'copy' });
    } catch {
      notify('warn', 'This browser did not allow copying. Select the link and copy it.');
    }
  };
  const post = () => {
    if (!link || v.sample) return;
    window.open(`https://x.com/intent/post?${new URLSearchParams({ text, url: link }).toString()}`, '_blank', 'noopener,noreferrer');
    track('invite.copy', { how: 'x' });
  };
  /* The phone's share sheet (share/nativeShare.ts): straight to WhatsApp or Telegram. Refused: copied instead. */
  const share = async () => {
    if (!link || v.sample) return;
    const r = await shareNative({ url: link, text });
    if (r === 'shared') track('invite.copy', { how: 'share' });
    else if (r === 'failed' || r === 'unsupported') void copy();
  };
  return {
    state: code ? 'ok' : !v.address ? 'connect' : own.state === 'ok' ? 'loading' : own.state,
    code, copy, post, share, retry: () => { if (v.address) void loadOwnCode(v.address); },
    canShare: canShareNative(), phone: prefersNativeShare(),
  };
}

/** The link as text, or why there is none. */
export function LinkText({ l }: { l: LinkState }) {
  if (l.code) return <span className="rf-linktext" title={`valuedesk.so/?ref=${l.code}`}><span>valuedesk.so/?ref=</span><b>{l.code}</b></span>;
  if (l.state === 'loading') return <Skeleton className="rf-linkskel" />;
  return <span className={`rf-linktext is-empty is-${l.state}`}>{l.state === 'connect' ? 'Connect a wallet to get your link' : l.state === 'none' ? 'Your link appears with your SoDEX account' : 'SoDEX did not answer'}</span>;
}

/** The main action: copy (`share`, or a phone: the share sheet), or the step before it. */
export function LinkButton({ l, label = 'Copy link', share, className, icon }: { l: LinkState; label?: string; share?: boolean; className?: string; icon?: IconName }) {
  const cls = `rf-cta${className ? ` ${className}` : ''}`;
  if (l.state === 'connect') return <button type="button" className={cls} onClick={() => void openConnectDialog()}>Connect wallet</button>;
  if (l.state === 'none') return <a className={cls} href="https://sodex.com" target="_blank" rel="noopener noreferrer">Open SoDEX</a>;
  if (l.state === 'error') return <button type="button" className={cls} onClick={l.retry}>Try again</button>;
  const sharing = (l.phone || share) && l.canShare;
  return (
    <button type="button" className={cls} disabled={!l.code} onClick={() => void (sharing ? l.share() : l.copy())}>
      {sharing ? 'Share' : label}{icon && <Icon name={sharing ? 'share' : icon} size={16} />}
    </button>
  );
}

/* --------------------------------------------------------------------- the tables ----- */

/** Post on X, the share sheet (a phone: copy), as icons. */
export function LinkIcons({ l }: { l: LinkState }) {
  if (!l.code) return null;
  return (
    <>
      <button type="button" className="rf-icon" aria-label="Post on X" title="Post on X" onClick={l.post}><svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M11.7 8.6 17.4 2h-1.8l-4.7 5.5L7.100 2H2.500l6 8.700L2.500 17.700h1.800l5.200-6.100 4.200 6.100h4.600zM5 3.400h1.500l9 13h-1.500z" /></svg></button>
      {l.phone ? <button type="button" className="rf-icon" aria-label="Copy link" title="Copy link" onClick={() => void l.copy()}><Icon name="layers" size={16} /></button>
        : l.canShare && <button type="button" className="rf-icon" aria-label="Share" title="Share" onClick={() => void l.share()}><Icon name="share" size={16} /></button>}
    </>
  );
}

/** Why the figures are missing, if they are. */
export function Missing({ v }: { v: RefView }) {
  if (v.absent) return <EmptyState compact icon="clock" title="Referral stats are not on this server yet" description="Your link works now; stats and credits show here once the server has them." />;
  if (v.error && !v.me && v.address) return <RetryState address={v.address} what="your referrals" />;
  return null;
}

type TierFilter = 'all' | '1' | '2' | '3';

export function ReferralTable({ rows }: { rows: InviteReferral[] | null }) {
  const [tier, setTier] = useState<TierFilter>('all');
  const [page, setPage] = useState(0);
  const shown = useMemo(() => (rows ?? []).filter((r) => tier === 'all' || String(r.tier) === tier), [rows, tier]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  useEffect(() => setPage(0), [tier]);
  const counts = [1, 2, 3].map((t) => (rows ?? []).filter((r) => r.tier === t).length);
  return (
    <Panel className="bots-listpanel rf-table">
      <div className="bots-toolbar">
        <Segmented
          label="Tier"
          value={tier}
          onChange={setTier}
          options={[
            { value: 'all', label: `All${rows ? ` (${rows.length})` : ''}` },
            { value: '1', label: `Tier 1 (${counts[0]})` },
            { value: '2', label: `Tier 2 (${counts[1]})` },
            { value: '3', label: `Tier 3 (${counts[2]})` },
          ]}
        />
      </div>
      {!rows ? (
        <div className="rf-skel-rows">{[0, 1, 2].map((i) => <Skeleton key={i} className="rf-skel-row" />)}</div>
      ) : !shown.length ? (
        <EmptyState compact icon="share" title={rows.length ? 'No referrals on this tier' : 'No one joined with your link yet'} description={rows.length ? undefined : 'Each trader who joins shows here with the credit they earned you.'} />
      ) : (
        <>
          <div className="bots-tablewrap">
            <table className="bots-table rf-tbl">
              <thead>
                <tr><th>Referred trader</th><th>Tier</th><th className="right">Rate</th><th className="right">Futures vol.</th><th className="right">Spot vol.</th><th className="right">Credits earned</th><th className="right">Joined</th></tr>
              </thead>
              <tbody>
                {shown.slice(page * PAGE, page * PAGE + PAGE).map((r) => (
                  <tr key={`${r.wallet}${r.at}`}>
                    <td className="num"><span className="rf-who"><Face seed={r.wallet} size={26} />{r.wallet}{r.welcome && <StatusPill size="sm" tone="brand">Welcome</StatusPill>}</span></td>
                    <td><span className={`rf-tier is-${r.tier}`}>T{r.tier}</span></td>
                    <td className="right num">{pct(r.rate)}</td>
                    <td className="right num">{compact(r.perpsUsd)}</td>
                    <td className="right num">{compact(r.spotUsd)}</td>
                    <td className={`right num${r.earnedUsd > 0 ? ' pos' : ''}`}>{r.earnedUsd > 0 ? `+${credit(r.earnedUsd)}` : credit(0)}</td>
                    <td className="right dim">{day(r.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
        </>
      )}
    </Panel>
  );
}

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  return (
    <div className="bots-pager">
      <IconButton icon="arrowLeft" label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)} />
      <span>Page {page + 1} / {pages}</span>
      <IconButton icon="arrowRight" label="Next page" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} />
    </div>
  );
}

export function RetryState({ address, what }: { address: string; what: string }) {
  return (
    <Panel>
      <EmptyState compact icon="warning" title={`Could not read ${what}`} actions={<Button variant="secondary" onClick={() => void loadMe(address)}>Try again</Button>} />
    </Panel>
  );
}

/** A trader's face: the address's identicon in a circle. */
export function Face({ seed, size }: { seed: string; size: number }) {
  return <span className="rf-face" style={{ width: size, height: size }}><Identicon seed={seed} size={Math.round(size * 0.58)} /></span>;
}

