/**
 * What every step shares: the run's context, the step recorder (console lines
 * + the JSON report), and `armed()` - the one way a step lets money move.
 */
import type { DepositChain } from '../../src/api';
import type { ChainRoute, CoinConfig } from '../../src/trading/funds';
import type { RunConfig, ReceiverSpec } from './config';
import type { Expectation, Guard } from './guard';
import type { KeyProvider, ProviderPolicy } from './provider';
import type { InFlight, Snapshot } from './reads';
import { dur, errText, hhmmss } from './util';

export type Mode = 'plan' | 'live';

export const STEP_ORDER = [
  'deposit-external',
  'enable-trading',
  'transfers',
  'orders',
  'spot-to-evm',
  'evm-to-spot',
  'withdraw-valuechain-self',
  'withdraw-valuechain-other',
  'withdraw-external',
  'extra-deposits',
  'extra-withdrawals',
  'cleanup',
  'revoke-builder',
] as const;
export type StepId = (typeof STEP_ORDER)[number];

export const STEP_TITLES: Record<StepId, string> = {
  'deposit-external': 'deposit USDC from an EVM chain to the wallet\'s own SoDEX deposit address',
  'enable-trading': 'register a trading key (one wallet signature)',
  transfers: 'Spot -> Perps -> Spot',
  orders: 'spot + perps orders (rest/cancel, market buy, open/close)',
  'spot-to-evm': 'Spot -> ValueChain wallet (USDC and SOSO)',
  'evm-to-spot': 'ValueChain wallet -> Spot (USDC)',
  'withdraw-valuechain-self': 'withdraw to the own ValueChain wallet',
  'withdraw-valuechain-other': 'withdraw to another ValueChain address',
  'withdraw-external': 'withdraw to another chain (SoDEX permit)',
  'extra-deposits': 'extra deposits from other EVM chains',
  'extra-withdrawals': 'extra withdrawals per chain',
  cleanup: 'move everything back to Spot and withdraw to the deposit chain',
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

export interface Ctx {
  mode: Mode;
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
}

/** A refusal from the runner's own safety rules - nothing was signed or sent. */
export class SafetyStop extends Error {
  override name = 'SafetyStop';
}

/**
 * Run `fn` with exactly these writes expected by the network guard and exactly
 * this wallet policy - and nothing else. Both are removed afterwards, whatever
 * happened. A request the guard refused inside `fn` is named in the error.
 */
export async function armed<T>(ctx: Ctx, a: { expect?: Expectation[]; policy?: ProviderPolicy }, fn: () => Promise<T>): Promise<T> {
  const before = ctx.guard.refusals.length;
  const disarm = a.expect?.length ? ctx.guard.expect(a.expect) : () => undefined;
  ctx.provider.setPolicy(a.policy ?? null);
  try {
    return await fn();
  } catch (e) {
    const blocked = ctx.guard.refusals.slice(before);
    if (blocked.length) {
      throw new SafetyStop(`${errText(e)} [the E2E guard refused ${blocked.map((b) => `${b.what} (${b.blocked})`).join('; ')} - that request was NOT sent]`);
    }
    throw e;
  } finally {
    disarm();
    ctx.provider.setPolicy(null);
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
  const r = ctx.cfg.receivers[name];
  if (!r) throw new SafetyStop(`No receiver "${name}" in the config.`);
  return { ...r, self: r.address.toLowerCase() === ctx.owner };
}

/** Every address money may be sent to in this run: the wallet itself and the configured receivers. */
export function allowedReceivers(ctx: Ctx): Set<string> {
  return new Set([ctx.owner, ...Object.values(ctx.cfg.receivers).map((r) => r.address.toLowerCase())]);
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
