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
 *   VITE_BUILDER_ID             Valuescan's SoDEX builder account id; unset =
 *                               no builder fee is approved or charged
 *   VITE_BUILDER_FEE_PERPS      fee per perps order, tenths of a bp (0..200)
 *   VITE_BUILDER_FEE_SPOT       fee per spot order, tenths of a bp (0..2000)
 *   VITE_BUILDER_MAX_FEE        the ceiling the user approves, tenths of a bp
 *                               (0..2000); default: the higher of the two fees
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

export interface BuilderConfig {
  /** Valuescan's SoDEX builder account id. */
  id: number;
  /** Charged per order, tenths of a basis point. */
  fee: { perps: number; spot: number };
  /** The approval ceiling the user signs, tenths of a basis point. */
  maxFeeRate: number;
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

const int = (v: string | undefined, lo: number, hi: number): number | null => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/** The builder as the build configured it, or null (no fee). Invalid values
 *  turn the builder off rather than signing something unintended. */
export function builderFromEnv(e: Record<string, string | undefined> = env): BuilderConfig | null {
  const id = int(e.VITE_BUILDER_ID, 1, Number.MAX_SAFE_INTEGER);
  if (id === null) return null;
  const perps = int(e.VITE_BUILDER_FEE_PERPS, 0, BUILDER_FEE_CAP.perps) ?? 0;
  const spot = int(e.VITE_BUILDER_FEE_SPOT, 0, BUILDER_FEE_CAP.spot) ?? 0;
  const max = int(e.VITE_BUILDER_MAX_FEE, 0, MAX_BUILDER_APPROVAL_RATE) ?? Math.max(perps, spot);
  if (max < Math.max(perps, spot)) return null;
  return { id, fee: { perps, spot }, maxFeeRate: max };
}

const pinned = (): Network | null => {
  const n = env.VITE_SODEX_NETWORK?.trim();
  return n === 'mainnet' || n === 'testnet' ? n : null;
};

let current: TradingConfig = {
  network: pinned() ?? 'mainnet',
  chainId: SODEX_CHAIN_ID[pinned() ?? 'mainnet'],
  gateway: (env.VITE_SODEX_GATEWAY?.trim() || GATEWAY_ORIGIN[pinned() ?? 'mainnet']).replace(/\/+$/, ''),
  writesAllowed: pinned() === 'testnet' || env.VITE_ALLOW_MAINNET_TRADING === '1',
  builder: builderFromEnv(),
  keyTtlMs: (int(env.VITE_TRADING_KEY_TTL_H, 1, 168) ?? 168) * 3_600_000,
  disabled: env.VITE_TRADING_DISABLED === '1',
};

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
    writesAllowed:
      !mismatch && (network === 'testnet' || h.mainnetWritesAllowed === true || env.VITE_ALLOW_MAINNET_TRADING === '1'),
  };
  fromBackend = true;
}

/** For tests. */
export function setTradingConfig(patch: Partial<TradingConfig>): void {
  current = { ...current, ...patch };
  fromBackend = true;
}
