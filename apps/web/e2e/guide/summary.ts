/**
 * Stage E: the one summary of everything - for the screen, as Markdown and as
 * JSON. Pure: it is handed what the stages recorded and returns text.
 *
 * It leads with what the owner asked to see - the builder fee checks, every
 * chain, every order type, what it cost - and nothing in those sections is
 * guessed: what the live runner did not report is "not run" (report.ts).
 *
 * NO SECRETS. Both files are scrubbed at the very end (scrub.ts): anything the
 * size of a key that is not a transaction hash from a known hash field is
 * replaced, whatever produced it.
 */
import { builderCheckRows, chainRows, findings, orderTypeRows, otherChecks, readChecks, type CheckStatus } from './report';
import type { LiveView, PlanView } from './runner';
import { collectTxHashes, makeKeyRedactor, scrubJson, scrubText } from './scrub';
import type { Item, StageResult } from './types';
import { fmtDur, fmtUsd, table, toAscii, wrap } from './ui';

export interface SummaryInput {
  startedAt: string;
  finishedAt: string;
  /** How the guide was started (never a key: the arguments cannot carry one). */
  mode: { stages: string[]; planOnly: boolean; throwawayKey: boolean; yes: boolean };
  /** Every stage that was selected, in order - skipped ones included. */
  stages: StageResult[];
  /** Why the run ended early (Ctrl+C, input ended), or null. */
  stopped: string | null;
  wallet: string | null;
  profile: string | null;
  plan: PlanView | null;
  live: LiveView | null;
  /** The runner's raw reports (for report.ts) - only ever read, never copied whole into the summary. */
  planReport: unknown;
  liveReport: unknown;
  /** The runner's own fee table, when it provides one (already text rows). */
  feeTable: string[] | null;
  /** Lines for apps/web/.env.local that stage C printed. */
  envLines: string[];
  next: string[];
  files: { summaryMd: string; summaryJson: string; logsDir: string; runnerReport: string | null; runnerSummary: string | null };
  /** The key held during stage D, to keep it out even of a "known hash" (null: none was held). */
  key: string | null;
}

export type Overall = 'PASS' | 'FAIL' | 'STOPPED' | 'INCOMPLETE';

export function overall(i: Pick<SummaryInput, 'stages' | 'stopped'>): Overall {
  if (i.stages.some((s) => s.status === 'FAIL')) return 'FAIL';
  if (i.stopped) return 'STOPPED';
  if (i.stages.length && i.stages.every((s) => s.status === 'PASS')) return 'PASS';
  return 'INCOMPLETE';
}

const STATUS_WORD: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', finding: 'FINDING', warn: 'WARN', skipped: 'SKIPPED', 'not-run': 'not run', 'not-testable': 'not testable' };

/** What a stage SPENT: the cost of the rows that ran. A planned row's cost is an estimate and is not money spent. */
const sumCost = (items: readonly Item[]): number | null => {
  const xs = items.filter((x) => x.status !== 'PLANNED').map((x) => x.costUsd).filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
};

/** A row's cost: what it cost - or, for a planned row, the estimate, marked as one. */
const rowCost = (x: Item): string => (x.status === 'PLANNED' && typeof x.costUsd === 'number' ? `~${fmtUsd(x.costUsd)}` : fmtUsd(x.costUsd));

/** Markdown table cell: no pipes, no line breaks. */
const cellMd = (s: string): string => s.replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ').trim();
const mdTable = (headers: string[], rows: string[][]): string[] => [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map((c) => cellMd(c ?? '')).join(' | ')} |`)];

export interface BuiltSummary {
  json: Record<string, unknown>;
  markdown: string;
  /** Lines for the screen (plain text). */
  screen: string[];
}

export function buildSummary(i: SummaryInput): BuiltSummary {
  const verdict = overall(i);
  const dSelected = i.stages.some((s) => s.id === 'D');
  const dStage = i.stages.find((s) => s.id === 'D');
  const liveRan = !!i.live && i.live.mode === 'live';

  // --- what the owner asked to see ------------------------------------------------------------
  const whyNotRun = !dSelected
    ? 'the live money run (stage D) was not part of this run'
    : liveRan
      ? 'the live runner did not report this check'
      : i.mode.planOnly
        ? 'plan only - nothing was executed'
        : dStage?.reason ?? 'the live money run did not take place';
  const checks = readChecks(i.liveReport);
  const builderRows = builderCheckRows(checks, whyNotRun);
  const others = otherChecks(checks);
  const chains = chainRows(i.liveReport ?? i.planReport, i.plan, liveRan ? i.live : null);
  const orders = orderTypeRows(i.liveReport, liveRan ? i.live : null);
  const found = findings(checks, chains, orders);
  const spend = i.live?.spend ?? null;
  const cap = i.live?.maxSpendUsd ?? i.plan?.maxSpendUsd ?? null;
  const estimate = i.plan && i.plan.estimatedCostUsd !== null ? i.plan.estimatedCostUsd + (i.plan.estimatedSentAwayUsd ?? 0) : null;

  // --- the JSON twin --------------------------------------------------------------------------
  const json: Record<string, unknown> = {
    tool: 'valuescan-guided-tests',
    version: 1,
    result: verdict,
    startedAt: i.startedAt,
    finishedAt: i.finishedAt,
    stopped: i.stopped,
    mode: i.mode,
    wallet: i.wallet,
    profile: i.profile,
    builderFeeChecks: builderRows.map((r) => ({ letter: r.letter, id: r.id, title: r.title, status: r.status, detail: r.detail })),
    findings: found,
    otherRunnerChecks: others,
    chains,
    orderTypes: orders,
    cost: { estimatedUsd: estimate, spentUsd: spend ? spend.costUsd : null, sentToOtherAddressesUsd: spend ? spend.sentAwayUsd : null, spendCapUsd: cap },
    stages: i.stages.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      reason: s.reason ?? null,
      startedAt: s.startedAt,
      ms: s.ms,
      costUsd: sumCost(s.items),
      notes: s.notes,
      items: s.items.map((x) => ({ id: x.id, group: x.group ?? null, title: x.title, status: x.status, ms: x.ms ?? null, costUsd: x.costUsd ?? null, detail: x.detail ?? null, log: x.log ?? null, txs: x.txs ?? [] })),
    })),
    feeTable: i.feeTable,
    whereFunds: i.live?.whereFunds ?? [],
    inFlight: i.live?.inFlight ?? [],
    envLines: i.envLines,
    next: i.next,
    files: i.files,
  };

  // --- the screen and the Markdown file -------------------------------------------------------
  const screen: string[] = [];
  const md: string[] = [];
  md.push(`# Valuescan guided test run - ${verdict}`, '', `Started ${i.startedAt}, finished ${i.finishedAt}.`, `Stages: ${i.mode.stages.join(', ')}${i.mode.planOnly ? ' (stage D: plan only)' : ''}${i.mode.throwawayKey ? ' (throwaway key)' : ''}.`);
  if (i.wallet) md.push(`Test wallet: \`${i.wallet}\`${i.profile ? `, profile \`${i.profile}\`` : ''}.`);
  if (i.stopped) md.push('', `**The run was stopped early: ${i.stopped}.**`);
  md.push('');
  screen.push(`RESULT: ${verdict}${i.stopped ? ` (stopped early: ${i.stopped})` : ''}`, '');

  /** A numbered section heading, on the screen and in the file. */
  let sectionNo = 0;
  const section = (name: string, shout: string): void => {
    sectionNo++;
    md.push(`## ${sectionNo}. ${name}`, '');
    screen.push(`${sectionNo}. ${shout}`);
  };
  const indent = (lines: string[]): string[] => lines.map((l) => `   ${l}`);

  if (!dSelected) {
    // Nothing of the live run exists: say so once instead of four empty sections.
    section('Builder fee, chains, order types, cost', 'BUILDER FEE, CHAINS, ORDER TYPES, COST');
    md.push(`Not run: ${whyNotRun}.`, '');
    screen.push(`   not run: ${whyNotRun}`, '');
  } else {
    // Builder fee.
    section('Builder fee', 'BUILDER FEE - what you asked to see');
    md.push(...mdTable(['', 'Check', 'Result', 'Evidence'], builderRows.map((r) => [`(${r.letter})`, r.title, STATUS_WORD[r.status], r.detail])), '');
    screen.push(...indent(table(['', 'check', 'result'], builderRows.map((r) => [`(${r.letter})`, r.title, STATUS_WORD[r.status]]), { max: [3, 92, 12] })));
    for (const r of builderRows.filter((x) => x.detail && x.status !== 'not-run' && x.status !== 'finding')) screen.push(...wrap(`(${r.letter}) ${r.detail}`, 110, '      '));
    if (builderRows.every((r) => r.status === 'not-run')) screen.push(...wrap(`why: ${whyNotRun}`, 110, '   '));
    // Findings: how SoDEX behaved where the run only observes. Not failures - but they are for the owner to read.
    if (found.length) {
      md.push('**Findings** - what the run observed about how SoDEX behaves. These are not failures; read them:', '', ...found.map((f) => `- **${cellMd(f.where)}**: ${cellMd(f.evidence)}`), '');
      screen.push('', `   FINDINGS (${found.length}) - not failures; this is how SoDEX behaved. Read them:`);
      for (const f of found) screen.push(...wrap(`- ${f.where}: ${f.evidence}`, 110, '     ').map((l, k) => (k === 0 ? l : `  ${l}`)));
    }
    if (others.length) {
      md.push('Other checks the runner reported:', '', ...mdTable(['Check', 'Result', 'Detail'], others.map((c) => [c.title, STATUS_WORD[c.status], c.detail ?? ''])), '');
      screen.push('   other checks the runner reported:', ...indent(table(['check', 'result'], others.map((c) => [c.title, STATUS_WORD[c.status]]), { max: [86, 12] })));
    }
    screen.push('');

    // Chains.
    section('Every chain: deposit and withdrawal', 'EVERY CHAIN - deposit and withdrawal');
    if (!chains.length) {
      md.push('Not run: no plan was made, so the route table is not known.', '');
      screen.push('   not run: no plan was made, so the route table is not known');
    } else {
      const cellText = (c: { status: CheckStatus; detail: string }): string => `${STATUS_WORD[c.status]}${c.detail ? ` - ${c.detail}` : ''}`;
      md.push(...mdTable(['Chain', 'Coin', 'Deposit', 'Withdrawal'], chains.map((c) => [c.chain, c.coin, cellText(c.deposit), cellText(c.withdraw)])), '');
      screen.push(...indent(table(['chain', 'coin', 'deposit', 'withdrawal'], chains.map((c) => [c.chain, c.coin, STATUS_WORD[c.deposit.status], STATUS_WORD[c.withdraw.status]]))));
      const ran = (s: CheckStatus): boolean => s === 'pass' || s === 'finding';
      const tested = chains.filter((c) => ran(c.deposit.status) || ran(c.withdraw.status)).length;
      const failed = chains.filter((c) => c.deposit.status === 'fail' || c.withdraw.status === 'fail');
      screen.push(`   ${tested} of ${chains.length} routes tested${failed.length ? `, ${failed.length} FAILED` : ''}. Why each of the others was not: in the summary file.`);
      for (const c of failed) screen.push(...wrap(`FAILED ${c.chain} ${c.coin}: ${[c.deposit, c.withdraw].filter((x) => x.status === 'fail').map((x) => x.detail).join('; ')}`, 110, '      '));
    }
    screen.push('');

    // Order types.
    section('Every order type', 'EVERY ORDER TYPE');
    if (!orders.length) {
      const why = liveRan ? 'the live run did not reach its orders step' : whyNotRun;
      md.push(`Not run: ${why}.`, '');
      screen.push(`   not run: ${why}`);
    } else {
      md.push(...mdTable(['Order', 'Result', 'Detail'], orders.map((o) => [o.title, STATUS_WORD[o.status], o.detail])), '');
      screen.push(...indent(table(['order', 'result'], orders.map((o) => [o.title, STATUS_WORD[o.status]]), { max: [92, 12] })));
    }
    screen.push('');

    // Cost.
    section('What it cost', 'WHAT IT COST');
    const costLines = [
      `estimated by the plan ......... ${fmtUsd(estimate)}`,
      `spent in the live run ......... ${spend ? fmtUsd(spend.costUsd) : 'nothing - no live run'}`,
      `sent to your other addresses .. ${spend ? fmtUsd(spend.sentAwayUsd) : '-'}`,
      `spend cap ..................... ${fmtUsd(cap)}`,
    ];
    md.push(...costLines.map((l) => `- ${l.replace(/ \.+ /, ': ')}`), '');
    screen.push(...indent(costLines), '');
  }

  // Every stage, every step.
  section('Every stage, every step', 'EVERY STAGE, EVERY STEP');
  const stageRows = i.stages.map((s) => [s.id, s.title, s.status, fmtDur(s.ms), fmtUsd(sumCost(s.items)), s.reason ?? '']);
  md.push(...mdTable(['Stage', 'What', 'Result', 'Time', 'Cost', 'Note'], stageRows), '');
  screen.push(...indent(table(['stage', 'what', 'result', 'time', 'cost'], stageRows.map((r) => r.slice(0, 5)), { right: [3, 4] })));
  for (const s of i.stages) if (s.reason) screen.push(...wrap(`${s.id}: ${s.reason}`, 110, '      '));
  screen.push('');
  for (const s of i.stages) {
    if (!s.items.length) continue;
    const name = (x: Item): string => `${x.group ? `${x.group}: ` : ''}${x.title}`;
    md.push(`### Stage ${s.id} - ${s.title}: ${s.status}`, '');
    md.push(...mdTable(['Result', 'Item', 'Time', 'Cost', 'Detail'], s.items.map((x) => [x.status, name(x), fmtDur(x.ms), rowCost(x), `${x.detail ?? ''}${x.txs?.length ? ` tx: ${x.txs.map((t) => t.explorer ?? `${t.chain} ${t.hash}`).join(', ')}` : ''}`])), '');
    for (const n of s.notes) md.push(`- ${n}`);
    if (s.notes.length) md.push('');
    screen.push(`   Stage ${s.id} - ${s.title}: ${s.status}`);
    // On the screen a group is a line of its own above its rows (the file repeats it in every row).
    const rows: string[][] = [];
    let group: string | undefined;
    for (const x of s.items) {
      if (x.group !== group) {
        group = x.group;
        if (group) rows.push(['', `[${group}]`, '', '']);
      }
      rows.push([x.status, x.title, fmtDur(x.ms), rowCost(x)]);
    }
    screen.push(...indent(table(['result', 'item', 'time', 'cost'], rows, { right: [2, 3], max: [8, 84, 8, 8] })));
    // Under the table: why, for every row that is not a plain pass (the file has it in its Detail column).
    for (const x of s.items) {
      if (x.status === 'FAIL' || x.status === 'WARN') screen.push(...wrap(`${x.status} ${x.title}: ${x.detail ?? ''}${x.log ? ` [log: ${x.log}]` : ''}`, 110, '      '));
      else if ((x.status === 'SKIPPED' || x.status === 'FINDING') && x.detail) screen.push(...wrap(`${x.status} ${x.title}: ${x.detail}`, 110, '      '));
    }
    screen.push('');
  }

  // The runner's fee table.
  if (i.feeTable?.length) {
    section('Fee table (from the live runner)', 'FEE TABLE (from the live runner)');
    md.push(...i.feeTable, '');
    screen.push(...indent(i.feeTable), '');
  }

  // Where every coin is.
  if (dSelected) {
    section('Where every coin is', 'WHERE EVERY COIN IS');
    if (i.live?.whereFunds.length) {
      md.push('```', ...i.live.whereFunds, ...i.live.inFlight.map((f) => `  IN FLIGHT  ${f}`), '```', '');
      screen.push(...i.live.whereFunds.map((l) => `   ${l.trimEnd()}`));
      for (const f of i.live.inFlight) screen.push(`   IN FLIGHT: ${f}`);
    } else {
      const none = liveRan
        ? 'The runner could not read the balances - connect the wallet in the app and look there.'
        : 'No live run took place: the guide moved nothing. Whatever you sent to the test wallet is still in that wallet.';
      md.push(none, '');
      screen.push(...wrap(none, 110, '   '));
    }
    screen.push('');
  }

  // Settings for the app.
  if (i.envLines.length) {
    section('Settings for the app (apps/web/.env.local)', 'SETTINGS FOR THE APP (apps/web/.env.local)');
    md.push('```', ...i.envLines, '```', '');
    screen.push(...indent(i.envLines), '');
  }

  // What to do next.
  section('What to do next', 'WHAT TO DO NEXT');
  const next = i.next.length ? i.next : ['Nothing: everything that was selected passed.'];
  next.forEach((n, k) => {
    md.push(`${k + 1}. ${n}`);
    screen.push(...wrap(`${k + 1}. ${n}`, 110, '   ').map((l, j) => (j === 0 ? l : `   ${l}`)));
  });
  md.push('');
  screen.push('');

  // Files.
  md.push('## Files', '', `- this summary: \`${i.files.summaryMd}\``, `- as JSON: \`${i.files.summaryJson}\``, `- logs of this run: \`${i.files.logsDir}\``);
  if (i.files.runnerReport) md.push(`- the live runner's report: \`${i.files.runnerReport}\``);
  if (i.files.runnerSummary) md.push(`- the live runner's own summary: \`${i.files.runnerSummary}\``);
  md.push('');
  screen.push('FILES', `   summary ....... ${i.files.summaryMd}`, `   as JSON ....... ${i.files.summaryJson}`, `   logs .......... ${i.files.logsDir}`);
  if (i.files.runnerReport) screen.push(`   runner report . ${i.files.runnerReport}`);
  if (i.files.runnerSummary) screen.push(`   runner summary  ${i.files.runnerSummary}`);

  // --- scrub ----------------------------------------------------------------------------------
  // Transaction hashes are known from the runner's hash fields and the rows' own tx lists - never from free text.
  const allow = collectTxHashes({ liveReport: i.liveReport, txs: i.stages.flatMap((s) => s.items.flatMap((x) => x.txs ?? [])) }, i.key);
  const exact = makeKeyRedactor(i.key);
  return {
    json: scrubJson(JSON.parse(exact(JSON.stringify(json))) as Record<string, unknown>, allow),
    markdown: scrubText(exact(toAscii(md.join('\n'))), allow),
    screen: screen.map((l) => scrubText(exact(toAscii(l)), allow)),
  };
}
