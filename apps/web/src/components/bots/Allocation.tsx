/**
 * Smart margining (owner 2026-11-08): what each bot sets aside of the futures account (copy-engine botReserveUsd:
 * a maker's max holding and a quote each side, a grid an order per level), against what the account holds. The
 * executor refuses a real bot that would take the total past it; this shows the split for all bots and for one.
 * Practice bots set nothing aside: they are listed apart, as what they would need for real.
 */
import { FINAL_STATUSES, botReserveUsd, type AlgoView } from '@copy-engine';
import { DASH, fmtUsd } from '../../format';
import { useAccountTotals } from '../account/useAccountTotals';
import { CoinIcon } from '../CoinIcon';
import { botName } from './botWords';
import type { BotsCtx } from './BotsPage';
import { Panel, Shell, ShellHeader, StatusPill } from './kit/kit';

const COLORS = ['var(--pos)', '#5b8def', '#c18cff', '#f0b44c', '#4cc9d4', '#f07c6c', '#9bd46a', '#e58ac9'];

export interface Allocation {
  /** The futures account value (null while unknown). */
  equity: number | null;
  used: number;
  free: number | null;
  real: Array<{ v: AlgoView; usd: number }>;
  practice: Array<{ v: AlgoView; usd: number }>;
}

export function allocationOf(bots: readonly AlgoView[], equity: number | null): Allocation {
  const running = bots.filter((v) => v.algo.spec.bot === true && !FINAL_STATUSES.has(v.algo.status));
  const real = running.filter((v) => !v.algo.spec.paper).map((v) => ({ v, usd: botReserveUsd(v.algo.spec) })).sort((a, b) => b.usd - a.usd);
  const practice = running.filter((v) => v.algo.spec.paper).map((v) => ({ v, usd: botReserveUsd(v.algo.spec) }));
  const used = real.reduce((t, x) => t + x.usd, 0);
  return { equity, used, free: equity === null ? null : Math.max(0, equity - used), real, practice };
}

/** The account value bots are measured against: the real one, or (example bots) one that fits them. */
export function useAllocation(ctx: BotsCtx): Allocation {
  const totals = useAccountTotals(ctx.demo ? null : ctx.address);
  const demoEquity = ctx.demo ? Math.max(500, Math.ceil(ctx.bots.reduce((t, v) => t + (FINAL_STATUSES.has(v.algo.status) ? 0 : botReserveUsd(v.algo.spec)), 0) * 1.4 / 100) * 100) : null;
  const all = allocationOf(ctx.demo ? ctx.bots.map((v) => ({ ...v, algo: { ...v.algo, spec: { ...v.algo.spec, paper: false } } }) as AlgoView) : ctx.bots, ctx.demo ? demoEquity : totals.perpsUsd);
  return all;
}

/** The whole account: one bar, a segment per real bot, the rest free. */
export function AllocationPanel({ ctx }: { ctx: BotsCtx }) {
  const a = useAllocation(ctx);
  const eq = a.equity;
  const over = eq !== null && a.used > eq + 1e-6;
  const scale = Math.max(eq ?? 0, a.used, 1);
  return (
    <Shell className="bots-alloc">
      <ShellHeader icon="wallet" title="Margin" subtitle="What your bots set aside of your futures account" aside={over ? <StatusPill tone="negative" dot>Over by {fmtUsd(a.used - eq!, 0)}</StatusPill> : eq !== null ? <StatusPill tone="positive" dot>{fmtUsd(a.free!, 0)} free</StatusPill> : null} />
      <Panel className="bots-alloc__b">
        <div className="bots-alloc__nums">
          <span><small>Account</small><b>{eq === null ? DASH : fmtUsd(eq, 0)}</b></span>
          <span><small>Set aside</small><b>{fmtUsd(a.used, 0)}</b></span>
          <span><small>Free for new bots</small><b className={over ? 'neg' : ''}>{a.free === null ? DASH : fmtUsd(a.free, 0)}</b></span>
        </div>
        <div className="bots-alloc__bar" role="img" aria-label={`Set aside ${fmtUsd(a.used, 0)} of ${eq === null ? 'an unknown amount' : fmtUsd(eq, 0)}`}>
          {a.real.map((x, i) => <i key={x.v.algo.id} style={{ width: `${(x.usd / scale) * 100}%`, background: COLORS[i % COLORS.length] }} title={`${botName(x.v)}: ${fmtUsd(x.usd, 0)}`} />)}
        </div>
        {a.real.length > 0 ? (
          <ul className="bots-alloc__list">
            {a.real.map((x, i) => (
              <li key={x.v.algo.id}>
                <i style={{ background: COLORS[i % COLORS.length] }} aria-hidden="true" />
                <CoinIcon coin={x.v.algo.spec.symbol} size={16} />
                <span>{botName(x.v)}</span>
                <b>{fmtUsd(x.usd, 0)}</b>
                <small>{eq ? `${Math.round((x.usd / eq) * 100)}%` : ''}</small>
              </li>
            ))}
          </ul>
        ) : <p className="bots-fine">No real bot runs: nothing is set aside.</p>}
        {a.practice.length > 0 && !ctx.demo && <p className="bots-fine">{a.practice.length} practice bot{a.practice.length === 1 ? '' : 's'} set nothing aside (they would need {fmtUsd(a.practice.reduce((t, x) => t + x.usd, 0), 0)} for real).</p>}
      </Panel>
    </Shell>
  );
}

/** One bot's share, for its page. */
export function BotAllocation({ v, ctx }: { v: AlgoView; ctx: BotsCtx }) {
  const a = useAllocation(ctx);
  const usd = botReserveUsd(v.algo.spec);
  const eq = a.equity;
  return (
    <div className="bots-alloc__one">
      <div className="bots-alloc__nums">
        <span><small>This bot sets aside</small><b>{fmtUsd(usd, 0)}</b></span>
        <span><small>Of your account</small><b>{eq ? `${Math.round((usd / eq) * 100)}%` : DASH}</b></span>
        <span><small>Free for new bots</small><b>{a.free === null ? DASH : fmtUsd(a.free, 0)}</b></span>
      </div>
      <div className="bots-alloc__bar">
        <i style={{ width: `${eq ? Math.min(100, (usd / Math.max(eq, a.used)) * 100) : 0}%`, background: 'var(--pos)' }} />
        <i style={{ width: `${eq ? Math.min(100, ((a.used - (v.algo.spec.paper ? 0 : usd)) / Math.max(eq, a.used)) * 100) : 0}%`, background: 'rgb(var(--ink) / 0.22)' }} />
      </div>
      <small className="bots-fine">{v.algo.spec.paper ? 'Practice: nothing is set aside; this is what it would need for real.' : 'Green: this bot. Grey: your other bots.'}</small>
    </div>
  );
}
