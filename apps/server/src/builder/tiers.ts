/**
 * Which fee a wallet is signed, pure (docs/BUILDER-TIERS.md §4, §5).
 *
 * In this order:
 *   1. a fee set by hand for the wallet (`overrides`) - it wins over everything;
 *   2. the default fee while the wallet is under the underpaid policy: an
 *      underpaid or tampered order in the last `days` days;
 *   3. the tier of the wallet's counted volume (perps + spot) - of the last `volumeDays` days when the
 *      file sets them, else lifetime. The caller passes that volume in `WalletFacts`.
 * Whatever the outcome, no fee is ever above the default fee of the first tier.
 *
 * Volume is held in MICRO-USD (whole millionths of a dollar), so adding up
 * thousands of fills never drifts the way floats do.
 */
import { defaultFee, type Fee, type TiersConfig } from './config.js';

export const MICRO = 1_000_000;

/** The flags a terms answer may carry. Nothing else is ever sent: anyone can ask for any address. */
export type Flag = 'underpaid' | 'tampered' | 'override' | 'no-builder';
export const FLAGS: readonly Flag[] = ['underpaid', 'tampered', 'override', 'no-builder'];

/** What the server knows about a wallet. All zero for a wallet it has never verified. */
export interface WalletFacts {
  /** Counted volume in the configuration's window (or lifetime). */
  perpsMicro: number;
  spotMicro: number;
  /** When the wallet's last underpaid / tampered / builder-less order was created (ms, 0 = never). */
  underpaidAt: number;
  tamperedAt: number;
  noBuilderAt: number;
}

export const NO_FACTS: WalletFacts = { perpsMicro: 0, spotMicro: 0, underpaidAt: 0, tamperedAt: 0, noBuilderAt: 0 };

export interface NextTier {
  atUsd: number;
  fee: Fee;
}

export interface Decision {
  fee: Fee;
  default: Fee;
  tier: { index: number; next: NextTier | null };
  flags: Flag[];
}

const DAY_MS = 86_400_000;

/** A tier's threshold in micro-USD. */
const thresholdMicro = (usd: number): number => Math.round(usd * MICRO);

/** The tier a counted volume is in: the last one whose threshold it has reached. */
export function tierIndex(cfg: TiersConfig, totalMicro: number): number {
  let index = 0;
  for (let i = 1; i < cfg.tiers.length; i++) {
    if (totalMicro >= thresholdMicro(cfg.tiers[i]!.minVolumeUsd)) index = i;
  }
  return index;
}

const within = (at: number, days: number, now: number): boolean => at > 0 && now - at < days * DAY_MS;

export function decide(cfg: TiersConfig, address: string, facts: WalletFacts, now: number): Decision {
  const dflt = defaultFee(cfg);
  const total = facts.perpsMicro + facts.spotMicro;
  const index = tierIndex(cfg, total);
  const tier = cfg.tiers[index]!;
  const after = cfg.tiers[index + 1];
  const next: NextTier | null = after ? { atUsd: after.minVolumeUsd, fee: { perps: after.perps, spot: after.spot } } : null;

  const days = cfg.underpaid.days;
  const underpaid = within(facts.underpaidAt, days, now);
  const tampered = within(facts.tamperedAt, days, now);
  const noBuilder = within(facts.noBuilderAt, days, now);
  const override = cfg.overrides[address.toLowerCase()];

  let fee: Fee = { perps: tier.perps, spot: tier.spot };
  if (override) fee = { perps: override.perps, spot: override.spot };
  else if (cfg.underpaid.policy === 'default-fee' && (underpaid || tampered)) fee = { ...dflt };

  const flags: Flag[] = [];
  if (underpaid) flags.push('underpaid');
  if (tampered) flags.push('tampered');
  if (override) flags.push('override');
  if (noBuilder) flags.push('no-builder');

  return {
    // The validation already keeps every fee at or below the default; this is the same rule once more, where it is signed.
    fee: { perps: Math.min(fee.perps, dflt.perps), spot: Math.min(fee.spot, dflt.spot) },
    default: dflt,
    tier: { index, next },
    flags,
  };
}
