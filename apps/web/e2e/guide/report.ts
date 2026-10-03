/**
 * What the summary leads with, read from the live runner's report: the builder
 * fee checks, every chain, every order type.
 *
 * RULE: nothing here is guessed. A check the report does not name is "not run".
 * The fields this file reads (the contract with the runner; each is optional):
 *
 *   report.checks[]      { id, title?, status, detail?, value? }
 *                        status: pass | fail | finding | warn | skipped | not-run
 *                        the builder-fee checks use the ids in BUILDER_CHECKS
 *   report.chains[]      { chain, label?, coin?, deposit: { status, detail? }, withdraw: { status, detail? } }
 *                        status: pass | fail | finding | skipped | not-run | not-testable
 *   report.orderTypes[]  { id, title?, engine?, status, detail? }
 *
 * `finding` is the runner's word for "the run observed how SoDEX behaves here;
 * it is not a failure, and the owner should read it" (a replaced order keeps or
 * loses the builder; what SoDEX does with a post-only order that would cross).
 * A finding is never shown as "not run" and never counts as a failure.
 *
 * Until the runner writes them, the chain and order tables are built from what
 * its report has today: the plan's route table, the plan lines of the deposit
 * and withdrawal steps, and the recorded sub-steps of the orders step. Pure.
 */
import type { LiveView, PlanView } from './runner';

export type CheckStatus = 'pass' | 'fail' | 'finding' | 'warn' | 'skipped' | 'not-run' | 'not-testable';

export interface RunnerCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string | null;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The runner's word for a result -> ours. Anything unknown is "not run": it is never read as a pass. */
export function checkStatus(v: unknown): CheckStatus {
  if (v === true) return 'pass';
  if (v === false) return 'fail';
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/[_\s]+/g, '-') : '';
  if (['pass', 'passed', 'ok', 'success'].includes(s)) return 'pass';
  if (['fail', 'failed', 'error', 'blocked'].includes(s)) return 'fail';
  if (['finding', 'observed', 'info'].includes(s)) return 'finding';
  if (['warn', 'warning'].includes(s)) return 'warn';
  if (['skip', 'skipped'].includes(s)) return 'skipped';
  if (['not-testable', 'untestable', 'unsupported'].includes(s)) return 'not-testable';
  return 'not-run';
}

export function readChecks(report: unknown): RunnerCheck[] {
  const list = obj(report)?.checks;
  if (!Array.isArray(list)) return [];
  return list.flatMap((c): RunnerCheck[] => {
    const o = obj(c);
    const id = text(o?.id);
    if (!o || !id) return [];
    const value = o.value === undefined || o.value === null ? null : typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value);
    const detail = [text(o.detail), value !== null && !text(o.detail)?.includes(value) ? `result: ${value}` : null].filter(Boolean).join(' - ');
    return [{ id, title: text(o.title) ?? id, status: checkStatus(o.status ?? o.ok), detail: detail || null }];
  });
}

export interface ExpectedCheck {
  /** The id the runner reports it under. */
  id: string;
  /** The owner's list: (a) to (f); (g) is docs/BUILDER-TIERS.md section 8, item 6. */
  letter: string;
  title: string;
}

/** docs/BUILDER-TIERS.md section 8 "Live", as rows of the summary. */
export const BUILDER_CHECKS: readonly ExpectedCheck[] = [
  { id: 'builder-fee-default', letter: 'a', title: 'First orders carry the default fee (2 bp); each fill\'s builderFee is 2 bp of its notional' },
  { id: 'builder-volume-verified', letter: 'b', title: 'Volume above 10 USDC, verified by the server from SoDEX\'s own records' },
  { id: 'builder-fee-lowered', letter: 'c', title: 'The next order carries the lower fee (1.5 bp); its fill\'s builderFee is 1.5 bp' },
  { id: 'builder-underpaid-not-counted', letter: 'd', title: 'Cheating attempt: an order with a lower fee is not credited (and is flagged)' },
  { id: 'builder-no-builder-not-counted', letter: 'd', title: 'Cheating attempt: an order without the builder is not credited' },
  { id: 'builder-modify-keeps-builder', letter: 'e', title: 'A modified order still names the builder' },
  { id: 'builder-replace-keeps-builder', letter: 'e', title: 'A replaced order still names the builder' },
  { id: 'builder-income-matches', letter: 'f', title: 'The builder account\'s income equals the builderFee of the run\'s fills' },
  { id: 'builder-approval-enforced', letter: 'g', title: 'Approval lowered or revoked: the app sends nothing until it is approved again' },
];

export interface BuilderCheckRow extends ExpectedCheck {
  status: CheckStatus;
  detail: string;
}

/** The owner's list, each row with what the runner reported under its id - or "not run". */
export function builderCheckRows(checks: readonly RunnerCheck[], why: string): BuilderCheckRow[] {
  return BUILDER_CHECKS.map((e) => {
    const hit = checks.find((c) => c.id === e.id);
    return hit ? { ...e, status: hit.status, detail: hit.detail ?? '' } : { ...e, status: 'not-run' as const, detail: why };
  });
}

/** The runner's checks that are not on the builder list: shown as they are, so none is lost. */
export function otherChecks(checks: readonly RunnerCheck[]): RunnerCheck[] {
  const known = new Set(BUILDER_CHECKS.map((c) => c.id));
  return checks.filter((c) => !known.has(c.id));
}

export interface Finding {
  /** Where it was observed: a check's title, a chain route, an order type. */
  where: string;
  /** The runner's evidence, in its own words. */
  evidence: string;
}

/**
 * Everything the run reported as a FINDING - in the checks, on a chain route,
 * for an order type - each with the runner's own evidence text.
 */
export function findings(checks: readonly RunnerCheck[], chains: readonly ChainRow[], orders: readonly OrderTypeRow[]): Finding[] {
  const out: Finding[] = [];
  const none = '(the runner gave no evidence text)';
  for (const c of checks) if (c.status === 'finding') out.push({ where: c.title, evidence: c.detail ?? none });
  for (const c of chains) {
    if (c.deposit.status === 'finding') out.push({ where: `${c.chain} ${c.coin} deposit`, evidence: c.deposit.detail || none });
    if (c.withdraw.status === 'finding') out.push({ where: `${c.chain} ${c.coin} withdrawal`, evidence: c.withdraw.detail || none });
  }
  for (const o of orders) if (o.status === 'finding') out.push({ where: o.title, evidence: o.detail || none });
  return out;
}

// --- chains -------------------------------------------------------------------------------------

export interface ChainCell {
  status: CheckStatus;
  detail: string;
}

export interface ChainRow {
  chain: string;
  coin: string;
  deposit: ChainCell;
  withdraw: ChainCell;
}

const cell = (v: unknown): ChainCell => {
  const o = obj(v);
  if (!o) return { status: checkStatus(v), detail: '' };
  return { status: checkStatus(o.status ?? o.ok), detail: text(o.detail) ?? text(o.reason) ?? '' };
};

/** `Arbitrum One       USDC       open, min 5        open, min 5        1          deposit, withdraw+verify` */
export function parseRouteRow(line: string): { chain: string; coin: string; native: boolean; depositOpen: boolean; withdrawOpen: boolean; runner: string } | null {
  const m = /^(.+?)\s+(\S+)\s+(open, min \S+|CLOSED)\s+(open, min \S+|CLOSED)\s+(\S+)\s+(.+)$/.exec(line.trim());
  if (!m) return null;
  return { chain: m[1]!.trim(), coin: m[2]!.replace(/\*$/, ''), native: m[2]!.endsWith('*'), depositOpen: m[3] !== 'CLOSED', withdrawOpen: m[4] !== 'CLOSED', runner: m[6]!.trim() };
}

interface Touched {
  chain: string;
  coin: string;
  step: string;
}

/** Which chain/coin each deposit and withdrawal step of the plan touches, from the plan's own lines. */
export function touchedByPlan(plan: Pick<PlanView, 'steps'>): { deposits: Touched[]; withdrawals: Touched[] } {
  const deposits: Touched[] = [];
  const withdrawals: Touched[] = [];
  for (const s of plan.steps) {
    if (s.skip) continue;
    for (const l of s.lines) {
      let m = /^send [\d.]+ (\S+) on (.+?) \((?:0x[0-9a-fA-F]{40}|[^)]*)\) to the wallet's own SoDEX deposit address/.exec(l);
      if (m) deposits.push({ coin: m[1]!, chain: m[2]!, step: s.id });
      m = /^[\d.]+ (\S+) from (.+?) to the wallet's \S+ deposit address/.exec(l);
      if (m) deposits.push({ coin: m[1]!, chain: m[2]!, step: s.id });
      m = /^(\S+) (?:[\d.]+|all of Spot) -> (.+?) \((?:native|token|0x[0-9a-fA-F]{40})\) to /.exec(l);
      if (m) withdrawals.push({ coin: m[1]!, chain: m[2]!, step: s.id });
    }
  }
  return { deposits, withdrawals };
}

const stepResult = (live: Pick<LiveView, 'steps'> | null, step: string): ChainCell => {
  if (!live) return { status: 'not-run', detail: 'planned only - no live run' };
  const s = live.steps.find((x) => x.id === step);
  if (!s) return { status: 'not-run', detail: `the run did not reach ${step}` };
  if (s.status === 'ok') return { status: 'pass', detail: `step ${step}` };
  if (s.status === 'skipped') return { status: 'skipped', detail: s.reason ?? `step ${step} was skipped` };
  return { status: 'fail', detail: `step ${step}: ${s.error ?? s.status}` };
};

/**
 * Every chain SoDEX offers, with what this run did on it. From `report.chains`
 * when the runner writes it; else from the plan's route table and the steps.
 */
export function chainRows(report: unknown, plan: Pick<PlanView, 'routes' | 'steps'> | null, live: Pick<LiveView, 'steps'> | null): ChainRow[] {
  const listed = obj(report)?.chains;
  if (Array.isArray(listed) && listed.length) {
    return listed.flatMap((c): ChainRow[] => {
      const o = obj(c);
      const chain = text(o?.label) ?? text(o?.chain);
      if (!o || !chain) return [];
      return [{ chain, coin: text(o.coin) ?? '', deposit: cell(o.deposit), withdraw: cell(o.withdraw) }];
    });
  }
  if (!plan) return [];
  const touched = touchedByPlan(plan);
  const rows: ChainRow[] = [];
  for (const line of plan.routes.slice(1)) {
    const r = parseRouteRow(line);
    if (!r) continue;
    const same = (t: Touched): boolean => t.chain === r.chain && t.coin.toUpperCase() === r.coin.toUpperCase();
    const dep = touched.deposits.find(same);
    const wd = touched.withdrawals.find(same);
    const canDeposit = /\bdeposit\b/.test(r.runner);
    const canWithdraw = /\bwithdraw/.test(r.runner);
    const verify = /withdraw\+verify/.test(r.runner) ? 'arrival verified on the chain' : 'SoDEX\'s withdrawal record only - this computer cannot read that chain';
    rows.push({
      chain: r.chain,
      coin: r.coin,
      deposit: dep
        ? stepResult(live, dep.step)
        : !r.depositOpen
          ? { status: 'not-testable', detail: 'deposits are closed on SoDEX right now' }
          : !canDeposit
            ? { status: 'not-testable', detail: r.native ? 'the runner sends USDC deposits only (a chain\'s coins share one deposit address)' : 'the runner cannot sign on this chain' }
            : { status: 'not-run', detail: 'not part of this run' },
      withdraw: wd
        ? { ...stepResult(live, wd.step), ...(live && live.steps.find((x) => x.id === wd.step)?.status === 'ok' ? { detail: verify } : {}) }
        : !r.withdrawOpen
          ? { status: 'not-testable', detail: 'withdrawals are closed on SoDEX right now' }
          : !canWithdraw
            ? { status: 'not-testable', detail: 'the app does not offer this route' }
            : { status: 'not-run', detail: 'not part of this run' },
    });
  }
  return rows;
}

// --- order types --------------------------------------------------------------------------------

export interface OrderTypeRow {
  title: string;
  status: CheckStatus;
  detail: string;
}

/**
 * Every order type the run exercised. From `report.orderTypes` when the runner
 * writes it; else the recorded actions of its `orders` step (an action line,
 * followed by its "verify" lines).
 */
export function orderTypeRows(report: unknown, live: Pick<LiveView, 'steps'> | null): OrderTypeRow[] {
  const listed = obj(report)?.orderTypes;
  if (Array.isArray(listed) && listed.length) {
    return listed.flatMap((x): OrderTypeRow[] => {
      const o = obj(x);
      const title = text(o?.title) ?? text(o?.id);
      if (!o || !title) return [];
      return [{ title: `${text(o.engine) ? `${text(o.engine)}: ` : ''}${title}`, status: checkStatus(o.status ?? o.ok), detail: text(o.detail) ?? '' }];
    });
  }
  // `orders` in the runner of 2026-10-02; `orders-spot` and `orders-perps` after it was split.
  const orderSteps = (live?.steps ?? []).filter((s) => s.id === 'orders' || s.id.startsWith('orders-'));
  if (!orderSteps.length) return [];
  const rows: OrderTypeRow[] = [];
  for (const sub of orderSteps.flatMap((s) => s.subSteps)) {
    const isVerify = /^verify\b|: verify\b/i.test(sub.title);
    const st: CheckStatus = sub.status === 'ok' ? 'pass' : sub.status === 'warn' ? 'warn' : 'fail';
    const last = rows.at(-1);
    if (isVerify && last) {
      // A failed verification fails the action it belongs to.
      if (st === 'fail') {
        last.status = 'fail';
        last.detail = `${sub.title}: ${sub.detail ?? 'failed'}`;
      } else if (last.status === 'pass' && !last.detail) last.detail = 'verified';
    } else if (!isVerify && /\b(BUY|SELL|limit|market|cancel|order)\b/i.test(sub.title)) {
      rows.push({ title: sub.title, status: st, detail: st === 'pass' ? '' : sub.detail ?? '' });
    }
  }
  return rows;
}
