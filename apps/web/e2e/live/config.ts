/**
 * The runner's config file: shape, defaults, and STRUCTURAL validation.
 *
 * Structural means: types, decimal strings, known keys, receiver names that
 * exist. Whether an amount clears SoDEX's minimum, whether a route is open and
 * whether an address is valid FOR ITS CHAIN needs live data - that is checked
 * in the plan (plan.ts), before anything is signed.
 *
 * Every coin amount is a decimal STRING ("20", "0.0015") - never a JSON number,
 * which would already be a float. A handful of amounts also take a word:
 *   "min"  the route's live withdrawal minimum
 *   "all"  everything that can move
 *   "auto" the smallest order the market accepts (plus 20 %)
 * Keys starting with "//" are comments and ignored.
 */
import { readFileSync } from 'node:fs';
import { isDecimal } from './util';

export interface ReceiverSpec {
  address: string;
  /** XRP / Stellar: the numeric memo (destination tag). */
  memo?: string;
  /** XRP / Stellar: the address takes no memo (a wallet you control, not an exchange). */
  noMemo?: boolean;
}

export interface ExtraWithdrawal {
  coin: string;
  chain: string;
  /** decimal | "min" | "all" */
  amount: string;
  /** "self" (this wallet, EVM chains only) or a key of `receivers`. */
  receiver: string;
  /** Not enough of the coin in Spot: market-buy what is missing first (costs a fee + spread). */
  buyIfMissing?: boolean;
}

/**
 * The Valuescan builder fee for this run - what VITE_BUILDER_* are for a build
 * (docs/BUILDER-CODES.md, docs/BUILDER-TIERS.md).
 */
export interface RunBuilder {
  /** The builder's SoDEX account id. */
  id: number;
  /** The builder account's wallet address (public, lower-case): its balances are read to check the income. null: not checked. */
  address: string | null;
  /** DEFAULT fee per perps order / per spot order, tenths of a basis point (perps 0..200, spot 0..2000). */
  feePerps: number;
  feeSpot: number;
  /** The ceiling the wallet approves, tenths of a bp (default: the higher fee). */
  maxFee: number;
  /** No approval, no trading - what a build with a builder is (contract G1). false only to test an optional build. */
  required: boolean;
  /** Run the last step, revoke-builder (one more signature: maxFeeRate 0). */
  revokeAtEnd: boolean;
  /**
   * The server's terms-signing PUBLIC keys (base64url of the raw 32 bytes,
   * contract section 3). With them the run tests the fee tiers: the default
   * fee, the verified volume, the lower fee, the cheating attempts. Empty: the
   * fee is the default throughout and the tier checks are skipped.
   */
  termsKeys: string[];
  /**
   * What the tier test must see once the volume passes `atUsd`. null: what the
   * server itself announces as the wallet's next tier.
   */
  expectTier: { atUsd: number; perps: number; spot: number } | null;
}

/** One deposit the OWNER sends by hand (a chain the runner cannot sign on); the run waits for it and verifies it. */
export interface ManualDeposit {
  coin: string;
  chain: string;
  /**
   * At least this much must arrive in Spot (a decimal string, in the coin), or
   * "auto": the round trip the runner plans (handBack.ts) - what the chain
   * withdrawal sent you, less your wallet's fee and what stays at your address,
   * never below SoDEX's deposit minimum.
   */
  amount: string;
  /** You chose not to send this one: reported "skipped (owner)", nothing is waited for. */
  skip?: boolean;
}

export interface RunConfig {
  /** Must be true for live mode: "I know this moves real funds". */
  acknowledgeRealFunds: boolean;
  /** Web + API proxy origin (the Vite dev server). */
  backend: string;
  /**
   * The most this wallet may LOSE in this run, in USD: fees, gas, activation,
   * trading costs, AND anything sent to an address other than the wallet
   * itself (receivers). Checked before every step.
   */
  maxSpendUsd: number;
  /** A brand-new wallet is the expected start; true allows one that already has a SoDEX account (e.g. to resume). */
  allowExistingAccount: boolean;
  /** The chain the key-backed wallet starts on, like a browser wallet that is on some network (SoDEX chain key or VALUECHAIN). */
  startChain: string;
  /** Trading-key lifetime registered on SoDEX, hours (1..168). */
  keyTtlHours: number;
  deposit: { chain: string; amount: string };
  transfers: { amount: string };
  orders: {
    spotSymbol: string;
    /** How far below the best bid the resting spot limit buy sits (capped inside the market's price band). */
    spotLimitOffsetPct: number;
    /** SOSO market-buy quantity for ValueChain gas: decimal | "auto". */
    sosoBuyQuantity: string;
    perpsSymbol: string;
    perpsLimitOffsetPct: number;
    /** USDC moved Spot -> Perps for the perps orders (more if the market needs it), moved back afterwards. */
    perpsCollateral: string;
    /**
     * How long to wait for a take-profit placed at the market to trigger, seconds
     * (0 = do not try). Not triggering in that time is reported, never a failure.
     */
    triggerWaitSeconds: number;
  };
  spotToEvm: { usdc: string; soso: string };
  evmToSpot: { usdc: string };
  withdrawValuechainSelf: { amount: string };
  withdrawValuechainOther: { amount: string; receiver: string };
  withdrawExternal: { coin: string; chain: string; amount: string; receiver: string };
  extraDeposits: Array<{ chain: string; amount: string }>;
  extraWithdrawals: ExtraWithdrawal[];
  receivers: Record<string, ReceiverSpec>;
  cleanup: { enabled: boolean; chain: string };
  /**
   * The evm-tour step (profiles evm-tour and all-chains): per EVM chain the
   * runner signs on, the chain's native coin and USDC out to this wallet and
   * back. `chains`: "all", or the chain keys to tour; `skip`: chain keys to
   * leave out. `sellBack`: sell the native coins bought for the tour back to
   * USDC once the last chain that needs them is done.
   */
  evmTour: { chains: 'all' | string[]; skip: string[]; sellBack: boolean };
  /**
   * The chain-withdrawals step (profile all-chains): per route on a chain the
   * runner cannot sign on, a withdrawal of the route's minimum to the owner's
   * own address there - `receivers.<chain key in lower case>` (receivers.sol,
   * receivers.btc, receivers.xrp ...). A route without that receiver is skipped.
   */
  chainWithdrawals: { skip: string[]; buyIfMissing: boolean };
  /** The manual-deposits step (profile all-chains): deposits the owner sends by hand, opted into per route. */
  manualDeposits: ManualDeposit[];
  /**
   * null (the default): no builder - nothing is approved, read or attached, and
   * the builder checks report "skipped". Set: the enable-trading step approves
   * the fee when SoDEX does not list it (ONE more wallet signature), every order
   * must carry the builder at the fee owed, every fill's builderFee is checked,
   * and revoke-builder can clear the approval at the end. With `termsKeys` the
   * builder-tiers step runs the whole of docs/BUILDER-TIERS.md section 8.
   */
  builder: RunBuilder | null;
  timeouts: {
    depositMinutes: number;
    withdrawMinutes: number;
    settleSeconds: number;
    orderSeconds: number;
    /** How long to wait for the server's fee verifier after a hint (contract section 6: "a minute or two"). */
    verifierMinutes: number;
    /** How long a live run waits for a new wallet's deposit addresses to be issued. */
    addressIssueSeconds: number;
    /** How long to wait for the account stream to report a fill before leaving it to the final cross-check. */
    streamSeconds: number;
  };
}

export const DEFAULT_CONFIG: RunConfig = {
  acknowledgeRealFunds: false,
  backend: 'http://127.0.0.1:5180',
  maxSpendUsd: 8,
  allowExistingAccount: false,
  startChain: 'ARBITRUM_ETH',
  keyTtlHours: 24,
  deposit: { chain: 'ARBITRUM_ETH', amount: '25' },
  transfers: { amount: '2' },
  orders: {
    spotSymbol: 'WSOSO_vUSDC',
    spotLimitOffsetPct: 50,
    sosoBuyQuantity: 'auto',
    perpsSymbol: 'BTC-USD',
    perpsLimitOffsetPct: 50,
    perpsCollateral: '8',
    triggerWaitSeconds: 45,
  },
  spotToEvm: { usdc: '3', soso: 'all' },
  evmToSpot: { usdc: '1' },
  withdrawValuechainSelf: { amount: '1' },
  withdrawValuechainOther: { amount: '1', receiver: 'valuechain' },
  withdrawExternal: { coin: 'USDC', chain: 'ARBITRUM_ETH', amount: '5', receiver: 'self' },
  extraDeposits: [],
  extraWithdrawals: [{ coin: 'ETH', chain: 'ARBITRUM_ETH', amount: 'min', receiver: 'self', buyIfMissing: true }],
  receivers: {},
  cleanup: { enabled: false, chain: 'ARBITRUM_ETH' },
  evmTour: { chains: 'all', skip: [], sellBack: true },
  chainWithdrawals: { skip: [], buyIfMissing: true },
  manualDeposits: [],
  builder: null,
  timeouts: { depositMinutes: 30, withdrawMinutes: 30, settleSeconds: 180, orderSeconds: 60, verifierMinutes: 15, addressIssueSeconds: 180, streamSeconds: 10 },
};

export interface LoadedConfig {
  config: RunConfig;
  /** Where it came from ('defaults' when no file was given). */
  source: string;
  errors: string[];
  warnings: string[];
}

const CHAIN_RE = /^[A-Z0-9_]{2,32}$/;
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Read and validate a config file (or the defaults, when `path` is null). */
export function loadConfig(path: string | null): LoadedConfig {
  if (!path) return { ...validateConfig({}), source: 'defaults' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { config: structuredClone(DEFAULT_CONFIG), source: path, errors: [`Cannot read ${path}: ${(e as Error).message}`], warnings: [] };
  }
  return { ...validateConfig(raw), source: path };
}

/** Merge `raw` over the defaults and check every field. Pure (tests call it directly). */
export function validateConfig(raw: unknown): Omit<LoadedConfig, 'source'> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('The config must be a JSON object.');
    return { config: cfg, errors, warnings };
  }
  const src = stripComments(raw) as Record<string, unknown>;

  const known = new Set(Object.keys(DEFAULT_CONFIG));
  for (const k of Object.keys(src)) if (!known.has(k)) warnings.push(`Unknown key "${k}" is ignored (a typo?).`);

  const bool = (v: unknown, where: string): boolean | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') errors.push(`${where} must be true or false.`);
    return typeof v === 'boolean' ? v : undefined;
  };
  const numIn = (v: unknown, where: string, lo: number, hi: number): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
      errors.push(`${where} must be a number from ${lo} to ${hi}.`);
      return undefined;
    }
    return v;
  };
  const amount = (v: unknown, where: string, words: readonly string[] = []): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v === 'number') {
      errors.push(`${where} must be a decimal STRING like "${v}" - a JSON number is already a float.`);
      return undefined;
    }
    if (typeof v !== 'string' || !(isDecimal(v) || words.includes(v))) {
      errors.push(`${where} must be a decimal string${words.length ? ` or one of ${words.map((w) => `"${w}"`).join(', ')}` : ''}.`);
      return undefined;
    }
    if (isDecimal(v) && Number(v) <= 0) {
      errors.push(`${where} must be more than 0.`);
      return undefined;
    }
    return v.trim();
  };
  const chain = (v: unknown, where: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !CHAIN_RE.test(v)) {
      errors.push(`${where} must be a SoDEX chain key like "ARBITRUM_ETH".`);
      return undefined;
    }
    return v;
  };
  const text = (v: unknown, where: string, re = /^[A-Za-z0-9_.-]{1,40}$/): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !re.test(v)) {
      errors.push(`${where} is not valid.`);
      return undefined;
    }
    return v;
  };
  const obj = (v: unknown, where: string, keys: readonly string[]): Record<string, unknown> | undefined => {
    if (v === undefined) return undefined;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      errors.push(`${where} must be an object.`);
      return undefined;
    }
    for (const k of Object.keys(v)) if (!keys.includes(k)) warnings.push(`Unknown key "${where}.${k}" is ignored (a typo?).`);
    return v as Record<string, unknown>;
  };
  const set = <T>(v: T | undefined, apply: (x: T) => void) => {
    if (v !== undefined) apply(v);
  };

  set(bool(src.acknowledgeRealFunds, 'acknowledgeRealFunds'), (v) => (cfg.acknowledgeRealFunds = v));
  if (src.backend !== undefined) {
    if (typeof src.backend !== 'string' || !/^https?:\/\/[^/\s]+$/.test(src.backend.replace(/\/+$/, ''))) errors.push('backend must be an origin like "http://127.0.0.1:5180".');
    else cfg.backend = src.backend.replace(/\/+$/, '');
  }
  set(numIn(src.maxSpendUsd, 'maxSpendUsd', 0, 1000), (v) => (cfg.maxSpendUsd = v));
  set(bool(src.allowExistingAccount, 'allowExistingAccount'), (v) => (cfg.allowExistingAccount = v));
  set(chain(src.startChain, 'startChain'), (v) => (cfg.startChain = v));
  set(numIn(src.keyTtlHours, 'keyTtlHours', 1, 168), (v) => (cfg.keyTtlHours = v));

  const dep = obj(src.deposit, 'deposit', ['chain', 'amount']);
  if (dep) {
    set(chain(dep.chain, 'deposit.chain'), (v) => (cfg.deposit.chain = v));
    set(amount(dep.amount, 'deposit.amount'), (v) => (cfg.deposit.amount = v));
  }
  const tr = obj(src.transfers, 'transfers', ['amount']);
  if (tr) set(amount(tr.amount, 'transfers.amount'), (v) => (cfg.transfers.amount = v));

  const ord = obj(src.orders, 'orders', ['spotSymbol', 'spotLimitOffsetPct', 'sosoBuyQuantity', 'perpsSymbol', 'perpsLimitOffsetPct', 'perpsCollateral', 'triggerWaitSeconds']);
  if (ord) {
    set(text(ord.spotSymbol, 'orders.spotSymbol', /^[A-Za-z0-9_./-]{1,40}$/), (v) => (cfg.orders.spotSymbol = v));
    set(numIn(ord.spotLimitOffsetPct, 'orders.spotLimitOffsetPct', 1, 90), (v) => (cfg.orders.spotLimitOffsetPct = v));
    set(amount(ord.sosoBuyQuantity, 'orders.sosoBuyQuantity', ['auto']), (v) => (cfg.orders.sosoBuyQuantity = v));
    set(text(ord.perpsSymbol, 'orders.perpsSymbol', /^[A-Za-z0-9_./-]{1,40}$/), (v) => (cfg.orders.perpsSymbol = v));
    set(numIn(ord.perpsLimitOffsetPct, 'orders.perpsLimitOffsetPct', 1, 90), (v) => (cfg.orders.perpsLimitOffsetPct = v));
    set(amount(ord.perpsCollateral, 'orders.perpsCollateral'), (v) => (cfg.orders.perpsCollateral = v));
    set(numIn(ord.triggerWaitSeconds, 'orders.triggerWaitSeconds', 0, 600), (v) => (cfg.orders.triggerWaitSeconds = v));
  }
  const s2e = obj(src.spotToEvm, 'spotToEvm', ['usdc', 'soso']);
  if (s2e) {
    set(amount(s2e.usdc, 'spotToEvm.usdc'), (v) => (cfg.spotToEvm.usdc = v));
    set(amount(s2e.soso, 'spotToEvm.soso', ['all']), (v) => (cfg.spotToEvm.soso = v));
  }
  const e2s = obj(src.evmToSpot, 'evmToSpot', ['usdc']);
  if (e2s) set(amount(e2s.usdc, 'evmToSpot.usdc'), (v) => (cfg.evmToSpot.usdc = v));
  const wvs = obj(src.withdrawValuechainSelf, 'withdrawValuechainSelf', ['amount']);
  if (wvs) set(amount(wvs.amount, 'withdrawValuechainSelf.amount'), (v) => (cfg.withdrawValuechainSelf.amount = v));
  const wvo = obj(src.withdrawValuechainOther, 'withdrawValuechainOther', ['amount', 'receiver']);
  if (wvo) {
    set(amount(wvo.amount, 'withdrawValuechainOther.amount'), (v) => (cfg.withdrawValuechainOther.amount = v));
    set(text(wvo.receiver, 'withdrawValuechainOther.receiver', NAME_RE), (v) => (cfg.withdrawValuechainOther.receiver = v));
  }
  const wx = obj(src.withdrawExternal, 'withdrawExternal', ['coin', 'chain', 'amount', 'receiver']);
  if (wx) {
    set(text(wx.coin, 'withdrawExternal.coin'), (v) => (cfg.withdrawExternal.coin = v));
    set(chain(wx.chain, 'withdrawExternal.chain'), (v) => (cfg.withdrawExternal.chain = v));
    set(amount(wx.amount, 'withdrawExternal.amount', ['min']), (v) => (cfg.withdrawExternal.amount = v));
    set(text(wx.receiver, 'withdrawExternal.receiver', NAME_RE), (v) => (cfg.withdrawExternal.receiver = v));
  }
  if (src.extraDeposits !== undefined) {
    if (!Array.isArray(src.extraDeposits)) errors.push('extraDeposits must be a list.');
    else {
      cfg.extraDeposits = [];
      src.extraDeposits.forEach((d, i) => {
        const o = obj(d, `extraDeposits[${i}]`, ['chain', 'amount']);
        const c = chain(o?.chain, `extraDeposits[${i}].chain`);
        const a = amount(o?.amount, `extraDeposits[${i}].amount`);
        if (o && (!c || !a)) errors.push(`extraDeposits[${i}] needs "chain" and "amount".`);
        if (c && a) cfg.extraDeposits.push({ chain: c, amount: a });
      });
    }
  }
  if (src.extraWithdrawals !== undefined) {
    if (!Array.isArray(src.extraWithdrawals)) errors.push('extraWithdrawals must be a list.');
    else {
      cfg.extraWithdrawals = [];
      src.extraWithdrawals.forEach((w, i) => {
        const where = `extraWithdrawals[${i}]`;
        const o = obj(w, where, ['coin', 'chain', 'amount', 'receiver', 'buyIfMissing']);
        if (!o) return;
        const coin = text(o.coin, `${where}.coin`);
        const c = chain(o.chain, `${where}.chain`);
        const a = amount(o.amount, `${where}.amount`, ['min', 'all']);
        const r = text(o.receiver ?? 'self', `${where}.receiver`, NAME_RE);
        const buy = bool(o.buyIfMissing, `${where}.buyIfMissing`);
        if (!coin || !c || !a || !r) {
          errors.push(`${where} needs "coin", "chain", "amount" and "receiver".`);
          return;
        }
        cfg.extraWithdrawals.push({ coin, chain: c, amount: a, receiver: r, buyIfMissing: buy ?? false });
      });
    }
  }
  const rc = obj(src.receivers, 'receivers', Object.keys((src.receivers as object | undefined) ?? {}));
  if (rc) {
    cfg.receivers = {};
    for (const [name, v] of Object.entries(rc)) {
      if (!NAME_RE.test(name) || name === 'self') {
        errors.push(`receivers."${name}": a receiver name is letters, digits, "_" or "-" (and not "self").`);
        continue;
      }
      if (v === '' || v === null) continue; // an unset receiver: the steps that need it are skipped
      if (typeof v === 'string') {
        cfg.receivers[name] = { address: v.trim() };
        continue;
      }
      const r = obj(v, `receivers.${name}`, ['address', 'memo', 'noMemo']);
      if (!r) continue;
      if (typeof r.address !== 'string' || !r.address.trim()) {
        errors.push(`receivers.${name}.address must be a string.`);
        continue;
      }
      if (r.memo !== undefined && (typeof r.memo !== 'string' || !/^\d{1,20}$/.test(r.memo))) {
        errors.push(`receivers.${name}.memo must be a string of digits.`);
        continue;
      }
      const noMemo = bool(r.noMemo, `receivers.${name}.noMemo`);
      cfg.receivers[name] = { address: r.address.trim(), ...(r.memo !== undefined ? { memo: r.memo as string } : {}), ...(noMemo ? { noMemo } : {}) };
    }
  }
  const cl = obj(src.cleanup, 'cleanup', ['enabled', 'chain']);
  if (cl) {
    set(bool(cl.enabled, 'cleanup.enabled'), (v) => (cfg.cleanup.enabled = v));
    set(chain(cl.chain, 'cleanup.chain'), (v) => (cfg.cleanup.chain = v));
  }
  const tour = obj(src.evmTour, 'evmTour', ['chains', 'skip', 'sellBack']);
  if (tour) {
    if (tour.chains !== undefined) {
      if (tour.chains === 'all') cfg.evmTour.chains = 'all';
      else if (!Array.isArray(tour.chains)) errors.push('evmTour.chains must be "all" or a list of chain keys.');
      else {
        const list = tour.chains.map((c, i) => chain(c, `evmTour.chains[${i}]`)).filter((c): c is string => !!c);
        if (list.length === tour.chains.length) cfg.evmTour.chains = list;
      }
    }
    if (tour.skip !== undefined) {
      if (!Array.isArray(tour.skip)) errors.push('evmTour.skip must be a list of chain keys.');
      else cfg.evmTour.skip = tour.skip.map((c, i) => chain(c, `evmTour.skip[${i}]`)).filter((c): c is string => !!c);
    }
    set(bool(tour.sellBack, 'evmTour.sellBack'), (v) => (cfg.evmTour.sellBack = v));
  }
  const cw = obj(src.chainWithdrawals, 'chainWithdrawals', ['skip', 'buyIfMissing']);
  if (cw) {
    if (cw.skip !== undefined) {
      if (!Array.isArray(cw.skip)) errors.push('chainWithdrawals.skip must be a list of chain keys.');
      else cfg.chainWithdrawals.skip = cw.skip.map((c, i) => chain(c, `chainWithdrawals.skip[${i}]`)).filter((c): c is string => !!c);
    }
    set(bool(cw.buyIfMissing, 'chainWithdrawals.buyIfMissing'), (v) => (cfg.chainWithdrawals.buyIfMissing = v));
  }
  if (src.manualDeposits !== undefined) {
    if (!Array.isArray(src.manualDeposits)) errors.push('manualDeposits must be a list.');
    else {
      cfg.manualDeposits = [];
      src.manualDeposits.forEach((d, i) => {
        const where = `manualDeposits[${i}]`;
        const o = obj(d, where, ['coin', 'chain', 'amount', 'skip']);
        if (!o) return;
        const coin = text(o.coin, `${where}.coin`);
        const c = chain(o.chain, `${where}.chain`);
        const a = amount(o.amount ?? 'auto', `${where}.amount`, ['auto']);
        const skip = bool(o.skip, `${where}.skip`);
        if (!coin || !c || !a) {
          errors.push(`${where} needs "coin", "chain" and "amount".`);
          return;
        }
        if (cfg.manualDeposits.some((x) => x.coin.toUpperCase() === coin.toUpperCase() && x.chain === c)) {
          errors.push(`${where}: ${coin} on ${c} is listed twice.`);
          return;
        }
        cfg.manualDeposits.push({ coin, chain: c, amount: a, ...(skip ? { skip: true } : {}) });
      });
    }
  }
  if (src.builder !== undefined && src.builder !== null) {
    const b = obj(src.builder, 'builder', ['id', 'address', 'feePerps', 'feeSpot', 'maxFee', 'maxFeeRate', 'required', 'revokeAtEnd', 'termsKeys', 'expectTier']);
    if (b) {
      const whole = (v: unknown, where: string, lo: number, hi: number): number | undefined => {
        const n = numIn(v, where, lo, hi);
        if (n !== undefined && !Number.isInteger(n)) {
          errors.push(`${where} must be a whole number (tenths of a basis point).`);
          return undefined;
        }
        return n;
      };
      const before = errors.length;
      const id = whole(b.id, 'builder.id', 1, Number.MAX_SAFE_INTEGER);
      let address: string | null = null;
      if (b.address !== undefined && b.address !== null && b.address !== '') {
        if (typeof b.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(b.address.trim())) errors.push("builder.address must be the builder account's wallet ADDRESS (0x + 40 hex) - never a key.");
        else address = b.address.trim().toLowerCase();
      }
      const feePerps = whole(b.feePerps ?? 0, 'builder.feePerps', 0, 200) ?? 0;
      const feeSpot = whole(b.feeSpot ?? 0, 'builder.feeSpot', 0, 2000) ?? 0;
      // `maxFeeRate` is SoDEX's own name for it (and the app's); either spelling, not two different values.
      if (b.maxFee !== undefined && b.maxFeeRate !== undefined && b.maxFee !== b.maxFeeRate) errors.push('builder.maxFee and builder.maxFeeRate are the same setting - give one.');
      const maxFee = whole(b.maxFee ?? b.maxFeeRate ?? Math.max(feePerps, feeSpot), b.maxFee !== undefined ? 'builder.maxFee' : 'builder.maxFeeRate', 0, 2000) ?? 0;
      // A build with a builder requires the approval (docs/BUILDER-TIERS.md G1); `false` tests an optional build.
      const required = bool(b.required, 'builder.required') ?? true;
      const revokeAtEnd = bool(b.revokeAtEnd, 'builder.revokeAtEnd') ?? false;
      const termsKeys: string[] = [];
      if (b.termsKeys !== undefined && b.termsKeys !== null) {
        if (!Array.isArray(b.termsKeys)) errors.push('builder.termsKeys must be a list of public keys (base64url of the raw 32 bytes).');
        else {
          b.termsKeys.forEach((k, i) => {
            const ok = typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k.trim()) && Buffer.from(k.trim(), 'base64url').length === 32;
            if (!ok) errors.push(`builder.termsKeys[${i}] is not an Ed25519 PUBLIC key (43 characters of base64url = 32 bytes).`);
            else termsKeys.push((k as string).trim());
          });
        }
      }
      let expectTier: RunBuilder['expectTier'] = null;
      if (b.expectTier !== undefined && b.expectTier !== null) {
        const t = obj(b.expectTier, 'builder.expectTier', ['atUsd', 'perps', 'spot']);
        const atUsd = numIn(t?.atUsd, 'builder.expectTier.atUsd', 0, 1_000_000);
        const perps = whole(t?.perps, 'builder.expectTier.perps', 0, 200);
        const spot = whole(t?.spot, 'builder.expectTier.spot', 0, 2000);
        if (t && (atUsd === undefined || perps === undefined || spot === undefined)) errors.push('builder.expectTier needs "atUsd", "perps" and "spot".');
        else if (t) {
          if (perps! > feePerps || spot! > feeSpot) errors.push('builder.expectTier names a fee above the default - a tier can only lower the fee.');
          else expectTier = { atUsd: atUsd!, perps: perps!, spot: spot! };
        }
      }
      if (id === undefined) errors.push('builder.id (the builder account id) is required.');
      if (feePerps === 0 && feeSpot === 0) errors.push('builder needs feePerps or feeSpot above 0 (or set "builder": null).');
      if (maxFee < Math.max(feePerps, feeSpot)) errors.push('builder.maxFee is below the fee it has to cover.');
      if (errors.length === before && id !== undefined) cfg.builder = { id, address, feePerps, feeSpot, maxFee, required, revokeAtEnd, termsKeys, expectTier };
    }
  }
  const to = obj(src.timeouts, 'timeouts', ['depositMinutes', 'withdrawMinutes', 'settleSeconds', 'orderSeconds', 'verifierMinutes', 'addressIssueSeconds', 'streamSeconds']);
  if (to) {
    set(numIn(to.depositMinutes, 'timeouts.depositMinutes', 1, 240), (v) => (cfg.timeouts.depositMinutes = v));
    set(numIn(to.withdrawMinutes, 'timeouts.withdrawMinutes', 1, 240), (v) => (cfg.timeouts.withdrawMinutes = v));
    set(numIn(to.settleSeconds, 'timeouts.settleSeconds', 10, 3600), (v) => (cfg.timeouts.settleSeconds = v));
    set(numIn(to.orderSeconds, 'timeouts.orderSeconds', 5, 600), (v) => (cfg.timeouts.orderSeconds = v));
    set(numIn(to.verifierMinutes, 'timeouts.verifierMinutes', 0.01, 60), (v) => (cfg.timeouts.verifierMinutes = v));
    set(numIn(to.addressIssueSeconds, 'timeouts.addressIssueSeconds', 0, 3600), (v) => (cfg.timeouts.addressIssueSeconds = v));
    set(numIn(to.streamSeconds, 'timeouts.streamSeconds', 0.05, 120), (v) => (cfg.timeouts.streamSeconds = v));
  }

  // Receivers named by steps must exist (or be "self").
  const named: Array<[string, string]> = [
    ['withdrawExternal.receiver', cfg.withdrawExternal.receiver],
    ...cfg.extraWithdrawals.map((w, i): [string, string] => [`extraWithdrawals[${i}].receiver`, w.receiver]),
  ];
  for (const [where, r] of named) {
    if (r !== 'self' && !cfg.receivers[r]) errors.push(`${where} is "${r}", but receivers has no "${r}" (set it, or use "self").`);
  }
  if (cfg.withdrawValuechainOther.receiver === 'self') errors.push('withdrawValuechainOther.receiver must name a DIFFERENT address in receivers, not "self".');
  return { config: cfg, errors, warnings };
}

function stripComments(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripComments);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!k.startsWith('//')) out[k] = stripComments(x);
    return out;
  }
  return v;
}
