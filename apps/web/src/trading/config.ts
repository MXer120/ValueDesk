/**
 * Where browser trading goes, and who earns the builder fee.
 *
 * THE NETWORK comes from the backend's /api/health (the network its market
 * data and account ids are read from): trading against a different network
 * than the one on screen would sign orders for account ids and symbol ids that
 * mean something else there. VITE_SODEX_NETWORK can pin it for a build.
 *
 * Build-time settings (all optional):
 *   VITE_SODEX_NETWORK          'mainnet' | 'testnet' - pin the network
 *   VITE_SODEX_GATEWAY          gateway origin override (default: SoDEX's own)
 *   VITE_ALLOW_MAINNET_TRADING  '1' - allow mainnet writes even when the
 *                               backend's own switch is off
 *
 * WHAT THE SERVER MAY DECIDE. Its /api/health picks mainnet or testnet, and
 * may only ever switch trading OFF (`mainnetWritesAllowed: false`). Chain ids,
 * gateway origins and signing domains are pinned in this bundle (@sodex-core,
 * sodex/chainParams.ts): an impersonated or compromised API cannot point a
 * signature or a deposit anywhere else, nor switch mainnet trading on.
 *
 * THE BUILDER FEE (docs/BUILDER-CODES.md). OFF unless VITE_BUILDER_ID is set:
 * without it nothing is approved, attached or shown, and the app behaves
 * exactly as it does with no builder at all. The server has no say in any of
 * this - who is paid, and how much, is fixed in the bundle the user loads.
 *   VITE_BUILDER_ID             Valuescan's SoDEX builder account id; unset =
 *                               no builder fee is approved or charged
 *   VITE_BUILDER_FEE_PERPS      fee per perps order, tenths of a bp (0..200)
 *   VITE_BUILDER_FEE_SPOT       fee per spot order, tenths of a bp (0..2000;
 *                               SoDEX charges it on sells only)
 *   VITE_BUILDER_MAX_FEE        the ceiling the user approves, tenths of a bp
 *                               (0..2000); default: the higher of the two fees
 *   VITE_BUILDER_REQUIRED       '1' - trading through Valuescan requires the
 *                               approval; unset - the fee is optional, and a
 *                               user who declines trades without it
 *   VITE_TRADING_KEY_TTL_H      trading key lifetime in hours (1..168; 168 =
 *                               7 days, what sodex.com gives its web key)
 *   VITE_TRADING_DISABLED       '1' - an emergency build with trading off
 */
import {
  BUILDER_FEE_CAP,
  GATEWAY_ORIGIN,
  MAX_BUILDER_APPROVAL_RATE,
  SODEX_CHAIN_ID,
  type Network,
} from '@sodex-core';
import { logger } from '../log';

export interface BuilderConfig {
  /** Valuescan's SoDEX builder account id. */
  id: number;
  /** Charged per order, tenths of a basis point. 0 = nothing is attached on that engine. */
  fee: { perps: number; spot: number };
  /** The approval ceiling the user signs, tenths of a basis point. */
  maxFeeRate: number;
  /**
   * true: trading through Valuescan requires the approval - declining leaves
   * trading off. false: optional - a user who declines (or whose approval SoDEX
   * refuses) trades without a builder fee.
   */
  required: boolean;
}

export interface TradingConfig {
  network: Network;
  /** SoDEX chain id: EIP-712 domain of exchange actions, X-API-Chain. */
  chainId: number;
  /** Gateway origin requests are sent to, no trailing slash. */
  gateway: string;
  /** Mainnet writes are allowed (always true on testnet). */
  writesAllowed: boolean;
  builder: BuilderConfig | null;
  /** Trading key lifetime, milliseconds. */
  keyTtlMs: number;
  /** An emergency build: every write is refused. */
  disabled: boolean;
}

// `import.meta.env` is Vite's; under the node test runner it is absent.
const env = ((import.meta as { env?: Record<string, string | undefined> }).env ?? {}) as Record<string, string | undefined>;

const blank = (v: string | undefined): boolean => v === undefined || v.trim() === '';

const int = (v: string | undefined, lo: number, hi: number): number | null => {
  if (blank(v)) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/**
 * Why a build that SETS a builder does not get one - empty when the settings
 * are valid (or no builder is configured at all). A value that is present but
 * unusable is never read as 0: a typo must not quietly become "no fee on perps".
 */
export function builderEnvProblems(e: Record<string, string | undefined> = env): string[] {
  if (blank(e.VITE_BUILDER_ID)) return [];
  const out: string[] = [];
  if (int(e.VITE_BUILDER_ID, 1, Number.MAX_SAFE_INTEGER) === null) out.push('VITE_BUILDER_ID must be a positive integer (the builder account id)');
  const fee = (name: 'VITE_BUILDER_FEE_PERPS' | 'VITE_BUILDER_FEE_SPOT', cap: number): number => {
    if (blank(e[name])) return 0;
    const n = int(e[name], 0, cap);
    if (n === null) out.push(`${name} must be an integer 0..${cap} (tenths of a basis point)`);
    return n ?? 0;
  };
  const perps = fee('VITE_BUILDER_FEE_PERPS', BUILDER_FEE_CAP.perps);
  const spot = fee('VITE_BUILDER_FEE_SPOT', BUILDER_FEE_CAP.spot);
  if (!blank(e.VITE_BUILDER_MAX_FEE)) {
    const max = int(e.VITE_BUILDER_MAX_FEE, 0, MAX_BUILDER_APPROVAL_RATE);
    if (max === null) out.push(`VITE_BUILDER_MAX_FEE must be an integer 0..${MAX_BUILDER_APPROVAL_RATE} (tenths of a basis point)`);
    else if (max < Math.max(perps, spot)) out.push('VITE_BUILDER_MAX_FEE is below the fee it has to cover');
  }
  if (!blank(e.VITE_BUILDER_REQUIRED) && e.VITE_BUILDER_REQUIRED!.trim() !== '1' && e.VITE_BUILDER_REQUIRED!.trim() !== '0') {
    out.push("VITE_BUILDER_REQUIRED must be '1' (required) or unset (optional)");
  }
  return out;
}

/**
 * The builder as the build configured it, or null (no fee). Invalid values
 * turn the builder off rather than signing something unintended; a builder
 * whose fees are both 0 charges nothing and is the same as none.
 */
export function builderFromEnv(e: Record<string, string | undefined> = env): BuilderConfig | null {
  const id = int(e.VITE_BUILDER_ID, 1, Number.MAX_SAFE_INTEGER);
  if (id === null || builderEnvProblems(e).length) return null;
  const perps = int(e.VITE_BUILDER_FEE_PERPS, 0, BUILDER_FEE_CAP.perps) ?? 0;
  const spot = int(e.VITE_BUILDER_FEE_SPOT, 0, BUILDER_FEE_CAP.spot) ?? 0;
  if (perps === 0 && spot === 0) return null;
  const max = int(e.VITE_BUILDER_MAX_FEE, 0, MAX_BUILDER_APPROVAL_RATE) ?? Math.max(perps, spot);
  return { id, fee: { perps, spot }, maxFeeRate: max, required: e.VITE_BUILDER_REQUIRED?.trim() === '1' };
}

const pinned = (): Network | null => {
  const n = env.VITE_SODEX_NETWORK?.trim();
  return n === 'mainnet' || n === 'testnet' ? n : null;
};

let current: TradingConfig = {
  network: pinned() ?? 'mainnet',
  chainId: SODEX_CHAIN_ID[pinned() ?? 'mainnet'],
  gateway: (env.VITE_SODEX_GATEWAY?.trim() || GATEWAY_ORIGIN[pinned() ?? 'mainnet']).replace(/\/+$/, ''),
  // On until the server says otherwise: it may only ever switch trading OFF.
  writesAllowed: true,
  builder: builderFromEnv(),
  keyTtlMs: (int(env.VITE_TRADING_KEY_TTL_H, 1, 168) ?? 168) * 3_600_000,
  disabled: env.VITE_TRADING_DISABLED === '1',
};

// A builder that was meant to be on and is not must be visible to whoever runs the build.
{
  const problems = builderEnvProblems();
  const log = logger('trade');
  if (problems.length) log.error('the builder fee is OFF: its settings are invalid', { problems });
  else if (!blank(env.VITE_BUILDER_ID) && !current.builder) log.warn('the builder fee is OFF: both VITE_BUILDER_FEE_PERPS and VITE_BUILDER_FEE_SPOT are 0');
}

/** Whether the backend has told us which network it reads. */
let fromBackend = false;

export const tradingConfig = (): TradingConfig => current;
export const configuredFromBackend = (): boolean => fromBackend;

/**
 * Apply what /api/health reports. A pinned network wins; a backend on another
 * network is then a misconfiguration and trading stays off.
 */
export function configureFromHealth(h: { network?: string; restBase?: string; mainnetWritesAllowed?: boolean } | null): void {
  if (!h) return;
  const reported: Network | null = h.network === 'testnet' ? 'testnet' : h.network === 'mainnet' ? 'mainnet' : null;
  if (!reported) return;
  const pin = pinned();
  const network = pin ?? reported;
  const mismatch = pin !== null && pin !== reported;
  current = {
    ...current,
    network,
    chainId: SODEX_CHAIN_ID[network],
    gateway: (env.VITE_SODEX_GATEWAY?.trim() || GATEWAY_ORIGIN[network]).replace(/\/+$/, ''),
    // The server may only ever switch trading OFF, never on (security audit K-03).
    writesAllowed:
      !mismatch && (network === 'testnet' || h.mainnetWritesAllowed !== false || env.VITE_ALLOW_MAINNET_TRADING === '1'),
  };
  fromBackend = true;
}

/** For tests. */
export function setTradingConfig(patch: Partial<TradingConfig>): void {
  current = { ...current, ...patch };
  fromBackend = true;
}
