/**
 * What every step shares: the run's context, the step recorder (console lines
 * + the JSON report), `armed()` - the one way a step lets a write leave - and
 * `scenario()` - the one way a step records an assertion.
 */
import { OrderValidationError, SodexApiError } from '@sodex-core';
import type { DepositChain } from '../../src/api';
import type { ChainRoute, CoinConfig } from '../../src/trading/funds';
import { OutcomeUnknownError } from '../../src/trading/gateway';
import { TradingError } from '../../src/trading/session';
import type { AppTerms } from './app';
import type { Checks } from './checks';
import type { RunConfig, ReceiverSpec } from './config';
import type { FeeRates, FillCheck } from './fees';
import type { Expectation, Guard } from './guard';
import type { HistoryLimiter } from './history';
import type { Ledger } from './ledger';
import type { NativeRegistry } from './native';
import type { OwnerInput } from './ownerInput';
import type { KeyProvider, ProviderPolicy } from './provider';
import type { InFlight, Snapshot } from './reads';
import type { AccountStream } from './stream';
import type { TermsWatch } from './terms';
import { dur, errText, hhmmss } from './util';

/**
 * How long to wait before reading again after `e`, or null when `e` is an answer
 * (a refusal, a validation error) that reading again would only repeat.
 */
export function transientWait(e: unknown, base: number | undefined): number | null {
  if (base === undefined) return null;
  const x = e as { name?: string; retryInMs?: number; httpStatus?: number; status?: number; message?: string; cause?: { code?: string } } | null;
  if (x?.name === 'RateLimitedError') return Math.max(base, (x.retryInMs ?? 0) + 2_000);
  if (x?.name === 'UnreachableError') return base;
  // A read the app gave up on (its own timeout aborted it): a slow node or gateway, worth one more try.
  if (x?.name === 'AbortError' || x?.name === 'TimeoutError') return base;
  const status = x?.httpStatus ?? x?.status ?? 0;
  if (status === 429) return Math.max(base, 60_000);
  if (status >= 500 && status <= 599) return base;
  const text = `${x?.message ?? ''} ${x?.cause?.code ?? ''}`;
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|timed? ?out|did not answer|operation was aborted|not a batch answer/i.test(text)) return base;
  return null;
}

export type Mode = 'plan' | 'live';

export const STEP_ORDER = [
  'deposit-external',
  'enable-trading',
  'transfers',
  'builder-tiers',
  'orders-spot',
  'orders-perps',
  'refusals',
  'spot-to-evm',
  'evm-to-spot',
  'withdraw-valuechain-self',
  'withdraw-valuechain-other',
  'withdraw-external',
  'extra-deposits',
  'extra-withdrawals',
  'evm-tour',
  'chain-withdrawals',
  'manual-deposits',
  'key-lifecycle',
  'cleanup',
  'cross-check',
  'revoke-builder',
] as const;
export type StepId = (typeof STEP_ORDER)[number];

/** Names `--only` also takes, for what they were called before. */
export const STEP_ALIASES: Readonly<Record<string, readonly StepId[]>> = {
  orders: ['orders-spot', 'orders-perps'],
};

export const STEP_TITLES: Record<StepId, string> = {
  'deposit-external': 'deposit USDC from an EVM chain to the wallet\'s own SoDEX deposit address',
  'enable-trading': 'approve the builder fee (if one is set) and register a trading key',
  transfers: 'Spot -> Perps -> Spot',
  'builder-tiers': 'the builder fee: default fee, verified volume, lower fee, cheating attempts, approval enforcement',
  'orders-spot': 'spot orders: limit rest / change / cancel, market buy by funds and by quantity, market sell, IOC, FOK, post-only',
  'orders-perps': 'perps orders: leverage and margin modes, every order type, exits, cancel-all, dead-man switch',
  refusals: 'what must be refused: nothing here may move anything',
  'spot-to-evm': 'Spot -> ValueChain wallet (USDC and SOSO)',
  'evm-to-spot': 'ValueChain wallet -> Spot (USDC)',
  'withdraw-valuechain-self': 'withdraw to the own ValueChain wallet',
  'withdraw-valuechain-other': 'withdraw to another ValueChain address',
  'withdraw-external': 'withdraw to another chain (SoDEX permit)',
  'extra-deposits': 'extra deposits from other EVM chains',
  'extra-withdrawals': 'extra withdrawals per chain',
  'evm-tour': 'every EVM chain the runner signs on, out and back: the native coin (withdrawn, sent back to the deposit address), then USDC',
  'chain-withdrawals': 'per route on a chain the runner cannot sign on: a withdrawal to your own address there',
  'manual-deposits': 'the deposits you send by hand from other chains: the run shows the verified address and waits for the credit',
  'key-lifecycle': 'the trading key: restore, still registered, revoke, an order with the old key is rejected',
  cleanup: 'move everything back to Spot and withdraw to the deposit chain',
  'cross-check': 'reconcile SoDEX\'s order history and fills with what the run recorded',
  'revoke-builder': 'revoke the builder-fee approval (one wallet signature)',
};

export interface TxRecord {
  chain: string;
  hash: string;
  what: string;
  explorer?: string;
  status?: string;
  gas?: string;
  gasUsd?: number;
}

export interface SubRecord {
  title: string;
  status: 'ok' | 'failed' | 'warn';
  startedAt: string;
  ms: number;
  detail?: string;
}

export interface StepRecord {
  id: StepId | 'preflight';
  title: string;
  status: 'planned' | 'running' | 'ok' | 'failed' | 'skipped' | 'blocked';
  startedAt?: string;
  endedAt?: string;
  ms?: number;
  /** What the plan said this step would do. */
  plan?: string[];
  estimateUsd?: number;
  /** Measured: priced holdings before/after (price moves of held coins show up here too). */
  measured?: { valueBeforeUsd: number; valueAfterUsd: number; sentAwayUsd: number; costUsd: number };
  amounts: Record<string, string>;
  fees: Record<string, string>;
  txs: TxRecord[];
  subSteps: SubRecord[];
  notes: string[];
  /** The assertions this step recorded, by verdict (the full list is the report's `checks`). */
  checks?: { pass: number; fail: number; finding: number; skipped: number; failed: string[] };
  error?: string;
  reason?: string;
}

/** Console lines and the report's step records, written together. */
export class Recorder {
  readonly steps: StepRecord[] = [];
  current: StepRecord | null = null;
  constructor(private readonly out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {}

  line(text: string, indent = 0): void {
    for (const part of text.split('\n')) this.out(`${hhmmss()}  ${' '.repeat(indent)}${part}`);
  }
  begin(id: StepRecord['id'], title: string): StepRecord {
    const r: StepRecord = { id, title, status: 'running', startedAt: new Date().toISOString(), amounts: {}, fees: {}, txs: [], subSteps: [], notes: [] };
    this.steps.push(r);
    this.current = r;
    this.line(`== ${id}: ${title}`);
    return r;
  }
  note(text: string): void {
    this.current?.notes.push(text);
    this.line(text, 5);
  }
  amount(k: string, v: string): void {
    if (this.current) this.current.amounts[k] = v;
  }
  fee(k: string, v: string): void {
    if (this.current) this.current.fees[k] = v;
  }
  tx(t: TxRecord): void {
    this.current?.txs.push(t);
    this.line(`tx ${t.what}: ${t.hash} on ${t.chain}${t.explorer ? ` (${t.explorer})` : ''}`, 5);
  }
  /**
   * A timed READ-ONLY sub-step that is tried again when the failure is the network's,
   * not an answer: a timeout, a dropped connection, a 5xx, a rate limit. One slow
   * answer of a public endpoint must not end a run before it started (seen live: the
   * asset config timed out once and the whole plan failed). Never use it for anything
   * that writes - a write that may have landed is not repeated.
   */
  async read<T>(title: string, fn: () => Promise<T>, detail?: (v: T) => string | undefined): Promise<T> {
    const waits = [5_000, 15_000, 45_000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sub(attempt ? `${title} (again, ${attempt + 1} of ${waits.length + 1})` : title, fn, detail);
      } catch (e) {
        const wait = transientWait(e, waits[attempt]);
        if (wait === null || attempt >= waits.length) throw e;
        this.line(`the network failed, not SoDEX's answer (${errText(e)}) - trying again in ${Math.round(wait / 1000)} s`, 5);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  /** A timed sub-step; its failure fails the step. */
  async sub<T>(title: string, fn: () => Promise<T>, detail?: (v: T) => string | undefined): Promise<T> {
    const t0 = Date.now();
    this.line(`- ${title}`, 3);
    try {
      const v = await fn();
      const d = detail?.(v);
      this.current?.subSteps.push({ title, status: 'ok', startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, ...(d ? { detail: d } : {}) });
      this.line(`ok (${dur(Date.now() - t0)})${d ? ` ${d}` : ''}`, 5);
      return v;
    } catch (e) {
      this.current?.subSteps.push({ title, status: 'failed', startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, detail: errText(e) });
      throw e;
    }
  }
  warn(title: string, detail: string): void {
    this.current?.subSteps.push({ title, status: 'warn', startedAt: new Date().toISOString(), ms: 0, detail });
    this.line(`WARNING ${title}: ${detail}`, 5);
  }
  end(status: StepRecord['status'], error?: unknown): void {
    const r = this.current;
    if (!r) return;
    r.status = status;
    r.endedAt = new Date().toISOString();
    r.ms = Date.parse(r.endedAt) - Date.parse(r.startedAt ?? r.endedAt);
    if (error !== undefined) r.error = errText(error);
    this.line(`${status === 'ok' ? 'ok' : status.toUpperCase()} ${r.id} (${dur(r.ms)})${r.error ? `: ${r.error}` : ''}`);
    this.current = null;
  }
  skip(id: StepId, title: string, reason: string): void {
    this.steps.push({ id, title, status: 'skipped', reason, amounts: {}, fees: {}, txs: [], subSteps: [], notes: [] });
    this.line(`-- ${id}: skipped - ${reason}`);
  }
}

/** Deposit address per chain: the backend's answer and the on-chain registry's, side by side. */
export interface DepositAddressCheck {
  backend: string | null;
  backendVerified: boolean;
  registry: string | null;
  /** Both present and equal (case-insensitive: EVM). */
  match: boolean;
  note?: string;
}

/** What preflight established; the steps rely on it. */
export interface Pre {
  health: { network: string; chainId: number; mainnetWritesAllowed: boolean };
  vc: DepositChain;
  coins: CoinConfig[];
  usdc: CoinConfig;
  soso: CoinConfig;
  accountId: number;
  newAccount: boolean;
  depositAddresses: Map<string, DepositAddressCheck>;
  /** Estimated cost per step (USD, including value sent to other addresses), from the plan. */
  estimates: Map<StepId, { costUsd: number; sentAwayUsd: number }>;
}

/** The builder account's vUSDC, read before the run's first order (public reads). */
export interface BuilderBalances {
  at: number;
  spot: string | null;
  perps: string | null;
}

export interface Ctx {
  mode: Mode;
  /** The run profile (profiles.ts). */
  profile: string;
  cfg: RunConfig;
  owner: string;
  provider: KeyProvider;
  guard: Guard;
  rec: Recorder;
  pre: Pre;
  selected: Set<StepId>;
  registryOnly: boolean;
  inFlight: InFlight[];
  /** Running totals, checked against cfg.maxSpendUsd before every step. */
  spend: { costUsd: number; sentAwayUsd: number };
  /** What the running step sent to addresses other than the wallet (USD) - not a cost, but it leaves this wallet. */
  stepSentAwayUsd: number;
  lastSnapshot: Snapshot | null;
  /** Every assertion of the run. */
  checks: Checks;
  /** Every order that left, SoDEX's answers, and every fill. */
  ledger: Ledger;
  /** The wallet's account stream (null: not opened - plan mode, or it could not be). */
  stream: AccountStream | null;
  /** The one door to the rate-limited history routes (null in plan mode: they are never read). */
  history: HistoryLimiter | null;
  /** The signed fee terms the runner itself has seen verify (null: no terms keys in the config). */
  terms: TermsWatch | null;
  /** The app's terms module (null: this checkout has none, or no terms keys are configured). */
  appTerms: AppTerms | null;
  /** The account's own fee rates per engine, read once (null: SoDEX reported none). */
  feeRates: { spot?: FeeRates | null; perps?: FeeRates | null };
  /** The fee check of every fill judged so far, by fill key (the report's fee table). */
  fillChecks: Map<string, FillCheck>;
  /** The builder account's balances before the run's first order. */
  builderBaseline: BuilderBalances | null;
  /** When the run started (ms): history is read from here on. */
  startedAtMs: number;
  /** Every signature / transaction the test wallet refused (its policy did not allow it), in order. */
  walletRefusals: string[];
  /** Every typed-data signature the test wallet GAVE, by primary type, in order ("ONE signature" is counted from this). */
  walletSigned: string[];
  /** The check of each configured deposit / withdrawal, by `<step>#<index>` (declared once the routes are known). */
  routeChecks: Map<string, string>;
  /** What the builder-tiers step learned and the final cross-check judges fills against. */
  tiers: { defaultFee?: number; loweredFee?: number; cheats: Array<{ kind: 'underpaid' | 'no-builder'; orderID: number | null; clOrdID: string | null; notional: string }> };
  /** Set by a step to make the app's NEXT terms answer a tampered copy of the real one (runner.ts wires it into the app's terms module). */
  tamperTerms: ((body: Record<string, unknown>) => Record<string, unknown>) | null;
  /** For the offline simulation only: called when the run waits for a deposit the OWNER sends by hand. A real run never sets it. */
  onManualDeposit: ((d: { coin: string; chain: string; address: string; amount: string }) => void) | null;
  /** What the owner types while the run waits for a hand-sent deposit (`s` skips it). null: no keyboard - the wait runs to its time-out. */
  ownerInput: OwnerInput | null;
  /**
   * The chains the runner cannot sign on (chain-withdrawals, manual-deposits): per coin, the units
   * these steps added to Spot (bought, credited by a hand-sent deposit) less what they withdrew -
   * what is sold back to USDC at the end.
   */
  otherCoins: Map<string, bigint>;
  /** Per route (`COIN|CHAIN`): the chain withdrawal to the owner ran, and what arrived there. */
  handArrived: Map<string, string>;
  /** Routes whose withdrawal waits for the owner's hand-sent deposit (no spot market to buy the coin on). */
  deferredWithdrawals: Set<string>;
  /** The non-EVM chains the runner signs on itself (native/index.ts; the simulation's fakes in tests). null: none. */
  native: NativeRegistry | null;
}

/** A refusal from the runner's own safety rules - nothing was signed or sent. */
export class SafetyStop extends Error {
  override name = 'SafetyStop';
}

/**
 * The app tried to send or sign something the running step had not armed, and
 * the runner's guard or wallet said no. NOTHING left the process - so inside a
 * scenario this fails that scenario and the step goes on; in a funds step (a
 * chain of moves) it stops the run like any SafetyStop.
 */
export class Refused extends SafetyStop {
  override name = 'Refused';
}

/** An assertion of a scenario did not hold. The account is in a state the scenario's recovery can clear. */
export class CheckFailure extends Error {
  override name = 'CheckFailure';
  constructor(
    message: string,
    readonly evidence: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Run `fn` with exactly these writes expected by the network guard and exactly
 * this wallet policy - and nothing else. Both are removed afterwards, whatever
 * happened. A request the guard refused inside `fn` is named in the error.
 */
export async function armed<T>(ctx: Ctx, a: { expect?: Expectation[]; policy?: ProviderPolicy }, fn: () => Promise<T>): Promise<T> {
  const before = ctx.guard.refusals.length;
  const signedBefore = ctx.walletRefusals.length;
  const disarm = a.expect?.length ? ctx.guard.expect(a.expect) : () => undefined;
  ctx.provider.setPolicy(a.policy ?? null);
  try {
    return await fn();
  } catch (e) {
    const blocked = ctx.guard.refusals.slice(before);
    if (blocked.length) {
      throw new Refused(`${errText(e)} [the E2E guard refused ${blocked.map((b) => `${b.what} (${b.blocked})`).join('; ')} - that request was NOT sent]`);
    }
    const unsigned = ctx.walletRefusals.slice(signedBefore);
    if (unsigned.length) throw new Refused(`${errText(e)} [the test wallet refused ${unsigned.join('; ')} - nothing was signed]`);
    throw e;
  } finally {
    disarm();
    ctx.provider.setPolicy(null);
  }
}

/**
 * A definite "no" that moved nothing: the app refused before signing
 * (validation, the trading gate), or SoDEX answered with a rejection. NOT an
 * unanswered write (that may have executed) and not a refusal by the runner's
 * own guard or wallet (that means the app tried something the step did not expect).
 */
export function isDefiniteRefusal(e: unknown): boolean {
  if (e instanceof SafetyStop || e instanceof OutcomeUnknownError) return false;
  return e instanceof SodexApiError || e instanceof TradingError || e instanceof OrderValidationError || e instanceof RangeError;
}

/**
 * One assertion of a step. `fn` records its own verdict (ctx.checks.pass /
 * finding / skip) and may throw:
 *   CheckFailure, or a definite refusal  -> recorded as FAIL, `recover` puts the
 *                                           account back in order, the step goes on;
 *   anything else (a timeout, an unanswered write, a refusal by the guard)
 *                                        -> recorded as FAIL and thrown: the run stops,
 *                                           because the account's state is not known.
 * A scenario that returns without recording anything is a bug in the runner and fails.
 */
export async function scenario(ctx: Ctx, id: string, fn: () => Promise<void>, recover?: () => Promise<void>): Promise<void> {
  ctx.rec.line(`* ${id}`, 3);
  try {
    await fn();
    if (!ctx.checks.get(id)) ctx.checks.fail(id, 'the scenario ended without a verdict (a bug in the runner)');
  } catch (e) {
    const soft = e instanceof CheckFailure || e instanceof Refused || isDefiniteRefusal(e);
    ctx.checks.fail(id, errText(e), e instanceof CheckFailure ? e.evidence : {});
    if (!soft) throw e;
    if (recover) {
      try {
        await recover();
      } catch (r) {
        throw new SafetyStop(`${id} failed (${errText(e)}) and the account could not be put back in order: ${errText(r)}`);
      }
    }
  }
}

export function coinNamed(ctx: Ctx, name: string): CoinConfig {
  const c = ctx.pre.coins.find((x) => x.coin.toUpperCase() === name.toUpperCase());
  if (!c) throw new SafetyStop(`SoDEX's asset config has no coin "${name}".`);
  return c;
}

export function routeOf(coin: CoinConfig, chain: string): ChainRoute {
  const r = coin.chains.find((c) => c.key === chain);
  if (!r) throw new SafetyStop(`${coin.coin} has no route on ${chain} in SoDEX's asset config.`);
  return r;
}

/** The receiver a step names: the wallet itself, or an entry of `receivers` (the ONLY other destinations allowed). */
export function receiverNamed(ctx: Ctx, name: string): ReceiverSpec & { self: boolean } {
  if (name === 'self') return { address: ctx.owner, self: true };
  if (name.startsWith('native:')) {
    // The test wallet's own address on a chain the runner signs on (the same key): its own - nothing leaves the owner.
    const chain = ctx.native?.chains.find((c) => c.chainKey === name.slice('native:'.length));
    if (!chain || !ctx.native) throw new SafetyStop(`the runner does not sign on ${name.slice('native:'.length)}`);
    return { address: chain.address(ctx.native.keys), noMemo: true, self: true };
  }
  const r = ctx.cfg.receivers[name];
  if (!r) throw new SafetyStop(`No receiver "${name}" in the config.`);
  return { ...r, self: r.address.toLowerCase() === ctx.owner };
}

/** Every address money may be sent to in this run: the wallet itself and the configured receivers. */
export function allowedReceivers(ctx: Ctx): Set<string> {
  const native = ctx.native ? ctx.native.chains.map((c) => c.address(ctx.native!.keys).toLowerCase()) : [];
  return new Set([ctx.owner, ...Object.values(ctx.cfg.receivers).map((r) => r.address.toLowerCase()), ...native]);
}

/** Refuse a step whose estimate would take the run past maxSpendUsd. */
export function checkBudget(ctx: Ctx, id: StepId, estimateUsd: number): void {
  const spent = ctx.spend.costUsd + ctx.spend.sentAwayUsd;
  if (spent + estimateUsd > ctx.cfg.maxSpendUsd + 1e-9) {
    throw new SafetyStop(
      `budget: ${id} is estimated at $${estimateUsd.toFixed(2)}; with $${spent.toFixed(2)} already spent that exceeds maxSpendUsd $${ctx.cfg.maxSpendUsd.toFixed(2)}. Nothing was sent for this step.`,
    );
  }
}
