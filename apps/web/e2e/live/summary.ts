/**
 * `<report>.summary.md` - the run in words, next to the JSON report, built
 * from the report alone (pure: units.test.ts feeds it a report).
 *
 * Order, as the owner asked: the BUILDER FEE first (its section's heading names
 * fees, so the guided launcher takes it, with the fee of every fill under it, as
 * the runner's fee table), then what failed and the findings, the chains, the
 * order types, the trading key, the refusals, transfers and withdrawals, the
 * cross-check, the cost, and where every coin is. Nothing is guessed: a check
 * the run did not record reads "not run", with why.
 */
import type { CheckRecord, CheckStatus } from './checks';
import { fillTableMarkdown } from './fees';
import type { StepRecord } from './context';

export interface SummaryInput {
  mode: string;
  profile: string;
  wallet: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  checks: readonly CheckRecord[];
  chains: ReadonlyArray<{ chain: string; label?: string; coin?: string; native?: boolean; deposit: { status: string; detail: string }; withdraw: { status: string; detail: string }; route?: { status: string; detail: string } }>;
  feeTable: ReadonlyArray<Record<string, string | number | boolean | null>>;
  termsSeen: ReadonlyArray<{ at: number; verified: boolean; fee: { perps: number; spot: number } | null; flags: readonly string[] }>;
  spend: { costUsd: number; sentAwayUsd: number };
  maxSpendUsd: number;
  builder: { id: number; feePerps: number; feeSpot: number } | null;
  steps: readonly StepRecord[];
  whereFunds: readonly string[] | null;
  inFlight: ReadonlyArray<{ what: string; ref?: string }>;
  plan: { problems: readonly string[]; notTestable: ReadonlyArray<{ what: string; why: string }> } | null;
}

/** The builder checks, in the order of docs/BUILDER-TIERS.md section 8 and then the rest. */
export const BUILDER_ORDER: readonly string[] = [
  'builder-approval',
  'builder-terms-signed',
  'builder-terms-tamper-rejected',
  'builder-fee-default',
  'builder-volume-verified',
  'builder-fee-lowered',
  'builder-underpaid-not-counted',
  'builder-no-builder-not-counted',
  'builder-no-builder-flagged',
  'builder-terms-back-to-default',
  'builder-approval-enforced',
  'builder-reapproved-orders-resume',
  'builder-modify-keeps-builder',
  'builder-replace-keeps-builder',
  'builder-spot-buy-not-charged',
  'builder-order-records',
  'builder-income-matches',
  'builder-revoke',
  'refuse-unapproved-builder',
  'refuse-builder-fee-above-approval',
  'perps-fees-builder',
  'spot-fees-builder',
];

const WORD: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', finding: 'FINDING', skipped: 'skipped', 'not-run': 'not run' };
const esc = (s: unknown): string => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const clip = (s: string, n = 320): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const usd = (n: number): string => `$${n.toFixed(2)}`;

function table(head: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string[] {
  if (!rows.length) return ['(none)'];
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map((c) => esc(c)).join(' | ')} |`)];
}

const checkRows = (list: readonly CheckRecord[]): Array<readonly unknown[]> => list.map((c) => [c.id, WORD[c.status], clip(c.detail || c.title)]);

/** The fee the server signed, as it changed over the run ("perps 20 -> 15 -> 20"). */
function feeHistory(seen: SummaryInput['termsSeen']): string | null {
  const fees = seen.filter((t) => t.verified && t.fee).map((t) => `perps ${t.fee!.perps} / spot ${t.fee!.spot}`);
  const steps = fees.filter((f, i) => i === 0 || f !== fees[i - 1]);
  return steps.length ? steps.join(' -> ') : null;
}

/** The route checks whose evidence says SoDEX's withdrawal minimum does not cover its fee, worded for the owner. */
export function minimumsBelowFee(checks: readonly CheckRecord[]): string[] {
  const out: string[] = [];
  for (const c of checks) {
    const m = c.evidence?.minBelowFee as { coin: string; label: string; min: string; fee: string } | undefined;
    if (!m) continue;
    const equal = Number(m.min) === Number(m.fee);
    out.push(
      `- **${m.coin} to ${m.label}**: minimum ${m.min} ${m.coin}, fee ${m.fee} ${m.coin}. ${
        equal
          ? `A user who withdraws exactly the minimum would receive nothing - the fee takes all of it.`
          : `A user who withdraws the minimum - or anything up to ${m.fee} ${m.coin} - would receive nothing: the fee is larger than the amount.`
      } The app's Withdraw sheet stops it before anything is signed ("The amount must be more than the ${m.fee} ${m.coin} fee"), so nothing is lost - but the minimum SoDEX shows is misleading: the smallest withdrawal that pays anything out is just above ${m.fee} ${m.coin}.`,
    );
  }
  return out;
}

export function buildSummary(r: SummaryInput): string {
  const md: string[] = [];
  const by = new Map(r.checks.map((c) => [c.id, c]));
  const counts = { pass: 0, fail: 0, finding: 0, skipped: 0, 'not-run': 0 } as Record<CheckStatus, number>;
  for (const c of r.checks) counts[c.status] += 1;
  const area = (a: string) => r.checks.filter((c) => c.area === a);

  md.push(`# Live E2E run - ${r.mode === 'plan' ? 'PLAN (nothing was signed or sent)' : 'LIVE'} - profile ${r.profile}`, '');
  md.push(`- wallet \`${r.wallet}\`, ${r.startedAt} to ${r.finishedAt}, exit code ${r.exitCode}`);
  md.push(`- checks: ${counts.pass} pass, ${counts.fail} fail, ${counts.finding} finding(s), ${counts.skipped} skipped, ${counts['not-run']} not run`);
  if (r.mode === 'plan') md.push('- plan mode: every check that needs a live run reads "not run"; the route checks are read-only and ran');
  md.push('');

  // --- 1. the builder fee ---------------------------------------------------------------------------------------
  md.push('## Builder fee and the fee of every fill', '');
  if (!r.builder) md.push('No builder was configured for this run: every builder check is skipped. The fee of every fill (SoDEX\'s commission) is below.', '');
  else {
    md.push(`Builder #${r.builder.id}, default fee perps ${r.builder.feePerps} / spot ${r.builder.feeSpot} (tenths of a basis point).`);
    const h = feeHistory(r.termsSeen);
    if (h) md.push(`The fee the server signed for this wallet, as it changed: ${h}.`);
    const flags = [...new Set(r.termsSeen.flatMap((t) => t.flags))];
    if (flags.length) md.push(`Flags the server set on this wallet: ${flags.join(', ')}.`);
    md.push('');
  }
  const builderChecks = [...BUILDER_ORDER.map((id) => by.get(id)).filter((c): c is CheckRecord => !!c), ...r.checks.filter((c) => c.area === 'builder' && !BUILDER_ORDER.includes(c.id))];
  md.push(...table(['check', 'verdict', 'what was seen'], checkRows(builderChecks)), '');
  md.push('### Fee of every fill', '');
  md.push(...fillTableMarkdown(r.feeTable), '');

  // --- 2. what failed, and the findings ---------------------------------------------------------------------------
  const failed = r.checks.filter((c) => c.status === 'fail');
  const findings = r.checks.filter((c) => c.status === 'finding');
  md.push('## Failed checks', '');
  md.push(...(failed.length ? table(['check', 'what was seen'], failed.map((c) => [c.id, clip(c.detail, 500)])) : ['None.']), '');
  md.push('## Findings (how SoDEX or the app behaved - for you to decide on, not failures)', '');
  const short = minimumsBelowFee(r.checks);
  if (short.length) {
    md.push('### Withdrawal minimums that do not cover the fee', '');
    md.push('On these routes SoDEX states a withdrawal minimum that is not more than the fee it charges. What it means for a user who tries such a withdrawal:', '');
    md.push(...short, '');
  }
  md.push(...(findings.length ? table(['check', 'what was seen'], findings.map((c) => [c.id, clip(c.detail, 500)])) : ['None.']), '');
  if (r.plan?.problems.length) md.push('## Plan problems', '', ...r.plan.problems.map((p) => `- ${esc(p)}`), '');

  // --- 3. chains ------------------------------------------------------------------------------------------------------
  md.push('## Chains', '');
  md.push(...table(['chain', 'coin', 'deposit', 'withdrawal', 'route check'], r.chains.map((c) => [`${c.label ?? c.chain}`, `${c.coin ?? ''}${c.native ? ' (native)' : ''}`, `${c.deposit.status}${c.deposit.detail && c.deposit.status !== 'pass' ? `: ${clip(c.deposit.detail, 120)}` : ''}`, `${c.withdraw.status}${c.withdraw.detail && c.withdraw.status !== 'pass' ? `: ${clip(c.withdraw.detail, 120)}` : ''}`, c.route ? `${c.route.status}${c.route.status === 'finding' || c.route.status === 'fail' ? `: ${clip(c.route.detail, 160)}` : ''}` : '-'])), '');
  const tour = r.checks.filter((c) => c.step === 'evm-tour' || c.step === 'chain-withdrawals' || c.step === 'manual-deposits');
  if (tour.length) md.push('### Every chain leg', '', ...table(['check', 'verdict', 'what was seen'], checkRows(tour)), '');
  if (r.plan?.notTestable.length) md.push('### Not testable automatically', '', ...r.plan.notTestable.map((n) => `- **${esc(n.what)}**: ${esc(n.why)}`), '');

  // --- 4. order types -------------------------------------------------------------------------------------------------
  md.push('## Order types', '');
  md.push(...table(['engine', 'check', 'verdict', 'what was seen'], [...area('orders-perps'), ...area('orders-spot')].map((c) => [c.area === 'orders-perps' ? 'perps' : 'spot', c.id, WORD[c.status], clip(c.detail || c.title, 220)])), '');

  // --- 5. the trading key -------------------------------------------------------------------------------------------------
  md.push('## The trading key', '', ...table(['check', 'verdict', 'what was seen'], checkRows(area('keys'))), '');

  // --- 6. refusals --------------------------------------------------------------------------------------------------------
  md.push('## Refusals (nothing here may move anything)', '', ...table(['check', 'verdict', 'what was seen'], checkRows(area('refusals'))), '');

  // --- 7. transfers, withdrawals, deposits, the cross-check ----------------------------------------------------------------
  const funds = r.checks.filter((c) => (c.area === 'transfers' || c.area === 'deposits' || c.area === 'withdrawals') && !tour.includes(c));
  md.push('## Transfers, deposits and withdrawals', '', ...table(['check', 'verdict', 'what was seen'], checkRows(funds)), '');
  md.push('## Cross-check', '', ...table(['check', 'verdict', 'what was seen'], checkRows(area('cross-checks'))), '');

  // --- 8. cost --------------------------------------------------------------------------------------------------------
  md.push('## Cost', '');
  md.push(`Spent ${usd(r.spend.costUsd)} in costs (fees, gas, activation, trading) + ${usd(r.spend.sentAwayUsd)} sent to your other addresses = ${usd(r.spend.costUsd + r.spend.sentAwayUsd)} (maxSpendUsd ${usd(r.maxSpendUsd)}).`, '');
  const measured = r.steps.filter((s) => s.id !== 'preflight' && (s.measured || s.estimateUsd !== undefined));
  if (measured.length) {
    md.push(...table(['step', 'status', 'estimate', 'measured cost', 'sent to your other addresses'], measured.map((s) => [s.id, s.status, s.estimateUsd === undefined ? '-' : usd(s.estimateUsd), s.measured ? usd(s.measured.costUsd) : 'not measured', s.measured ? usd(s.measured.sentAwayUsd) : '-'])), '');
  }

  // --- 9. where every coin is ------------------------------------------------------------------------------------------
  md.push('## Where every coin is', '');
  if (r.whereFunds?.length) md.push('```', ...r.whereFunds.map((l) => l.replace(/^ {2}/, '')), '```');
  else md.push(r.mode === 'plan' ? 'Plan mode: nothing moved.' : 'The balances could not be read at the end - check the app.');
  if (r.inFlight.length) md.push('', '**In flight:**', ...r.inFlight.map((f) => `- ${esc(f.what)}${f.ref ? ` (${esc(f.ref)})` : ''}`));
  md.push('');
  return md.join('\n');
}
