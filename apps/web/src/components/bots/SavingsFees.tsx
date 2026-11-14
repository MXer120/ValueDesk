/**
 * Savings > Your fees (owner 2026-11-14: "only bots fees here + make the vip thing gold. Also, the staking thing should
 * be right of the your fees thing then there or just same element"): what a bot order pays, side by side - SoDEX's
 * tier, ValueDesk's bot fee (its VIP step in gold), and what SOSO staking takes off SoDEX's fee - the wallet's row
 * marked on each, and what the next step needs. The marks come from the wallet's own figures: SoDEX's fee and staking
 * tier (useVenueFees), the bot fee the executor charges now, its bots' pace.
 */
import { BOT_FEE_LADDER, BOT_FEE_VIP } from '@copy-engine';
import { FEE_TIERS, STAKING_TIERS, fmtSoso, type FeeTierRow } from '../../fees';
import { fmtUsd } from '../../format';
import { Panel, ProgressBar, StatusPill } from './kit/kit';

const bp = (tenths: number) => `${(tenths / 10).toFixed(1)} bp`;
const rbp = (frac: number) => `${(frac * 10_000).toFixed(frac * 10_000 < 1 && frac > 0 ? 2 : 1)} bp`;
/** $100K, $5M, $2B: a ladder's thresholds, short enough for a narrow column. */
export const shortUsd = (usd: number): string => (usd >= 1e9 ? `$${+(usd / 1e9).toFixed(1)}B` : usd >= 1e6 ? `$${+(usd / 1e6).toFixed(1)}M` : usd >= 1e3 ? `$${+(usd / 1e3).toFixed(0)}K` : `$${usd}`);
const from = (usd: number) => (usd <= 0 ? 'From $0' : `From ${shortUsd(usd)}`);

export interface LadderRow { key: string; when: string; fee: string; sub?: string; vip?: boolean }

/** One ladder: its rows, the wallet's marked; the next step's need under it. */
export function Ladder({ title, line, rows, at, next, credit, note }: {
  title: string;
  line: string;
  rows: LadderRow[];
  /** The wallet's row (null: not known yet). */
  at: number | null;
  /** The next step: what it needs and how far the wallet is (0..1, null: no bar). */
  next?: { words: string; reach: number | null } | null;
  /** Credits or the welcome lower this fee now: said under it, with the fee it is at. */
  credit?: { fee: string; words: string } | null;
  note?: string;
}) {
  return (
    <Panel className="sv-ladder">
      <div className="sv-ladder__head">
        <b>{title}</b>
        <small>{line}</small>
      </div>
      <ol className="sv-ladder__rows">
        {rows.map((r, i) => (
          <li key={r.key} className={[i === at ? 'is-you' : '', r.vip ? 'is-vip' : ''].filter(Boolean).join(' ')} aria-current={i === at ? 'true' : undefined}>
            <span className="sv-ladder__when">{r.vip && <Crown />}{r.when}</span>
            <span className="sv-ladder__fee">{r.fee}{r.sub && <small>{r.sub}</small>}</span>
            <span className="sv-ladder__mark">{i === at && <StatusPill size="sm" tone="brand" dot className={r.vip ? 'sv-gold' : undefined}>You</StatusPill>}</span>
          </li>
        ))}
      </ol>
      {next && (
        <div className="sv-ladder__next">
          {next.reach !== null && <ProgressBar value={next.reach} max={1} size="sm" tone={next.reach >= 1 ? 'positive' : 'brand'} label={`Progress to the next step of ${title}`} />}
          <small>{next.words}</small>
        </div>
      )}
      {credit && <p className="sv-ladder__credit"><StatusPill size="sm" tone="positive" dot>Now {credit.fee}</StatusPill>{credit.words}</p>}
      {note && <p className="sv-ladder__note">{note}</p>}
    </Panel>
  );
}

/** SoDEX's own tiers (fees.ts FEE_TIERS), maker and taker on futures; the boundary belongs to the lower tier. */
export function sodexRows(): LadderRow[] {
  return FEE_TIERS.map((t: FeeTierRow) => ({ key: `s${t.tier}`, when: t.tier === 0 ? `Up to ${shortUsd(FEE_TIERS[1]?.minVolume ?? 5e6)}` : `Over ${shortUsd(t.minVolume)}`, fee: `${rbp(t.perpsMaker)} / ${rbp(t.perpsTaker)}`, sub: `Tier ${t.tier}` }));
}

export function SavingsFees({ sodexTier, stakeTier, makerFee, perDay, volumeUsd, botTenths, vip, credit }: {
  /** SoDEX's fee tier index for the wallet (null: not read yet). */
  sodexTier: number | null;
  /** SoDEX's staking tier index (null: not read yet). */
  stakeTier: number | null;
  /** The wallet's SoDEX maker fee before staking (fraction): what staking's share is taken off. */
  makerFee: number;
  /** The wallet's bots' volume a day (USD): the pace the next steps are measured at. */
  perDay: number;
  /** The wallet's 14-day volume the builder ledger counted (null: not known). */
  volumeUsd: number | null;
  /** The bot fee the executor charges this wallet now (tenths of a bp). */
  botTenths: number;
  vip: boolean;
  /** Credits or the welcome lower the bot fee now (null: neither). */
  credit: { fee: string; words: string } | null;
}) {
  const v = volumeUsd ?? 0;
  const botRows: LadderRow[] = [...BOT_FEE_LADDER.map((s) => ({ key: `b${s.fromUsd}`, when: from(s.fromUsd), fee: bp(s.fee) })), { key: 'vip', when: 'VIP', fee: bp(BOT_FEE_VIP), sub: '$5M in 14 days', vip: true }];
  const botAt = vip ? botRows.length - 1 : (() => { const i = BOT_FEE_LADDER.findIndex((s) => s.fee === botTenths); return i >= 0 ? i : null; })();
  const botNext = botAt !== null && !vip
    ? botAt + 1 < BOT_FEE_LADDER.length
      ? { words: `${fmtUsd(Math.max(0, BOT_FEE_LADDER[botAt + 1]!.fromUsd - v), 0)} more 14-day volume to ${bp(BOT_FEE_LADDER[botAt + 1]!.fee)}`, reach: Math.min(1, v / BOT_FEE_LADDER[botAt + 1]!.fromUsd) }
      : { words: `${fmtUsd(Math.max(0, 5e6 - v), 0)} more 14-day volume to VIP`, reach: Math.min(1, v / 5e6) }
    : null;
  // SoDEX: the next tier at the bots' pace (SoDEX's own 14-day volume is not public; the bots' is what this page knows).
  const sNext = sodexTier !== null ? FEE_TIERS.find((t) => t.tier === sodexTier + 1) ?? null : null;
  const sReach = sNext && perDay > 0 ? Math.min(1, (perDay * 14) / sNext.minVolume) : null;
  const stakeRows: LadderRow[] = STAKING_TIERS.map((t) => ({
    key: `k${t.tier}`,
    when: t.soso ? `${fmtSoso(t.soso)} SOSO` : 'None',
    fee: t.discount ? `${Math.round(t.discount * 100)}% off` : '0%',
    sub: t.discount ? `${fmtUsd(makerFee * t.discount * 1e6, 0)} per $1M` : undefined,
  }));
  const kNext = stakeTier !== null ? STAKING_TIERS.find((t) => t.tier === stakeTier + 1) ?? null : null;
  const kNow = stakeTier !== null ? STAKING_TIERS.find((t) => t.tier === stakeTier) ?? null : null;
  return (
    <div className="sv-fees">
      <Ladder
        title="SoDEX"
        line="Maker / taker on futures by 14-day volume"
        rows={sodexRows()}
        at={sodexTier}
        next={sNext ? { words: `Tier ${sNext.tier} from over ${shortUsd(sNext.minVolume)}${sReach !== null ? `: ${Math.round(sReach * 100)}% at your bots' pace` : ''}`, reach: sReach } : null}
      />
      <Ladder
        title="ValueDesk bots"
        line="Builder fee on every bot order"
        rows={botRows}
        at={botAt}
        next={botNext}
        credit={credit}
      />
      <Ladder
        title="Staking"
        line="SOSO staked on SoDEX, off every SoDEX fee"
        rows={stakeRows}
        at={stakeTier}
        next={kNext && kNow ? { words: `${fmtSoso(kNext.soso - kNow.soso)} SOSO more: ${Math.round(kNext.discount * 100)}% off, +${fmtUsd(makerFee * (kNext.discount - kNow.discount) * 1e6, 0)} per $1M`, reach: kNext.soso ? Math.min(1, kNow.soso / kNext.soso) : null } : null}
        note="SOSO's price can fall: weigh the stake against the saving."
      />
    </div>
  );
}

const Crown = () => (
  <svg className="sv-crown" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 5.2 5 8l3-4.5L11 8l3-2.8-1.2 7.3H3.2z" /></svg>
);
