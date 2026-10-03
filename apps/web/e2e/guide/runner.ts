/**
 * The contract with the live runner (apps/web/e2e/live/run.ts), seen from the
 * outside: its command line, its console lines and its JSON report.
 *
 * The guide never imports the runner. It starts it as a child process and reads
 * what it prints and writes, so the runner's own safety model stays the only
 * thing between a key and a signature - and so work in progress on the runner
 * cannot break the guide. Everything here is tolerant: a field that is missing
 * or renamed degrades to "unknown", never to a crash.
 *
 * Everything in this file is pure (no process, no network).
 */
import type { ItemStatus, TxRef } from './types';

// --- capabilities ---------------------------------------------------------------------------

export interface Capabilities {
  steps: string[];
  profiles: string[];
  flags: string[];
  /** Where this came from: the runner's own `capabilities` answer, its usage text, or what it had on 2026-10-02. */
  source: 'capabilities' | 'usage' | 'defaults';
}

/**
 * The runner's steps, in run order, as its owner named them on 2026-10-02
 * (`orders` stays an alias of orders-spot,orders-perps). Used ONLY when the
 * runner can neither be asked (`capabilities`) nor read (its usage text) - the
 * list it reports itself always wins, so an older runner keeps its own steps.
 */
export const KNOWN_STEPS: readonly string[] = [
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
];

export const DEFAULT_CAPABILITIES: Capabilities = {
  steps: [...KNOWN_STEPS],
  profiles: [],
  flags: ['--config', '--confirm', '--only', '--throwaway-key', '--registry-only', '--backend', '--report-dir'],
  source: 'defaults',
};

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);

/** `run.ts capabilities` printed `{ steps, profiles, flags }` and exited 0 - or null (an older runner). */
export function parseCapabilities(stdout: string, code: number | null): Capabilities | null {
  if (code !== 0) return null;
  const a = stdout.indexOf('{');
  const b = stdout.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j: unknown;
  try {
    j = JSON.parse(stdout.slice(a, b + 1));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const steps = strings(o.steps);
  if (!steps || !steps.length) return null;
  return { steps, profiles: strings(o.profiles) ?? [], flags: strings(o.flags) ?? [], source: 'capabilities' };
}

/** What the runner's usage text (printed with exit 2 for an unknown argument, or by --help) says it can do. */
export function capabilitiesFromUsage(text: string): Capabilities | null {
  const flags = [...new Set([...text.matchAll(/(?:^|[\s[|])(--[a-z][a-z0-9-]+)/g)].map((m) => m[1]!))];
  if (!flags.includes('--config')) return null;
  const listAfter = (flag: string): string[] => {
    const m = new RegExp(`${flag}[^\\n]*?:\\s*([a-z0-9-]+(?:\\s*,\\s*[a-z0-9-]+)*)\\s*$`, 'm').exec(text);
    return m ? m[1]!.split(',').map((s) => s.trim()).filter(Boolean) : [];
  };
  const steps = listAfter('--only');
  return { steps: steps.length ? steps : [...KNOWN_STEPS], profiles: listAfter('--profile'), flags, source: 'usage' };
}

export const hasProfile = (c: Capabilities, name: string): boolean => c.profiles.includes(name);
export const hasFlag = (c: Capabilities, flag: string): boolean => c.flags.includes(flag);

// --- profiles ---------------------------------------------------------------------------------

export interface ProfileInfo {
  name: string;
  title: string;
  /** What it covers, one line each. */
  covers: string[];
}

/** The live-run profiles the owner asked for, in the order they are offered. What each DOES is the runner's; this is only the menu text. */
export const RUN_PROFILES: readonly ProfileInfo[] = [
  {
    name: 'core',
    title: 'Core - one chain, everything',
    covers: [
      'Arbitrum One only: deposit, transfers, every order type, every withdrawal path',
      'the builder fee: 2 bp on the first orders, 1.5 bp after 10 USDC of volume, and the cheating attempts',
    ],
  },
  {
    name: 'evm-tour',
    title: 'EVM tour - every EVM chain, out and back',
    covers: ['everything in Core', 'plus a deposit from and a withdrawal to every EVM chain SoDEX offers (the test wallet needs funds on each)'],
  },
  {
    name: 'all-chains',
    title: 'All chains - also the ones this computer cannot sign on',
    covers: [
      'everything in the EVM tour',
      'plus withdrawals to addresses YOU supply on the other chains (Solana, Bitcoin, XRP, ...)',
      'plus deposits you send by hand from those chains, which the run waits for and verifies',
    ],
  },
  {
    name: 'builder-rerun',
    title: 'Builder fee again - on the test wallet of an earlier run',
    covers: [
      'the builder fee test alone: the approval, 2 bp on the first orders, 1.5 bp after 10 USDC of verified volume, the cheating attempts, the approval enforced, the cross-check',
      'on the funded test wallet of an earlier run - after the server forgot it (apps/server: npx tsx tools/builderTiers.ts forget --address <wallet>)',
    ],
  },
];

/**
 * The full test: not a profile of the runner but a choice of the guide - the
 * all-chains profile with everything switched on: every receiver asked for, every
 * hand-sent deposit offered, the builder fee and its tiers when stage C set the
 * builder up, and the cleanup back to Arbitrum.
 */
export const FULL_TEST: ProfileInfo = {
  name: 'full',
  title: 'Full test (everything) - one run for every chain, fund only Arbitrum One',
  covers: [
    'everything in "All chains": every order type, every way out, every EVM chain out and back, the builder fee and its tiers (when stage C set up the builder)',
    'withdrawals to YOUR addresses on every other chain (one wallet, e.g. SafePal, holds them all) - you enter each address',
    'the deposits back from those addresses, sent by you during the run - each one optional',
    'at the end everything bought is sold back to USDC and the USDC is withdrawn back to Arbitrum One',
  ],
};
/** The runner profile the full test runs. */
export const FULL_TEST_PROFILE = 'all-chains';

export interface ProfileMenu {
  /** Offered, in order: the full test (when the runner has all-chains), the known ones, then any other profile the runner has. */
  available: ProfileInfo[];
  /** Asked for by the owner, but not in this runner version. */
  missing: ProfileInfo[];
}

export function profileMenu(c: Capabilities): ProfileMenu {
  const has = new Set(c.profiles);
  const known = new Set(RUN_PROFILES.map((p) => p.name));
  return {
    available: [
      ...(has.has(FULL_TEST_PROFILE) ? [FULL_TEST] : []),
      ...RUN_PROFILES.filter((p) => has.has(p.name)),
      ...[...has].filter((p) => !known.has(p)).map((name) => ({ name, title: name, covers: ['(a profile of this runner version the guide has no description for)'] })),
    ],
    missing: RUN_PROFILES.filter((p) => !has.has(p.name)),
  };
}

/** Receivers that need the owner: not set, rejected, or missing a memo. */
export const receiversToAsk = (needs: readonly ReceiverNeed[]): ReceiverNeed[] => needs.filter((n) => !n.set || n.memo || n.problem !== null);

// --- the command line -----------------------------------------------------------------------

export interface RunnerInvocation {
  mode: 'plan' | 'live' | 'capabilities';
  config?: string | null;
  /** live: the wallet address the key controls. */
  confirm?: string | null;
  only?: readonly string[] | null;
  throwaway?: boolean;
  registryOnly?: boolean;
  reportDir?: string | null;
  profile?: string | null;
}

/**
 * The runner's arguments. There is no parameter for a key: it travels only in
 * the child's environment (VS_E2E_KEY). Combinations the runner would refuse
 * anyway are refused here first, so a mistake in the guide cannot even start it.
 */
export function runnerArgs(i: RunnerInvocation): string[] {
  if (i.mode === 'capabilities') return ['capabilities'];
  const out: string[] = [i.mode];
  if (i.mode === 'live') {
    if (i.throwaway) throw new Error('a throwaway key cannot run live');
    if (i.registryOnly) throw new Error('--registry-only is for plan mode only');
    if (!i.config) throw new Error('live mode needs a config file');
    if (!i.confirm || !/^0x[0-9a-fA-F]{40}$/.test(i.confirm)) throw new Error('live mode needs --confirm <the wallet address>');
  }
  if (i.config) out.push('--config', i.config);
  if (i.mode === 'live') out.push('--confirm', i.confirm!);
  if (i.profile) out.push('--profile', i.profile);
  if (i.only && i.only.length) out.push('--only', i.only.join(','));
  if (i.throwaway) out.push('--throwaway-key');
  if (i.registryOnly) out.push('--registry-only');
  if (i.reportDir) out.push('--report-dir', i.reportDir);
  return out;
}

// --- console lines --------------------------------------------------------------------------

/** `20:23:01  text` -> `text` (the runner stamps every line with a clock). */
export const stripClock = (line: string): string => line.replace(/^\d\d:\d\d:\d\d {2}/, '');

/** The report file the runner says it wrote (its last `report   <file>` line). */
export function findReportPath(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^report\s+(.+\.json)\s*$/.exec(stripClock(lines[i]!));
    if (m) return m[1]!.trim();
  }
  return null;
}

/** The wallet address the runner printed (`wallet   0x...`). */
export function findWallet(lines: readonly string[]): string | null {
  for (const l of lines) {
    const m = /^wallet\s+(0x[0-9a-fA-F]{40})\b/.exec(stripClock(l));
    if (m) return m[1]!;
  }
  return null;
}

/** Lines that say why the runner refused to start at all (exit 2 before any plan). */
export function refusalLines(lines: readonly string[]): string[] {
  return lines
    .map(stripClock)
    .map((l) => l.trim())
    .filter((l) => /^(REFUSED:|CONFIG ERROR:|KEY ERROR:|fatal:|unknown argument|unknown step|Run this from apps\/web|live mode needs|Set VS_E2E_KEY)/.test(l));
}

/** Config warnings the runner printed (`config warning: Unknown key ...`). */
export function configWarnings(lines: readonly string[]): string[] {
  return lines.map(stripClock).map((l) => l.trim()).filter((l) => l.startsWith('config warning:')).map((l) => l.slice('config warning:'.length).trim());
}

// --- the plan -------------------------------------------------------------------------------

export interface PlanStep {
  id: string;
  title: string;
  lines: string[];
  costUsd: number | null;
  sentAwayUsd: number | null;
  skip: string | null;
  problems: string[];
}

export interface PlanView {
  wallet: string | null;
  exitCode: number | null;
  throwaway: boolean;
  /** Why preflight itself failed (then there is no plan). */
  preflightError: string | null;
  problems: string[];
  warnings: string[];
  checklist: string[];
  steps: PlanStep[];
  estimatedCostUsd: number | null;
  estimatedSentAwayUsd: number | null;
  maxSpendUsd: number | null;
  /** The cap the runner suggests for this plan (its estimate with room), or null when it names none. */
  suggestedMaxSpendUsd: number | null;
  balances: string[];
  /** The per-chain route table the runner prints (text rows; the first is the header). */
  routes: string[];
  selectedSteps: string[];
  /** Receiver addresses this plan wants and does not have (or has and rejects). */
  receivers: ReceiverNeed[];
  /** The deposits the owner can send back by hand (profile all-chains). */
  handDeposits: HandDeposit[];
  /** The runner's budget block (null: this runner version has none). */
  budget: BudgetView | null;
}

/** One deposit the owner can send by hand from their own wallet, as the runner plans it. */
export interface HandDeposit {
  coin: string;
  chain: string;
  label: string;
  /** 'send' | 'skipped' | 'offered' (not configured yet). */
  state: string;
  /** What the owner sends (never below SoDEX's deposit minimum). */
  amount: string;
  depositMin: string;
  walletFee: string;
  feeCoin: string;
  /** What the owner must already hold (0: the run's withdrawal covers it). */
  needFirst: string;
  order: string;
  /** The runner's own sentence about it. */
  line: string;
}

export interface BudgetView {
  fund: string[];
  costUsd: number | null;
  sentAwayUsd: number | null;
  returnsUsd: number | null;
  leftOnChains: string[];
  ownerWallet: string[];
  minutes: { expected: number | null; worst: number | null };
  suggestedMaxSpendUsd: number | null;
}

/** The hand-sent deposits of a plan report (tolerant: anything missing is left out). */
export function handDepositsOf(v: unknown): HandDeposit[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x): HandDeposit[] => {
    const o = obj(x);
    const coin = text(o?.coin);
    const chain = text(o?.chain);
    if (!o || !coin || !chain || !/^[A-Za-z0-9_.-]{1,40}$/.test(coin) || !/^[A-Z0-9_]{2,32}$/.test(chain)) return [];
    return [{
      coin,
      chain,
      label: text(o.label) ?? chain,
      state: text(o.state) ?? 'offered',
      amount: text(o.amount) ?? text(o.sendBack) ?? '?',
      depositMin: text(o.depositMin) ?? '?',
      walletFee: text(o.walletFee) ?? '?',
      feeCoin: text(o.feeCoin) ?? coin,
      needFirst: text(o.needFirst) ?? '0',
      order: text(o.order) ?? 'withdraw-first',
      line: text(o.line) ?? `${coin} on ${text(o.label) ?? chain}`,
    }];
  });
}

export function budgetOf(v: unknown): BudgetView | null {
  const o = obj(v);
  if (!o) return null;
  const m = obj(o.minutes);
  return {
    fund: lines(o.fund),
    costUsd: num(o.costUsd),
    sentAwayUsd: num(o.sentAwayUsd),
    returnsUsd: num(o.returnsUsd),
    leftOnChains: lines(o.leftOnChains),
    ownerWallet: lines(o.ownerWallet),
    minutes: { expected: num(m?.expected), worst: num(m?.worst) },
    suggestedMaxSpendUsd: num(o.suggestedMaxSpendUsd),
  };
}

/** A receiver address the selected steps need. */
export interface ReceiverNeed {
  /** The name in the config's `receivers` section. */
  name: string;
  /** The chain it is for, when the runner says so. */
  chain: string | null;
  /** What it is needed for, in the runner's words. */
  why: string;
  /** XRP / Stellar: a memo (destination tag) is asked for. */
  memo: boolean;
  /** false: not set yet. true: set, and `problem` says what is wrong with it. */
  set: boolean;
  problem: string | null;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const lines = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The plan part of a runner report, or null when this is not a runner report. */
export function readPlanReport(json: unknown): PlanView | null {
  const r = obj(json);
  if (!r || r.tool !== 'valuescan-live-e2e') return null;
  const p = obj(r.plan);
  const cfg = obj(r.config);
  const pre = Array.isArray(r.steps) ? r.steps.map(obj).find((s) => s?.id === 'preflight') : null;
  const planned: unknown = p?.steps;
  const steps: PlanStep[] = (Array.isArray(planned) ? planned : []).flatMap((s: unknown) => {
    const o = obj(s);
    const id = text(o?.id);
    if (!o || !id) return [];
    return [{ id, title: text(o.title) ?? id, lines: lines(o.lines), costUsd: num(o.costUsd), sentAwayUsd: num(o.sentAwayUsd), skip: text(o.skip), problems: lines(o.problems) }];
  });
  const problems = [...new Set(lines(p?.problems))];
  const warnings = lines(p?.warnings);
  return {
    wallet: text(r.wallet),
    exitCode: num(r.exitCode),
    throwaway: r.throwawayKey === true,
    preflightError: p ? null : text(pre?.error) ?? (pre && pre.status !== 'ok' ? `preflight ${String(pre.status)}` : null),
    problems,
    warnings,
    checklist: lines(p?.checklist),
    steps,
    estimatedCostUsd: num(p?.estimatedCostUsd),
    estimatedSentAwayUsd: num(p?.estimatedSentAwayUsd),
    maxSpendUsd: num(cfg?.maxSpendUsd),
    suggestedMaxSpendUsd: num(p?.suggestedMaxSpendUsd),
    balances: lines(p?.balances),
    routes: lines(p?.routes),
    selectedSteps: lines(r.selectedSteps),
    receivers: receiversNeeded(p?.receiversNeeded, { problems, warnings, steps }),
    handDeposits: handDepositsOf(p?.handDeposits),
    budget: budgetOf(p?.budget),
  };
}

/**
 * The receivers a plan asks for. The runner's own list (`plan.receiversNeeded`:
 * `[{ name, chain?, why?, memo?, set?, problem? }]`) when it has one; otherwise
 * read from its messages, which name a receiver as `receivers.<name>`:
 *   "... receivers.solana is not set"                      not set yet
 *   "... give receivers.xrp a "memo", or "noMemo": true"   a memo is needed
 *   "receivers.solana: <what is wrong>"                    set, and rejected
 */
export function receiversNeeded(listed: unknown, plan: Pick<PlanView, 'problems' | 'warnings' | 'steps'>): ReceiverNeed[] {
  if (Array.isArray(listed)) {
    const out = listed.flatMap((x): ReceiverNeed[] => {
      const o = obj(x);
      const name = text(o?.name);
      if (!o || !name || !RECEIVER_NAME.test(name)) return [];
      return [{ name, chain: text(o.chain) ?? text(o.label), why: text(o.why) ?? text(o.detail) ?? '', memo: o.memo === true || o.memo === 'required', set: o.set === true, problem: text(o.problem) }];
    });
    if (out.length || listed.length === 0) return out;
  }
  const by = new Map<string, ReceiverNeed>();
  const get = (name: string): ReceiverNeed => {
    let n = by.get(name);
    if (!n) by.set(name, (n = { name, chain: null, why: '', memo: false, set: true, problem: null }));
    return n;
  };
  const sources: string[] = [...plan.problems, ...plan.warnings, ...plan.steps.flatMap((s) => [...(s.skip ? [`${s.id}: ${s.skip}`] : []), ...s.problems.map((p) => `${s.id}: ${p}`)])];
  for (const line of sources) {
    for (const m of line.matchAll(/receivers\.([A-Za-z0-9_-]{1,40})\b/g)) {
      const n = get(m[1]!);
      const rest = line.slice((m.index ?? 0) + m[0].length);
      if (/^ is not set\b/.test(rest)) n.set = false;
      else if (/^ a "memo"/.test(rest)) n.memo = true;
      else if (/^: /.test(rest)) n.problem = rest.slice(2).trim();
      else if (/^ is this wallet itself/.test(rest)) n.problem = 'it is the test wallet itself - it must be a different address you control';
      if (!n.why) n.why = line.replace(/\s+/g, ' ').trim();
    }
  }
  return [...by.values()].filter((n) => !n.set || n.memo || n.problem !== null);
}

const RECEIVER_NAME = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * The same view from the console alone - for a runner that wrote no report (or
 * one this version cannot read). Sections are the ones printPlan writes.
 */
export function planFromConsole(raw: readonly string[], exitCode: number | null): PlanView {
  const ls = raw.map(stripClock);
  const section = (start: RegExp): string[] => {
    const i = ls.findIndex((l) => start.test(l));
    if (i < 0) return [];
    const out: string[] = [];
    for (let k = i + 1; k < ls.length; k++) {
      const l = ls[k]!;
      if (!l.startsWith('  ')) break;
      out.push(l.replace(/^ {2}/, ''));
    }
    return out;
  };
  const bullets = (xs: string[]): string[] => xs.map((l) => l.replace(/^- /, '').trim()).filter(Boolean);
  const steps: PlanStep[] = [];
  for (const l of section(/^Steps$/)) {
    const head = /^([a-z][a-z0-9-]+)\s+(?:SKIPPED - (.*)|est\. cost \$([\d.]+)(?: \+ sent to another address \$([\d.]+))?)$/.exec(l);
    if (head) {
      steps.push({ id: head[1]!, title: head[1]!, lines: [], costUsd: head[3] ? Number(head[3]) : null, sentAwayUsd: head[4] ? Number(head[4]) : head[3] ? 0 : null, skip: head[2] ?? null, problems: [] });
    } else if (steps.length) {
      const t = l.trim();
      if (t.startsWith('PROBLEM: ')) steps.at(-1)!.problems.push(t.slice(9));
      else steps.at(-1)!.lines.push(t);
    }
  }
  const total = ls.map((l) => /^Estimated total\s+costs \$([\d.]+) \+ sent to your other addresses \$([\d.]+) = \$[\d.]+ \(maxSpendUsd \$([\d.]+)\)/.exec(l)).find(Boolean);
  const failed = ls.map((l) => /^FAILED preflight \([^)]*\)(?:: (.*))?$/.exec(l)).find(Boolean);
  const problems = [...new Set(bullets([...section(/^Problems a live run would refuse to start with:$/), ...section(/^PROBLEMS - live mode refuses to start:$/)]))];
  const warnings = bullets(section(/^Warnings$/));
  return {
    wallet: findWallet(raw),
    exitCode,
    throwaway: ls.some((l) => /^wallet\s+0x[0-9a-fA-F]{40} \(a throwaway key/.test(l)),
    preflightError: failed ? failed[1] ?? 'preflight failed' : null,
    problems,
    warnings,
    checklist: section(/^Funding checklist/),
    steps,
    estimatedCostUsd: total ? Number(total[1]) : null,
    estimatedSentAwayUsd: total ? Number(total[2]) : null,
    maxSpendUsd: total ? Number(total[3]) : null,
    suggestedMaxSpendUsd: (() => {
      const m = ls.map((l) => /^Suggested maxSpendUsd for this run: ([\d.]+)/.exec(l)).find(Boolean);
      return m ? Number(m[1]) : null;
    })(),
    balances: section(/^Balances$/),
    routes: section(/^Routes per chain/),
    selectedSteps: (ls.find((l) => /^steps\s{2,}/.test(l)) ?? '').replace(/^steps\s+/, '').split(',').map((s) => s.trim()).filter(Boolean),
    receivers: receiversNeeded(undefined, { problems, warnings, steps }),
    handDeposits: [],
    budget: null,
  };
}

// --- funding ----------------------------------------------------------------------------------

export interface FundingNeed {
  ok: boolean;
  chain: string;
  amount: string;
  coin: string;
  why: string;
  holds: string;
  raw: string;
}

/** `[ ] Arbitrum One     25.00 USDC  (deposit) - wallet holds 0.00` */
export function parseChecklistLine(line: string): FundingNeed | null {
  const m = /^\[( |x)\]\s+(.+?)\s+(\d[\d.,eE+-]*)\s+(\S+)\s+\((.*)\)\s+-\s+wallet holds\s+(.+?)\s*$/.exec(line.trim());
  if (!m) return null;
  return { ok: m[1] === 'x', chain: m[2]!.trim(), amount: m[3]!, coin: m[4]!, why: m[5]!.trim(), holds: m[6]!, raw: line.trim() };
}

export interface FundingStatus {
  needs: FundingNeed[];
  missing: FundingNeed[];
  /** Problems that are only "the wallet does not hold enough yet". */
  fundingProblems: string[];
  /** Every other problem: waiting does not fix these. */
  blockers: string[];
  funded: boolean;
  /** A live run would start. */
  ready: boolean;
}

const isFundingProblem = (p: string): boolean => /^fund the wallet\b/i.test(p.trim());

export function fundingStatus(plan: Pick<PlanView, 'checklist' | 'problems' | 'preflightError'>): FundingStatus {
  const needs = plan.checklist.map(parseChecklistLine).filter((n): n is FundingNeed => n !== null);
  const missing = needs.filter((n) => !n.ok);
  const fundingProblems = plan.problems.filter(isFundingProblem);
  const blockers = [...(plan.preflightError ? [`the runner's read-only checks failed: ${plan.preflightError}`] : []), ...plan.problems.filter((p) => !isFundingProblem(p))];
  const funded = !plan.preflightError && missing.length === 0 && fundingProblems.length === 0;
  return { needs, missing, fundingProblems, blockers, funded, ready: funded && blockers.length === 0 };
}

/** The token the deposit step sends, from its plan line (`send 25 USDC on Arbitrum One (0xaf88...)`). */
export function depositToken(plan: Pick<PlanView, 'steps'>): { chain: string; token: string } | null {
  for (const s of plan.steps) {
    for (const l of s.lines) {
      const m = /send [\d.]+ USDC on (.+?) \((0x[0-9a-fA-F]{40})\)/.exec(l);
      if (m) return { chain: m[1]!, token: m[2]! };
    }
  }
  return null;
}

/** What to send, in plain words, numbered. */
export function fundingInstructions(wallet: string, st: FundingStatus, plan: Pick<PlanView, 'steps'>): string[] {
  const out: string[] = [];
  const tok = depositToken(plan);
  const list = st.missing.length ? st.missing : st.needs;
  list.forEach((n, i) => {
    out.push(`${i + 1}. Send ${n.amount} ${n.coin} on ${n.chain} to ${wallet}`);
    out.push(`   what for: ${n.why}. The wallet holds ${n.holds} ${n.coin} there now.`);
    if (n.coin.toUpperCase() === 'USDC' && tok && tok.chain === n.chain) {
      out.push(`   It must be native USDC, token contract ${tok.token} - not a bridged USDC (USDC.e).`);
    }
  });
  if (!list.length) for (const p of st.fundingProblems) out.push(`- ${p}`);
  return out;
}

/** One line for the wait loop: what is still missing. */
export function missingLine(st: FundingStatus): string {
  if (st.missing.length) return st.missing.map((n) => `${n.amount} ${n.coin} on ${n.chain} (holds ${n.holds})`).join('; ');
  if (st.fundingProblems.length) return st.fundingProblems.join('; ');
  return 'nothing';
}

// --- a live run's report ----------------------------------------------------------------------

export interface LiveStep {
  id: string;
  title: string;
  status: string;
  ms: number | null;
  /** Measured (priced holdings before/after), else null. */
  costUsd: number | null;
  estimateUsd: number | null;
  error: string | null;
  reason: string | null;
  txs: TxRef[];
  fees: Record<string, string>;
  /** Every check and action of the step, as the runner recorded them. */
  subSteps: Array<{ title: string; status: string; ms: number | null; detail: string | null }>;
}

export interface LiveView {
  mode: string;
  exitCode: number | null;
  wallet: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  steps: LiveStep[];
  selectedSteps: string[];
  spend: { costUsd: number; sentAwayUsd: number } | null;
  maxSpendUsd: number | null;
  whereFunds: string[];
  inFlight: string[];
  /** Whatever the runner calls its fee table, untouched (rendered by summary.ts). */
  feeTable: unknown;
}

export function readLiveReport(json: unknown): LiveView | null {
  const r = obj(json);
  if (!r || r.tool !== 'valuescan-live-e2e') return null;
  const cfg = obj(r.config);
  const spend = obj(r.spend);
  const steps: LiveStep[] = (Array.isArray(r.steps) ? r.steps : []).flatMap((s) => {
    const o = obj(s);
    const id = text(o?.id);
    if (!o || !id) return [];
    const measured = obj(o.measured);
    const txs: TxRef[] = (Array.isArray(o.txs) ? o.txs : []).flatMap((t) => {
      const x = obj(t);
      const hash = text(x?.hash);
      return x && hash ? [{ chain: text(x.chain) ?? '?', hash, ...(text(x.explorer) ? { explorer: text(x.explorer)! } : {}) }] : [];
    });
    const fees = obj(o.fees) ?? {};
    return [{
      id,
      title: text(o.title) ?? id,
      status: text(o.status) ?? 'unknown',
      ms: num(o.ms),
      costUsd: num(measured?.costUsd),
      estimateUsd: num(o.estimateUsd),
      error: text(o.error),
      reason: text(o.reason),
      txs,
      fees: Object.fromEntries(Object.entries(fees).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
      subSteps: (Array.isArray(o.subSteps) ? o.subSteps : []).flatMap((x) => {
        const b = obj(x);
        const title = text(b?.title);
        return b && title ? [{ title, status: text(b.status) ?? 'unknown', ms: num(b.ms), detail: text(b.detail) }] : [];
      }),
    }];
  });
  return {
    mode: text(r.mode) ?? '?',
    exitCode: num(r.exitCode),
    wallet: text(r.wallet),
    startedAt: text(r.startedAt),
    finishedAt: text(r.finishedAt),
    steps,
    selectedSteps: lines(r.selectedSteps),
    spend: spend && num(spend.costUsd) !== null && num(spend.sentAwayUsd) !== null ? { costUsd: num(spend.costUsd)!, sentAwayUsd: num(spend.sentAwayUsd)! } : null,
    maxSpendUsd: num(cfg?.maxSpendUsd),
    whereFunds: lines(r.whereFunds),
    inFlight: (Array.isArray(r.inFlight) ? r.inFlight : []).flatMap((f) => {
      const o = obj(f);
      const what = text(o?.what);
      return what ? [`${what}${text(o?.ref) ? ` [${text(o?.ref)}]` : ''}`] : [];
    }),
    feeTable: r.feeTable ?? r.fees ?? null,
  };
}

/** A runner step's status as a row status. A step still "running" in a report was cut off. */
export function stepItemStatus(status: string): ItemStatus {
  switch (status) {
    case 'ok':
      return 'PASS';
    case 'skipped':
      return 'SKIPPED';
    case 'planned':
      return 'PLANNED';
    default:
      return 'FAIL'; // failed, blocked, running (interrupted), anything unknown
  }
}

export interface Resume {
  /** The step the run stopped at (null: it finished). */
  stoppedAt: string | null;
  /** The steps still to run, in order, the stopped one first. */
  remaining: string[];
}

/**
 * After a stop: which steps are left. `order` is the runner's step order;
 * `plannedSkips` are the steps its plan had already said it would skip (a
 * disabled cleanup, an unset receiver) - nothing to resume there.
 */
export function resumeSteps(view: Pick<LiveView, 'steps' | 'selectedSteps'>, order: readonly string[], plannedSkips: ReadonlySet<string> = new Set()): Resume {
  const done = new Set(view.steps.filter((s) => s.status === 'ok' || s.status === 'skipped').map((s) => s.id));
  const selected = view.selectedSteps.length ? view.selectedSteps : [...order];
  const inOrder = [...order.filter((s) => selected.includes(s)), ...selected.filter((s) => !order.includes(s))].filter((s) => !plannedSkips.has(s) || view.steps.some((x) => x.id === s && x.status !== 'skipped'));
  const first = inOrder.findIndex((s) => !done.has(s));
  if (first < 0) return { stoppedAt: null, remaining: [] };
  return { stoppedAt: inOrder[first]!, remaining: inOrder.slice(first).filter((s) => !done.has(s)) };
}

/** The steps a run's own plan said it would skip (from the `plan` inside its report). */
export function plannedSkips(report: unknown): Set<string> {
  return new Set((readPlanReport(report)?.steps ?? []).filter((s) => s.skip).map((s) => s.id));
}

/** The manual way to resume, for someone who wants the bare commands. */
export function resumeCommand(wallet: string, remaining: readonly string[]): string[] {
  return [
    'cd apps\\web',
    `npx tsx e2e/live/run.ts live --config e2e/live/config.json --confirm ${wallet} --only ${remaining.join(',')}`,
  ];
}

/** `<report>.summary.md`, in either spelling. */
export function summaryPathsFor(reportPath: string): string[] {
  return [reportPath.replace(/\.json$/i, '.summary.md'), `${reportPath}.summary.md`];
}

/**
 * The runner's fee table, if it provides one: a section of its summary whose
 * heading names fees, else a `feeTable` in its JSON report rendered as rows.
 */
export function extractFeeTable(summaryMd: string | null, feeTable: unknown): string[] | null {
  if (summaryMd) {
    const ls = summaryMd.split(/\r?\n/);
    const start = ls.findIndex((l) => /^#{1,6}\s.*\bfees?\b/i.test(l));
    if (start >= 0) {
      const level = /^#+/.exec(ls[start]!)![0].length;
      const out: string[] = [];
      for (let i = start + 1; i < ls.length; i++) {
        const h = /^(#+)\s/.exec(ls[i]!);
        if (h && h[1]!.length <= level) break;
        out.push(ls[i]!);
      }
      while (out.length && !out[0]!.trim()) out.shift();
      while (out.length && !out.at(-1)!.trim()) out.pop();
      if (out.length) return out;
    }
  }
  if (Array.isArray(feeTable) && feeTable.length) {
    const rows = feeTable.map(obj).filter((r): r is Record<string, unknown> => r !== null);
    if (rows.length) {
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const cell = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
      return [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(' | ')} |`)];
    }
    return feeTable.filter((x): x is string => typeof x === 'string');
  }
  return null;
}
