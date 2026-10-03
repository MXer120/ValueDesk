/**
 * Preflight: everything the runner reads before it may sign anything - and the
 * whole of `plan` mode. Read-only: every request here is a GET or a JSON-RPC
 * read (the guard enforces that in plan mode).
 *
 *   - the backend (network, ValueChain params, the pinned exchange contract)
 *   - SoDEX's live asset config: every route a selected step uses must be OPEN,
 *     amounts must clear its minimum; per-chain minimum + fee table
 *   - the wallet: balances on ValueChain and every EVM chain the app knows,
 *     its SoDEX account (a brand-new wallet is the expected start)
 *   - the wallet's USDC deposit address: the backend's answer AND an independent
 *     read of the on-chain registry - they must match
 *   - markets for the orders (tick/step/min notional, best bid/ask)
 *   - every receiver, validated for its chain before anything is signed
 *   - per-step estimates, a cash-flow simulation of the run, the total against
 *     maxSpendUsd, and a funding checklist
 */
import { api, type Symbol as MarketInfo } from '../../src/api';
import { addressProblem, type AddressKind } from '../../src/trading/addresses';
import { symbolFor } from '../../src/trading/actions';
import { assetConfigs, balancesOf, chainLabel, memoProblem, receiverProblem, toChecksumAddress, withdrawQuote, type ChainRoute, type CoinConfig } from '../../src/trading/funds';
import { maintenanceFor, maintenanceNote, receiverBlacklisted } from '../../src/trading/relay';
import { CANONICAL_USDC, formatUnits, parseUnits, usdcRoutes, type UsdcRoute } from '../../src/trading/onboard';
import { coinPrices, priceOf } from '../../src/trading/prices';
import { VALUECHAIN_RPC } from '../../src/trading/rpc';
import { sodexAccountId } from '../../src/trading/session';
import { ALL_EVM, GAS_FLOOR, appSendsUsdc, chainRank, evmChain } from './chains';
import { Checks } from './checks';
import type { RunConfig } from './config';
import { REPLACE_KEEPS_BUILDER } from '../../src/trading/feeGuard';
import { STEP_ORDER, STEP_TITLES, type DepositAddressCheck, type Mode, type Pre, type Recorder, type StepId } from './context';
import { chainWithdrawals } from './chainRoutes';
import { checkRoutes, notTestable, sameDepositAddress } from './routes';
import { depositBackProblem, gasReserve, nativeLegAmounts, oneWayAmount, oneWayUsdcAmount, reserveGasUnits, roundTripAmount, tourPlan, usdcLegAmounts } from './tour';
import { handKey, handLine, isHandActive, resolveHandPlans, type HandPlan } from './handBack';
import { VALUECHAIN_CHAIN_ID } from './provider';
import { engineState, gasPrice, nativeBalance, registryDepositAddresses, tokenBalance } from './reads';
import { requestTerms, type TermsVerdict, type TermsWatch } from './terms';
import { approx, cut, dCmp, dDiv, dMax, dMul, dSub, errText, isDecimal, lessPct, morePct, shortAddr, sleep, toStep, usd } from './util';

/** The SoDEX exchange contract on ValueChain (backend /api/deposit/chain; memory: sodex-browser-trading-protocol). */
export const PINNED_EXCHANGE = '0x0101010101010101010101010101010101010101';
/** The activation fee SoDEX keeps from a wallet's first deposit (USDC). */
export const ACTIVATION_FEE_USDC = '1';

/** A receiver address a selected step needs (`receivers.<name>` in the config). */
export interface ReceiverNeed {
  name: string;
  /** The chain key it is for (VALUECHAIN, SOL, XRP ...). */
  chain: string;
  /** What it is needed for. */
  why: string;
  /** The chain takes a memo (destination tag) and none - nor "noMemo" - is set. */
  memo: boolean;
  set: boolean;
  /** Set, and refused: why. null: fine (or not set). */
  problem: string | null;
}

export interface StepPlan {
  id: StepId;
  title: string;
  lines: string[];
  costUsd: number;
  sentAwayUsd: number;
  problems: string[];
  skip?: string;
}

export interface PlanResult {
  pre: Pre;
  plans: StepPlan[];
  problems: string[];
  warnings: string[];
  checklist: string[];
  totalCostUsd: number;
  totalSentAwayUsd: number;
  routeTable: string[];
  balances: string[];
  markets: string[];
  /** Every receiver address the selected steps name: set or not, and what is wrong with it (the guided launcher asks for these). */
  receiversNeeded: ReceiverNeed[];
  /** The server's fee terms for this wallet, as the runner judged them (null: no builder / no terms keys). */
  terms: { verdict: TermsVerdict; cacheControl: string | null } | null;
  /** Every route, checked read-only (routes.ts), one line each. */
  routeChecks: string[];
  /** What no run can test automatically, with why. */
  notTestable: Array<{ what: string; why: string }>;
  /** What the plan changed in the config for this profile (printed). */
  profileNotes: string[];
  /** A maxSpendUsd that covers this plan's estimate with room to spare. */
  suggestedMaxSpendUsd: number;
  /**
   * The deposits the owner can send back by hand (profile all-chains): every
   * route on a chain the runner cannot sign on, what the run sends there first,
   * what to send back, what the owner's wallet needs. The guided launcher offers them.
   */
  handDeposits: HandRow[];
  /** The run's money and time in one place (printed as "Budget"). */
  budget: Budget;
}

/** One hand-sent deposit as the plan offers it. */
export interface HandRow extends HandPlan {
  /** 'send': configured, the owner sends it; 'skipped': configured and left out; 'offered': not configured. */
  state: 'send' | 'skipped' | 'offered';
  /** The chain withdrawal to the owner's address runs first (a receiver is set, the route is open). */
  withdrawalRuns: boolean;
  /** The amount the run asks for (sendBack, or the configured amount). */
  amount: string;
  line: string;
  sendBackUsd: number;
}

export interface Budget {
  /** What to send to the test wallet before the run (the funding checklist). */
  fund: string[];
  costUsd: number;
  /** Sent to your own other addresses (withdrawals to your wallet on other chains). */
  sentAwayUsd: number;
  /** Of that, what comes back to the test wallet when you send every hand-sent deposit. */
  returnsUsd: number;
  /** What the run leaves on a chain it cannot bring it back from (Polygon USDC without POL ...). */
  leftOnChains: string[];
  /** Per hand-sent deposit: what YOUR wallet needs first (optional - only for the ones you send). */
  ownerWallet: string[];
  /** A rough duration: expected (SoDEX's estimates) and the worst case before a time-out stops it. */
  minutes: { expected: number; worst: number };
  suggestedMaxSpendUsd: number;
}

// --- markets: the smallest orders SoDEX accepts ----------------------------------------------

export interface Market {
  engine: 'spot' | 'perps';
  sym: MarketInfo;
  bid: string;
  ask: string;
}

export async function readMarket(engine: 'spot' | 'perps', ref: string): Promise<Market> {
  const sym = (await symbolFor(engine, ref)) as unknown as MarketInfo;
  const ob = await api.orderbook(engine, sym.name, 5);
  const bid = ob.book?.bids?.[0]?.[0];
  const ask = ob.book?.asks?.[0]?.[0];
  if (!isDecimal(bid) || !isDecimal(ask)) throw new Error(`${engine} ${sym.name}: the order book is empty`);
  return { engine, sym, bid, ask };
}

const rule = (v: string | undefined | null): string => (isDecimal(v) ? v : '0');

/**
 * A resting limit BUY far below the market, at the smallest size SoDEX takes.
 * The offset is kept inside the market's own downward price band (at 80 % of
 * it), so the order is accepted but does not fill.
 */
export function restingBuy(m: Market, offsetPct: number): { price: string; qty: string; offsetPct: number; lock: string } {
  const band = approx(m.sym.sellLimitDownRatio) * 100;
  const eff = band > 0 ? Math.min(offsetPct, Math.floor(band * 0.8 * 100) / 100) : offsetPct;
  let price = toStep(lessPct(m.bid, eff), rule(m.sym.tickSize), 'floor');
  if (dCmp(price, rule(m.sym.minPrice)) < 0) price = toStep(rule(m.sym.minPrice), rule(m.sym.tickSize), 'ceil');
  const minN = rule(m.sym.minNotional);
  let qty = dCmp(minN, '0') > 0 ? toStep(dDiv(morePct(minN, 5), price, 'ceil'), rule(m.sym.stepSize), 'ceil') : rule(m.sym.minQuantity);
  qty = toStep(dMax(qty, rule(m.sym.minQuantity)), rule(m.sym.stepSize), 'ceil');
  return { price, qty, offsetPct: eff, lock: dMul(price, qty) };
}

/** The smallest market-order size whose value at the ask clears the minimum notional by `headroomPct`. */
export function marketQty(m: Market, headroomPct: number): string {
  const minN = rule(m.sym.minNotional);
  let q = dCmp(minN, '0') > 0 ? toStep(dDiv(morePct(minN, headroomPct), m.ask, 'ceil'), rule(m.sym.stepSize), 'ceil') : '0';
  q = dMax(q, rule(m.sym.marketMinQuantity) !== '0' ? rule(m.sym.marketMinQuantity) : rule(m.sym.minQuantity));
  return toStep(q, rule(m.sym.stepSize), 'ceil');
}

/** Estimated cost of a market order of `qty` (taker fee + half the spread), in the quote coin (USDC). */
export function marketCost(m: Market, qty: string): number {
  const notional = approx(qty) * approx(m.ask);
  const halfSpread = ((approx(m.ask) - approx(m.bid)) / 2) * approx(qty);
  return notional * approx(m.sym.takerFee) + Math.max(0, halfSpread);
}

/** The spot market that buys `coin` with USDC (e.g. vETH_vUSDC), from the backend's symbol list. */
export async function spotMarketFor(coin: CoinConfig): Promise<Market> {
  const list = (await api.symbols('spot')).symbols;
  const s = list.find((x) => x.baseCoin?.toUpperCase() === coin.asset.toUpperCase() && x.quoteCoin?.toUpperCase() === 'VUSDC' && (!x.status || x.status === 'TRADING'));
  if (!s) throw new Error(`no ${coin.asset}/USDC spot market that is TRADING to buy ${coin.coin} on`);
  return readMarket('spot', s.name);
}

// --- deposit address: the backend and the on-chain registry must agree ------------------------

/**
 * The wallet's deposit address for `coin` (USDC unless named) on `chainKey`:
 * what the app's Deposit sheet offers (api.depositOptions, cross-checked by the
 * app itself) AND an independent eth_call of the per-coin registry. `waitMs` > 0
 * keeps asking while a new wallet's addresses are being issued (the Deposit
 * sheet polls every 8 s the same way).
 */
export async function checkDepositAddress(
  owner: string,
  chainKey: string,
  o: { registryOnly: boolean; waitMs: number; say?: (s: string) => void; coin?: string; kind?: AddressKind | 'other' },
): Promise<DepositAddressCheck> {
  const t0 = Date.now();
  const coinName = (o.coin ?? 'USDC').toUpperCase();
  for (;;) {
    let backend: string | null = null;
    let backendVerified = false;
    const notes: string[] = [];
    if (!o.registryOnly) {
      try {
        const r = await api.depositOptions(owner);
        const route = r.assets.find((a) => a.symbol.toUpperCase() === coinName)?.routes.find((x) => x.chain.toUpperCase() === chainKey);
        backend = route?.address || null;
        backendVerified = route?.verified === true;
        const rej = r.rejected.find((x) => x.chain.toUpperCase() === chainKey);
        if (!route) notes.push(rej ? `backend: ${rej.reason}` : `backend: no ${coinName} route on this chain yet (a new wallet\'s addresses take a moment to be issued)`);
      } catch (e) {
        notes.push(`backend: ${errText(e)}`);
      }
    } else {
      notes.push('--registry-only: the backend was not asked');
    }
    let registry: string | null = null;
    try {
      registry = (await registryDepositAddresses(owner, coinName)).get(chainKey) ?? null;
      if (!registry) notes.push(`registry: no ${coinName} address on this chain for this wallet yet`);
    } catch (e) {
      notes.push(`registry: ${errText(e)}`);
    }
    const match = !!backend && !!registry && sameDepositAddress(backend, registry, o.kind ?? 'evm');
    if (backend && registry && !match) notes.push('MISMATCH between the backend and the on-chain registry');
    const res: DepositAddressCheck = { backend, backendVerified, registry, match, ...(notes.length ? { note: notes.join('; ') } : {}) };
    if (match || (backend && registry) || Date.now() - t0 >= o.waitMs) return res;
    const left = o.waitMs - (Date.now() - t0);
    o.say?.(`deposit address on ${chainKey} not settled yet (${notes.join('; ')}) - asking again in ${Math.ceil(Math.min(8000, left) / 1000)} s`);
    await sleep(Math.max(0, Math.min(8000, left)));
  }
}

/** Why this deposit address may not be used (null = fine). */
export function depositAddressProblem(owner: string, chainKey: string, d: DepositAddressCheck | undefined, o: { coin?: string; kind?: AddressKind } = {}): string | null {
  const coinName = (o.coin ?? 'USDC').toUpperCase();
  const kind = o.kind ?? 'evm';
  if (!d) return `no deposit address was checked for ${chainKey}`;
  if (!d.backend) return `the backend has no verified ${coinName} deposit address on ${chainKey}${d.note ? ` (${d.note})` : ''}`;
  if (!d.backendVerified) return `the backend did not mark the ${chainKey} deposit address as verified`;
  if (!d.registry) return `the on-chain registry has no ${coinName} deposit address on ${chainKey} for this wallet`;
  if (!d.match) return `the backend (${d.backend}) and the on-chain registry (${d.registry}) disagree on the ${chainKey} deposit address`;
  const p = addressProblem(kind, d.backend);
  if (p) return `the ${chainKey} deposit address is not a valid ${kind} address (${p})`;
  if (kind === 'evm' && d.backend.toLowerCase() === owner) return 'the deposit address is the wallet itself';
  return null;
}

// --- preflight ------------------------------------------------------------------------------------

interface PreflightInput {
  mode: Mode;
  cfg: RunConfig;
  owner: string;
  selected: Set<StepId>;
  registryOnly: boolean;
  rec: Recorder;
  /** The runner's own judge of the server's fee terms (null: no builder with terms keys). */
  terms?: TermsWatch | null;
  /** The run profile (profiles.ts) and the notes applyProfile made. */
  profile?: string;
  profileNotes?: string[];
  /** Where the route checks are recorded (null: not recorded). */
  checks?: Checks | null;
}

/** What one perps market order costs, roughly: the taker fee, the builder fee at the default, half the spread. */
function perpsFillCost(m: Market, qty: string, builderFee: number): number {
  return marketCost(m, qty) + approx(qty) * approx(m.ask) * (builderFee / 100_000);
}

const ethGasUnits = { erc20: 65_000, approve: 55_000, deposit: 160_000 };

/** How the app changes a resting limit order, and what the run checks about its builder (G6). */
const changeNote = REPLACE_KEEPS_BUILDER
  ? " (the app uses SoDEX's replace - proven to keep the builder; the run checks the replacement's record still names it)"
  : " (the app changes it as cancel + new order; one replace sent by the runner shows whether SoDEX keeps the builder)";

export async function preflight(o: PreflightInput): Promise<PlanResult> {
  const { cfg, owner, rec } = o;
  const problems: string[] = [];
  const warnings: string[] = [];
  const say = (s: string) => rec.line(s, 5);
  const has = (id: StepId) => o.selected.has(id);

  // 1. The backend.
  const health = await rec.read('backend health', async () => {
    const h = await api.health();
    return { network: String(h?.network ?? ''), chainId: Number(h?.chainId), mainnetWritesAllowed: h?.mainnetWritesAllowed === true };
  }, (h) => `network ${h.network}, chain ${h.chainId}, app mainnet writes ${h.mainnetWritesAllowed ? 'allowed' : 'OFF'}`);
  if (health.network !== 'mainnet') problems.push(`the backend reads ${health.network || 'an unknown network'}, not mainnet`);
  if (health.chainId !== VALUECHAIN_CHAIN_ID) problems.push(`the backend's chain id is ${health.chainId}, not ${VALUECHAIN_CHAIN_ID}`);
  if (o.mode === 'live' && !health.mainnetWritesAllowed) problems.push('the backend reports mainnet writes switched off - the app itself would refuse to trade');

  const vc = await rec.read('ValueChain parameters (backend /api/deposit/chain)', () => api.depositChain(), (c) => `exchange ${c.exchange}`);
  if (vc.chainId !== VALUECHAIN_CHAIN_ID) problems.push(`the backend's ValueChain id is ${vc.chainId}`);
  if (vc.exchange.toLowerCase() !== PINNED_EXCHANGE) problems.push(`the backend names ${vc.exchange} as the SoDEX exchange contract; the runner only deposits to ${PINNED_EXCHANGE}`);
  if (vc.rpcUrl.replace(/\/+$/, '') !== VALUECHAIN_RPC) warnings.push(`the backend's ValueChain RPC is ${vc.rpcUrl}; the test wallet uses ${VALUECHAIN_RPC}`);

  // 2. SoDEX's live asset config.
  const coins = await rec.read('SoDEX asset config', () => assetConfigs(), (c) => `${c.length} coins`);
  const usdc = coins.find((c) => c.coin.toUpperCase() === 'USDC');
  const soso = coins.find((c) => c.valuechain.native);
  if (!usdc || usdc.assetId === null) throw new Error('SoDEX\'s asset config has no tradable USDC');
  if (!soso || soso.assetId === null) throw new Error('SoDEX\'s asset config has no tradable SOSO');

  // 3. The account.
  const accountId = await rec.read('SoDEX account', () => sodexAccountId(owner), (id) => (id ? `account #${id}` : 'none yet (a brand-new wallet)'));
  const newAccount = accountId === 0;
  if (!newAccount && o.mode === 'live' && !cfg.allowExistingAccount) {
    problems.push(`this wallet already has SoDEX account #${accountId}; a brand-new wallet is the expected start (set allowExistingAccount: true to use it anyway, e.g. to resume with --only)`);
  }
  if (!newAccount && has('deposit-external')) warnings.push('the account exists: deposit-external will be credited in full (no activation fee), not "amount - 1"');
  if (o.profile === 'builder-rerun') {
    if (newAccount) problems.push('builder-rerun runs on the funded test wallet of an earlier run - this wallet has no SoDEX account (run the core profile first)');
    if (!cfg.builder) problems.push('builder-rerun needs "builder" in the config (the builder account id and the fees)');
    else if (!cfg.builder.termsKeys.length) problems.push("builder-rerun needs builder.termsKeys (the server's terms public key) - without them the tier change cannot be tested");
  }
  if (newAccount) {
    const needsAccount = STEP_ORDER.filter((s) => s !== 'deposit-external' && s !== 'extra-deposits' && o.selected.has(s));
    if (needsAccount.length && !has('deposit-external')) problems.push(`no SoDEX account yet, but ${needsAccount.join(', ')} need one - include deposit-external`);
  }

  // 4. Balances.
  const prices = await coinPrices().catch(() => new Map<string, number>());
  const px = (coin: string): number | null => (/^v?USDC$/i.test(coin) ? 1 : priceOf(prices, coin) ?? null);
  const wallet = await rec.read('wallet balances (ValueChain + every EVM chain the runner signs on)', async () => {
    const out: Record<string, { native: string; usdc: string | null; err?: string }> = {};
    const reads: Array<Promise<void>> = [];
    reads.push(
      (async () => {
        try {
          const [n, u] = await Promise.all([nativeBalance(VALUECHAIN_RPC, owner), tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner)]);
          out.VALUECHAIN = { native: formatUnits(n, 18), usdc: formatUnits(u, usdc.valuechain.decimals) };
        } catch (e) {
          out.VALUECHAIN = { native: '0', usdc: null, err: errText(e) };
        }
      })(),
    );
    for (const c of Object.values(ALL_EVM)) {
      reads.push(
        (async () => {
          const canon = c.source === 'app' ? CANONICAL_USDC[c.key] : undefined;
          try {
            const [n, u] = await Promise.all([nativeBalance(c.rpcUrl, owner), canon ? tokenBalance(c.rpcUrl, canon.address, owner) : Promise.resolve(null)]);
            out[c.key] = { native: formatUnits(n, c.native.decimals), usdc: u === null || !canon ? null : formatUnits(u, canon.decimals) };
          } catch (e) {
            out[c.key] = { native: '0', usdc: null, err: errText(e) };
          }
        })(),
      );
    }
    await Promise.all(reads);
    return out;
  });
  const balances: string[] = [];
  const nativeSym = (key: string) => (key === 'VALUECHAIN' ? 'SOSO' : evmChain(key)?.native.symbol ?? '?');
  for (const key of ['VALUECHAIN', ...Object.keys(ALL_EVM)]) {
    const w = wallet[key];
    if (!w) continue;
    const name = key === 'VALUECHAIN' ? 'ValueChain' : evmChain(key)!.name;
    const usdcText = w.usdc !== null ? `, USDC ${cut(w.usdc, 6)}` : evmChain(key)?.source === 'runner' ? '' : ', USDC -';
    balances.push(`${name.padEnd(17)} ${w.err ? `could not read (${w.err})` : `${nativeSym(key)} ${cut(w.native, 8)}${nativeSym(key) === 'USDC' ? ' (the native coin)' : ''}${usdcText}`}`);
  }
  let spotUsdc = '0';
  let perpsUsdc = '0';
  let spotSoso = '0';
  if (!newAccount) {
    const [bu, bs] = await Promise.all([balancesOf(owner, usdc), balancesOf(owner, soso)]);
    spotUsdc = bu.spot;
    perpsUsdc = bu.perps;
    spotSoso = bs.spot;
    balances.push(`${'SoDEX Spot'.padEnd(16)} USDC ${cut(spotUsdc, 6)}, SOSO ${cut(spotSoso, 6)}`);
    balances.push(`${'SoDEX Perps'.padEnd(16)} USDC ${cut(perpsUsdc, 6)} (can move)`);
  }

  // 5. Routes: every one a selected step uses must be open; the per-chain table for the coverage plan.
  const coin = (name: string) => coins.find((c) => c.coin.toUpperCase() === name.toUpperCase());
  const route = (c: CoinConfig | undefined, chain: string): ChainRoute | undefined => c?.chains.find((r) => r.key === chain);
  const routeTable = coverageTable(coins);

  const depositRoutes: UsdcRoute[] = await usdcRoutes().catch((e) => {
    problems.push(`could not read SoDEX's USDC deposit routes: ${errText(e)}`);
    return [];
  });

  // 6. Deposit addresses (USDC, each chain a deposit comes from).
  const depositChains = [...(has('deposit-external') ? [cfg.deposit.chain] : []), ...(has('extra-deposits') ? cfg.extraDeposits.map((d) => d.chain) : [])];
  const depositAddresses = new Map<string, DepositAddressCheck>();
  const checkDepositChain = async (chainKey: string): Promise<void> => {
    const d = await rec.read(
      `USDC deposit address on ${chainKey}: backend vs on-chain registry`,
      () => checkDepositAddress(owner, chainKey, { registryOnly: o.registryOnly, waitMs: o.mode === 'live' ? cfg.timeouts.addressIssueSeconds * 1000 : 0, say }),
      (d) => `backend ${d.backend ?? '-'}${d.backend ? (d.backendVerified ? ' (verified)' : ' (NOT verified)') : ''} | registry ${d.registry ?? '-'} -> ${d.match ? 'MATCH' : 'no match'}${d.note ? ` [${d.note}]` : ''}`,
    );
    depositAddresses.set(chainKey, d);
    const p = depositAddressProblem(owner, chainKey, d);
    // A disagreement is a problem in any mode. Not issued yet is normal for a new wallet: live waits
    // for it (up to 3 min, like the Deposit sheet) and then still requires both sources to agree.
    const disagree = !!d.backend && !!d.registry && !d.match;
    if (p && (disagree || o.mode === 'live')) problems.push(`deposit ${chainKey}: ${p}`);
    else if (p) warnings.push(`deposit ${chainKey}: ${p} - a live run waits up to ${Math.round(cfg.timeouts.addressIssueSeconds / 60)} min for the addresses to be issued, then requires the backend and the registry to agree`);
  };
  for (const chainKey of [...new Set(depositChains)]) await checkDepositChain(chainKey);

  // 7. Markets.
  const markets: string[] = [];
  const mk = async (engine: 'spot' | 'perps', ref: string): Promise<Market | null> => {
    try {
      const m = await readMarket(engine, ref);
      if (m.sym.status && m.sym.status !== 'TRADING') problems.push(`${engine} ${m.sym.name} is ${m.sym.status}, not TRADING`);
      markets.push(
        `${engine.padEnd(5)} ${m.sym.name} (${m.sym.displayName}) bid ${m.bid} ask ${m.ask} | tick ${m.sym.tickSize} step ${m.sym.stepSize} min qty ${m.sym.minQuantity} min notional ${m.sym.minNotional} | taker ${(approx(m.sym.takerFee) * 100).toFixed(3)} %${m.sym.sellLimitDownRatio ? ` | limit band down ${(approx(m.sym.sellLimitDownRatio) * 100).toFixed(0)} %` : ''}`,
      );
      return m;
    } catch (e) {
      problems.push(`${engine} market ${ref}: ${errText(e)}`);
      return null;
    }
  };
  const needSpot = (['orders-spot', 'refusals', 'key-lifecycle'] as const).some(has);
  const needPerps = (['builder-tiers', 'orders-perps', 'refusals'] as const).some(has);
  const spotM = needSpot ? await mk('spot', cfg.orders.spotSymbol) : null;
  const perpsM = needPerps ? await mk('perps', cfg.orders.perpsSymbol) : null;
  if (spotM && spotM.sym.baseCoinID !== soso.assetId && has('spot-to-evm') && has('orders-spot')) {
    warnings.push(`orders.spotSymbol ${spotM.sym.name} does not buy SOSO: the ValueChain wallet will have no gas unless it already holds SOSO`);
  }

  // 7a. Every route, read-only (recorded as route-<coin>-<chain> checks).
  let routeLines: string[] = [];
  try {
    const rc = await rec.read('every route: open/closed, minimum, fee, maintenance, deposit address, the app\'s receiver check', () =>
      checkRoutes({ owner, coins, cfg, registryOnly: o.registryOnly, checks: o.checks ?? new Checks() }),
      (r) => `${r.lines.length} routes, ${r.warnings.length} with a problem`,
    );
    routeLines = rc.lines;
    warnings.push(...rc.warnings);
  } catch (e) {
    warnings.push(`the route checks could not run: ${errText(e)}`);
  }

  // 7b. The server's fee terms for this wallet (a read: no hint, nothing is verified by asking).
  let terms: PlanResult['terms'] = null;
  const b = cfg.builder;
  if (b && b.termsKeys.length && o.terms) {
    const watch = o.terms;
    try {
      const t = await rec.read('the server\'s fee terms for this wallet (GET /api/vs/builder/terms)', () => requestTerms(watch, owner), (x) =>
        x.verdict.off ? 'fee tiers are OFF on the backend' : x.verdict.verified ? `verified (key ${x.verdict.keyId}): perps ${x.verdict.answer.fee?.perps} / spot ${x.verdict.answer.fee?.spot}` : `NOT verified: ${x.verdict.problems.join('; ')}`,
      );
      terms = { verdict: t.verdict, cacheControl: t.cacheControl };
      const v = t.verdict;
      const tiersWanted = has('builder-tiers');
      const add = (msg: string): void => {
        (tiersWanted ? problems : warnings).push(msg);
      };
      if (v.off) add('builder-tiers: the backend answers `builderId: null` - it has no builder-tiers.json, so no fee tier can be tested (apps/server: npx tsx tools/builderTiers.ts init --builder-id <id> --test-tiers)');
      else if (!v.verified) add(`builder-tiers: the server's terms do not verify under builder.termsKeys: ${v.problems.join('; ')}`);
      else {
        const f = v.answer.fee!;
        if (f.perps < b.feePerps || f.spot < b.feeSpot) warnings.push(`this wallet's terms are already below the default (perps ${f.perps} / spot ${f.spot}): builder-fee-default cannot be shown on its first orders - use a new wallet, or clear it (apps/server: npx tsx tools/builderTiers.ts forget --address ${owner})`);
        if (v.answer.flags.includes('underpaid')) warnings.push(`the server has this wallet flagged "underpaid" (an earlier cheating test): it stays on the default fee and no tier can be reached - clear it first (apps/server: npx tsx tools/builderTiers.ts forget --address ${owner})`);
        if (!v.answer.tier?.next && !b.expectTier) warnings.push('the server announces no further fee tier for this wallet and the config names none: builder-volume-verified cannot run');
        if (!/\bno-store\b/i.test(t.cacheControl ?? '')) warnings.push(`the terms answer is sent with Cache-Control "${t.cacheControl ?? ''}", not no-store`);
      }
    } catch (e) {
      (has('builder-tiers') ? problems : warnings).push(`the server's fee terms could not be read: ${errText(e)}`);
    }
  }

  // 8. Step plans.
  const plans: StepPlan[] = [];
  const add = (id: StepId, p: Omit<StepPlan, 'id' | 'title'>) => plans.push({ id, title: STEP_TITLES[id], ...p });
  const gasUsd = async (chainKey: string, units: number): Promise<number> => {
    const url = chainKey === 'VALUECHAIN' ? VALUECHAIN_RPC : evmChain(chainKey)?.rpcUrl;
    if (!url) return 0;
    try {
      const gp = await gasPrice(url);
      const native = (Number(gp) * units * 1.5) / 1e18;
      return native * (px(nativeSym(chainKey)) ?? 0);
    } catch {
      return 0;
    }
  };
  const needs: Array<{ chain: string; coin: string; amount: number; have: number | null; why: string }> = [];
  /** What the run leaves on a chain it cannot bring back from (budget). */
  const leftOnChains: string[] = [];
  /** The hand-sent deposits, planned with live reads (all-chains). */
  const hand = has('chain-withdrawals') || has('manual-deposits')
    ? await resolveHandPlans(coins, cfg, {
        market: async (c) => !!(await spotMarketFor(c).catch(() => null)),
        fee: async (c, r) => formatUnits((await withdrawQuote(c, r, owner)).fee, c.valuechain.decimals),
      })
    : null;
  const handRows: HandRow[] = [];
  let returnsUsd = 0;
  const handActiveFor = (coinName: string, chain: string): boolean => has('manual-deposits') && isHandActive(cfg.manualDeposits.find((d) => d.coin.toUpperCase() === coinName.toUpperCase() && d.chain === chain) ?? null);

  // Cash flow through the run (estimates, to catch a run that cannot finish before it starts).
  const sim = { spotUsdc: approx(spotUsdc), perpsUsdc: approx(perpsUsdc), walletUsdc: approx(wallet.VALUECHAIN?.usdc ?? '0'), walletSoso: approx(wallet.VALUECHAIN?.native ?? '0'), spotSoso: approx(spotSoso) };
  // The largest Spot USDC shortfall of any step: a wide profile raises the deposit by it (below) instead of refusing.
  let deficit = 0;
  const shortfalls = new Set<string>();
  const short = (id: StepId, have: number, want: number, what: string): string | null => {
    if (have + 1e-9 >= want) return null;
    const msg = `${id}: ${what} would hold ~${have.toFixed(4)} but this step needs ~${want.toFixed(4)}`;
    if (what.startsWith('Spot USDC')) {
      deficit = Math.max(deficit, want - have);
      shortfalls.add(msg);
    }
    return msg;
  };

  /** The deposit-external plan for the configured amount (again, when a profile raises it). */
  const planDeposit = async (): Promise<{ plan: Omit<StepPlan, 'id' | 'title'>; needs: typeof needs }> => {
    const d = cfg.deposit;
    const r = depositRoutes.find((x) => x.chain.key === d.chain);
    const pr: string[] = [];
    const myNeeds: typeof needs = [];
    let cost = 0;
    if (!r) pr.push(`SoDEX has no OPEN canonical USDC deposit route on ${d.chain} right now`);
    else {
      if (approx(d.amount) < approx(r.minDeposit)) pr.push(`deposit.amount ${d.amount} is below SoDEX's minimum ${r.minDeposit} USDC on ${r.chain.name}`);
      if (newAccount && approx(d.amount) <= approx(ACTIVATION_FEE_USDC)) pr.push(`a first deposit must be more than the ${ACTIVATION_FEE_USDC} USDC activation fee`);
      try {
        parseUnits(d.amount, r.decimals);
      } catch (e) {
        pr.push(`deposit.amount: ${errText(e)}`);
      }
      cost = (newAccount ? approx(ACTIVATION_FEE_USDC) : 0) + (await gasUsd(d.chain, ethGasUnits.erc20));
      const w = wallet[d.chain];
      myNeeds.push({ chain: d.chain, coin: 'USDC', amount: approx(d.amount), have: w?.usdc === null || !w ? null : approx(w.usdc), why: 'deposit' });
      myNeeds.push({ chain: d.chain, coin: r.chain.native.symbol, amount: await gasNeed(d.chain), have: w ? approx(w.native) : null, why: 'gas for the USDC transfer (with headroom; the rest stays in the wallet)' });
    }
    const dAddr = depositAddresses.get(d.chain);
    return {
      plan: {
        lines: [
          `send ${d.amount} USDC on ${chainLabel(d.chain)} (${r?.token ?? 'canonical USDC'}) to the wallet's own SoDEX deposit address ${dAddr?.backend ?? dAddr?.registry ?? '(not issued yet)'}`,
          `wait for the receipt, then until SoDEX shows the account and Spot USDC +${newAccount ? `${approx(d.amount) - approx(ACTIVATION_FEE_USDC)} (amount - ${ACTIVATION_FEE_USDC} USDC activation)` : d.amount} (timeout ${cfg.timeouts.depositMinutes} min; SoDEX estimate ${r?.etaSeconds ? `~${Math.max(1, Math.round(r.etaSeconds / 60))} min` : 'n/a'})`,
        ],
        costUsd: cost,
        sentAwayUsd: 0,
        problems: pr,
      },
      needs: myNeeds,
    };
  };
  if (has('deposit-external')) {
    const dp = await planDeposit();
    add('deposit-external', dp.plan);
    needs.push(...dp.needs);
    sim.spotUsdc += approx(cfg.deposit.amount) - (newAccount ? approx(ACTIVATION_FEE_USDC) : 0);
  }

  if (has('enable-trading')) {
    const lines = [`one EIP-712 signature (UserSignedAddAPIKeyAction) registers key "valuescan-web" for ${cfg.keyTtlHours} h on spot + perps; verified in SoDEX's key list`];
    if (cfg.builder) {
      const b = cfg.builder;
      lines.push(
        `builder fee: builder account #${b.id}, perps ${b.feePerps} / spot ${b.feeSpot} tenths of a bp per order (spot: sells only), approved maximum ${b.maxFee}${b.required ? ', REQUIRED' : ', optional'}`,
        'if SoDEX does not already list that approval: ONE more signature (ApproveBuilderFeeAction) BEFORE the key, sent to POST /user/{wallet}/builders, then verified in GET /user/{wallet}/builders on both engines',
        'every order of this run must then carry the builder as the last field of its batch - an order naming an unapproved builder is rejected by SoDEX',
      );
    }
    add('enable-trading', { lines, costUsd: 0, sentAwayUsd: 0, problems: [] });
  }

  if (has('transfers')) {
    const a = cfg.transfers.amount;
    const p = short('transfers', sim.spotUsdc, approx(a), 'Spot USDC');
    add('transfers', { lines: [`Spot -> Perps ${a} USDC, then Perps -> Spot ${a} USDC; each verified in the balances`], costUsd: 0, sentAwayUsd: 0, problems: p ? [p] : [] });
  }

  // The perps steps borrow collateral from Spot and give it back; what they spend is fees.
  const perpsLev = async (m: Market): Promise<number> => {
    let lev = approx(String(m.sym.initLeverage ?? 20)) || 20;
    if (!newAccount) {
      const st = await engineState('perps', owner).catch(() => null);
      const s = st?.S?.find((x) => x.s === m.sym.name);
      if (s?.l) lev = s.l;
    }
    return lev;
  };
  const dfltPerps = cfg.builder?.feePerps ?? 0;
  const dfltSpot = cfg.builder?.feeSpot ?? 0;

  if (has('builder-tiers')) {
    const bt = cfg.builder;
    if (!bt) add('builder-tiers', { lines: [], costUsd: 0, sentAwayUsd: 0, problems: [], skip: 'no builder is configured for this run' });
    else if (!bt.termsKeys.length) add('builder-tiers', { lines: [], costUsd: 0, sentAwayUsd: 0, problems: [], skip: 'builder.termsKeys is empty: the server\'s fee terms cannot be verified, so the tiers cannot be tested (every order carries the default fee; the order steps check that)' });
    else if (!perpsM) add('builder-tiers', { lines: [], costUsd: 0, sentAwayUsd: 0, problems: [`perps market ${cfg.orders.perpsSymbol} could not be read`] });
    else {
      const q = marketQty(perpsM, 10);
      const unit = approx(q) * approx(perpsM.ask);
      const next = terms?.verdict.answer.tier?.next ?? null;
      const target = bt.expectTier ?? (next ? { atUsd: next.atUsd, perps: next.fee.perps, spot: next.fee.spot } : null);
      // First round trip, more round trips until past the milestone, one at the lower fee, the two cheating orders (1 + 2 units) and their close (3).
      const trips = target ? Math.max(1, Math.ceil((target.atUsd * 1.05) / (2 * unit))) : 1;
      const fills = 2 * trips + 2 + 1 + 2 + 1;
      const units = 2 * trips + 2 + 3 + 3;
      const cost = perpsFillCost(perpsM, q, dfltPerps) * units;
      const collateral = Math.max(approx(cfg.orders.perpsCollateral), Math.ceil(unit * 0.6 + 3));
      const pr: string[] = [];
      const p = short('builder-tiers', sim.spotUsdc, collateral, 'Spot USDC (perps collateral)');
      if (p) pr.push(p);
      sim.spotUsdc -= cost;
      add('builder-tiers', {
        lines: [
          `perps ${perpsM.sym.name}: move ~${collateral} USDC Spot -> Perps; one order is ${q} (~${unit.toFixed(2)} USD)`,
          `the server's terms for this wallet verify under builder.termsKeys and name the default fee (perps ${bt.feePerps} / spot ${bt.feeSpot})${terms ? `; now: ${terms.verdict.verified ? `perps ${terms.verdict.answer.fee?.perps} / spot ${terms.verdict.answer.fee?.spot}, verified volume $${terms.verdict.answer.volume?.totalUsd ?? '?'}` : 'NOT verified'}` : ''}`,
          'a copy of a real terms answer with its fee lowered is refused by the app (the default stays)',
          `${trips} round trip(s) (market buy + reduce-only close) at the default fee; each fill's builderFee is ${bt.feePerps / 10} bp of its notional`,
          target ? `past $${target.atUsd} of volume: hint, then wait up to ${cfg.timeouts.verifierMinutes} min for the server to sign perps ${target.perps} / spot ${target.spot} (no order history is read meanwhile)` : 'the server names no further tier: the lower-fee checks will not run',
          'one round trip at the lower fee; its fills pay the lower share',
          `two CHEATING orders the runner signs itself (around the app's gate, labelled DIRECT): ${q} with a fee below the one owed, ${dMul(q, '2')} with no builder; closed through the app; neither may be credited, the first must be flagged "underpaid"`,
          'the approval lowered below the fee owed, then revoked (two wallet signatures): the app must send nothing; then approved again (one more signature)',
          `about ${fills} fills, ~${units} units of ${unit.toFixed(2)} USD`,
        ],
        costUsd: cost * 1.5,
        sentAwayUsd: 0,
        problems: pr,
      });
    }
  }

  if (has('orders-spot')) {
    const pr: string[] = [];
    const lines: string[] = [];
    let cost = 0;
    if (!spotM) pr.push(`spot market ${cfg.orders.spotSymbol} could not be read`);
    else {
      const rb = restingBuy(spotM, cfg.orders.spotLimitOffsetPct);
      const q = cfg.orders.sosoBuyQuantity === 'auto' ? marketQty(spotM, 20) : cfg.orders.sosoBuyQuantity;
      const funds = approx(spotM.sym.minNotional) * 1.2 || 1.2;
      const buyUsd = approx(q) * approx(spotM.ask);
      const ioc = approx(rb.lock) * 1.05;
      lines.push(
        `spot ${spotM.sym.name}: limit BUY ${rb.qty} @ ${rb.price} (${rb.offsetPct} % below the bid, locks ~${cut(rb.lock, 4)} USDC) rests; price changed, size changed${dfltSpot ? changeNote : ''}; cancelled`,
        `market BUY for ${funds.toFixed(2)} USDC (by funds), market BUY ${q} (by quantity), market SELL of the smallest size`,
        'post-only (GTX) resting and crossing, IOC not crossing and crossing, FOK not fillable and fillable (SoDEX documents FOK as not supported: whatever it does is recorded)',
        'dead-man switch: scheduled a minute out, cleared',
        `every fill: commission at the account's own rate${dfltSpot ? `, builder fee ${dfltSpot / 10} bp on sells and none on buys` : ''}`,
      );
      cost = (marketCost(spotM, q) * 4 + buyUsd * (dfltSpot / 100_000)) * 1.5;
      const p1 = short('orders-spot', sim.spotUsdc, Math.max(approx(rb.lock), funds + buyUsd * 2 + ioc * 2) * 1.05, 'Spot USDC');
      if (p1) pr.push(p1);
      // About four buys and one sell of the smallest size: the rest stays in the base coin.
      const kept = funds + buyUsd * 3 - buyUsd * 0.95;
      sim.spotUsdc -= kept + cost;
      if (spotM.sym.baseCoinID === soso.assetId) sim.spotSoso += kept / Math.max(approx(spotM.ask), 1e-12);
    }
    add('orders-spot', { lines, costUsd: cost, sentAwayUsd: 0, problems: pr });
  }

  if (has('orders-perps')) {
    const pr: string[] = [];
    const lines: string[] = [];
    let cost = 0;
    if (!perpsM) pr.push(`perps market ${cfg.orders.perpsSymbol} could not be read`);
    else {
      const q = marketQty(perpsM, 10);
      const notional = approx(q) * approx(perpsM.ask);
      const lev = await perpsLev(perpsM);
      const collateral = Math.max(approx(cfg.orders.perpsCollateral), Math.ceil((6 * notional) / Math.max(1, lev - 1) + 3));
      const fills = 10;
      cost = perpsFillCost(perpsM, q, dfltPerps) * fills * 1.5;
      lines.push(
        `perps ${perpsM.sym.name}: move ~${collateral} USDC Spot -> Perps (leverage ${lev}x); one order is ${q} (~${notional.toFixed(2)} USD)`,
        'leverage changed in cross, the market switched to isolated; market buy by quantity; isolated margin +1 / -0.5 USDC; reduce-only close; back to cross',
        `limit BUY rests; price changed, size changed${dfltPerps ? changeNote : ''}; cancelled`,
        'post-only resting and crossing; IOC not crossing and crossing; stop-loss and take-profit on the position (listed, trigger changed, cancelled); a take-profit just above the market, waited for (not firing is reported, not failed)',
        'FOK not fillable and fillable (recorded whatever SoDEX does); entry with attached take-profit and stop-loss; cancel-all of three resting orders; dead-man switch cleared, then let fire',
        `every fill: commission at the account's own rate${dfltPerps ? `, builder fee ${dfltPerps / 10} bp of the notional` : ''}; ends flat, no open orders, at the leverage it started with; collateral back to Spot`,
        `about ${fills} fills of ~${notional.toFixed(2)} USD`,
      );
      const p2 = short('orders-perps', sim.spotUsdc, collateral, 'Spot USDC (perps collateral)');
      if (p2) pr.push(p2);
      sim.spotUsdc -= cost;
    }
    add('orders-perps', { lines, costUsd: cost, sentAwayUsd: 0, problems: pr });
  }

  if (has('refusals')) {
    const pr: string[] = [];
    const lines = [
      'refused by the app before signing: limit orders below the minimum notional (spot, perps), a quantity below one step, triggers on the last / index price, a spot trigger, transfers and withdrawals of more than the balance, a withdrawal below the minimum, malformed receivers for every address format',
      'off-grid price and size: the order leaves (and rests) at the snapped values',
      'refused by SoDEX (sent, must move nothing): market orders below the minimum notional, reduce-only with no position, an order naming a builder the wallet never approved, one with a fee above the approval (both signed by the runner itself, labelled DIRECT)',
    ];
    let cost = 0;
    if (perpsM) cost += perpsFillCost(perpsM, marketQty(perpsM, 10), dfltPerps) * 0.2; // only if SoDEX executes what it should refuse
    if (!perpsM || !spotM) pr.push('refusals need both markets');
    add('refusals', { lines, costUsd: cost, sentAwayUsd: 0, problems: pr });
  }

  if (has('spot-to-evm')) {
    const a = cfg.spotToEvm.usdc;
    const pr: string[] = [];
    const p = short('spot-to-evm', sim.spotUsdc, approx(a), 'Spot USDC');
    if (p) pr.push(p);
    const sosoAmt = cfg.spotToEvm.soso === 'all' ? sim.spotSoso : approx(cfg.spotToEvm.soso);
    if (cfg.spotToEvm.soso !== 'all' && sim.spotSoso + 1e-12 < sosoAmt) pr.push(`spot-to-evm: Spot would hold ~${sim.spotSoso} SOSO, not ${cfg.spotToEvm.soso}`);
    add('spot-to-evm', {
      lines: [`Spot -> ValueChain wallet ${a} USDC (engine EVM_WITHDRAW, key-signed); verify the wallet's USDC`, `Spot -> ValueChain wallet ${cfg.spotToEvm.soso === 'all' ? `all SOSO (~${sosoAmt.toFixed(4)})` : `${cfg.spotToEvm.soso} SOSO`} - lands as native SOSO (gas); verify the wallet's SOSO`],
      costUsd: 0,
      sentAwayUsd: 0,
      problems: pr,
    });
    sim.spotUsdc -= approx(a);
    sim.walletUsdc += approx(a);
    sim.walletSoso += sosoAmt;
    sim.spotSoso -= sosoAmt;
  }

  const vcGas = await gasUsd('VALUECHAIN', ethGasUnits.approve + ethGasUnits.deposit);
  const needSosoGas = (id: StepId, pr: string[]) => {
    if (sim.walletSoso < 0.001) pr.push(`${id}: the ValueChain wallet would hold ~${sim.walletSoso} SOSO - it needs SOSO for gas (run orders + spot-to-evm first, or send it some SOSO)`);
  };

  if (has('evm-to-spot')) {
    const a = cfg.evmToSpot.usdc;
    const pr: string[] = [];
    const p = short('evm-to-spot', sim.walletUsdc, approx(a), 'the ValueChain wallet\'s USDC');
    if (p) pr.push(p);
    add('evm-to-spot', {
      lines: [`ValueChain wallet -> Spot ${a} USDC (transferFunds -> depositFromWallet): the token's permit + a CallForPermit (DepositERC20WithPermit) - two signatures, relayed by SoDEX, no gas; verify Spot`],
      costUsd: 0,
      sentAwayUsd: 0,
      problems: pr,
    });
    sim.walletUsdc -= approx(a);
    sim.spotUsdc += approx(a);
  }

  if (has('withdraw-valuechain-self')) {
    const a = cfg.withdrawValuechainSelf.amount;
    const p = short('withdraw-valuechain-self', sim.spotUsdc, approx(a), 'Spot USDC');
    add('withdraw-valuechain-self', { lines: [`Withdraw sheet: ${a} USDC from Spot to the own ValueChain wallet (engine transfer, no wallet prompt); verify the wallet`], costUsd: 0, sentAwayUsd: 0, problems: p ? [p] : [] });
    sim.spotUsdc -= approx(a);
    sim.walletUsdc += approx(a);
  }

  if (has('withdraw-valuechain-other')) {
    const w = cfg.withdrawValuechainOther;
    const r = cfg.receivers[w.receiver];
    if (!r) {
      add('withdraw-valuechain-other', { lines: [], costUsd: 0, sentAwayUsd: 0, problems: [], skip: `receivers.${w.receiver} is not set` });
    } else {
      const pr: string[] = [];
      const bad = receiverProblem('VALUECHAIN', r.address);
      if (bad) pr.push(`receivers.${w.receiver}: ${bad}`);
      if (r.address.toLowerCase() === owner) pr.push(`receivers.${w.receiver} is this wallet itself - it must be a DIFFERENT address you control`);
      const p = short('withdraw-valuechain-other', sim.spotUsdc, approx(w.amount), 'Spot USDC');
      if (p) pr.push(p);
      needSosoGas('withdraw-valuechain-other', pr);
      add('withdraw-valuechain-other', {
        lines: [`Withdraw sheet: ${w.amount} USDC from Spot to ${r.address} on ValueChain (engine -> own wallet, then ONE ERC-20 transfer the wallet signs); verify the receiver's USDC`],
        costUsd: vcGas,
        sentAwayUsd: approx(w.amount),
        problems: pr,
      });
      sim.spotUsdc -= approx(w.amount);
    }
  }

  /**
   * One withdrawal to another chain, checked the way the app checks it before
   * anything moves - with the app's own reads: SoDEX's on-chain fee and
   * liquidity (withdrawQuote), its maintenance switch (maintenanceFor) and the
   * receiver blacklist (receiverBlacklisted). All reads; nothing is sent.
   */
  const withdrawal = async (id: StepId, spec: { coin: string; chain: string; amount: string; receiver: string; buyIfMissing?: boolean; fromHand?: boolean }, label: string) => {
    const pr: string[] = [];
    const lines: string[] = [];
    const c = coin(spec.coin);
    const r = route(c, spec.chain);
    let cost = 0;
    let away = 0;
    if (!c || c.assetId === null) pr.push(`${label}: SoDEX has no tradable coin "${spec.coin}"`);
    else if (!r) pr.push(`${label}: ${spec.coin} has no route on ${spec.chain}`);
    else {
      if (!r.withdraw.allowed) pr.push(`${label}: ${spec.coin} withdrawals to ${r.label} are CLOSED right now`);
      if (r.addressKind === 'other') pr.push(`${label}: the app does not offer ${r.label}`);
      const min = r.withdraw.min ?? '0';
      let fee = r.withdraw.fee ?? '0';
      let available: bigint | null = null;
      try {
        const q = await withdrawQuote(c, r, owner);
        const onChainFee = formatUnits(q.fee, c.valuechain.decimals);
        if (r.withdraw.fee !== null && approx(onChainFee) !== approx(r.withdraw.fee)) warnings.push(`${label}: SoDEX's asset config says fee ${r.withdraw.fee}, the chain says ${onChainFee} ${spec.coin} - the chain's applies`);
        fee = onChainFee;
        available = q.available;
      } catch (e) {
        warnings.push(`${label}: could not read SoDEX's on-chain fee for ${spec.coin} -> ${r.label} (${errText(e)}); using the asset config's ${fee}`);
      }
      const maint = await maintenanceFor(c.coin, owner).catch(() => null);
      const note = maintenanceNote(maint, r.key, 'withdraw');
      if (note?.severity === 'unavailable') pr.push(`${label}: SoDEX has ${spec.coin} withdrawals to ${r.label} paused: ${note.message}`);
      else if (note) warnings.push(`${label}: SoDEX reports ${spec.coin} withdrawals to ${r.label} as ${note.severity}: ${note.message}`);
      if (maint && !maint.known) warnings.push(`${label}: SoDEX's maintenance status could not be read (the app does not block on that)`);
      const amount = spec.amount === 'min' ? min : spec.amount === 'all' ? null : spec.amount;
      if (amount !== null && available !== null) {
        try {
          if (parseUnits(amount, c.valuechain.decimals) > available) pr.push(`${label}: SoDEX can pay out only ${formatUnits(available, c.valuechain.decimals)} ${spec.coin} on ${r.label} right now`);
        } catch {
          /* reported below */
        }
      }
      if (amount !== null && approx(amount) <= approx(fee)) pr.push(`${label}: ${amount} ${spec.coin} does not cover the ${fee} fee`);
      if (amount !== null) {
        if (approx(amount) < approx(min)) pr.push(`${label}: ${amount} ${spec.coin} is below the minimum ${min} on ${r.label}`);
        try {
          parseUnits(amount, c.valuechain.decimals);
        } catch (e) {
          pr.push(`${label}: ${errText(e)}`);
        }
      }
      const rcv: { address: string; memo?: string; noMemo?: boolean } | undefined = spec.receiver === 'self' ? { address: owner } : cfg.receivers[spec.receiver];
      if (!rcv) pr.push(`${label}: receivers.${spec.receiver} is not set`);
      else {
        if (spec.receiver === 'self' && r.addressKind !== 'evm') pr.push(`${label}: "self" is an EVM address - ${r.label} needs a receiver in receivers`);
        if (r.memo === 'numeric' && !rcv.memo && !rcv.noMemo) pr.push(`${label}: ${r.label} takes a memo (destination tag) - give receivers.${spec.receiver} a "memo", or "noMemo": true for an address that needs none`);
        const bad = receiverProblem(r, rcv.address) ?? memoProblem(r, rcv.memo ?? '', rcv.noMemo === true);
        if (bad) pr.push(`${label}: receiver ${rcv.address}: ${bad}`);
        else {
          // The receiver exactly as the permit will carry it (withdrawFunds: EVM checksummed, else "address:memo").
          const memo = r.memo === 'numeric' && !rcv.noMemo ? rcv.memo ?? '' : '';
          const permitReceiver = r.addressKind === 'evm' ? toChecksumAddress(rcv.address) : memo ? `${rcv.address}:${memo}` : rcv.address;
          const listed = await receiverBlacklisted(r.key, permitReceiver).catch(() => null);
          if (listed) pr.push(`${label}: SoDEX does not pay out to ${rcv.address} on ${r.label} (on-chain blacklist)`);
          if (listed === null) warnings.push(`${label}: could not read SoDEX's receiver blacklist for ${r.label}`);
          // Never toward this wallet's own SoDEX deposit address with less than the deposit minimum arriving (not credited).
          const own = await registryDepositAddresses(owner, c.coin)
            .then((m) => m.get(r.key) ?? null)
            .catch(() => null);
          if (own && amount !== null && sameDepositAddress(own, rcv.address, r.addressKind) && r.deposit.min && approx(amount) - approx(fee) < approx(r.deposit.min)) {
            pr.push(`${label}: ${rcv.address} is this wallet's own SoDEX deposit address on ${r.label}, and ${cut(String(approx(amount) - approx(fee)), 8)} ${spec.coin} would arrive - below SoDEX's deposit minimum ${r.deposit.min}, which it does not credit`);
          }
        }
      }
      const coinPx = px(c.coin) ?? 0;
      const amt = amount === null ? 0 : approx(amount);
      cost += approx(fee) * coinPx;
      const self = !!rcv && rcv.address.toLowerCase() === owner;
      if (!self) away += Math.max(0, amt - approx(fee)) * coinPx;
      const verifiable = r.addressKind === 'evm' && !!evmChain(r.key);
      lines.push(
        `${spec.coin} ${amount ?? 'all of Spot'} -> ${r.label} (${r.isNativeToken ? 'native' : r.tokenAddress ?? 'token'}) to ${spec.receiver === 'self' ? 'this wallet' : `${spec.receiver} ${rcv?.address ?? '?'}`}: min ${min}, fee ${fee} ${spec.coin} on-chain (~${usd(approx(fee) * coinPx)})${available !== null ? `, SoDEX can pay ${cut(formatUnits(available, c.valuechain.decimals), 4)}` : ''}; Spot -> own ValueChain wallet, SoDEX's address check, ONE permit signature relayed by SoDEX (it pays the gas); verify SoDEX's withdrawal record${verifiable ? ` and the balance on ${r.label}` : ` (arrival on ${r.label} cannot be read here - the record only)`}`,
      );
      if (c.coin.toUpperCase() === 'USDC') {
        const p = short(id, sim.spotUsdc, amt, 'Spot USDC');
        if (p) pr.push(p);
        sim.spotUsdc -= amt;
      } else if (spec.buyIfMissing) {
        // The simulation does not track other coins in Spot: assume the whole amount is bought
        // (at least the market's minimum order, ~6 USDC). The exact buy is priced separately.
        lines.push(`  if Spot holds less than that: buy the missing ${spec.coin} on its USDC spot market first`);
        // What the buy costs at the market's ask (as buyOnSpot sizes it: at least the market's minimum order).
        let spend = Math.max(amt * coinPx * 1.1, 6);
        try {
          const m = await spotMarketFor(c);
          const q = dMax(marketQty(m, 10), toStep(dDiv(amount ?? '0', String(1 - approx(m.sym.takerFee) - 0.0005), 'ceil'), rule(m.sym.stepSize), 'ceil'));
          spend = Math.max(spend, approx(q) * approx(m.ask) * 1.06);
        } catch {
          /* no market: the step says so */
        }
        const p = short(id, sim.spotUsdc, spend, 'Spot USDC (to buy it)');
        if (p) pr.push(p);
        sim.spotUsdc -= spend;
      } else if (spec.fromHand) {
        lines.push(`  ${amt || 'what arrived'} ${spec.coin} comes from your hand-sent deposit first (SoDEX has no ${spec.coin}/USDC spot market)`);
      } else {
        lines.push(`  needs ${amt || 'some'} ${spec.coin} in Spot already (buyIfMissing is off)`);
      }
    }
    return { lines, cost, away, pr };
  };

  if (has('withdraw-external')) {
    const w = await withdrawal('withdraw-external', cfg.withdrawExternal, 'withdrawExternal');
    add('withdraw-external', { lines: w.lines, costUsd: w.cost, sentAwayUsd: w.away, problems: w.pr });
  }

  if (has('extra-deposits')) {
    if (!cfg.extraDeposits.length) add('extra-deposits', { lines: [], costUsd: 0, sentAwayUsd: 0, problems: [], skip: 'extraDeposits is empty' });
    else {
      const lines: string[] = [];
      const pr: string[] = [];
      let cost = 0;
      for (const d of cfg.extraDeposits) {
        const r = depositRoutes.find((x) => x.chain.key === d.chain);
        if (!r) {
          pr.push(`extraDeposits ${d.chain}: no OPEN canonical USDC deposit route (the runner deposits USDC only - the app's sendUsdcDeposit)`);
          continue;
        }
        if (approx(d.amount) < approx(r.minDeposit)) pr.push(`extraDeposits ${d.chain}: ${d.amount} is below the minimum ${r.minDeposit}`);
        cost += await gasUsd(d.chain, ethGasUnits.erc20);
        const w = wallet[d.chain];
        needs.push({ chain: d.chain, coin: 'USDC', amount: approx(d.amount), have: w?.usdc === null || !w ? null : approx(w.usdc), why: 'extra deposit' });
        needs.push({ chain: d.chain, coin: r.chain.native.symbol, amount: await gasNeed(d.chain), have: w ? approx(w.native) : null, why: 'gas (with headroom)' });
        lines.push(`${d.amount} USDC from ${r.chain.name} to the wallet's ${d.chain} deposit address; verify Spot +${d.amount}`);
        sim.spotUsdc += approx(d.amount);
      }
      add('extra-deposits', { lines, costUsd: cost, sentAwayUsd: 0, problems: pr });
    }
  }

  if (has('extra-withdrawals')) {
    if (!cfg.extraWithdrawals.length) add('extra-withdrawals', { lines: [], costUsd: 0, sentAwayUsd: 0, problems: [], skip: 'extraWithdrawals is empty' });
    else {
      const lines: string[] = [];
      const pr: string[] = [];
      let cost = 0;
      let away = 0;
      for (const [i, x] of cfg.extraWithdrawals.entries()) {
        const w = await withdrawal('extra-withdrawals', x, `extraWithdrawals[${i}]`);
        lines.push(...w.lines);
        pr.push(...w.pr);
        cost += w.cost;
        away += w.away;
        const c = coin(x.coin);
        if (x.buyIfMissing && c && c.coin.toUpperCase() !== 'USDC') {
          try {
            const m = await spotMarketFor(c);
            const r = route(c, x.chain);
            const amount = x.amount === 'min' ? r?.withdraw.min ?? '0' : x.amount === 'all' ? '0' : x.amount;
            const q = dMax(marketQty(m, 10), toStep(dDiv(amount, String(1 - approx(m.sym.takerFee)), 'ceil'), rule(m.sym.stepSize), 'ceil'));
            const mc = marketCost(m, q);
            lines.push(`  buy on ${m.sym.name}: up to ${q} ${c.coin} (~${(approx(q) * approx(m.ask)).toFixed(2)} USDC; cost ~${usd(mc)}; leftover stays in Spot)`);
            cost += mc;
          } catch (e) {
            pr.push(`extraWithdrawals[${i}]: ${errText(e)}`);
          }
        }
      }
      add('extra-withdrawals', { lines, costUsd: cost, sentAwayUsd: away, problems: pr });
    }
  }

  /** SoDEX's on-chain withdrawal fee for a route (the asset config's when the chain cannot be read). */
  const feeOf = async (c: CoinConfig, r: ChainRoute): Promise<string> =>
    withdrawQuote(c, r, owner)
      .then((q) => formatUnits(q.fee, c.valuechain.decimals))
      .catch(() => r.withdraw.fee ?? '0');

  if (has('evm-tour')) {
    const tp = tourPlan(coins, cfg, o.selected);
    const lines: string[] = [];
    const pr: string[] = [];
    let cost = 0;
    const capital = new Map<string, number>();
    let usdcCapital = 0;
    // The wallet's deposit addresses per coin (the on-chain registry): a leg with no way back runs one-way.
    const listedOf = new Map<string, Promise<Map<string, string> | null>>();
    const listed = (c: string): Promise<Map<string, string> | null> => {
      if (!listedOf.has(c)) listedOf.set(c, registryDepositAddresses(owner, c).catch(() => null));
      return listedOf.get(c)!;
    };
    for (const tc of tp.chains) {
      const usdcRuns = tc.legs.some((l) => l.kind === 'usdc' && !l.skip);
      for (const leg of tc.legs) {
        if (leg.skip) {
          lines.push(`${tc.label}, ${leg.coin.coin}: skipped - ${leg.skip}`);
          continue;
        }
        const fee = await feeOf(leg.coin, leg.route);
        const p = px(leg.coin.coin) ?? 0;
        const noBack = depositBackProblem(leg, await listed(leg.coin.coin));
        if (noBack) {
          const one = oneWayAmount(leg.route, leg.coin, fee);
          const arrives = cut(dSub(one, fee), 6);
          cost += approx(fee) * p;
          if (leg.coin.coin.toUpperCase() === 'USDC') usdcCapital = Math.max(usdcCapital, approx(one));
          else capital.set(leg.coin.coin, Math.max(capital.get(leg.coin.coin) ?? 0, approx(one) * p * 1.05));
          leftOnChains.push(`${tc.label}: ~${arrives} ${leg.coin.coin} stays in the test wallet there - ${noBack}, so it cannot be deposited back`);
          lines.push(`${tc.label}: ${one} ${leg.coin.coin} out to this wallet (fee ${fee}); the deposit back is NOT RUN: ${noBack}. The ~${arrives} ${leg.coin.coin} that arrives stays in the test wallet there.`);
          continue;
        }
        if (leg.kind === 'native') {
          const reserve = await gasReserve(tc.spec, reserveGasUnits(usdcRuns));
          const a = nativeLegAmounts(leg.route, leg.coin, fee, reserve);
          cost += approx(fee) * p + (await gasUsd(tc.chain, 21_000));
          let buy = '';
          if (leg.coin.coin.toUpperCase() === 'USDC') usdcCapital = Math.max(usdcCapital, approx(a.withdraw));
          else {
            try {
              const m = await spotMarketFor(leg.coin);
              const q = dMax(marketQty(m, 10), toStep(a.withdraw, rule(m.sym.stepSize), 'ceil'));
              capital.set(leg.coin.coin, Math.max(capital.get(leg.coin.coin) ?? 0, approx(q) * approx(m.ask) * 1.05));
              cost += marketCost(m, q) * (cfg.evmTour.sellBack ? 2 : 1);
              buy = `; bought on ${m.sym.name} if Spot holds less (~${usd(approx(q) * approx(m.ask))})`;
            } catch (e) {
              buy = `; NOTHING to buy it with (${errText(e)}) - the leg runs only if Spot already holds ${a.withdraw}`;
            }
          }
          lines.push(`${tc.label}: ${a.withdraw} ${leg.coin.coin} out to this wallet (fee ${fee}), ${a.back} back to the verified deposit address by a plain transfer the runner signs (DIRECT; ~${reserve} ${tc.spec.native.symbol} stays for gas)${buy}`);
        } else {
          const a = usdcLegAmounts(leg.route, fee);
          if (tc.ownerGas) {
            // SoDEX lists no route for this chain's gas coin (Polygon: POL): the run cannot get any. The deposit back
            // runs only when the wallet already holds enough - it is never part of the funding.
            const w = wallet[tc.chain];
            const need = await gasNeed(tc.chain);
            const held = w ? approx(w.native) : 0;
            const sym = tc.spec.native.symbol;
            if (held + 1e-12 < need) {
              const one = oneWayUsdcAmount(leg.route, fee);
              cost += approx(fee);
              usdcCapital = Math.max(usdcCapital, approx(one));
              const left = approx(one) - approx(fee);
              leftOnChains.push(`${tc.label}: ~${left.toFixed(2)} USDC stays in the test wallet there - no ${sym} for gas to send it back (SoDEX lists no ${sym} route); send ~${fmtAmt(need)} ${sym} there before the run to include the deposit back`);
              lines.push(`${tc.label}: ${one} USDC out to this wallet (fee ${fee}); the deposit back is NOT RUN: no ${sym} for gas on ${tc.label} (SoDEX lists no ${sym} route, the wallet holds ${fmtAmt(held)} ${sym}; it would need ~${fmtAmt(need)}). The ~${left.toFixed(2)} USDC that arrives stays in the test wallet there.`);
              continue;
            }
            needs.push({ chain: tc.chain, coin: sym, amount: need, have: held, why: `gas for sending USDC back (SoDEX lists no ${sym} route to bring it from Spot; the wallet already holds it)` });
          }
          cost += approx(fee) + (await gasUsd(tc.chain, ethGasUnits.erc20));
          usdcCapital = Math.max(usdcCapital, approx(a.withdraw));
          lines.push(`${tc.label}: ${a.withdraw} USDC out to this wallet (fee ${fee}), ${a.back} back with the app's sendUsdcDeposit`);
        }
      }
    }
    for (const l of tp.left) lines.push(`${l.label}: not toured - ${l.why}`);
    if (cfg.evmTour.sellBack) lines.push('each coin bought for the tour is sold back to USDC after the last chain that needs it (what is below the market minimum stays in Spot)');
    // Conservative: every coin bought may sit in Spot until the end (below a market's minimum it is not sold back),
    // and every fee and spread is paid along the way - so the tour needs all of it at once, plus the largest USDC leg.
    const need = [...capital.values()].reduce((a, b) => a + b, 0) + usdcCapital + cost * 1.2 + 1;
    const p = short('evm-tour', sim.spotUsdc, need, "Spot USDC (the tour's working capital: it comes back)");
    if (p) pr.push(p);
    sim.spotUsdc -= cost;
    add('evm-tour', { lines, costUsd: cost * 1.2, sentAwayUsd: 0, problems: pr });
  }

  if (has('chain-withdrawals')) {
    const list = chainWithdrawals(coins, cfg);
    const lines: string[] = [];
    const pr: string[] = [];
    let cost = 0;
    let away = 0;
    for (const w of list) {
      if (w.skip) {
        lines.push(`${w.coin.coin} -> ${w.route.label}: skipped - ${w.skip}`);
        continue;
      }
      const hp = hand?.plans.get(handKey(w.coin.coin, w.route.key)) ?? null;
      const active = handActiveFor(w.coin.coin, w.route.key);
      const market = w.coin.coin.toUpperCase() === 'USDC' || (hand?.market.get(w.coin.coin) ?? !!(await spotMarketFor(w.coin).catch(() => null)));
      // With the owner's hand-sent deposit back: enough that what arrives covers it, their wallet's fee and what stays.
      const amount = active && hp && hp.order === 'withdraw-first' ? hp.withdraw : roundTripAmount(w.route, w.coin, await feeOf(w.coin, w.route));
      const label = `chain-withdrawals ${w.coin.coin} -> ${w.route.label}`;
      if (!market) {
        if (!active || !hp) {
          lines.push(`${w.coin.coin} -> ${w.route.label}: not testable from USDC alone - SoDEX has no ${w.coin.coin}/USDC spot market to buy it on; send ${w.coin.coin} by hand first (manualDeposits), the run then withdraws it back`);
          continue;
        }
        lines.push(`${w.coin.coin} -> ${w.route.label}: DEPOSIT FIRST - SoDEX has no ${w.coin.coin}/USDC spot market, so after your hand-sent ${hp.sendBack} ${w.coin.coin} (manual-deposits) the run withdraws it back to receivers.${w.receiverName}`);
        const r = await withdrawal('chain-withdrawals', { coin: w.coin.coin, chain: w.route.key, amount: hp.withdraw, receiver: w.receiverName, buyIfMissing: false, fromHand: true }, label);
        lines.push(...r.lines.map((l) => `  ${l}`));
        pr.push(...r.pr);
        cost += r.cost;
        away += r.away;
        continue;
      }
      const r = await withdrawal('chain-withdrawals', { coin: w.coin.coin, chain: w.route.key, amount, receiver: w.receiverName, buyIfMissing: cfg.chainWithdrawals.buyIfMissing }, label);
      lines.push(...r.lines);
      pr.push(...r.pr);
      cost += r.cost;
      away += r.away;
      if (active && hp) lines.push(`  sized for your hand-sent deposit back: ${hp.arrives} ${w.coin.coin} arrives, you send back ${hp.sendBack} (deposit minimum ${hp.depositMin}), your wallet's fee ~${hp.walletFee} ${hp.feeCoin}${approx(hp.keep) > 0 ? `, ${hp.keep} ${w.coin.coin} stays at your address` : ''}`);
      if (w.coin.coin.toUpperCase() !== 'USDC' && cfg.chainWithdrawals.buyIfMissing) {
        try {
          const m = await spotMarketFor(w.coin);
          cost += marketCost(m, dMax(marketQty(m, 10), toStep(amount, rule(m.sym.stepSize), 'ceil')));
        } catch {
          lines.push(`  no ${w.coin.coin}/USDC spot market: the withdrawal runs only if Spot already holds ${amount}`);
        }
      }
    }
    if (!list.some((w) => !w.skip)) add('chain-withdrawals', { lines: [], costUsd: 0, sentAwayUsd: 0, problems: [], skip: list.length ? 'no route can run - set your own addresses in receivers (receivers.sol, receivers.btc, ...)' : 'SoDEX lists no route on a chain the runner cannot sign on' });
    else add('chain-withdrawals', { lines, costUsd: cost, sentAwayUsd: away, problems: pr });
  }

  // Every route the owner could send a deposit from by hand, with what it takes (the guided launcher offers these).
  if (hand) {
    for (const h of hand.routes) {
      if (h.why) continue;
      const hp = hand.plans.get(handKey(h.coin.coin, h.route.key));
      if (!hp) continue;
      const d = h.deposit;
      const amount = d && d.amount !== 'auto' ? d.amount : hp.sendBack;
      const withdrawalRuns = !!h.withdrawal && !h.withdrawal.skip && has('chain-withdrawals');
      handRows.push({ ...hp, state: !d ? 'offered' : d.skip ? 'skipped' : 'send', withdrawalRuns, amount, line: handLine(hp, d, withdrawalRuns), sendBackUsd: approx(amount) * (px(h.coin.coin) ?? 0) });
    }
  }

  if (has('manual-deposits')) {
    if (!cfg.manualDeposits.length) {
      add('manual-deposits', { lines: [], costUsd: 0, sentAwayUsd: 0, problems: [], skip: 'manualDeposits is empty - opt in per route ({ "coin", "chain", "amount": "auto" }, or choose the full test in the guided launcher) to have the run wait for a deposit you send by hand' });
    } else {
      const lines: string[] = [];
      const pr: string[] = [];
      let cost = 0;
      for (const d of cfg.manualDeposits) {
        const c = coin(d.coin);
        const r = route(c, d.chain);
        if (!c || !r) {
          pr.push(`manualDeposits ${d.coin} on ${d.chain}: SoDEX lists no such route`);
          continue;
        }
        if (d.skip) {
          lines.push(`${c.coin} on ${r.label}: left out by you - reported "skipped (owner)"`);
          continue;
        }
        if (!r.deposit.allowed) pr.push(`manualDeposits ${d.coin} on ${r.label}: deposits are CLOSED right now`);
        if (r.addressKind === 'other') pr.push(`manualDeposits ${d.coin} on ${r.label}: the app does not offer this chain`);
        const row = handRows.find((x) => x.coin === c.coin && x.chain === r.key);
        const amount = d.amount === 'auto' ? row?.sendBack ?? r.deposit.min ?? null : d.amount;
        if (!amount) {
          pr.push(`manualDeposits ${d.coin} on ${r.label}: SoDEX lists no deposit minimum - give an amount`);
          continue;
        }
        // Never a hand-sent deposit SoDEX would not credit (the owner's network fee comes on top of it).
        if (r.deposit.min && approx(amount) < approx(r.deposit.min)) pr.push(`manualDeposits ${d.coin} on ${r.label}: ${amount} is below SoDEX's deposit minimum ${r.deposit.min} - a deposit below it is not credited`);
        const known = await registryDepositAddresses(owner, c.coin)
          .then((m) => m.get(r.key) ?? null)
          .catch(() => null);
        const waitMin = Math.max(cfg.timeouts.depositMinutes, Math.ceil(((r.deposit.etaSeconds ?? 0) * 2) / 60));
        lines.push(row ? row.line : `you send ${amount} ${c.coin} on ${r.label} by hand (at least SoDEX's deposit minimum ${r.deposit.min ?? '-'}; your wallet's network fee on top)`);
        lines.push(`  to the wallet's ${r.label} deposit address (${known ? `the registry lists ${known}` : 'not issued yet'}; shown again, verified, when the step runs); the run waits up to ${waitMin} min for Spot to rise by ${amount} - optional: type s + Enter to skip it`);
        const coinPx = px(c.coin) ?? 0;
        if (row) cost += approx(row.walletFee) * (px(row.feeCoin) ?? 0);
        // What comes back is sold back to USDC at the end (a taker fee and half the spread, roughly).
        if (c.coin.toUpperCase() !== 'USDC') cost += approx(amount) * coinPx * 0.002;
        returnsUsd += approx(amount) * coinPx;
        if (c.coin.toUpperCase() === 'USDC') sim.spotUsdc += approx(amount);
      }
      if (cfg.manualDeposits.some((d) => !d.skip)) lines.push("at the end, every coin chain-withdrawals and these deposits left in Spot is sold back to USDC (what is below a market's minimum order stays in Spot)");
      add('manual-deposits', { lines, costUsd: cost, sentAwayUsd: 0, problems: pr });
    }
  }

  if (has('key-lifecycle')) {
    const pr: string[] = [];
    const lines = [
      'the session is dropped and restoreTrading() brings the key back from the vault; an order signed with it rests and is cancelled',
      'keyStillRegistered() says yes; both engines list the key',
      'disableTrading({ revoke: true }): the wallet signs one revocation per engine, on ValueChain (it switches there); both engines drop the key',
      'an order signed with the revoked key (prepared before the revocation, sent by the runner) must be rejected',
      'trading is enabled again (one more signature): a new key under the same name; an order signed with it rests and is cancelled',
    ];
    if (spotM) {
      const rb = restingBuy(spotM, cfg.orders.spotLimitOffsetPct);
      const p = short('key-lifecycle', sim.spotUsdc + sim.perpsUsdc, approx(rb.lock) * 1.05, 'Spot USDC (the resting orders lock it)');
      if (p) pr.push(p);
    } else pr.push(`spot market ${cfg.orders.spotSymbol} could not be read`);
    add('key-lifecycle', { lines, costUsd: 0, sentAwayUsd: 0, problems: pr });
  }

  if (has('cleanup')) {
    if (!cfg.cleanup.enabled) add('cleanup', { lines: [], costUsd: 0, sentAwayUsd: 0, problems: [], skip: 'cleanup.enabled is false' });
    else {
      const r = route(usdc, cfg.cleanup.chain);
      const pr: string[] = [];
      let fee = r?.withdraw.fee ?? '1';
      if (!r) pr.push(`cleanup: USDC has no route on ${cfg.cleanup.chain}`);
      else {
        if (!r.withdraw.allowed) pr.push(`cleanup: USDC withdrawals to ${r.label} are CLOSED`);
        if (r.addressKind !== 'evm') pr.push('cleanup: the cleanup chain must be an EVM chain (it withdraws to this wallet)');
        fee = await withdrawQuote(usdc, r, owner)
          .then((q) => formatUnits(q.fee, usdc.valuechain.decimals))
          .catch(() => fee);
      }
      add('cleanup', {
        lines: [
          'Perps -> Spot (all USDC), ValueChain wallet -> Spot (all USDC, gasless; SOSO stays in the wallet)',
          `withdraw all Spot USDC to this wallet on ${r?.label ?? cfg.cleanup.chain} (on-chain fee ${fee} USDC, min ${r?.withdraw.min ?? '?'})`,
        ],
        costUsd: approx(fee),
        sentAwayUsd: 0,
        problems: pr,
      });
    }
  }

  if (has('cross-check')) {
    add('cross-check', {
      lines: [
        `read SoDEX's order history and fills of both engines ONCE: four requests, ${Math.round(35)} s apart (the two routes take about four a minute per IP), only while the server's fee verifier is idle`,
        'every order of the run is in the history as it was sent; every fill belongs to an order of the run and matches the stream; every fee is judged again; every order record names the builder the order carried',
        cfg.builder?.address ? `the builder account #${cfg.builder.id}'s balances rose by the builder fees the run's fills paid` : 'the builder account\'s income is not checked (builder.address is not set)',
        'nothing is left open; this step signs and sends nothing',
      ],
      costUsd: 0,
      sentAwayUsd: 0,
      problems: [],
    });
  }

  if (has('revoke-builder')) {
    if (!cfg.builder) add('revoke-builder', { lines: [], costUsd: 0, sentAwayUsd: 0, problems: [], skip: 'no builder is configured for this run' });
    else if (!cfg.builder.revokeAtEnd) add('revoke-builder', { lines: [], costUsd: 0, sentAwayUsd: 0, problems: [], skip: 'builder.revokeAtEnd is false - the approval stays on the account' });
    else {
      add('revoke-builder', {
        lines: [`one signature (ApproveBuilderFeeAction with maxFeeRate 0) clears the approval of builder #${cfg.builder.id}; verified: gone from both lists of GET /user/{wallet}/builders`],
        costUsd: 0,
        sentAwayUsd: 0,
        problems: [],
      });
    }
  }

  // The receivers the selected steps name, for whoever fills them in (the guided launcher reads this list).
  const receiversNeeded: ReceiverNeed[] = [];
  const needReceiver = (name: string, chain: string, coinName: string | null, why: string): void => {
    if (name === 'self' || receiversNeeded.some((n) => n.name === name)) return;
    const rcv = cfg.receivers[name];
    const r = coinName ? route(coin(coinName), chain) : undefined;
    const target: ChainRoute | 'VALUECHAIN' | undefined = chain === 'VALUECHAIN' ? 'VALUECHAIN' : r;
    let problem: string | null = null;
    if (rcv && target) problem = receiverProblem(target, rcv.address) ?? memoProblem(target, rcv.memo ?? '', rcv.noMemo === true);
    if (rcv && !problem && chain === 'VALUECHAIN' && rcv.address.toLowerCase() === owner) problem = 'it is this wallet itself - it must be a different address you control';
    const memo = !!r && r.memo === 'numeric' && !rcv?.memo && !rcv?.noMemo;
    receiversNeeded.push({ name, chain, why, memo, set: !!rcv, problem });
  };
  if (has('withdraw-valuechain-other')) needReceiver(cfg.withdrawValuechainOther.receiver, 'VALUECHAIN', null, 'another EVM address of yours (e.g. your SafePal EVM address - the same on every EVM chain), not this test wallet: withdraw-valuechain-other sends it 1 USDC on ValueChain');
  if (has('withdraw-external')) needReceiver(cfg.withdrawExternal.receiver, cfg.withdrawExternal.chain, cfg.withdrawExternal.coin, `withdraw-external: ${cfg.withdrawExternal.coin} to ${chainLabel(cfg.withdrawExternal.chain)}`);
  if (has('extra-withdrawals')) for (const x of cfg.extraWithdrawals) needReceiver(x.receiver, x.chain, x.coin, `extra-withdrawals: ${x.coin} to ${chainLabel(x.chain)}`);
  if (has('chain-withdrawals')) {
    for (const w of chainWithdrawals(coins, cfg)) {
      // Routes that cannot run anyway (closed, not offered) ask for nothing; an unset receiver is what the owner can supply.
      if (w.skip && !/^receivers\./.test(w.skip)) continue;
      const onChain = chainWithdrawals(coins, cfg).filter((x) => x.route.key === w.route.key && (!x.skip || /^receivers\./.test(x.skip))).map((x) => x.coin.coin);
      needReceiver(w.receiverName, w.route.key, w.coin.coin, `your own ${w.route.label} address (e.g. in SafePal) - the run withdraws ${[...new Set(onChain)].join(', ')} there; optional, those withdrawals are skipped without it`);
    }
  }

  // A wide profile funds its own working capital: the deposit is raised by the largest Spot shortfall (printed, never silent).
  const profileNotes = [...(o.profileNotes ?? [])];
  const raises = o.profile === 'evm-tour' || o.profile === 'all-chains';
  if (raises && deficit > 0 && has('deposit-external')) {
    const before = cfg.deposit.amount;
    cfg.deposit.amount = String(Math.ceil(approx(before) + deficit + 2));
    for (const pl of plans) pl.problems = pl.problems.filter((x) => !shortfalls.has(x));
    const dp = await planDeposit();
    const i = plans.findIndex((pl) => pl.id === 'deposit-external');
    if (i >= 0) plans[i] = { ...plans[i]!, ...dp.plan };
    for (let k = needs.length - 1; k >= 0; k--) if (needs[k]!.chain === cfg.deposit.chain && (needs[k]!.why === 'deposit' || needs[k]!.why.startsWith('gas for the USDC transfer'))) needs.splice(k, 1);
    needs.unshift(...dp.needs);
    profileNotes.push(`deposit.amount: ${cfg.deposit.amount} USDC instead of ${before} - the ${o.profile} profile's steps need ~${usd(deficit)} more in Spot at their busiest (working capital: it comes back, or leaves to your own addresses)`);
  } else if (raises && deficit > 0 && !newAccount && !has('deposit-external')) {
    // A resumed run (--only without deposit-external) whose steps need more in Spot than the account holds:
    // the run tops Spot up itself, from the wallet's USDC on the deposit chain, BEFORE its first step - instead
    // of refusing. With a cushion (an estimate is an estimate); the cleanup brings what is left back.
    const before = cfg.deposit.amount;
    const r = depositRoutes.find((x) => x.chain.key === cfg.deposit.chain);
    const held = wallet[cfg.deposit.chain]?.usdc;
    const least = Math.ceil(deficit + 2);
    const cushion = Math.ceil(deficit + Math.max(10, (plans.reduce((t, pl) => t + (pl.skip ? 0 : pl.costUsd + pl.sentAwayUsd), 0)) * 0.1));
    // As much of the cushion as the wallet holds there; never less than the shortfall (then the wallet must be funded).
    const fromWallet = held === null || held === undefined ? cushion : Math.min(cushion, Math.floor(approx(held)));
    const topUp = Math.max(least, fromWallet, r ? Math.ceil(approx(r.minDeposit)) : 0);
    cfg.deposit.amount = String(topUp);
    o.selected.add('deposit-external');
    if (!depositAddresses.has(cfg.deposit.chain)) await checkDepositChain(cfg.deposit.chain);
    for (const pl of plans) pl.problems = pl.problems.filter((x) => !shortfalls.has(x));
    const dp = await planDeposit();
    plans.unshift({ id: 'deposit-external', title: STEP_TITLES['deposit-external'], ...dp.plan, lines: [`TOP-UP for this resumed run: the selected steps need ~${usd(deficit)} more in Spot at their busiest than the account holds`, ...dp.plan.lines] });
    needs.unshift(...dp.needs);
    profileNotes.push(`deposit-external added as a top-up of ${topUp} USDC from ${chainLabel(cfg.deposit.chain)} (deposit.amount was ${before}): the resumed steps need ~${usd(deficit)} more in Spot than the account holds (working capital: the cleanup withdraws what is left back to ${chainLabel(cfg.cleanup.chain)})`);
  }
  for (const p of plans) if (!p.skip) problems.push(...p.problems);
  const totalCostUsd = plans.reduce((s, p) => s + (p.skip ? 0 : p.costUsd), 0);
  const totalSentAwayUsd = plans.reduce((s, p) => s + (p.skip ? 0 : p.sentAwayUsd), 0);
  if (totalCostUsd + totalSentAwayUsd > cfg.maxSpendUsd) {
    problems.push(`estimated spend ${usd(totalCostUsd + totalSentAwayUsd)} (costs ${usd(totalCostUsd)} + sent to other addresses ${usd(totalSentAwayUsd)}) is above maxSpendUsd ${usd(cfg.maxSpendUsd)}`);
  }

  // Funding checklist.
  const checklist: string[] = [];
  const byChain = new Map<string, Array<(typeof needs)[number]>>();
  for (const n of needs) byChain.set(n.chain, [...(byChain.get(n.chain) ?? []), n]);
  for (const [chain, list] of byChain) {
    const merged = new Map<string, { amount: number; have: number | null; why: string[] }>();
    for (const n of list) {
      const m = merged.get(n.coin) ?? { amount: 0, have: n.have, why: [] };
      m.amount += n.amount;
      m.why.push(n.why);
      merged.set(n.coin, m);
    }
    for (const [c, m] of merged) {
      const ok = m.have !== null && m.have + 1e-12 >= m.amount;
      checklist.push(`[${ok ? 'x' : ' '}] ${chainLabel(chain).padEnd(16)} ${fmtAmt(m.amount)} ${c.padEnd(5)} (${m.why.join(' + ')}) - wallet holds ${m.have === null ? '?' : fmtAmt(m.have)}`);
      if (!ok) problems.push(`fund the wallet: ${fmtAmt(m.amount)} ${c} on ${chainLabel(chain)} (it holds ${m.have === null ? '?' : fmtAmt(m.have)})`);
    }
  }
  if (!byChain.size) checklist.push('[x] nothing to send from other chains for the selected steps');

  const estimates = new Map<StepId, { costUsd: number; sentAwayUsd: number }>(plans.map((p) => [p.id, { costUsd: p.costUsd, sentAwayUsd: p.sentAwayUsd }]));
  const suggestedMaxSpendUsd = Math.max(5, Math.ceil((totalCostUsd + totalSentAwayUsd) * 1.3 + 2));
  // What YOUR wallet needs first, per hand-sent deposit you send (optional: only for those).
  const ownerWallet = handRows
    .filter((h) => h.state === 'send')
    .map((h) =>
      approx(h.needFirst) > 0 || approx(h.needFirstFeeCoin) > 0
        ? `${h.coin} on ${h.label}: ${approx(h.needFirst) > 0 ? `${h.needFirst} ${h.coin}` : ''}${approx(h.needFirst) > 0 && approx(h.needFirstFeeCoin) > 0 ? ' + ' : ''}${approx(h.needFirstFeeCoin) > 0 ? `${h.needFirstFeeCoin} ${h.feeCoin}` : ''} of your own (${h.order === 'deposit-first' ? `you send ${h.sendBack} first + ~${h.walletFee} ${h.feeCoin} network fee; ${h.arrives} comes back` : `~${h.walletFee} ${h.feeCoin} network fee`})`
        : `${h.coin} on ${h.label}: nothing of your own - the run sends ${h.arrives} ${h.coin}, you send back ${h.sendBack} (the minimum SoDEX credits is ${h.depositMin}), ~${h.walletFee} ${h.feeCoin} network fee on top${approx(h.keep) > 0 ? `, ${h.keep} ${h.coin} stays at your address (${h.keepWhy})` : ''}`,
    );
  const budget: Budget = {
    fund: checklist,
    costUsd: totalCostUsd,
    sentAwayUsd: totalSentAwayUsd,
    // What comes back can never be more than what went out (a deposit sent first is your own coin coming in).
    returnsUsd: Math.min(returnsUsd, totalSentAwayUsd),
    leftOnChains,
    ownerWallet,
    minutes: durationMinutes(plans, cfg, coins, o.selected, handRows),
    suggestedMaxSpendUsd,
  };
  return {
    pre: { health, vc, coins, usdc, soso, accountId, newAccount, depositAddresses, estimates },
    plans,
    problems,
    warnings,
    checklist,
    totalCostUsd,
    totalSentAwayUsd,
    routeTable,
    balances,
    markets,
    receiversNeeded,
    terms,
    routeChecks: routeLines,
    notTestable: notTestable(coins, cfg),
    profileNotes,
    suggestedMaxSpendUsd,
    handDeposits: handRows,
    budget,
  };
}

/**
 * A rough duration: per deposit SoDEX's own estimate (5 min where it gives none),
 * per withdrawal 5 min, per hand-sent deposit 5 min (you send it) plus the chain's
 * confirms it), the trading steps 25 min, the builder's verifier and the
 * cross-check their own waits. Worst case: every wait to its time-out.
 */
function durationMinutes(plans: readonly StepPlan[], cfg: RunConfig, coins: readonly CoinConfig[], selected: ReadonlySet<StepId>, hand: readonly HandRow[]): { expected: number; worst: number } {
  const on = (id: StepId) => selected.has(id) && plans.some((p) => p.id === id && !p.skip);
  const eta = (coin: string, chain: string): number => {
    const r = coins.find((c) => c.coin.toUpperCase() === coin.toUpperCase())?.chains.find((x) => x.key === chain);
    return r?.deposit.etaSeconds ? r.deposit.etaSeconds / 60 : 5;
  };
  let expected = 0;
  let worst = 0;
  const deposit = (coin: string, chain: string) => {
    expected += eta(coin, chain);
    worst += cfg.timeouts.depositMinutes;
  };
  const withdraw = () => {
    expected += 5;
    worst += cfg.timeouts.withdrawMinutes;
  };
  if (on('deposit-external')) deposit('USDC', cfg.deposit.chain);
  if (on('builder-tiers')) {
    expected += 8;
    worst += 10 + cfg.timeouts.verifierMinutes;
  }
  for (const id of ['orders-spot', 'orders-perps', 'refusals', 'key-lifecycle', 'transfers', 'spot-to-evm', 'evm-to-spot', 'withdraw-valuechain-self', 'withdraw-valuechain-other'] as const) {
    if (on(id)) {
      expected += id.startsWith('orders') ? 8 : 2;
      worst += id.startsWith('orders') ? 15 : 5;
    }
  }
  if (on('withdraw-external')) withdraw();
  if (on('extra-withdrawals')) for (let i = 0; i < cfg.extraWithdrawals.length; i++) withdraw();
  const tour = plans.find((p) => p.id === 'evm-tour' && !p.skip);
  if (tour && selected.has('evm-tour')) {
    for (const l of tour.lines) {
      if (/ out to this wallet/.test(l)) withdraw();
      if (/ back (to the verified deposit address|with the app's sendUsdcDeposit)/.test(l)) {
        expected += 5;
        worst += cfg.timeouts.depositMinutes;
      }
    }
  }
  const cw = plans.find((p) => p.id === 'chain-withdrawals' && !p.skip);
  if (cw && selected.has('chain-withdrawals')) for (const l of cw.lines) if (/^\S+ \S+ -> .*: min /.test(l)) withdraw();
  for (const h of hand) {
    if (h.state !== 'send' || !on('manual-deposits')) continue;
    expected += 5 + eta(h.coin, h.chain);
    worst += Math.max(cfg.timeouts.depositMinutes, Math.ceil((eta(h.coin, h.chain) * 2)));
  }
  if (on('cleanup')) withdraw();
  if (on('cross-check')) {
    expected += 3;
    worst += 5;
  }
  return { expected: Math.ceil(expected), worst: Math.ceil(Math.max(worst, expected)) };
}

const fmtAmt = (n: number): string => (n >= 1 ? n.toFixed(2) : n.toPrecision(3));

/**
 * Native coin to hold for one USDC transfer on `chainKey`: x5 today's gas price
 * x 65k gas, but at least a comfortable floor per chain - gas prices move, and
 * what is not spent stays in the wallet.
 */
export const ownerGasNeed = (chainKey: string): Promise<number> => gasNeed(chainKey);

async function gasNeed(chainKey: string): Promise<number> {
  const url = evmChain(chainKey)?.rpcUrl;
  const floor = GAS_FLOOR[chainKey] ?? 0.001;
  if (!url) return floor;
  try {
    const gp = await gasPrice(url);
    return Math.max((Number(gp) * ethGasUnits.erc20 * 5) / 1e18, floor);
  } catch {
    return floor;
  }
}

/**
 * The coverage table: per chain, USDC and the chain's native coin (where
 * SoDEX lists them), with deposit minimum and withdrawal minimum + fee from the
 * live asset config. One run per CHAIN covers that chain's custody path.
 */
/** One coin on one chain, as SoDEX lists it now, and what the runner can do there. */
export interface RouteRow {
  chain: string;
  label: string;
  coin: string;
  native: boolean;
  depositOpen: boolean;
  withdrawOpen: boolean;
  depositMin: string | null;
  withdrawMin: string | null;
  withdrawFee: string | null;
  /** The runner can send a deposit of it (USDC on an EVM chain the app sends from; a native coin on an EVM chain the runner signs on). */
  canDeposit: boolean;
  /** The app offers a withdrawal there. */
  canWithdraw: boolean;
  /** The arrival can be read on that chain from this computer. */
  canVerify: boolean;
}

/** Per chain: USDC and the chain's native coin (where SoDEX lists them). */
export function routeRows(coins: CoinConfig[]): RouteRow[] {
  const usdc = coins.find((c) => c.coin.toUpperCase() === 'USDC');
  const chains = new Set<string>();
  for (const c of coins) for (const r of c.chains) chains.add(r.key);
  const sorted = [...chains].sort((a, b) => chainRank(a) - chainRank(b) || a.localeCompare(b));
  const out: RouteRow[] = [];
  for (const key of sorted) {
    const rows: Array<[CoinConfig, ChainRoute]> = [];
    const u = usdc?.chains.find((r) => r.key === key);
    if (usdc && u) rows.push([usdc, u]);
    for (const c of coins) {
      const r = c.chains.find((x) => x.key === key && x.isNativeToken);
      if (r && c !== usdc) rows.push([c, r]);
    }
    for (const [c, r] of rows) {
      out.push({
        chain: key,
        label: chainLabel(key),
        coin: c.coin,
        native: r.isNativeToken,
        depositOpen: r.deposit.allowed,
        withdrawOpen: r.withdraw.allowed,
        depositMin: r.deposit.min,
        withdrawMin: r.withdraw.min,
        withdrawFee: r.withdraw.fee,
        canDeposit: r.addressKind === 'evm' && ((c === usdc && !r.isNativeToken && appSendsUsdc(key)) || (r.isNativeToken && !!evmChain(key))),
        canWithdraw: r.addressKind !== 'other',
        canVerify: !!evmChain(key) && r.addressKind === 'evm',
      });
    }
  }
  return out;
}

/**
 * The coverage table: per chain, USDC and the chain's native coin (where
 * SoDEX lists them), with deposit minimum and withdrawal minimum + fee from the
 * live asset config. One run per CHAIN covers that chain's custody path.
 */
function coverageTable(coins: CoinConfig[]): string[] {
  const out: string[] = [`${'chain'.padEnd(18)} ${'coin'.padEnd(10)} ${'deposit'.padEnd(18)} ${'withdraw'.padEnd(18)} ${'fee'.padEnd(10)} runner`];
  for (const r of routeRows(coins)) {
    const dep = r.depositOpen ? `open, min ${r.depositMin ?? '-'}` : 'CLOSED';
    const wd = r.withdrawOpen ? `open, min ${r.withdrawMin ?? '-'}` : 'CLOSED';
    const runner = [r.canDeposit ? 'deposit' : null, r.canWithdraw ? `withdraw${r.canVerify ? '+verify' : ' (status only)'}` : null].filter(Boolean).join(', ');
    out.push(`${r.label.padEnd(18)} ${`${r.coin}${r.native ? '*' : ''}`.padEnd(10)} ${dep.padEnd(18)} ${wd.padEnd(18)} ${(r.withdrawFee ?? '-').padEnd(10)} ${runner || '-'}`);
  }
  out.push('(* = the chain\'s native coin)');
  return out;
}

/** Print the plan (plan mode, and the top of a live run). */
export function printPlan(rec: Recorder, p: PlanResult, cfg: RunConfig, o: { mode: Mode; owner: string; throwaway: boolean }): void {
  const L = (s = '') => rec.line(s);
  L('');
  L(`PLAN for ${o.owner}${o.throwaway ? ' (throwaway key - plan only)' : ''}`);
  if (p.profileNotes.length) {
    L('Profile changes to the config');
    for (const n of p.profileNotes) L(`  ${n}`);
  }
  L(`SoDEX account     ${p.pre.newAccount ? 'none yet (brand-new wallet)' : `#${p.pre.accountId}`}`);
  L('Balances');
  for (const b of p.balances) L(`  ${b}`);
  L('USDC deposit addresses (backend vs on-chain registry getDepositWalletList)');
  if (!p.pre.depositAddresses.size) L('  (no deposit step selected)');
  for (const [chain, d] of p.pre.depositAddresses) {
    L(`  ${chain.padEnd(14)} backend ${d.backend ?? '-'}${d.backend ? (d.backendVerified ? ' (verified)' : ' (NOT verified)') : ''} | registry ${d.registry ?? '-'} -> ${d.match ? 'MATCH' : 'NOT CONFIRMED'}${d.note ? ` (${d.note})` : ''}`);
  }
  L('Routes per chain (live SoDEX asset config) - one run per chain covers its custody path');
  for (const r of p.routeTable) L(`  ${r}`);
  if (p.routeChecks.length) {
    L('Route checks (read-only: open/closed, minimum, fee, maintenance, deposit address, the app\'s receiver check)');
    for (const r of p.routeChecks) L(`  ${r}`);
  }
  if (p.markets.length) {
    L('Markets');
    for (const m of p.markets) L(`  ${m}`);
  }
  L('Steps');
  for (const s of p.plans) {
    if (s.skip) {
      L(`  ${s.id.padEnd(26)} SKIPPED - ${s.skip}`);
      continue;
    }
    L(`  ${s.id.padEnd(26)} est. cost ${usd(s.costUsd)}${s.sentAwayUsd ? ` + sent to another address ${usd(s.sentAwayUsd)}` : ''}`);
    for (const l of s.lines) L(`      ${l}`);
    for (const pr of s.problems) L(`      PROBLEM: ${pr}`);
  }
  if (p.handDeposits.length) {
    L('Hand-sent deposits (optional - from your own wallet, e.g. SafePal; the run shows each one and waits for it, s + Enter skips it)');
    for (const h of p.handDeposits) L(`  ${h.line}`);
  }
  L(`Estimated total   costs ${usd(p.totalCostUsd)} + sent to your other addresses ${usd(p.totalSentAwayUsd)} = ${usd(p.totalCostUsd + p.totalSentAwayUsd)} (maxSpendUsd ${usd(cfg.maxSpendUsd)})`);
  L(`Suggested maxSpendUsd for this run: ${p.suggestedMaxSpendUsd}${cfg.maxSpendUsd < p.suggestedMaxSpendUsd ? ` (the config says ${cfg.maxSpendUsd})` : ''}`);
  L(`Funding checklist (send to ${shortAddr(o.owner)} before a live run)`);
  for (const c of p.checklist) L(`  ${c}`);
  const b = p.budget;
  L('Budget');
  L(`  fund the test wallet .... ${b.fund.length ? b.fund.map((f) => f.replace(/^\[[ x]\]\s+/, '').replace(/\s+\(.*$/, '').replace(/\s+/g, ' ')).join(' + ') : 'nothing'}`);
  L(`  costs (fees, gas, spreads, activation) ~${usd(b.costUsd)}`);
  L(`  sent to your own addresses ~${usd(b.sentAwayUsd)}${b.returnsUsd ? `, of which ~${usd(b.returnsUsd)} comes back if you send every hand-sent deposit` : ''}`);
  for (const l of b.leftOnChains) L(`  left on a chain .......... ${l}`);
  if (b.ownerWallet.length) {
    L('  your own wallet (optional, only for the hand-sent deposits you send):');
    for (const l of b.ownerWallet) L(`    - ${l}`);
  }
  L(`  maxSpendUsd .............. ${b.suggestedMaxSpendUsd} suggested (costs + sent to your addresses, +30 %)`);
  L(`  time ..................... ~${Math.round(b.minutes.expected)} min expected; at most ~${Math.round(b.minutes.worst)} min before a time-out would stop it`);
  if (p.notTestable.length) {
    L('Not testable automatically');
    for (const n of p.notTestable) L(`  - ${n.what}: ${n.why}`);
  }
  if (p.warnings.length) {
    L('Warnings');
    for (const w of p.warnings) L(`  - ${w}`);
  }
  if (p.problems.length) {
    L(o.mode === 'live' ? 'PROBLEMS - live mode refuses to start:' : 'Problems a live run would refuse to start with:');
    for (const pr of [...new Set(p.problems)]) L(`  - ${pr}`);
  } else {
    L('No blocking problems.');
  }
  L('');
}
