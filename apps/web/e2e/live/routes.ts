/**
 * Every route, read-only, in every run and every profile (preflight): for each
 * coin SoDEX lists on a chain (USDC and the chain's native coin, and every
 * route the config names), one check `route-<coin>-<chain>`:
 *
 *   - open or closed, both ways; minimum and fee as the asset config states them,
 *     and the fee the chain itself charges (withdrawQuote) - a difference is a finding
 *   - SoDEX's maintenance switch for the coin on that chain (deposit, withdraw)
 *   - the wallet's deposit address there, when one is issued: well-formed for
 *     the chain's address format, and the app's Deposit sheet and the on-chain
 *     registry name the same one (--registry-only: the registry alone)
 *   - the app's own receiver check for that chain: a well-formed address is
 *     accepted, every malformed one (empty, cut short, mistyped, another
 *     format's, the zero address) is refused; for XRP / Stellar the memo rules
 *
 * Nothing here signs or sends; the checks are recorded in plan mode too.
 * And the list of what no run can test automatically, with why.
 */
import { api } from '../../src/api';
import { addressProblem, type AddressKind } from '../../src/trading/addresses';
import { memoProblem, withdrawQuote, type ChainRoute, type CoinConfig } from '../../src/trading/funds';
import { maintenanceFor, maintenanceNote } from '../../src/trading/relay';
import { formatUnits } from '../../src/trading/onboard';
import { appSendsUsdc, chainRank, evmChain } from './chains';
import { routeCheckId, type Checks } from './checks';
import type { RunConfig } from './config';
import { chainReceiverName } from './chainRoutes';
import { registryDepositAddresses } from './reads';
import { receiverFormatProblems } from './receivers';
import { approx, errText, shortAddr } from './util';

/** Two deposit addresses are the same one: EVM addresses in any case, every other format exactly. */
export const sameDepositAddress = (a: string, b: string, kind: AddressKind | 'other' = 'evm'): boolean => (kind === 'evm' ? a.toLowerCase() === b.toLowerCase() : a.trim() === b.trim());

export interface RouteRef {
  coin: CoinConfig;
  route: ChainRoute;
}

/** The routes checked: USDC and the native coin of every chain, plus every route the config names. */
export function routesToCheck(coins: readonly CoinConfig[], cfg: RunConfig): RouteRef[] {
  const out = new Map<string, RouteRef>();
  const addRef = (coin: CoinConfig | undefined, key: string): void => {
    const route = coin?.chains.find((r) => r.key === key);
    if (coin && route) out.set(`${coin.coin.toUpperCase()}|${key}`, { coin, route });
  };
  const usdc = coins.find((c) => c.coin.toUpperCase() === 'USDC');
  for (const c of coins) {
    for (const r of c.chains) {
      if (c === usdc || r.isNativeToken) addRef(c, r.key);
    }
  }
  const named = (n: string) => coins.find((c) => c.coin.toUpperCase() === n.toUpperCase());
  addRef(named(cfg.withdrawExternal.coin), cfg.withdrawExternal.chain);
  for (const x of cfg.extraWithdrawals) addRef(named(x.coin), x.chain);
  for (const d of cfg.manualDeposits) addRef(named(d.coin), d.chain);
  return [...out.values()].sort((a, b) => chainRank(a.route.key) - chainRank(b.route.key) || a.route.key.localeCompare(b.route.key) || (a.coin === usdc ? -1 : b.coin === usdc ? 1 : a.coin.coin.localeCompare(b.coin.coin)));
}

/** The app's memo rules on a memo chain (XRP, Stellar): asked for, digits only, XRP's 32-bit limit. */
export function memoRuleProblems(route: ChainRoute): string[] {
  if (route.memo !== 'numeric') return [];
  const out: string[] = [];
  if (memoProblem(route, '', false) === null) out.push('an empty memo is accepted without "no memo" ticked');
  if (memoProblem(route, '123456789', false) !== null) out.push('a numeric memo is refused');
  if (memoProblem(route, 'abc', false) === null) out.push('a memo with letters is accepted');
  if (route.key === 'XRP' && memoProblem(route, '4294967296', false) === null) out.push('an XRP destination tag above 4294967295 is accepted');
  if (memoProblem(route, '', true) !== null) out.push('"no memo" is not accepted');
  return out;
}

interface Reads {
  /** coin -> chain -> address, from the app's Deposit sheet (null: not asked / not readable). */
  app: Map<string, Map<string, { address: string; verified: boolean }>> | null;
  appError: string | null;
  registry: Map<string, Map<string, string> | Error>;
}

/** Check every route; the verdicts go into `checks` (declared here). Returns lines for the plan and warnings. */
export async function checkRoutes(o: { owner: string; coins: readonly CoinConfig[]; cfg: RunConfig; registryOnly: boolean; checks: Checks; say?: (s: string) => void }): Promise<{ lines: string[]; warnings: string[] }> {
  const refs = routesToCheck(o.coins, o.cfg);
  const reads: Reads = { app: null, appError: null, registry: new Map() };
  if (!o.registryOnly) {
    try {
      const r = await api.depositOptions(o.owner);
      reads.app = new Map(r.assets.map((a) => [a.symbol.toUpperCase(), new Map(a.routes.filter((x) => x.address).map((x) => [x.chain.toUpperCase(), { address: x.address, verified: x.verified }]))]));
    } catch (e) {
      reads.appError = errText(e);
    }
  }
  for (const coin of new Set(refs.map((r) => r.coin.coin.toUpperCase()))) {
    reads.registry.set(coin, await registryDepositAddresses(o.owner, coin).catch((e) => (e instanceof Error ? e : new Error(String(e)))));
  }
  // Four at a time; the results stay in table order.
  const results: Array<Awaited<ReturnType<typeof judgeRoute>>> = new Array(refs.length);
  let next = 0;
  const work = async (): Promise<void> => {
    for (let i = next++; i < refs.length; i = next++) results[i] = await judgeRoute(o, refs[i]!, reads);
  };
  await Promise.all([work(), work(), work(), work()]);
  const warnings = results.flatMap((r, i) => (r.status === 'fail' ? [`route ${refs[i]!.coin.coin} on ${refs[i]!.route.label}: ${r.problems.join('; ')}`] : []));
  return { lines: results.map((r) => r.line), warnings };
}

async function judgeRoute(o: { owner: string; checks: Checks }, ref: RouteRef, reads: Reads): Promise<{ status: 'pass' | 'fail' | 'finding' | 'skipped'; line: string; problems: string[] }> {
  const { coin, route } = ref;
  const id = routeCheckId(coin.coin, route.key);
  o.checks.declare({
    id,
    area: 'routes',
    step: 'preflight',
    title: `SoDEX's ${coin.coin} route on ${route.label} as the app sees it: open or closed, minimum, fee (config and chain), maintenance; the wallet's deposit address there; the app's receiver check for that chain`,
  });
  const head = `${coin.coin} ${route.label}`;
  if (route.addressKind === 'other') {
    o.checks.skip(id, `the app does not offer ${route.label}`);
    return { status: 'skipped', line: `${head}: skipped - the app does not offer this chain`, problems: [] };
  }
  const facts: string[] = [];
  const problems: string[] = [];
  const findings: string[] = [];
  facts.push(route.deposit.allowed ? `deposits open (min ${route.deposit.min ?? '-'})` : 'deposits CLOSED');
  facts.push(route.withdraw.allowed ? `withdrawals open (min ${route.withdraw.min ?? '-'}, fee ${route.withdraw.fee ?? '-'})` : 'withdrawals CLOSED');
  if (!route.deposit.allowed && !route.withdraw.allowed) {
    o.checks.skip(id, `${facts.join(', ')} on SoDEX right now - nothing to check`, { deposit: route.deposit, withdraw: route.withdraw });
    return { status: 'skipped', line: `${head}: skipped - closed both ways`, problems: [] };
  }
  // The fee the chain charges (what the app shows and passes back).
  if (route.withdraw.allowed) {
    try {
      const q = await withdrawQuote(coin, route, o.owner);
      const onChain = formatUnits(q.fee, coin.valuechain.decimals);
      facts.push(`on-chain fee ${onChain}`);
      if (route.withdraw.fee !== null && approx(onChain) !== approx(route.withdraw.fee)) findings.push(`SoDEX's asset config says fee ${route.withdraw.fee}, the chain charges ${onChain} (the app shows and pays the chain's)`);
      if (route.withdraw.min !== null && approx(route.withdraw.min) <= approx(onChain)) findings.push(`the withdrawal minimum ${route.withdraw.min} does not cover the ${onChain} fee - a withdrawal of the minimum would leave nothing (the app refuses it; the smallest real one is above the fee)`);
    } catch (e) {
      facts.push(`on-chain fee unreadable (${errText(e)})`);
    }
  }
  // Maintenance.
  const m = await maintenanceFor(coin.coin, o.owner).catch(() => null);
  if (!m || !m.known) facts.push('maintenance status unreadable');
  else {
    for (const affect of ['deposit', 'withdraw'] as const) {
      const n = maintenanceNote(m, route.key, affect);
      if (!n) continue;
      facts.push(`${affect}s ${n.severity}: ${n.message}`);
      const open = affect === 'deposit' ? route.deposit.allowed : route.withdraw.allowed;
      if (n.severity === 'unavailable' && open) findings.push(`${affect}s are open in the asset config but SoDEX's maintenance switch has them unavailable: ${n.message}`);
    }
  }
  // The wallet's deposit address there.
  if (route.deposit.allowed) {
    const reg = reads.registry.get(coin.coin.toUpperCase());
    const registry = reg instanceof Error || !reg ? null : reg.get(route.key) ?? null;
    const app = reads.app?.get(coin.coin.toUpperCase())?.get(route.key) ?? null;
    if (reg instanceof Error) facts.push(`registry unreadable (${reg.message})`);
    if (!registry && !app) facts.push('deposit address not issued yet');
    else {
      const addr = (app?.address ?? registry)!;
      const bad = addressProblem(route.addressKind, addr);
      if (bad) problems.push(`the deposit address ${addr} is not a valid ${route.addressKind} address (${bad})`);
      if (app && registry && !sameDepositAddress(app.address, registry, route.addressKind)) problems.push(`the app's Deposit sheet names ${app.address}, the on-chain registry ${registry}`);
      else facts.push(`deposit address ${shortAddr(addr)}${app && registry ? ' (app = registry)' : registry ? ' (registry)' : ' (app only - the registry lists none)'}`);
      if (app && !registry && !(reg instanceof Error)) findings.push(`the app's Deposit sheet offers ${app.address} but the per-coin registry lists no ${coin.coin} address on ${route.label}`);
    }
    if (reads.appError) facts.push(`the app's deposit options unreadable (${reads.appError})`);
  }
  // The app's receiver check for this chain.
  const rx = [...receiverFormatProblems(route), ...memoRuleProblems(route)];
  problems.push(...rx);
  if (!rx.length) facts.push(`receiver check ok${route.memo ? ' (memo rules too)' : ''}`);
  const detail = `${facts.join('; ')}${findings.length ? ` - ${findings.join('; ')}` : ''}${problems.length ? ` - ${problems.join('; ')}` : ''}`;
  const evidence = { deposit: route.deposit, withdraw: route.withdraw, addressKind: route.addressKind };
  if (problems.length) {
    o.checks.fail(id, detail, evidence);
    return { status: 'fail', line: `${head}: FAIL - ${detail}`, problems };
  }
  if (findings.length) {
    o.checks.finding(id, detail, evidence);
    return { status: 'finding', line: `${head}: FINDING - ${detail}`, problems: [] };
  }
  o.checks.pass(id, detail, evidence);
  return { status: 'pass', line: `${head}: ok - ${detail}`, problems: [] };
}

/** What no run can test automatically, per route (one line each) and overall, with why (the plan prints it; the report carries it). */
export function notTestable(coins: readonly CoinConfig[], cfg: RunConfig): Array<{ what: string; why: string }> {
  const out: Array<{ what: string; why: string }> = [];
  const manual = new Set(cfg.manualDeposits.map((d) => `${d.coin.toUpperCase()}|${d.chain}`));
  for (const { coin, route } of routesToCheck(coins, cfg)) {
    const what = `${coin.coin} on ${route.label}`;
    if (route.addressKind === 'other') {
      out.push({ what, why: 'the app does not offer this chain at all' });
      continue;
    }
    if (!route.deposit.allowed && !route.withdraw.allowed) {
      out.push({ what, why: 'closed both ways on SoDEX right now' });
      continue;
    }
    const evm = route.addressKind === 'evm';
    const spec = evmChain(route.key);
    const why: string[] = [];
    if (route.deposit.allowed) {
      if (!evm && !manual.has(`${coin.coin.toUpperCase()}|${route.key}`)) why.push(`deposit: the runner cannot sign on ${route.label} - opt in with manualDeposits { "coin": "${coin.coin}", "chain": "${route.key}", "amount": "${route.deposit.min ?? '...'}" } and send it by hand (the run waits for it and verifies it)`);
      if (evm && !spec) why.push('deposit: the runner has no chain id and public RPC for this chain (chains.ts)');
      if (evm && spec && !route.isNativeToken && coin.coin.toUpperCase() === 'USDC' && !appSendsUsdc(route.key)) why.push('deposit: the app sends USDC deposits only from its own chains');
      if (evm && spec && !route.isNativeToken && coin.coin.toUpperCase() !== 'USDC') why.push('deposit: a token other than USDC - the app sends no deposit of it and the runner sends native coins only');
    } else why.push('deposit: closed on SoDEX right now');
    if (route.withdraw.allowed) {
      if (!evm) why.push(`withdrawal: the arrival cannot be read from this computer - SoDEX's withdrawal record is the evidence (to your own address in receivers.${chainReceiverName(route.key)})`);
    } else why.push('withdrawal: closed on SoDEX right now');
    if (why.length) out.push({ what, why: why.join('; ') });
  }
  const evmKeys = new Set(coins.flatMap((c) => c.chains.filter((r) => r.addressKind === 'evm').map((r) => r.key)));
  for (const key of evmKeys) {
    const native = coins.some((c) => c.chains.some((r) => r.key === key && r.isNativeToken));
    const spec = evmChain(key);
    if (!native && spec) out.push({ what: `gas on ${spec.name}`, why: `SoDEX lists no ${spec.native.symbol} route there: the gas for sending USDC back must come from you (the plan's funding checklist says how much)` });
  }
  out.push({ what: "the builder account's own withdrawal of its fee income", why: 'it is the builder wallet\'s business, not the test wallet\'s - the run reads the income from public balances only' });
  out.push({ what: 'a deposit address SoDEX flags ("Suspicious") and replaces', why: 'cannot be provoked from outside; the app withholds a flagged address, and the plan says so when it sees one' });
  return out;
}

/** One line per route for the plan's table (how the route checks came out). */
export const routeLineHeader = 'Routes, checked read-only (open/closed, minimum, fee, maintenance, deposit address, the app\'s receiver check)';
