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
 * may only ever switch trading OFF (`mainnetWritesAllowed: false`, which
 * VITE_ALLOW_MAINNET_TRADING overrides, and the operator's emergency brake
 * `brake`, which nothing in a build overrides: apps/server/src/ops/brake.ts). Chain ids,
 * gateway origins and signing domains are pinned in this bundle (@sodex-core,
 * sodex/chainParams.ts): an impersonated or compromised API cannot point a
 * signature or a deposit anywhere else, nor switch mainnet trading on.
 *
 * THE BUILDER FEE (docs/BUILDER-CODES.md, docs/BUILDER-TIERS.md). OFF unless
 * VITE_BUILDER_ID is set: without it nothing is approved, attached or shown,
 * and the app behaves exactly as it does with no builder at all. Who is paid,
 * the highest fee and the approval ceiling are fixed in the bundle the user
 * loads. The server can do one thing only: LOWER a wallet's fee below the two
 * fees here, with a statement signed by a key pinned here (trading/terms.ts).
 *   VITE_BUILDER_ID             Valuescan's SoDEX builder account id; unset =
 *                               no builder fee is approved or charged
 *   VITE_BUILDER_FEE_PERPS      the DEFAULT (highest) fee per perps order,
 *                               tenths of a bp (0..200)
 *   VITE_BUILDER_FEE_SPOT       the DEFAULT (highest) fee per spot order,
 *                               tenths of a bp (0..2000; SoDEX charges it on
 *                               sells only)
 *   VITE_BUILDER_MAX_FEE        the ceiling the user approves, tenths of a bp
 *                               (0..2000); default: the higher of the two fees
 *   VITE_BUILDER_REQUIRED       unset or '1' - trading through Valuescan
 *                               REQUIRES the approval: an order goes out with
 *                               the builder or not at all. '0' - the fee is
 *                               optional and a user who declines trades without
 *                               it (for a test build; never a public one)
 *   VITE_BUILDER_TERMS_KEYS     Ed25519 public keys of the server that may
 *                               lower a wallet's fee: base64url of the raw 32
 *                               bytes, comma separated. Unset - every wallet
 *                               pays the two fees above
 * A build that names a builder but whose fee settings cannot be read (a typo,
 * both fees 0) does NOT fall back to trading without a fee: trading is off in
 * that build until the settings are fixed. Only VITE_BUILDER_REQUIRED=0 keeps
 * the old behaviour (the builder is simply off).
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
   * true (the default for a build that names a builder): trading through
   * Valuescan requires the approval - an order goes out with the builder or
   * not at all. false (VITE_BUILDER_REQUIRED=0, test builds): optional - a
   * user who declines trades without a builder fee.
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
  /**
   * Public keys (Ed25519, base64url of the raw 32 bytes) whose signature may
   * lower a wallet's builder fee (trading/terms.ts). Empty: nobody can.
   */
  termsKeys: readonly string[];
  /** Trading key lifetime, milliseconds. */
  keyTtlMs: number;
  /** An emergency build: every write is refused. */
  disabled: boolean;
  /**
   * The operator's emergency brake, from /api/health (null: off). `trading`
   * refuses every order from this browser; `copies` and `algos` hold the
   * browser copier and browser algos. It reaches open tabs within the 30 s
   * health poll, and no build setting overrides it.
   */
  brake: { trading: boolean; copies: boolean; algos: boolean; reason: string } | null;
}

// `import.meta.env` is Vite's; under the node test runner it is absent.
const env = ((import.meta as { env?: Record<string, string | undefined> }).env ?? {}) as Record<string, string | undefined>;

const blank = (v: string | undefined): boolean => v === undefined || v.trim() === '';

const int = (v: string | undefined, lo: number, hi: number): number | null => {
  if (blank(v)) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/** `VITE_BUILDER_REQUIRED=0`: the one setting that makes a builder optional. */
const optionalBuild = (e: Record<string, string | undefined>): boolean => e.VITE_BUILDER_REQUIRED?.trim() === '0';

/**
 * Why a build that SETS a builder does not get one - empty when the settings
 * are valid (or no builder is configured at all). A value that is present but
 * unusable is never read as 0: a typo must not quietly become "no fee on perps".
 * See `builderBroken` for what such a build does instead.
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
    out.push("VITE_BUILDER_REQUIRED must be '0' (optional, test builds only), or '1' / unset (required)");
  }
  // A builder that charges nothing is no builder. Naming one and charging nothing is
  // a forgotten fee, not a decision - unless the build says the fee is optional.
  if (!out.length && perps === 0 && spot === 0 && !optionalBuild(e)) {
    out.push('VITE_BUILDER_ID is set but both VITE_BUILDER_FEE_PERPS and VITE_BUILDER_FEE_SPOT are 0: set a fee, or remove VITE_BUILDER_ID');
  }
  return out;
}

/**
 * A build that names a builder and cannot charge it must not trade for free:
 * its trading is OFF (docs/BUILDER-TIERS.md G1). Not so when the build says
 * the fee is optional - there, as before, the builder is simply off.
 */
export function builderBroken(e: Record<string, string | undefined> = env): boolean {
  return builderEnvProblems(e).length > 0 && !optionalBuild(e);
}

/**
 * The builder as the build configured it, or null (no fee). Invalid values
 * never become a different fee: they give no builder here, and `builderBroken`
 * then switches the build's trading off. REQUIRED unless the build says '0'.
 */
export function builderFromEnv(e: Record<string, string | undefined> = env): BuilderConfig | null {
  const id = int(e.VITE_BUILDER_ID, 1, Number.MAX_SAFE_INTEGER);
  if (id === null || builderEnvProblems(e).length) return null;
  const perps = int(e.VITE_BUILDER_FEE_PERPS, 0, BUILDER_FEE_CAP.perps) ?? 0;
  const spot = int(e.VITE_BUILDER_FEE_SPOT, 0, BUILDER_FEE_CAP.spot) ?? 0;
  if (perps === 0 && spot === 0) return null;
  const max = int(e.VITE_BUILDER_MAX_FEE, 0, MAX_BUILDER_APPROVAL_RATE) ?? Math.max(perps, spot);
  return { id, fee: { perps, spot }, maxFeeRate: max, required: !optionalBuild(e) };
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/** The raw bytes of a base64url string, or null when it is not one. */
export function base64UrlBytes(s: string): Uint8Array | null {
  const t = s.trim();
  if (!t || !B64URL.test(t) || t.length % 4 === 1) return null;
  try {
    const bin = atob(t.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (t.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The pinned terms keys of the build: every entry that is a 32-byte Ed25519
 * public key. An unusable entry is dropped and named - it can only ever cost a
 * discount (no usable key: every wallet pays the default fee), never the fee.
 */
export function termsKeysFromEnv(e: Record<string, string | undefined> = env): { keys: string[]; problems: string[] } {
  const keys: string[] = [];
  const problems: string[] = [];
  for (const part of (e.VITE_BUILDER_TERMS_KEYS ?? '').split(',')) {
    const k = part.trim();
    if (!k) continue;
    if (base64UrlBytes(k)?.length !== 32) problems.push(`VITE_BUILDER_TERMS_KEYS: "${k.slice(0, 12)}${k.length > 12 ? '...' : ''}" is not base64url of 32 bytes`);
    else if (!keys.includes(k)) keys.push(k);
  }
  return { keys, problems };
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
  termsKeys: termsKeysFromEnv().keys,
  keyTtlMs: (int(env.VITE_TRADING_KEY_TTL_H, 1, 168) ?? 168) * 3_600_000,
  // An emergency build - or one that names a builder it cannot charge (G1).
  disabled: env.VITE_TRADING_DISABLED === '1' || builderBroken(),
  brake: null,
};

/** The brake as /api/health reports it: anything but an object with a switch on is off. */
export function brakeOf(b: unknown): TradingConfig['brake'] {
  if (!b || typeof b !== 'object') return null;
  const r = b as Record<string, unknown>;
  const out = { trading: r.trading === true, copies: r.copies === true, algos: r.algos === true, reason: typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim().slice(0, 300) : 'ValueDesk has paused trading for now.' };
  return out.trading || out.copies || out.algos ? out : null;
}

/** What a refused order says: the brake's reason when the operator paused trading, else the deployment's switch. */
export function writesOffMessage(cfg: TradingConfig = current): string {
  if (cfg.brake?.trading) return `ValueDesk paused trading: ${cfg.brake.reason}`;
  return `Trading on ${cfg.network} is switched off for this deployment.`;
}

// A builder that was meant to be on and is not must be visible to whoever runs the build.
{
  const problems = builderEnvProblems();
  const log = logger('trade');
  if (problems.length && builderBroken()) log.error('TRADING IS OFF in this build: it names a builder but its fee settings are invalid', { problems });
  else if (problems.length) log.error('the builder fee is OFF: its settings are invalid', { problems });
  else if (!blank(env.VITE_BUILDER_ID) && !current.builder) log.warn('the builder fee is OFF: both VITE_BUILDER_FEE_PERPS and VITE_BUILDER_FEE_SPOT are 0 (an optional build)');
  const terms = termsKeysFromEnv();
  if (terms.problems.length) log.error('builder fee tiers: a pinned terms key is unusable and was dropped', { problems: terms.problems, usable: terms.keys.length });
  if (current.builder && !current.builder.required) log.warn('this build makes the builder fee OPTIONAL (VITE_BUILDER_REQUIRED=0): a user who declines trades without it');
}

/** Whether the backend has told us which network it reads. */
let fromBackend = false;

export const tradingConfig = (): TradingConfig => current;
export const configuredFromBackend = (): boolean => fromBackend;

/**
 * Apply what /api/health reports. A pinned network wins; a backend on another
 * network is then a misconfiguration and trading stays off.
 */
export function configureFromHealth(h: { network?: string; restBase?: string; mainnetWritesAllowed?: boolean; brake?: unknown } | null): void {
  if (!h) return;
  const reported: Network | null = h.network === 'testnet' ? 'testnet' : h.network === 'mainnet' ? 'mainnet' : null;
  if (!reported) return;
  const pin = pinned();
  const network = pin ?? reported;
  const mismatch = pin !== null && pin !== reported;
  const brake = brakeOf(h.brake);
  current = {
    ...current,
    network,
    chainId: SODEX_CHAIN_ID[network],
    gateway: (env.VITE_SODEX_GATEWAY?.trim() || GATEWAY_ORIGIN[network]).replace(/\/+$/, ''),
    // The server may only ever switch trading OFF, never on (security audit K-03).
    // The brake beats every build setting: it is how the operator stops trading without a rebuild.
    writesAllowed:
      !mismatch && !brake?.trading && (network === 'testnet' || h.mainnetWritesAllowed !== false || env.VITE_ALLOW_MAINNET_TRADING === '1'),
    brake,
  };
  fromBackend = true;
}

/** For tests. */
export function setTradingConfig(patch: Partial<TradingConfig>): void {
  current = { ...current, ...patch };
  fromBackend = true;
}
