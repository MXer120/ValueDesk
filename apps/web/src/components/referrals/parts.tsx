/**
 * What every version of the Referrals page shares: the wallet's link and its actions, the figures, the tables, the
 * benefits and "How it works". Numbers carry the page; words stay to a line.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CREDIT_FEE, REFERRED_START_USD, TIER_SHARES, VIP_CODE_DAYS, WELCOME_CAP, WELCOME_CAP_DAYS, WELCOME_USD, type InviteMe, type InviteReferral } from '@sign/invites/claim';
import { DASH, fmtUsd } from '../../format';
import { track } from '../../analytics/usage';
import { canShareNative, prefersNativeShare, shareNative } from '../../share/nativeShare';
import { notify } from '../../toast';
import { Identicon } from '../Identicon';
import { Modal } from '../Modal';
import { openConnectDialog } from '../account/connect';
import { Button, EmptyState, Icon, IconButton, Panel, ProgressBar, Segmented, Skeleton, StatusPill, type IconName } from '../bots/kit/kit';
import { inviteLink, loadMe, loadOwnCode, useOwnCode } from '../../invites/invites';
import { WE_GET, YOU_GET } from '../../onboarding/referralRules';

const PAGE = 10;
export const pct = (x: number) => `${Number((x * 100).toFixed(1))}%`;
export const usd2 = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;
/** +$396.32 for something earned, $0.00 for nothing (no plus on zero). */
export const signedUsd = (n: number) => (n > 0 ? `+${usd2(n)}` : usd2(n));
/** A credit: cents from a dollar on, else four places (a referral's first credits are fractions of a cent). */
export const credit = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(Math.abs(n) >= 1 || n === 0 ? 2 : 4)}`;
/** $53.9M, $2.57M, $48.9K, $140. */
export const compact = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(n >= 1e4 ? 1 : 2)}K` : `$${n.toFixed(0)}`);
export const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export const welcomeText = () => fmtUsd(WELCOME_USD, 0);

/** What every version draws from. `me` null: no wallet, not read yet, or this server has no referrals. */
export interface RefView { address: string | null; me: InviteMe | null; loading: boolean; error: boolean; absent: boolean; sample: boolean; how: () => void }
export const referredOf = (me: InviteMe | null): number | null => (me ? me.stats.referred.reduce((x, y) => x + y, 0) : null);
export const earnedOfTier = (me: InviteMe | null, t: number): number => (me?.referrals ?? []).filter((r) => r.tier === t).reduce((x, r) => x + r.earnedUsd, 0);

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
  return <span className="rf-linktext is-empty">{l.state === 'connect' ? 'Connect a wallet to get your link' : l.state === 'none' ? 'Your link appears with your SoDEX account' : 'SoDEX did not answer'}</span>;
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

/** The smaller ones beside it. */
export function LinkMore({ l, copy }: { l: LinkState; copy?: boolean }) {
  if (!l.code) return null;
  return (
    <div className="rf-more">
      {(copy || l.phone) && <button type="button" className="rf-ghost" onClick={() => void l.copy()}>Copy link</button>}
      <button type="button" className="rf-ghost" onClick={l.post}>Post on X</button>
      {!l.phone && !copy && l.canShare && <button type="button" className="rf-ghost" onClick={() => void l.share()}>Share</button>}
    </div>
  );
}

/** Joined with whose code, and what this wallet's own code gives. */
export function LinkPills({ me }: { me: InviteMe | null }) {
  if (!me?.vipCode && !me?.joined && !me?.vipUntil) return null;
  return (
    <div className="rf-pills">
      {me.vipCode && <StatusPill size="md" icon="star" className="vip-pill">Your link gives {VIP_CODE_DAYS} days of VIP fee</StatusPill>}
      {me.vipUntil && <StatusPill size="md" icon="star" className="vip-pill">VIP fee until {day(me.vipUntil)}</StatusPill>}
      {me.joined && <StatusPill size="md" tone="positive" icon="check">Referred by {me.joined.inviter}</StatusPill>}
    </div>
  );
}

/* --------------------------------------------------------------------- the figures ----- */

/** The home page's strip of figures, hairlines between them. */
export function StatStrip({ me, loading }: { me: InviteMe | null; loading: boolean }) {
  const xs: Array<{ l: string; v: string; s: ReactNode; pos?: boolean; neg?: boolean }> = [
    { l: 'Credit balance', v: me ? usd2(me.credits.balanceUsd) : DASH, s: me ? <StatusPill size="sm" tone={me.credits.paying ? 'positive' : 'neutral'} dot>{me.credits.paying ? 'Paying your fees' : me.credits.balanceUsd > 0 ? 'Collecting' : 'Empty'}</StatusPill> : 'Pays your ValueDesk fees', neg: !!me && me.credits.balanceUsd < 0 },
    { l: 'Credits earned', v: me ? signedUsd(me.stats.earnedUsd) : DASH, s: me ? `${usd2(me.credits.spentUsd)} spent on fees` : 'From three tiers', pos: !!me && me.stats.earnedUsd > 0 },
    { l: 'Referred traders', v: me ? String(referredOf(me)) : DASH, s: me ? `${me.stats.referred.join(' · ')} by tier` : 'Tier 1, 2 and 3' },
    { l: 'Volume referred', v: me ? compact(me.stats.perpsUsd + me.stats.spotUsd) : DASH, s: me ? `${compact(me.stats.perpsUsd)} futures · ${compact(me.stats.spotUsd)} spot` : 'Futures and spot' },
  ];
  return (
    <section className="rf-strip" aria-label="Your referrals">
      {xs.map((x) => (
        <div key={x.l}>
          <span className="rf-k">{x.l}</span>
          {loading ? <Skeleton className="rf-skel-big" /> : <b className={`rf-big${x.pos ? ' pos' : ''}${x.neg ? ' neg' : ''}`}>{x.v}</b>}
          <small>{x.s}</small>
        </div>
      ))}
    </section>
  );
}

/** The wallet's welcome, if it joined with one. */
export function WelcomeBar({ me }: { me: InviteMe | null }) {
  const w = me?.welcome;
  if (!w) return null;
  return (
    <section className="rf-welcome" aria-label="Your welcome">
      <div><span className="rf-k">Your welcome</span><span><b>{fmtUsd(w.leftUsd, 0)}</b> left</span><StatusPill size="sm" tone={w.active ? 'positive' : 'neutral'} dot>{w.active ? '$0 ValueDesk fee' : 'Used'}</StatusPill></div>
      <ProgressBar value={w.usedUsd} max={w.limitUsd} size="md" tone="positive" label="Welcome volume used" />
      <small>{fmtUsd(w.usedUsd, 0)} of {fmtUsd(w.limitUsd, 0)} traded since you joined</small>
    </section>
  );
}

/** What both sides get. SoDEX's own lines carry their source. */
export function Benefits() {
  const src = (u: string) => <a href={u} target="_blank" rel="noopener noreferrer" className="rf-src">source</a>;
  const you: Array<{ v: string; t: ReactNode; vip?: boolean }> = [
    { v: pct(TIER_SHARES[0]), t: 'of the ValueDesk fees they pay, as credits' },
    { v: pct(TIER_SHARES[1]), t: 'from the traders they bring' },
    { v: pct(TIER_SHARES[2]), t: 'one level further' },
    ...WE_GET.map((b) => ({ v: b.title.split(' ')[0]!, t: <>{b.title.slice(b.title.indexOf(' ') + 1)} on SoDEX {src(b.source.url)}</> })),
  ];
  const they: Array<{ v: string; t: ReactNode; vip?: boolean }> = [
    { v: '$0', t: `ValueDesk fee on their first ${welcomeText()}` },
    { v: `$${REFERRED_START_USD / 1000}K`, t: 'fee tier from the first trade' },
    { v: `${VIP_CODE_DAYS} days`, t: 'of VIP fee, with the code of a VIP', vip: true },
    ...YOU_GET.slice(0, 1).map((b) => ({ v: b.title.split(' ')[0]!, t: <>{b.title.slice(b.title.indexOf(' ') + 1)} on SoDEX {src(b.source.url)}</> })),
  ];
  return (
    <section className="rf-bens" aria-label="Benefits">
      {([['You get', you], ['They get', they]] as const).map(([h, xs]) => (
        <div key={h} className="rf-ben">
          <h3>{h}</h3>
          <ul>{xs.map((x, i) => <li key={i}><b className={x.vip ? 'vip-text' : undefined}>{x.v}</b><span>{x.t}</span></li>)}</ul>
        </div>
      ))}
    </section>
  );
}

/** The referrals and the credit history, or why they cannot be read. */
export function Tables({ v }: { v: RefView }) {
  if (!v.address && !v.sample) return null;
  return (
    <div className="rf-tables">
      <section>
        <h3>Referrals</h3>
        {v.absent ? (
          <Panel className="rf-state"><EmptyState compact icon="clock" title="Referral stats are not on this server yet" description="Your link works now; stats and credits show here once the server has them." /></Panel>
        ) : v.error && !v.me && v.address ? <RetryState address={v.address} what="your referrals" /> : <ReferralTable rows={v.me?.referrals ?? null} />}
      </section>
      <section>
        <h3>Credit history</h3>
        <History me={v.me} loading={v.loading && !v.absent} />
      </section>
    </div>
  );
}

/* --------------------------------------------------------------------- the tables ----- */

type TierFilter = 'all' | '1' | '2' | '3';

function ReferralTable({ rows }: { rows: InviteReferral[] | null }) {
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

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  return (
    <div className="bots-pager">
      <IconButton icon="arrowLeft" label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)} />
      <span>Page {page + 1} / {pages}</span>
      <IconButton icon="arrowRight" label="Next page" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} />
    </div>
  );
}

function History({ me, loading }: { me: InviteMe | null; loading: boolean }) {
  const [page, setPage] = useState(0);
  const rows = me?.history ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  return (
    <Panel className="rf-hist">
      {loading ? <div className="rf-skel-rows">{[0, 1, 2].map((i) => <Skeleton key={i} className="rf-skel-row" />)}</div> : !rows.length ? (
        <EmptyState compact icon="clock" title="No credits yet" />
      ) : (
        <>
          <table className="bots-table rf-tbl is-hist">
            <thead><tr><th>Time</th><th>Type</th><th className="right">Credit</th></tr></thead>
            <tbody>
              {rows.slice(page * PAGE, page * PAGE + PAGE).map((h, i) => (
                <tr key={`${h.at}-${i}`}>
                  <td className="dim">{day(h.at)}</td>
                  <td>{h.kind === 'earn' ? <span className="rf-type"><span className={`rf-tier is-${h.tier ?? 1}`}>T{h.tier ?? 1}</span>{h.from}</span> : h.kind === 'grant' ? <span className="rf-type"><b className="vip-text">VIP credit</b></span> : <span className="rf-type">Fees paid</span>}</td>
                  <td className={`right num ${h.kind === 'spend' ? 'dim' : h.kind === 'grant' ? '' : 'pos'}`}>{h.kind === 'grant' ? <b className="vip-text">+{credit(h.usd)}</b> : <>{h.kind === 'spend' ? '−' : '+'}{credit(h.usd)}</>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
        </>
      )}
    </Panel>
  );
}

function RetryState({ address, what }: { address: string; what: string }) {
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

/* ---------------------------------------------------------------- how it works ----- */

/**
 * The programme's current values, all of them, from the shared rules (claim.ts): the terms name this page for them
 * (owner 2026-11-14: changing a value must never need the terms signed again).
 */
export function HowItWorks({ onClose }: { onClose: () => void }) {
  const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
  const steps: Array<{ t: string; l: string; vip?: boolean }> = [
    { t: 'Share your link', l: 'It is your SoDEX referral code: one link for ValueDesk and SoDEX.' },
    { t: 'They join', l: `One free signature. No ValueDesk fee on their first ${usd(WELCOME_USD)} (${WELCOME_CAP} welcomes per link in ${WELCOME_CAP_DAYS} days), and they start at the ${usd(REFERRED_START_USD)} fee tier.` },
    { t: 'You earn, three tiers deep', l: `${TIER_SHARES.map(pct).join(' / ')} of the ValueDesk fees paid by your referrals, theirs, and the next. For as long as they trade.` },
    { t: 'Credits pay your fees', l: `While you have credits your ValueDesk fee is ${(CREDIT_FEE / 10).toFixed(1)} bp and credits pay the rest. Never cash, never moved.` },
    { t: 'VIP codes', l: `Join with a VIP's code and you pay the VIP fee for ${VIP_CODE_DAYS} days.`, vip: true },
  ];
  return (
    <Modal open size="sm" title="How referrals work" className="dlg" onClose={onClose}>
      <ol className="rf-how">
        {steps.map((s, i) => (
          <li key={s.t} className={s.vip ? 'is-vip' : undefined}><i aria-hidden="true">{i + 1}</i><div><b className={s.vip ? 'vip-text' : undefined}>{s.t}</b><small>{s.l}</small></div></li>
        ))}
      </ol>
    </Modal>
  );
}
