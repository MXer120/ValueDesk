/**
 * Smart margining (owner 2026-11-08): what copy trading and each bot set aside of the futures account, against
 * what it holds. A copy sets aside its allocation (copy-engine copyReserveUsd), a bot its max holding and a quote
 * each side, a grid an order per level (botReserveUsd). The executor refuses a real bot that would take copies and
 * bots together past the account, and New bot says so first. Practice bots and paper copies set nothing aside.
 *
 * The panel (Bots overview, Portfolio): Simple is the account, copy trading, bots and free; Detailed shows every
 * copy and every bot as blocks of the account, then the breakdown, then what is free.
 */
import { useMemo } from 'react';
import { FINAL_STATUSES, botMarginUsd, copyReserveUsd, type AlgoView } from '@copy-engine';
import { DASH, fmtUsd, num, shortAddr } from '../../format';
import { api } from '../../api';
import { useAccountResource } from '../../accountFeeds';
import { useStored } from '../../hooks';
import { copyRows, readiness, useLiveCopy, type LiveCopy } from '../../copy/live';
import { useBots } from '../../bots/useBots';
import type { Eip1193Provider } from '../../wallet';
import { useAccountTotals } from '../account/useAccountTotals';
import { CoinIcon } from '../CoinIcon';
import { botName } from './botWords';
import type { BotsCtx } from './BotsPage';
import { Icon, Panel, Segmented, Shell, ShellHeader, StatusPill } from './kit/kit';

const PERPS_COLOR = '#c9cfd8';
const COPY_COLOR = '#5b8def';
const BOT_COLOR = 'var(--pos)';
const COPY_SHADES = ['#5b8def', '#86a9f5', '#3f6fd1', '#a9c1ff', '#2f58b0'];
const BOT_SHADES = ['var(--pos)', '#c18cff', '#f0b44c', '#4cc9d4', '#f07c6c', '#9bd46a', '#e58ac9'];

export interface MarginItem { id: string; kind: 'copy' | 'bot'; label: string; usd: number; color: string; coin?: string; mode?: string }

export interface Allocation {
  /** The futures account value (null while unknown). */
  equity: number | null;
  copies: MarginItem[];
  bots: MarginItem[];
  /** Margin your own open positions hold now (the account's position margin, less what the bots' positions hold). */
  perpsUsd: number;
  copyUsd: number;
  botUsd: number;
  /** Your own positions, copies and bots together (the panel's line). */
  used: number;
  /** What the account has left after all of it, for the panel. */
  free: number | null;
  /**
   * What a new bot may set aside: the account less bots and the executor's copies, as the executor's start check
   * counts it (own positions are shown, not part of this; copies running in a browser tab are not the executor's).
   * New bot gates on this number.
   */
  freeForBots: number | null;
  /** Practice bots: what they would need for real. */
  practiceUsd: number;
  practice: number;
}

/** A copy as the panel needs it (copy/live.ts copyRows, or the demo's). */
export interface MarginCopy { id: string; leader: string; mode: string; status: string; settings: { allocationUsd: number; paper: boolean } }

export function marginOf(bots: readonly AlgoView[], copies: readonly MarginCopy[], equity: number | null, positionsMargin = 0): Allocation {
  const running = bots.filter((v) => v.algo.spec.bot === true && !FINAL_STATUSES.has(v.algo.status));
  const real = running.filter((v) => !v.algo.spec.paper).map((v) => ({ v, usd: botMarginUsd(v.algo.spec) })).filter((x) => x.usd > 0).sort((a, b) => b.usd - a.usd);
  const practice = running.filter((v) => v.algo.spec.paper);
  const cs = copies.map((c) => ({ c, usd: copyReserveUsd(c) })).filter((x) => x.usd > 0).sort((a, b) => b.usd - a.usd);
  const copyItems: MarginItem[] = cs.map(({ c, usd }, i) => ({ id: `copy:${c.id}`, kind: 'copy', label: `Copying ${shortAddr(c.leader)}`, usd, color: COPY_SHADES[i % COPY_SHADES.length]!, mode: c.mode }));
  const botItems: MarginItem[] = real.map(({ v, usd }, i) => ({ id: `bot:${v.algo.id}`, kind: 'bot', label: botName(v), usd, color: BOT_SHADES[i % BOT_SHADES.length]!, coin: v.algo.spec.symbol }));
  const copyUsd = copyItems.reduce((t, x) => t + x.usd, 0);
  const botUsd = botItems.reduce((t, x) => t + x.usd, 0);
  // What the running bots' own positions hold of the account's position margin (their holding at their leverage):
  // taken off, so Perps is the margin of the user's own positions and a bot's is not counted twice.
  const botPos = running.filter((v) => !v.algo.spec.paper).reduce((t, v) => t + Math.abs(v.bot?.inventoryUsd ?? 0) / Math.max(1, v.algo.spec.leverage ?? 1), 0);
  const perpsUsd = Math.max(0, positionsMargin - botPos);
  const used = perpsUsd + copyUsd + botUsd;
  const executorCopies = cs.filter(({ c }) => c.mode !== 'browser').reduce((t, x) => t + x.usd, 0);
  return {
    equity, copies: copyItems, bots: botItems, perpsUsd, copyUsd, botUsd, used,
    free: equity === null ? null : Math.max(0, equity - used),
    freeForBots: equity === null ? null : Math.max(0, equity - botUsd - executorCopies),
    practice: practice.length, practiceUsd: practice.reduce((t, v) => t + botMarginUsd(v.algo.spec), 0),
  };
}

/** The wallet's copies in every mode, as the panel counts them. */
export function marginCopies(live: LiveCopy | null): MarginCopy[] {
  if (!live) return [];
  return copyRows(live).map(({ mode, view }) => ({ id: view.subscription.id, leader: view.subscription.settings.leader.address, mode, status: view.subscription.status, settings: view.subscription.settings }));
}

/** Example copies beside the example bots. */
const DEMO_COPIES: MarginCopy[] = [
  { id: 'demo-c1', leader: '0x8f2a6b1c9d0e4f5a7b3c2d1e0f9a8b7c6d5e41c9', mode: 'hosted', status: 'active', settings: { allocationUsd: 250, paper: false } },
  { id: 'demo-c2', leader: '0x31c7d2e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b7e0', mode: 'hosted', status: 'paused', settings: { allocationUsd: 150, paper: false } },
];

/** The account value bots are measured against: the real one, or (example bots) one that fits them. */
export function useAllocation(ctx: BotsCtx): Allocation {
  const totals = useAccountTotals(ctx.demo ? null : ctx.address);
  const pm = usePositionsMargin(ctx.demo ? null : ctx.address);
  const copies = ctx.demo ? DEMO_COPIES : marginCopies(ctx.live);
  return useMemo(() => {
    if (!ctx.demo) return marginOf(ctx.bots, copies, totals.perpsUsd, pm);
    // Example: $120 of own positions beside the example bots and copies.
    const a = marginOf(ctx.bots, copies, null, 120);
    return marginOf(ctx.bots, copies, Math.max(500, Math.ceil((a.used * 1.3) / 100) * 100), 120);
  }, [ctx.demo, ctx.bots, copies, totals.perpsUsd, pm]);
}

/**
 * The margin the account's open positions hold now: SoDEX's perps state, isolated position margin (im) plus cross
 * position margin (cm). Read from the shared account feed (the order ticket's), every 20 s.
 */
function usePositionsMargin(address: string | null): number {
  const acct = useAccountResource(address ? `state:perps:${address}` : null, () => api.state('perps', address!), 20_000);
  const st = (acct.data as { state?: Record<string, unknown> } | null)?.state;
  const n = (x: unknown) => { const v = num(x); return Number.isFinite(v) ? v : 0; };
  return st ? n(st.im) + n(st.cm) : 0;
}

/* ------------------------------------------------------------------ the panel ----- */

/**
 * The account as one line (owner 2026-11-08: "detailed should just be a line"): each segment its share, the rest the
 * free track. When copies and bots set aside more than the account holds, the line runs to what they set aside, the
 * account's edge is marked, and the part past it is red.
 */
function MarginLine({ a, segs }: { a: Allocation; segs: Array<{ id: string; usd: number; color: string; label: string }> }) {
  const eq = a.equity ?? 0;
  const scale = Math.max(eq, a.used, 1);
  const over = a.equity !== null && a.used > eq + 1e-6;
  const pct = (x: number) => `${(x / scale) * 100}%`;
  return (
    <div className="mg-line">
      <div className="bots-alloc__bar mg-bar" role="img" aria-label={`${fmtUsd(a.used, 0)} set aside of ${a.equity === null ? 'an unknown amount' : fmtUsd(eq, 0)}`}>
        {segs.filter((x) => x.usd > 0).map((x) => <i key={x.id} style={{ width: pct(x.usd), background: x.color }} title={`${x.label}: ${fmtUsd(x.usd, 0)}`} />)}
        {over && <b className="mg-over" style={{ left: pct(eq), width: pct(a.used - eq) }} aria-hidden="true" />}
      </div>
      {over && (
        <span className={`mg-edge${over ? ' is-over' : ''}`} style={{ left: pct(eq) }}><i aria-hidden="true" />Account {fmtUsd(eq, 0)}</span>
      )}
    </div>
  );
}

function Row({ color, label, usd, eq, coin, sub }: { color: string; label: string; usd: number; eq: number | null; coin?: string; sub?: string }) {
  return (
    <li>
      <i style={{ background: color }} aria-hidden="true" />
      {coin ? <CoinIcon coin={coin} size={16} /> : <span className="mg-copyic"><Icon name="layers" size={10} /></span>}
      <span>{label}{sub && <small> · {sub}</small>}</span>
      <b>{fmtUsd(usd, 0)}</b>
      <small>{eq ? `${Math.round((usd / eq) * 100)}%` : ''}</small>
    </li>
  );
}

/** Margin, the whole account: Simple (copy trading, bots, free) or Detailed (every copy and bot). */
export function MarginPanel({ a, note, className }: { a: Allocation; note?: string | null; className?: string }) {
  const [view, setView] = useStored<'simple' | 'detailed'>('vs.margin.view', 'simple');
  const eq = a.equity;
  const over = eq !== null && a.used > eq + 1e-6;
  return (
    <Shell className={`bots-alloc mg${className ? ` ${className}` : ''}`}>
      <ShellHeader
        icon="wallet"
        title="Margin"
        subtitle="What copy trading and bots set aside of your futures account"
        aside={<>
          {over ? <StatusPill tone="negative" dot>Over by {fmtUsd(a.used - eq!, 0)}</StatusPill> : eq !== null ? <StatusPill tone="positive" dot>{fmtUsd(a.free!, 0)} free</StatusPill> : null}
          <Segmented value={view} label="Margin view" onChange={setView} options={[{ value: 'simple', label: 'Simple' }, { value: 'detailed', label: 'Detailed' }]} />
        </>}
      />
      <Panel className="bots-alloc__b">
        <div className="bots-alloc__nums mg-nums">
          <span><small>Futures account</small><b>{eq === null ? DASH : fmtUsd(eq, 0)}</b></span>
          <span><small><i style={{ background: PERPS_COLOR }} />Perps</small><b>{fmtUsd(a.perpsUsd, 0)}</b></span>
          <span><small><i style={{ background: COPY_COLOR }} />Copy trading</small><b>{fmtUsd(a.copyUsd, 0)}</b></span>
          <span><small><i style={{ background: BOT_COLOR }} />Bots</small><b>{fmtUsd(a.botUsd, 0)}</b></span>
          <span><small><i className="is-free" />Free</small><b className={over ? 'neg' : ''}>{a.free === null ? DASH : fmtUsd(a.free, 0)}</b></span>
        </div>
        {view === 'simple' ? (
          <MarginLine a={a} segs={[{ id: 'perps', usd: a.perpsUsd, color: PERPS_COLOR, label: 'Your own positions' }, { id: 'copy', usd: a.copyUsd, color: COPY_COLOR, label: 'Copy trading' }, { id: 'bots', usd: a.botUsd, color: BOT_COLOR, label: 'Bots' }]} />
        ) : (
          <>
            <MarginLine a={a} segs={[{ id: 'perps', usd: a.perpsUsd, color: PERPS_COLOR, label: 'Your own positions' }, ...a.copies, ...a.bots]} />
            <div className="mg-free mg-perps"><i style={{ background: PERPS_COLOR }} aria-hidden="true" /><span>Your own positions (margin they hold now)</span><b>{fmtUsd(a.perpsUsd, 0)}</b><small>{eq ? `${Math.round((a.perpsUsd / eq) * 100)}%` : ''}</small></div>
            <div className="mg-groups">
              <section>
                <h4><i style={{ background: COPY_COLOR }} />Copy trading <b>{fmtUsd(a.copyUsd, 0)}</b></h4>
                {a.copies.length ? <ul className="bots-alloc__list">{a.copies.map((x) => <Row key={x.id} color={x.color} label={x.label} usd={x.usd} eq={eq} sub={x.mode === 'hosted' ? undefined : x.mode} />)}</ul> : <p className="bots-fine">No copy sets anything aside.</p>}
              </section>
              <section>
                <h4><i style={{ background: BOT_COLOR }} />Bots <b>{fmtUsd(a.botUsd, 0)}</b></h4>
                {a.bots.length ? <ul className="bots-alloc__list">{a.bots.map((x) => <Row key={x.id} color={x.color} label={x.label} usd={x.usd} eq={eq} coin={x.coin} />)}</ul> : <p className="bots-fine">No real bot runs.</p>}
              </section>
            </div>
            <div className="mg-free"><i className="is-free" aria-hidden="true" /><span>Free for new bots and copies</span><b className={over ? 'neg' : ''}>{a.free === null ? DASH : fmtUsd(a.free, 0)}</b><small>{eq ? `${Math.round(((a.free ?? 0) / eq) * 100)}%` : ''}</small></div>
          </>
        )}
        {over && <p className="bots-err mg-why">{fmtUsd(a.used, 0)} of margin is taken against a {fmtUsd(eq!, 0)} account: your own positions, each copy's allocation, and each bot's holding cap and quotes at its leverage. Raise a bot's leverage, lower its size or holding cap, or add funds.</p>}
        {a.freeForBots !== null && a.perpsUsd > 0.5 && <p className="bots-fine">New bots can set aside up to {fmtUsd(a.freeForBots, 0)}: your own positions show here, but the start check counts bots and copies only.</p>}
        {note ? <p className="bots-fine">{note}</p> : a.practice > 0 ? <p className="bots-fine">{a.practice} practice bot{a.practice === 1 ? '' : 's'} set nothing aside (they would need {fmtUsd(a.practiceUsd, 0)} for real).</p> : null}
      </Panel>
    </Shell>
  );
}

/** The Bots overview's panel. */
export function AllocationPanel({ ctx }: { ctx: BotsCtx }) {
  return <MarginPanel a={useAllocation(ctx)} note={ctx.demo ? 'Example bots and copies.' : null} />;
}

/** One bot's share, for its page. */
export function BotAllocation({ v, ctx }: { v: AlgoView; ctx: BotsCtx }) {
  const a = useAllocation(ctx);
  const usd = botMarginUsd(v.algo.spec);
  const eq = a.equity;
  const scale = Math.max(eq ?? 0, a.used, 1);
  const mine = v.algo.spec.paper ? 0 : usd;
  return (
    <div className="bots-alloc__one">
      <div className="bots-alloc__nums">
        <span><small>This bot sets aside</small><b>{fmtUsd(usd, 0)}</b></span>
        <span><small>Of your account</small><b>{eq ? `${Math.round((usd / eq) * 100)}%` : DASH}</b></span>
        <span><small>Free for bots</small><b>{a.freeForBots === null ? DASH : fmtUsd(a.freeForBots, 0)}</b></span>
      </div>
      <div className="bots-alloc__bar">
        <i style={{ width: `${(a.perpsUsd / scale) * 100}%`, background: PERPS_COLOR }} />
        <i style={{ width: `${(a.copyUsd / scale) * 100}%`, background: COPY_COLOR }} />
        <i style={{ width: `${(Math.max(0, a.botUsd - mine) / scale) * 100}%`, background: '#c18cff' }} />
        <i style={{ width: `${(mine / scale) * 100}%`, background: 'var(--pos)' }} />
      </div>
      <small className="bots-fine">{v.algo.spec.paper ? 'Practice: nothing is set aside; this is what it would need for real.' : <span className="bots-takers__key"><span><i style={{ background: PERPS_COLOR }} />Your positions</span><span><i style={{ background: COPY_COLOR }} />Copy trading</span><span><i style={{ background: '#c18cff' }} />Other bots</span><span><i style={{ background: 'var(--pos)' }} />This bot</span><span><i style={{ background: 'rgb(var(--ink) / 0.07)' }} />Free</span></span>}</small>
    </div>
  );
}

/**
 * Portfolio's panel (owner 2026-11-08: users see what they have given to copy trading and bots there): the wallet's
 * own copies and bots, read with the executor sign-in the Bots and Copy pages keep (nothing is signed here). Not
 * shown for someone else's account (Scan), nor until the wallet is signed in to the executor.
 */
export function PortfolioMargin({ address, provider }: { address: string | null; provider: Eip1193Provider | null }) {
  const live = useLiveCopy(address, provider);
  const signedIn = readiness(live, 'hosted').connected;
  const { bots } = useBots(address, signedIn);
  const totals = useAccountTotals(address);
  const copies = marginCopies(live);
  const pm = usePositionsMargin(address);
  const a = useMemo(() => marginOf(bots, copies, totals.perpsUsd, pm), [bots, copies, totals.perpsUsd, pm]);
  if (!address || !signedIn) return null;
  return <MarginPanel a={a} className="pf-margin" />;
}
