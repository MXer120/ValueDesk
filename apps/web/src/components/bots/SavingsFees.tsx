/**
 * Savings > Your fees (owner 2026-11-14: "For fee tier, needs to show both sodex fee tier, our fee tiers, the fee
 * credits"): SoDEX's tier table and ValueDesk's three ladders side by side, the wallet's row on each marked, and what
 * the next step needs. The marks come from the wallet's own figures: SoDEX's fee tier (useVenueFees), the 14-day volume
 * the builder ledger counted (the signed terms), the bot fee the executor charges now.
 */
import { BOT_FEE_LADDER, BOT_FEE_VIP } from '@copy-engine';
import { BUILDER_LADDER, COPY_LADDER, ladderIndex } from '../../builderSchedule';
import { FEE_TIERS, type FeeTierRow } from '../../fees';
import { fmtUsd } from '../../format';
import { Panel, ProgressBar, StatusPill } from './kit/kit';

const bp = (tenths: number) => `${(tenths / 10).toFixed(1)} bp`;
const rbp = (frac: number) => `${(frac * 10_000).toFixed(frac * 10_000 < 1 && frac > 0 ? 2 : 1)} bp`;
/** $100K, $5M, $2B: a ladder's thresholds, short enough for a narrow column. */
export const shortUsd = (usd: number): string => (usd >= 1e9 ? `$${+(usd / 1e9).toFixed(1)}B` : usd >= 1e6 ? `$${+(usd / 1e6).toFixed(1)}M` : usd >= 1e3 ? `$${+(usd / 1e3).toFixed(0)}K` : `$${usd}`);
const from = (usd: number) => (usd <= 0 ? 'From $0' : `From ${shortUsd(usd)}`);

export interface LadderRow { key: string; when: string; fee: string; sub?: string }

/** One ladder: its rows, the wallet's marked; the next step's need under it. */
export function Ladder({ title, line, rows, at, next, credit }: {
  title: string;
  line: string;
  rows: LadderRow[];
  /** The wallet's row (null: not known yet). */
  at: number | null;
  /** The next step: what it needs and how far the wallet is (0..1). */
  next?: { words: string; reach: number | null } | null;
  /** Credits or the welcome pay this ladder down now: said under it. */
  credit?: string | null;
}) {
  return (
    <Panel className="sv-ladder">
      <div className="sv-ladder__head">
        <b>{title}</b>
        <small>{line}</small>
      </div>
      <ol className="sv-ladder__rows">
        {rows.map((r, i) => (
          <li key={r.key} className={i === at ? 'is-you' : ''} aria-current={i === at ? 'true' : undefined}>
            <span className="sv-ladder__when">{r.when}</span>
            <span className="sv-ladder__fee">{r.fee}{r.sub && <small>{r.sub}</small>}</span>
            <span className="sv-ladder__mark">{i === at && <StatusPill size="sm" tone="brand" dot>You</StatusPill>}</span>
          </li>
        ))}
      </ol>
      {next && (
        <div className="sv-ladder__next">
          {next.reach !== null && <ProgressBar value={next.reach} max={1} size="sm" tone={next.reach >= 1 ? 'positive' : 'brand'} label={`Progress to the next step of ${title}`} />}
          <small>{next.words}</small>
        </div>
      )}
      {credit && <p className="sv-ladder__credit"><StatusPill size="sm" tone="positive" dot>Now 0.1 bp</StatusPill>{credit}</p>}
    </Panel>
  );
}

/** SoDEX's own tiers (fees.ts FEE_TIERS), maker and taker on futures; the boundary belongs to the lower tier. */
export function sodexRows(): LadderRow[] {
  return FEE_TIERS.map((t: FeeTierRow) => ({ key: `s${t.tier}`, when: t.tier === 0 ? `Up to ${shortUsd(FEE_TIERS[1]?.minVolume ?? 5e6)}` : `Over ${shortUsd(t.minVolume)}`, fee: `${rbp(t.perpsMaker)} / ${rbp(t.perpsTaker)}`, sub: `Tier ${t.tier}` }));
}

export function SavingsFees({ sodexTier, stakeOff, volumeUsd, botTenths, vip, credit }: {
  /** SoDEX's fee tier index for the wallet (null: not read yet). */
  sodexTier: number | null;
  /** Staking's share off every SoDEX fee (0..1). */
  stakeOff: number;
  /** The wallet's 14-day volume the builder ledger counted (null: not known). */
  volumeUsd: number | null;
  /** The bot fee the executor charges this wallet now (tenths of a bp). */
  botTenths: number;
  vip: boolean;
  /** Credits or the welcome lower every ValueDesk fee now: why, in words (null: neither). */
  credit: string | null;
}) {
  const v = volumeUsd ?? 0;
  const known = volumeUsd !== null;
  const tradeAt = known ? ladderIndex(v, BUILDER_LADDER.map((r) => r.minVolumeUsd)) : null;
  const copyAt = known ? ladderIndex(v, COPY_LADDER.map((r) => r.minVolumeUsd)) : null;
  const botRows: LadderRow[] = [...BOT_FEE_LADDER.map((s) => ({ key: `b${s.fromUsd}`, when: from(s.fromUsd), fee: bp(s.fee) })), { key: 'vip', when: 'VIP', fee: bp(BOT_FEE_VIP), sub: '$5M in 14 days, or assigned' }];
  const botAt = vip ? botRows.length - 1 : (() => { const i = BOT_FEE_LADDER.findIndex((s) => s.fee === botTenths); return i >= 0 ? i : null; })();
  const nextOf = (mins: number[], at: number | null, label: string) => {
    if (at === null || at + 1 >= mins.length) return null;
    const need = mins[at + 1]!;
    return { words: `${fmtUsd(Math.max(0, need - v), 0)} more 14-day volume to the next ${label} step`, reach: Math.min(1, v / need) };
  };
  const sNext = sodexTier !== null ? FEE_TIERS.find((t) => t.tier === sodexTier + 1) ?? null : null;
  return (
    <div className="sv-fees">
      <Ladder
        title="SoDEX"
        line={`Maker / taker on futures by 14-day volume${stakeOff > 0 ? `, less your ${Math.round(stakeOff * 100)}% staking` : ''}`}
        rows={sodexRows()}
        at={sodexTier}
        // SoDEX does not say the wallet's own 14-day volume there: the threshold, no bar (ValueDesk's count is not SoDEX's).
        next={sNext ? { words: `Tier ${sNext.tier} from over ${shortUsd(sNext.minVolume)} of 14-day volume on SoDEX`, reach: null } : null}
      />
      <Ladder
        title="ValueDesk trading"
        line="Builder fee on futures and spot orders"
        rows={BUILDER_LADDER.map((r) => ({ key: `t${r.minVolumeUsd}`, when: from(r.minVolumeUsd), fee: bp(r.perps) }))}
        at={tradeAt}
        next={nextOf(BUILDER_LADDER.map((r) => r.minVolumeUsd), tradeAt, 'trading')}
        credit={credit}
      />
      <Ladder
        title="ValueDesk copy trading"
        line="Builder fee on copied orders"
        rows={COPY_LADDER.map((r) => ({ key: `c${r.minVolumeUsd}`, when: from(r.minVolumeUsd), fee: bp(r.fee) }))}
        at={copyAt}
        next={nextOf(COPY_LADDER.map((r) => r.minVolumeUsd), copyAt, 'copy')}
        credit={credit}
      />
      <Ladder
        title="ValueDesk bots"
        line="Builder fee on every bot order"
        rows={botRows}
        at={botAt}
        next={botAt !== null && !vip && botAt + 1 < BOT_FEE_LADDER.length ? { words: `${fmtUsd(Math.max(0, BOT_FEE_LADDER[botAt + 1]!.fromUsd - v), 0)} more 14-day volume to ${bp(BOT_FEE_LADDER[botAt + 1]!.fee)}`, reach: Math.min(1, v / BOT_FEE_LADDER[botAt + 1]!.fromUsd) } : null}
        credit={credit}
      />
    </div>
  );
}
