/**
 * The run profiles: which steps a run takes, and what a profile changes in the
 * config before anything is planned (always printed - nothing changes silently).
 *
 *   core           the default config: one chain (the deposit chain), every order
 *                  type, every withdrawal path, the key's life, the refusals, the
 *                  builder fee with its tiers (when a builder is configured)
 *   evm-tour       core + every EVM chain the runner signs on, out and back
 *                  (the native coin, then USDC)
 *   all-chains     evm-tour + per route on a chain the runner cannot sign on, a
 *                  withdrawal to the owner's own address there (`receivers`), and
 *                  the deposits the owner opted into sending by hand
 *   builder-rerun  the fee test again on the funded test wallet (after `forget`):
 *                  enable trading with the approval, builder-tiers, cross-check
 *
 * No profile creates or funds a builder account: that is the owner's own,
 * existing account, which the runner only reads (by builder.address and id).
 *
 * `--only` still decides on its own: with it, exactly the steps it names run.
 */
import type { RunConfig } from './config';
import { STEP_ORDER, type StepId } from './context';

export const PROFILES = ['core', 'evm-tour', 'all-chains', 'builder-rerun'] as const;
export type Profile = (typeof PROFILES)[number];

export const PROFILE_TITLES: Record<Profile, string> = {
  core: 'one chain, everything: deposit, transfers, every order type, every way out, the key, the refusals, the builder fee',
  'evm-tour': 'core + every EVM chain the runner signs on, out and back (the native coin, then USDC)',
  'all-chains': 'evm-tour + withdrawals to your own addresses on the other chains, and the deposits you send from them by hand',
  'builder-rerun': 'the builder fee test again on the funded test wallet: the approval, the default fee, the tier change, the cheating attempts, the cross-check',
};

/** Steps only some profiles take. */
const TOUR: readonly StepId[] = ['evm-tour'];
const OTHER_CHAINS: readonly StepId[] = ['chain-withdrawals', 'manual-deposits'];

export function profileSteps(p: Profile): StepId[] {
  const core = STEP_ORDER.filter((s) => !TOUR.includes(s) && !OTHER_CHAINS.includes(s));
  switch (p) {
    case 'core':
      return core;
    case 'evm-tour':
      return STEP_ORDER.filter((s) => core.includes(s) || TOUR.includes(s));
    case 'all-chains':
      return [...STEP_ORDER];
    case 'builder-rerun':
      return ['enable-trading', 'builder-tiers', 'cross-check', 'revoke-builder'];
  }
}

/**
 * What a profile changes in the config before the plan, as lines to print.
 * builder-rerun: the funded test wallet's existing account is the expected start.
 */
export function applyProfile(cfg: RunConfig, p: Profile): string[] {
  const out: string[] = [];
  if (p === 'builder-rerun' && !cfg.allowExistingAccount) {
    cfg.allowExistingAccount = true;
    out.push('allowExistingAccount: true - this profile runs on the funded test wallet of an earlier run');
  }
  return out;
}
