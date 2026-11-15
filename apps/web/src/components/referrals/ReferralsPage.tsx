/**
 * Referrals (owner 2026-11-14: "We also need our own referral page looking like the screenshot just instead of claim
 * fees and fees earn its builder fee credit"): the wallet's link (its own SoDEX referral code, so every wallet with a
 * SoDEX account has one at once), what it earns three tiers deep, its referrals, and its fee credits with their history.
 * Credits pay the wallet's own ValueDesk fees by themselves: there is nothing to claim.
 *
 * Numbers carry the page; words stay to a line. Built with the Bots kit (Shell, Panel, StatCard, StatusPill,
 * Segmented, the bots table and pager) like the rest of the app's pages.
 */
import { useEffect, useMemo, useState } from 'react';
import { CREDIT_FEE, REFERRED_START_USD, TIER_SHARES, VIP_CREDIT_USD, WELCOME_CAP, WELCOME_CAP_DAYS, WELCOME_USD, type InviteMe, type InviteReferral } from '@sign/invites/claim';
import { DASH, fmtUsd } from '../../format';
import { track } from '../../analytics/usage';
import { notify } from '../../toast';
import { Modal } from '../Modal';
import { openConnectDialog } from '../account/connect';
import { Button, EmptyState, IconButton, Panel, ProgressBar, Segmented, Shell, ShellHeader, Skeleton, StatCard, StatusPill } from '../bots/kit/kit';
import { inviteLink, loadMe, loadOwnCode, useInviteMeState, useOwnCode } from '../../invites/invites';
import '../bots/kit/kit.css';
import '../bots/botsPages.css';
import './referrals.css';

const PAGE = 10;
const SEEN = (a: string) => `vd.credits.seen.${a.toLowerCase()}`;
const pct = (x: number) => `${Number((x * 100).toFixed(1))}%`;
const usd2 = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;
/** +$396.32 for something earned, $0.00 for nothing (no plus on zero). */
const signedUsd = (n: number) => (n > 0 ? `+${usd2(n)}` : usd2(n));
/** A credit: cents from a dollar on, else four places (a referral's first credits are fractions of a cent). */
const credit = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(Math.abs(n) >= 1 || n === 0 ? 2 : 4)}`;
/** $53.9M, $2.57M, $48.9K, $140: the reference's compact figures. */
const compact = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(n >= 1e4 ? 1 : 2)}K` : `$${n.toFixed(0)}`);
const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

type TierFilter = 'all' | '1' | '2' | '3';

export function ReferralsPage({ address }: { address: string | null }) {
  return (
    <div className="tf bots-page rf-page">
      <div className="bots-col">
        <header className="bots-head">
          <div className="bots-head__t">
            <h1>Referrals</h1>
            <p>Share your link. Earn ValueDesk fee credits from every trader it brings, three tiers deep.</p>
          </div>
        </header>
        {!address ? (
          <Shell>
            <Panel>
              <EmptyState icon="wallet" title="Connect a wallet" description="Your link is your SoDEX referral code." actions={<Button variant="primary" icon="wallet" onClick={() => void openConnectDialog()}>Connect wallet</Button>} />
            </Panel>
          </Shell>
        ) : <Referrals address={address} />}
      </div>
    </div>
  );
}

function Referrals({ address }: { address: string }) {
  const { me, error, loading, absent } = useInviteMeState(address);
  const [how, setHow] = useState(false);
  // New credit since this wallet last looked: counted once (analytics, after consent only).
  const earned = me?.credits.earnedUsd ?? null;
  useEffect(() => {
    if (earned === null) return;
    try {
      const was = Number(localStorage.getItem(SEEN(address)) ?? '0');
      if (earned > was + 1e-9) {
        track('credits.earn', {});
        localStorage.setItem(SEEN(address), String(earned));
      }
    } catch { /* private mode */ }
  }, [address, earned]);

  return (
    <div className="rf-grid">
      <div className="rf-main">
        <LinkCard address={address} me={me} />
        <section className="rf-hero" aria-label="How referrals pay">
          <div className="rf-hero__t">
            <h2>Invite traders. Earn for life.</h2>
            <p>{pct(TIER_SHARES[0])} of the ValueDesk fees they pay, {pct(TIER_SHARES[1])} from their referrals, {pct(TIER_SHARES[2])} from the next.</p>
          </div>
          <Button variant="secondary" icon="list" onClick={() => setHow(true)}>How it works</Button>
          <TierArt />
        </section>
        <Shell className="bots-listcard rf-stats">
          <ShellHeader icon="chart" title="Stats & referrals" />
          {loading ? <div className="bots-kpigrid is-5 rf-kpis">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="rf-skel-kpi" />)}</div> : (
            <div className="bots-kpigrid is-5 rf-kpis">
              <StatCard index={0} label="Referred traders" value={me ? String(me.stats.referred.reduce((x, y) => x + y, 0)) : DASH} hint={me ? `${me.stats.referred.join(' · ')} by tier` : undefined} />
              <StatCard index={1} label="Futures volume referred" value={me ? compact(me.stats.perpsUsd) : DASH} />
              <StatCard index={2} label="Spot volume referred" value={me ? compact(me.stats.spotUsd) : DASH} />
              <StatCard index={3} label="Credits earned" value={me ? signedUsd(me.stats.earnedUsd) : DASH} valueTone={me && me.stats.earnedUsd > 0 ? 'positive' : undefined} />
              <StatCard index={4} label="T1 / T2 / T3 rates" value={TIER_SHARES.map(pct).join(' ')} />
            </div>
          )}
          {absent ? (
            <Panel className="rf-state"><EmptyState compact icon="clock" title="Referral stats are not on this server yet" description="Your link works now; stats and credits show here once the server has them." /></Panel>
          ) : error && !me ? <RetryState address={address} what="your referrals" /> : <ReferralTable rows={me?.referrals ?? null} />}
        </Shell>
      </div>
      <aside className="rf-side">
        <CreditCards me={me} loading={loading && !absent} />
        <History me={me} loading={loading && !absent} />
      </aside>
      {how && <HowItWorks onClose={() => setHow(false)} />}
    </div>
  );
}

/* --------------------------------------------------------------------- the link ----- */

function LinkCard({ address, me }: { address: string; me: InviteMe | null }) {
  const own = useOwnCode(address);
  const code = own.state === 'ok' ? own.code : null;
  const link = code ? inviteLink(code) : null;
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      notify('ok', 'Link copied.');
      track('invite.copy', { how: 'copy' });
    } catch {
      notify('warn', 'This browser did not allow copying. Select the link and copy it.');
    }
  };
  const post = () => {
    if (!link) return;
    const text = `Trade on ValueDesk with my link: no ValueDesk fee on your first $${WELCOME_USD.toLocaleString('en-US')}.`;
    window.open(`https://x.com/intent/post?${new URLSearchParams({ text, url: link }).toString()}`, '_blank', 'noopener,noreferrer');
    track('invite.copy', { how: 'x' });
  };
  const share = async () => {
    if (!link || typeof navigator.share !== 'function') return;
    try {
      await navigator.share({ url: link, text: 'Trade on ValueDesk with my link.' });
      track('invite.copy', { how: 'share' });
    } catch { /* closed */ }
  };
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  return (
    <section className="rf-link" aria-label="Your link">
      <div className="rf-link__head">
        <span className="rf-k">Your link</span>
        {me?.joined && (
          <StatusPill size="sm" tone="positive" icon="check" className="rf-by">Referred by <b>{me.joined.inviter}</b></StatusPill>
        )}
      </div>
      <div className="rf-link__row">
        {own.state === 'loading' ? <Skeleton className="rf-link__field is-skel" /> : (
          <div className={`rf-link__field${code ? '' : ' is-empty'}`} title={link ?? undefined}>
            {code ? <><span>valuedesk.so/?ref=</span><b>{code}</b></> : own.state === 'none' ? 'Your link appears with your SoDEX account' : 'SoDEX did not answer'}
          </div>
        )}
        {code ? (
          <div className="rf-link__acts">
            <Button variant="primary" icon="layers" onClick={() => void copy()}>Copy</Button>
            <Button variant="secondary" onClick={post}>Post on X</Button>
            {canShare && <IconButton icon="share" label="Share" variant="secondary" onClick={() => void share()} />}
          </div>
        ) : own.state === 'none' ? (
          <a className="tf-btn is-secondary is-sm rf-link__go" href="https://sodex.com" target="_blank" rel="noopener noreferrer">Open SoDEX</a>
        ) : own.state === 'error' ? (
          <Button variant="secondary" onClick={() => void loadOwnCode(address)}>Try again</Button>
        ) : null}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------- the table ----- */

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
            { value: 'all', label: `My referrals${rows ? ` (${rows.length})` : ''}` },
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
                    <td className="num">{r.wallet}{r.welcome && <StatusPill size="sm" tone="brand" className="rf-wel">Welcome</StatusPill>}</td>
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

/* ------------------------------------------------------------------ the side ----- */

function CreditCards({ me, loading }: { me: InviteMe | null; loading: boolean }) {
  const c = me?.credits;
  const w = me?.welcome;
  return (
    <>
      <Panel className="rf-card">
        <div className="rf-card__head">
          <span className="rf-k">Credit balance</span>
          {c && <StatusPill size="sm" tone={c.paying ? 'positive' : 'neutral'} dot>{c.paying ? 'Paying your fees' : c.balanceUsd > 0 ? 'Collecting' : 'Empty'}</StatusPill>}
        </div>
        {loading ? <Skeleton className="rf-skel-big" /> : <b className={`rf-big${c && c.balanceUsd < 0 ? ' neg' : ''}`}>{c ? usd2(c.balanceUsd) : DASH}</b>}
        {c && c.grantedUsd > 0 && <StatusPill size="sm" icon="star" className="vip-pill rf-vipcredit">Includes your {usd2(c.grantedUsd)} VIP credit</StatusPill>}
        <p className="rf-fine">Pays your ValueDesk fees by itself. Never cash.</p>
      </Panel>
      <Panel className="rf-card">
        <span className="rf-k">Total credits earned</span>
        {loading ? <Skeleton className="rf-skel-big" /> : <b className={`rf-big${c && c.earnedUsd > 0 ? ' pos' : ''}`}>{c ? signedUsd(c.earnedUsd) : DASH}</b>}
        <dl className="rf-kv">
          <div><dt>Spent on fees</dt><dd className="num">{c ? usd2(c.spentUsd) : DASH}</dd></div>
          <div><dt>Your fee while it pays</dt><dd className="num">0.1 bp</dd></div>
        </dl>
      </Panel>
      {w && (
        <Panel className="rf-card">
          <div className="rf-card__head">
            <span className="rf-k">Your welcome</span>
            <StatusPill size="sm" tone={w.active ? 'brand' : 'neutral'} dot>{w.active ? '$0 ValueDesk fee' : 'Used'}</StatusPill>
          </div>
          <b className="rf-big">{fmtUsd(w.leftUsd, 0)}<small> left</small></b>
          <ProgressBar value={w.usedUsd} max={w.limitUsd} size="sm" tone="brand" label="Welcome volume used" />
          <p className="rf-fine">{fmtUsd(w.usedUsd, 0)} of {fmtUsd(w.limitUsd, 0)} traded since you joined.</p>
        </Panel>
      )}
    </>
  );
}

function History({ me, loading }: { me: InviteMe | null; loading: boolean }) {
  const [page, setPage] = useState(0);
  const rows = me?.history ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  return (
    <Panel className="rf-card rf-hist">
      <span className="rf-k">Credit history</span>
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

/* ---------------------------------------------------------------- how it works ----- */

/**
 * The programme's current values, all of them, from the shared rules (claim.ts): the terms name this page for them
 * (owner 2026-11-14: changing a value must never need the terms signed again).
 */
function HowItWorks({ onClose }: { onClose: () => void }) {
  const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
  const steps: Array<{ t: string; l: string; vip?: boolean }> = [
    { t: 'Share your link', l: 'It is your SoDEX referral code: one link for ValueDesk and SoDEX.' },
    { t: 'They join', l: `One free signature. No ValueDesk fee on their first ${usd(WELCOME_USD)} (${WELCOME_CAP} welcomes per link in ${WELCOME_CAP_DAYS} days), and they start at the ${usd(REFERRED_START_USD)} fee tier.` },
    { t: 'You earn, three tiers deep', l: `${TIER_SHARES.map(pct).join(' / ')} of the ValueDesk fees paid by your referrals, theirs, and the next. For as long as they trade.` },
    { t: 'Credits pay your fees', l: `While you have credits your ValueDesk fee is ${(CREDIT_FEE / 10).toFixed(1)} bp and credits pay the rest. Never cash, never moved.` },
    { t: 'VIP credit', l: `Every VIP wallet gets ${usd(VIP_CREDIT_USD)} of fee credit, once.`, vip: true },
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

/** The banner's picture: you, your referrals, theirs - the three tiers with their rates. */
function TierArt() {
  return (
    <svg className="rf-hero__art" viewBox="0 0 220 120" aria-hidden="true">
      <g className="rf-art__lines">
        <path d="M110 26 60 62M110 26l50 36M60 62 34 98M60 62l26 36M160 62l-26 36M160 62l26 36" />
      </g>
      <circle className="rf-art__you" cx="110" cy="22" r="13" />
      <text className="rf-art__lbl" x="110" y="26">You</text>
      {[[60, 62], [160, 62]].map(([x, y]) => <g key={`a${x}`}><circle className="rf-art__t1" cx={x} cy={y} r="11" /><text className="rf-art__pct" x={x} y={y! + 3.5}>25%</text></g>)}
      {[[34, 98], [86, 98], [134, 98], [186, 98]].map(([x, y]) => <g key={`b${x}`}><circle className="rf-art__t2" cx={x} cy={y} r="9" /><text className="rf-art__pct is-sm" x={x} y={y! + 3}>10%</text></g>)}
    </svg>
  );
}
