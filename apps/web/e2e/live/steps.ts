/**
 * The live steps. Each one:
 *   1. checks its preconditions against LIVE state (never an assumption from an
 *      earlier step - so `--only` can resume after an interruption);
 *   2. acts through the SAME app function the UI calls (sendUsdcDeposit,
 *      enableTrading, transferFunds, placeOrder/cancelOrder, withdrawFunds...),
 *      inside `armed()`: the network guard expects exactly the writes this
 *      action makes and the wallet signs exactly what it should - nothing else
 *      can go out;
 *   3. verifies the outcome by polling real balances / SoDEX state, with a
 *      timeout, and records amounts, fees, tx hashes and timings.
 * Any failure or timeout stops the run; the runner then prints where every
 * coin is.
 */
import { CALL_FOR_PERMIT_CONTRACT, CLOB_GATEWAY, CROSS_ENGINE_ACCOUNT_ID, TransferType, WITHDRAW_TOKEN_TARGET, canonicalDecimal, unwrapList } from '@sodex-core';
import { decodeFunctionData, parseAbi } from 'viem';
import { cancelOrder, placeOrder } from '../../src/trading/actions';
import { tradingConfig } from '../../src/trading/config';
import {
  balancesOf,
  memoProblem,
  receiverProblem,
  toChecksumAddress,
  transferFunds,
  unitsDown,
  withdrawFunds,
  withdrawQuote,
  withdrawalProgress,
  type ChainRoute,
  type CoinConfig,
} from '../../src/trading/funds';
import { CANONICAL_USDC, EVM_CHAINS, erc20TransferData, formatUnits, parseUnits, sendUsdcDeposit, usdcRoutes } from '../../src/trading/onboard';
import { coinPrices, priceOf } from '../../src/trading/prices';
import { VALUECHAIN_RPC } from '../../src/trading/rpc';
import { enableTrading, getTradingState, keyStillRegistered, sodexAccountId, tradingKeyName } from '../../src/trading/session';
import type { StoredKey } from '../../src/trading/vault';
import { SafetyStop, allowedReceivers, armed, coinNamed, receiverNamed, routeOf, type Ctx, type StepId } from './context';
import type { Expectation } from './guard';
import { ACTIVATION_FEE_USDC, checkDepositAddress, depositAddressProblem, marketQty, readMarket, restingBuy, spotMarketFor, type Market } from './plan';
import { VALUECHAIN_CHAIN_ID } from './provider';
import { engineState, nativeBalance, openOrders, orderHistory, positions, receipt, rpcRead, tokenBalance, type OpenOrder } from './reads';
import { approx, cut, dCmp, dDiv, dMax, dMul, dSub, dur, isDecimal, pollUntil, toStep, usd } from './util';

export class WaitTimeout extends Error {
  override name = 'WaitTimeout';
}

const ERC20 = parseAbi(['function approve(address spender, uint256 amount)', 'function transfer(address to, uint256 amount)']);
const EXCHANGE = parseAbi(['function depositERC20(address token, uint256 amount)']);

// --- shared helpers --------------------------------------------------------------------------------

const settleMs = (ctx: Ctx) => ctx.cfg.timeouts.settleSeconds * 1000;
const orderMs = (ctx: Ctx) => ctx.cfg.timeouts.orderSeconds * 1000;

/** Poll until `done`, printing progress every 30 s; a timeout stops the run (WaitTimeout). */
async function waitFor<T>(
  ctx: Ctx,
  what: string,
  o: { timeoutMs: number; intervalMs?: number; probe: () => Promise<T>; done: (v: T) => boolean; show: (v: T | undefined) => string },
): Promise<T> {
  const r = await pollUntil({
    timeoutMs: o.timeoutMs,
    intervalMs: o.intervalMs,
    probe: o.probe,
    done: o.done,
    progressEveryMs: 30_000,
    progress: (v, ms) => ctx.rec.line(`... ${dur(ms)} waiting for ${what}: ${o.show(v)}`, 7),
  });
  if (r.ok) return r.value;
  throw new WaitTimeout(`timed out after ${dur(r.ms)} waiting for ${what} - last seen: ${o.show(r.last)}${r.lastError ? ` (last read failed: ${r.lastError})` : ''}`);
}

const unitsOf = (v: string, dp: number): bigint => unitsDown(v, dp);

/** The trading engines' account id, from the trading key (after ensureTrading). */
const tradingAccount = (): number | null => getTradingState().accountId;

/** Expect one engine transfer between the owner's OWN accounts (toAccountID 999), exactly this coin and amount. */
function engineTransfer(engine: 'spot' | 'perps', type: number, coin: CoinConfig, amount: string, label: string): Expectation {
  const want = canonicalDecimal(amount);
  return {
    kind: 'engine-transfer',
    label,
    check: (r) => {
      const b = r.body ?? {};
      const acct = tradingAccount();
      if (r.engine !== engine) return `sent to ${r.engine}, expected ${engine}`;
      if (b.type !== type) return `transfer type ${b.type}, expected ${type}`;
      if (b.coinID !== coin.assetId) return `coin ${b.coinID}, expected ${coin.assetId} (${coin.coin})`;
      if (b.toAccountID !== CROSS_ENGINE_ACCOUNT_ID) return `to account ${b.toAccountID}, expected ${CROSS_ENGINE_ACCOUNT_ID} (the owner's own accounts)`;
      if (acct && b.fromAccountID !== acct) return `from account ${b.fromAccountID}, expected ${acct}`;
      if (b.amount !== want) return `amount ${b.amount}, expected ${want}`;
      return null;
    },
  };
}

interface OrderSpec {
  engine: 'spot' | 'perps';
  symbolID: number;
  side: 1 | 2;
  type: 1 | 2;
  qty: string;
  price?: string;
  reduceOnly?: boolean;
  label: string;
}

/** Expect exactly one order: symbol, side, type, quantity, price (limit) and reduce-only as planned. */
function orderExpect(o: OrderSpec): Expectation {
  return {
    kind: 'order',
    label: o.label,
    check: (r) => {
      const b = r.body ?? {};
      if (r.engine !== o.engine) return `sent to ${r.engine}, expected ${o.engine}`;
      const list: any[] = Array.isArray(b.orders) ? b.orders : [];
      if (list.length !== 1) return `${list.length} orders in the request, expected 1`;
      const x = list[0];
      const symbolID = o.engine === 'spot' ? x.symbolID : b.symbolID;
      if (symbolID !== o.symbolID) return `symbol ${symbolID}, expected ${o.symbolID}`;
      if (x.side !== o.side) return `side ${x.side}, expected ${o.side}`;
      if (x.type !== o.type) return `type ${x.type}, expected ${o.type}`;
      if (x.quantity !== canonicalDecimal(o.qty)) return `quantity ${x.quantity}, expected ${canonicalDecimal(o.qty)}`;
      if (x.funds !== undefined) return 'a funds-sized order was not expected';
      const price = o.price === undefined ? undefined : canonicalDecimal(o.price);
      if (x.price !== price) return `price ${x.price}, expected ${price ?? 'none (market)'}`;
      if (o.engine === 'perps') {
        if ((x.reduceOnly ?? false) !== (o.reduceOnly ?? false)) return `reduceOnly ${x.reduceOnly}, expected ${o.reduceOnly ?? false}`;
        if (x.stopPrice !== undefined) return 'a trigger order was not expected';
      }
      return null;
    },
  };
}

interface Placed {
  orderID: number | null;
  clOrdID: string | null;
}
function placedOrder(result: unknown): Placed {
  const list = Array.isArray(result) ? result : unwrapList<{ orderID?: number; clOrdID?: string }>(result, 'orders');
  const r = list[0] as { orderID?: number; clOrdID?: string } | undefined;
  return { orderID: typeof r?.orderID === 'number' ? r.orderID : null, clOrdID: typeof r?.clOrdID === 'string' ? r.clOrdID : null };
}
const isOurs = (o: OpenOrder, id: Placed): boolean => (id.orderID !== null && o.orderID === id.orderID) || (id.clOrdID !== null && o.clOrdID === id.clOrdID);

function cancelExpect(engine: 'spot' | 'perps', id: Placed, label: string): Expectation {
  return {
    kind: 'cancel',
    label,
    check: (r) => {
      const list: any[] = Array.isArray(r.body?.cancels) ? r.body.cancels : [];
      if (r.engine !== engine) return `sent to ${r.engine}, expected ${engine}`;
      if (list.length !== 1) return `${list.length} cancels in the request, expected 1`;
      const c = list[0];
      if (id.orderID !== null) return c.orderID === id.orderID ? null : `order ${c.orderID}, expected ${id.orderID}`;
      return c.clOrdID === id.clOrdID || c.origClOrdID === id.clOrdID ? null : 'not the order this step placed';
    },
  };
}

/** Explorer link for a tx on a chain key. */
function explorer(ctx: Ctx, chainKey: string, hash: string): string | undefined {
  if (chainKey === 'VALUECHAIN') return ctx.pre.vc.explorerUrl ? `${ctx.pre.vc.explorerUrl.replace(/\/+$/, '')}/tx/${hash}` : undefined;
  const c = EVM_CHAINS[chainKey];
  return c ? `${c.explorer}/tx/${hash}` : undefined;
}

async function usdPrice(coin: string): Promise<number> {
  if (/^v?USDC$/i.test(coin)) return 1;
  return priceOf(await coinPrices().catch(() => new Map()), coin) ?? 0;
}

// --- trading key ----------------------------------------------------------------------------------

/** Register the trading key with ONE wallet signature, through the app's own enableTrading. */
async function registerKey(ctx: Ctx): Promise<number> {
  const accountId = await sodexAccountId(ctx.owner);
  if (!accountId) throw new SafetyStop('this wallet has no SoDEX account yet - run deposit-external first');
  const name = tradingKeyName();
  await armed(
    ctx,
    {
      expect: [
        {
          kind: 'key-registration',
          label: `addAPIKey "${name}" (spot + perps)`,
          times: 2,
          check: (r) => {
            const b = r.body ?? {};
            const p = b.params ?? {};
            if (b.type !== 'addAPIKey') return `action ${b.type}, expected addAPIKey`;
            if (p.accountID !== accountId) return `account ${p.accountID}, expected ${accountId}`;
            if (p.name !== name) return `key name ${p.name}, expected ${name}`;
            if (typeof p.publicKey !== 'string' || p.publicKey.toLowerCase() === ctx.owner) return 'the trading key must be a separate key';
            return null;
          },
        },
      ],
      policy: {
        typedData: (td) => {
          const m = td.message;
          if (td.primaryType !== 'UserSignedAddAPIKeyAction') return `unexpected typed data ${td.primaryType}`;
          if (String(m.accountID) !== String(accountId)) return `account ${String(m.accountID)}, expected ${accountId}`;
          if (m.name !== name) return `key name ${String(m.name)}, expected ${name}`;
          if (String(m.chainID) !== String(tradingConfig().chainId)) return `SoDEX chain ${String(m.chainID)}`;
          return null;
        },
      },
    },
    () => enableTrading({ owner: ctx.owner, provider: ctx.provider, remember: true }),
  );
  const st = getTradingState();
  if (st.status !== 'enabled' || !st.accountId) throw new Error(`trading did not switch on (status ${st.status})`);
  ctx.rec.note(`trading key "${st.keyName}" ${st.keyAddress} on ${(st.engines ?? []).join(' + ')}, account #${st.accountId}, expires ${new Date(st.expiresAt ?? 0).toISOString()}`);
  return st.accountId;
}

/** Steps that sign with the trading key call this first: enables trading if it is not on (a signature, no funds). */
export async function ensureTrading(ctx: Ctx): Promise<number> {
  const st = getTradingState();
  if (st.status === 'enabled' && st.owner === ctx.owner && st.accountId && (st.expiresAt ?? 0) > Date.now() + 120_000) return st.accountId;
  return ctx.rec.sub('enable trading first (one wallet signature, no funds move)', () => registerKey(ctx));
}

// --- deposit from an EVM chain --------------------------------------------------------------------

async function depositOne(ctx: Ctx, chainKey: string, amountIn: string): Promise<void> {
  const { rec, owner } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const route = (await usdcRoutes()).find((r) => r.chain.key === chainKey);
  if (!route) throw new SafetyStop(`SoDEX has no OPEN canonical USDC deposit route on ${chainKey} right now`);
  const amount = canonicalDecimal(amountIn);
  const units = parseUnits(amount, route.decimals);
  if (units < parseUnits(route.minDeposit, route.decimals)) throw new SafetyStop(`${amount} USDC is below SoDEX's minimum ${route.minDeposit} on ${route.chain.name}`);

  // The deposit address: the backend's AND the on-chain registry's, re-read right before sending.
  const d = await rec.sub(
    `re-check the ${chainKey} deposit address (backend vs on-chain registry)`,
    () => checkDepositAddress(owner, chainKey, { registryOnly: false, waitMs: 180_000, say: (s) => rec.line(s, 7) }),
    (x) => `${x.backend ?? '-'} vs ${x.registry ?? '-'}`,
  );
  const bad = depositAddressProblem(owner, chainKey, d);
  if (bad) throw new SafetyStop(`deposit address: ${bad}`);
  const addr = d.backend!;

  const have = await tokenBalance(route.chain.rpcUrl, route.token, owner);
  if (have < units) throw new SafetyStop(`the wallet holds ${formatUnits(have, route.decimals)} USDC on ${route.chain.name}, not ${amount}`);
  const gas = await nativeBalance(route.chain.rpcUrl, owner);
  if (gas === 0n) throw new SafetyStop(`the wallet has no ${route.chain.native.symbol} on ${route.chain.name} for gas`);

  const acct0 = await sodexAccountId(owner);
  const spot0 = acct0 ? unitsOf((await balancesOf(owner, usdc)).spot, dp) : 0n;
  const expected = acct0 ? amount : dSub(amount, ACTIVATION_FEE_USDC);
  if (dCmp(expected, '0') <= 0) throw new SafetyStop(`a first deposit must be more than the ${ACTIVATION_FEE_USDC} USDC activation fee`);
  const expectUnits = unitsOf(expected, dp);

  const want = erc20TransferData(addr, units).toLowerCase();
  const token = route.token.toLowerCase();
  const sent = await rec.sub(`send ${amount} USDC on ${route.chain.name} to ${addr} (the app's sendUsdcDeposit)`, () =>
    armed(
      ctx,
      {
        policy: {
          tx: (t) =>
            t.chainId !== route.chain.chainId
              ? `chain ${t.chainId}, expected ${route.chain.chainId}`
              : t.to !== token
                ? `to ${t.to}, not the canonical USDC contract ${token}`
                : t.value !== 0n
                  ? 'carries native value'
                  : t.data !== want
                    ? 'not transfer(verified deposit address, exact amount)'
                    : null,
        },
      },
      () => sendUsdcDeposit({ provider: ctx.provider, owner, route, depositAddress: addr, amount }),
    ),
  );
  const flight = { what: `${amount} USDC sent on ${route.chain.name} to the wallet's SoDEX deposit address ${addr} - not credited yet`, since: Date.now(), ref: sent.explorerUrl };
  ctx.inFlight.push(flight);
  const rc = await rec.sub(
    `wait for the receipt on ${route.chain.name}`,
    () =>
      waitFor(ctx, `the receipt on ${route.chain.name}`, {
        timeoutMs: 10 * 60_000,
        intervalMs: 3000,
        // No receipt yet reads as a failed probe: polling goes on.
        probe: async () => {
          const r = await receipt(route.chain.rpcUrl, sent.hash);
          if (!r) throw new Error('not mined yet');
          return r;
        },
        done: () => true,
        show: () => 'not mined yet',
      }),
    (r) => `${r.status}, block ${r.blockNumber}`,
  );
  const gasWei = rc.gasUsed * rc.effectiveGasPrice;
  const gasUsd = approx(formatUnits(gasWei, 18)) * (await usdPrice(route.chain.native.symbol));
  const txr = ctx.rec.current?.txs.find((t) => t.hash.toLowerCase() === sent.hash.toLowerCase());
  if (txr) Object.assign(txr, { status: rc.status, gas: `${cut(formatUnits(gasWei, 18), 10)} ${route.chain.native.symbol}`, gasUsd });
  if (rc.status !== 'success') {
    ctx.inFlight.splice(ctx.inFlight.indexOf(flight), 1);
    throw new Error(`the USDC transfer REVERTED on ${route.chain.name} (${sent.explorerUrl}) - the USDC did not leave the wallet`);
  }
  rec.fee(`gas on ${route.chain.name}`, `${cut(formatUnits(gasWei, 18), 10)} ${route.chain.native.symbol} (${usd(gasUsd)})`);

  const eta = route.etaSeconds ? `SoDEX estimate ~${Math.max(1, Math.round(route.etaSeconds / 60))} min` : 'no SoDEX estimate';
  const credited = await rec.sub(`wait for SoDEX to ${acct0 ? 'credit' : 'open the account and credit'} Spot +${expected} USDC (${eta})`, () =>
    waitFor(ctx, `SoDEX to credit the deposit (${eta})`, {
      timeoutMs: ctx.cfg.timeouts.depositMinutes * 60_000,
      intervalMs: 15_000,
      probe: async () => {
        const id = await sodexAccountId(owner);
        const s = id ? unitsOf((await balancesOf(owner, usdc)).spot, dp) : 0n;
        return { id, s };
      },
      done: (v) => v.id > 0 && v.s >= spot0 + expectUnits,
      show: (v) => (v ? `account ${v.id || 'none yet'}, Spot USDC ${formatUnits(v.s, dp)} (want >= ${formatUnits(spot0 + expectUnits, dp)})` : 'no answer yet'),
    }),
  );
  ctx.inFlight.splice(ctx.inFlight.indexOf(flight), 1);
  const got = credited.s - spot0;
  rec.amount(`deposit ${route.chain.name}`, `sent ${amount} USDC, credited ${formatUnits(got, dp)} USDC to Spot${acct0 ? '' : ` (account #${credited.id} opened)`}`);
  if (!acct0) rec.fee('activation (first deposit)', `${formatUnits(unitsOf(amount, dp) - got, dp)} USDC`);
}

// --- the steps ---------------------------------------------------------------------------------------

async function stepDepositExternal(ctx: Ctx): Promise<void> {
  await depositOne(ctx, ctx.cfg.deposit.chain, ctx.cfg.deposit.amount);
}

async function stepEnableTrading(ctx: Ctx): Promise<void> {
  await ctx.rec.sub('register the trading key (one wallet signature)', () => registerKey(ctx));
  const st = getTradingState();
  if ((st.engines ?? []).length < 2) ctx.rec.warn('engines', `SoDEX accepted the key on ${(st.engines ?? []).join(', ')} only`);
  const meta: StoredKey = {
    v: 1,
    network: st.network,
    owner: ctx.owner,
    accountId: st.accountId!,
    name: st.keyName!,
    keyAddress: st.keyAddress!,
    expiresAt: st.expiresAt!,
    createdAt: Date.now(),
    builder: null,
    ...(st.engines && st.engines.length < 2 ? { engines: st.engines } : {}),
  };
  await ctx.rec.sub('verify: SoDEX lists the key on each engine', () =>
    waitFor(ctx, "the new key in SoDEX's key list", {
      timeoutMs: Math.max(settleMs(ctx), 180_000),
      intervalMs: 10_000,
      probe: () => keyStillRegistered(meta),
      done: (v) => v === true,
      show: (v) => (v === null ? 'SoDEX could not be asked' : v ? 'listed' : 'not listed yet (indexed reads lag a fresh key)'),
    }),
  );
  ctx.rec.amount('trading key', `${st.keyName} ${st.keyAddress}`);
}

async function stepTransfers(ctx: Ctx): Promise<void> {
  const { owner, rec } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const amount = canonicalDecimal(ctx.cfg.transfers.amount);
  const units = parseUnits(amount, dp);
  await ensureTrading(ctx);
  const b0 = await balancesOf(owner, usdc);
  if (unitsOf(b0.spot, dp) < units) throw new SafetyStop(`Spot holds ${b0.spot} USDC, less than ${amount}`);
  await rec.sub(`Spot -> Perps ${amount} USDC (transferFunds)`, () =>
    armed(ctx, { expect: [engineTransfer('spot', TransferType.PERPS_WITHDRAW, usdc, amount, 'Spot -> Perps')] }, () =>
      transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'spot', to: 'perps', amount }),
    ),
  );
  const b1 = await rec.sub('verify: Perps +amount, Spot -amount', () =>
    waitFor(ctx, 'the transfer in the balances', {
      timeoutMs: settleMs(ctx),
      probe: () => balancesOf(owner, usdc),
      done: (b) => unitsOf(b.perps, dp) >= unitsOf(b0.perps, dp) + units && unitsOf(b.spot, dp) + units <= unitsOf(b0.spot, dp),
      show: (b) => (b ? `Spot ${b.spot}, Perps ${b.perps} (were ${b0.spot} / ${b0.perps})` : '-'),
    }),
  );
  await rec.sub(`Perps -> Spot ${amount} USDC (transferFunds)`, () =>
    armed(ctx, { expect: [engineTransfer('perps', TransferType.SPOT_WITHDRAW, usdc, amount, 'Perps -> Spot')] }, () =>
      transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'perps', to: 'spot', amount }),
    ),
  );
  await rec.sub('verify: Spot +amount, Perps -amount', () =>
    waitFor(ctx, 'the transfer back in the balances', {
      timeoutMs: settleMs(ctx),
      probe: () => balancesOf(owner, usdc),
      done: (b) => unitsOf(b.spot, dp) >= unitsOf(b1.spot, dp) + units && unitsOf(b.perps, dp) + units <= unitsOf(b1.perps, dp),
      show: (b) => (b ? `Spot ${b.spot}, Perps ${b.perps} (were ${b1.spot} / ${b1.perps})` : '-'),
    }),
  );
  rec.amount('Spot <-> Perps', `${amount} USDC each way`);
}

/** Place a limit buy far below the market, see it open, cancel it, see it gone. */
async function restAndCancel(ctx: Ctx, m: Market, offsetPct: number): Promise<void> {
  const { owner, rec } = ctx;
  const rb = restingBuy(m, offsetPct);
  const name = `${m.engine} ${m.sym.name}`;
  if (m.engine === 'spot') {
    const free = unitsOf((await balancesOf(owner, ctx.pre.usdc)).spot, ctx.pre.usdc.valuechain.decimals);
    if (free < unitsOf(dMul(rb.lock, '1.01'), ctx.pre.usdc.valuechain.decimals)) throw new SafetyStop(`Spot USDC does not cover the resting order (~${cut(rb.lock, 4)} USDC)`);
  }
  const res = await rec.sub(`${name}: limit BUY ${rb.qty} @ ${rb.price} (${rb.offsetPct} % below the best bid ${m.bid})`, () =>
    armed(ctx, { expect: [orderExpect({ engine: m.engine, symbolID: m.sym.id, side: 1, type: 1, qty: rb.qty, price: rb.price, reduceOnly: false, label: `${name} resting limit buy` })] }, () =>
      placeOrder(m.engine, { symbol: m.sym.name, side: 'buy', type: 'limit', price: rb.price, quantity: rb.qty, tif: 'gtc' }),
    ),
  );
  const id = placedOrder(res.result);
  if (id.orderID === null && id.clOrdID === null) throw new Error(`${name}: SoDEX accepted the order but returned no order id to follow`);
  rec.amount(`${name} resting order`, `${rb.qty} @ ${rb.price} (#${id.orderID ?? id.clOrdID})`);
  await rec.sub(`${name}: verify the order is open`, () =>
    waitFor(ctx, 'the order in the open orders', { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => openOrders(m.engine, owner, m.sym.name), done: (l) => l.some((o) => isOurs(o, id)), show: (l) => `${l?.length ?? 0} open orders, ours not among them` }),
  );
  await rec.sub(`${name}: cancel it (cancelOrder)`, () =>
    armed(ctx, { expect: [cancelExpect(m.engine, id, `${name} cancel`)] }, () =>
      cancelOrder(m.engine, id.orderID !== null ? { symbol: m.sym.name, orderID: id.orderID } : { symbol: m.sym.name, clOrdID: id.clOrdID! }),
    ),
  );
  await rec.sub(`${name}: verify it is gone`, () =>
    waitFor(ctx, 'the order to leave the open orders', { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => openOrders(m.engine, owner, m.sym.name), done: (l) => !l.some((o) => isOurs(o, id)), show: () => 'still open' }),
  );
  const hist = await orderHistory(m.engine, owner, m.sym.name, 20).catch(() => []);
  const row = hist.find((o) => isOurs(o, id));
  if (row && approx(row.executedQty) > 0) rec.warn(`${name} resting order`, `${row.executedQty} FILLED before the cancel - it stays in the account (a perps fill is closed below)`);
  else rec.note(`${name}: order history says ${row?.status ?? 'n/a'}, nothing filled`);
}

async function stepOrders(ctx: Ctx): Promise<void> {
  const { owner, rec, cfg } = ctx;
  const usdc = ctx.pre.usdc;
  const soso = ctx.pre.soso;
  const udp = usdc.valuechain.decimals;
  await ensureTrading(ctx);

  // Spot: rest + cancel, then a market buy of SOSO (gas for the ValueChain wallet steps).
  const spotM = await readMarket('spot', cfg.orders.spotSymbol);
  await restAndCancel(ctx, spotM, cfg.orders.spotLimitOffsetPct);
  const m2 = await readMarket('spot', cfg.orders.spotSymbol);
  const base = ctx.pre.coins.find((c) => c.assetId === m2.sym.baseCoinID) ?? soso;
  const qty = cfg.orders.sosoBuyQuantity === 'auto' ? marketQty(m2, 20) : toStep(cfg.orders.sosoBuyQuantity, m2.sym.stepSize || '0', 'floor');
  const notional = dMul(qty, m2.ask);
  if (approx(notional) < approx(m2.sym.minNotional)) throw new SafetyStop(`a market buy of ${qty} (~${cut(notional, 4)} USDC) is below the market's minimum notional ${m2.sym.minNotional}`);
  const b0 = await balancesOf(owner, usdc);
  if (unitsOf(b0.spot, udp) < unitsOf(dMul(notional, '1.05'), udp)) throw new SafetyStop(`Spot holds ${b0.spot} USDC; the market buy needs ~${cut(dMul(notional, '1.05'), 4)}`);
  const c0 = await balancesOf(owner, base);
  await rec.sub(`spot ${m2.sym.name}: market BUY ${qty} ${base.coin} (~${cut(notional, 4)} USDC)`, () =>
    armed(ctx, { expect: [orderExpect({ engine: 'spot', symbolID: m2.sym.id, side: 1, type: 2, qty, label: `spot market buy ${base.coin}` })] }, () =>
      placeOrder('spot', { symbol: m2.sym.name, side: 'buy', type: 'market', quantity: qty, tif: 'ioc' }),
    ),
  );
  const bdp = base.valuechain.decimals;
  const c1 = await rec.sub(`verify: ${base.coin} arrived in Spot`, () =>
    waitFor(ctx, `${base.coin} in Spot`, { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => balancesOf(owner, base), done: (b) => unitsOf(b.spot, bdp) > unitsOf(c0.spot, bdp), show: (b) => `Spot ${base.coin} ${b?.spot ?? '?'}` }),
  );
  const b1 = await balancesOf(owner, usdc);
  const bought = formatUnits(unitsOf(c1.spot, bdp) - unitsOf(c0.spot, bdp), bdp);
  const paid = formatUnits(unitsOf(b0.spot, udp) - unitsOf(b1.spot, udp), udp);
  const mid = (approx(m2.bid) + approx(m2.ask)) / 2;
  rec.amount(`spot market buy`, `${bought} ${base.coin} for ${paid} USDC (avg ${(approx(paid) / Math.max(approx(bought), 1e-18)).toFixed(6)})`);
  rec.fee('spot market buy (fee + spread vs mid)', usd(approx(paid) - approx(bought) * mid));

  // Perps: collateral, rest + cancel, open at the minimum, reduce-only close, collateral back.
  const perpsM = await readMarket('perps', cfg.orders.perpsSymbol);
  const q = marketQty(perpsM, 10);
  const pNotional = approx(q) * approx(perpsM.ask);
  const st = await engineState('perps', owner).catch(() => null);
  const lev = st?.S?.find((x) => x.s === perpsM.sym.name)?.l ?? perpsM.sym.initLeverage ?? 20;
  const need = String(Math.max(approx(cfg.orders.perpsCollateral), Math.ceil((pNotional / lev) * 1.5 + pNotional * approx(perpsM.sym.takerFee) * 2 + 0.5)));
  const p0 = await balancesOf(owner, usdc);
  if (unitsOf(p0.perps, udp) < unitsOf(need, udp)) {
    const move = toStep(dSub(need, p0.perps), '0.000001', 'ceil');
    if (unitsOf(p0.spot, udp) < unitsOf(move, udp)) throw new SafetyStop(`Perps needs ~${need} USDC of collateral (leverage ${lev}x); Spot holds only ${p0.spot}`);
    await rec.sub(`Spot -> Perps ${move} USDC collateral (leverage ${lev}x)`, () =>
      armed(ctx, { expect: [engineTransfer('spot', TransferType.PERPS_WITHDRAW, usdc, move, 'collateral Spot -> Perps')] }, () =>
        transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'spot', to: 'perps', amount: move }),
      ),
    );
    await rec.sub('verify: collateral in Perps', () =>
      waitFor(ctx, 'Perps collateral', { timeoutMs: settleMs(ctx), probe: () => balancesOf(owner, usdc), done: (b) => unitsOf(b.perps, udp) >= unitsOf(p0.perps, udp) + unitsOf(move, udp), show: (b) => `Perps ${b?.perps ?? '?'}` }),
    );
  }
  await restAndCancel(ctx, perpsM, cfg.orders.perpsLimitOffsetPct);

  const pm = await readMarket('perps', cfg.orders.perpsSymbol);
  const oq = marketQty(pm, 10);
  await rec.sub(`perps ${pm.sym.name}: market BUY ${oq} (~${(approx(oq) * approx(pm.ask)).toFixed(2)} USD)`, () =>
    armed(ctx, { expect: [orderExpect({ engine: 'perps', symbolID: pm.sym.id, side: 1, type: 2, qty: oq, reduceOnly: false, label: `perps market open ${pm.sym.name}` })] }, () =>
      placeOrder('perps', { symbol: pm.sym.name, side: 'buy', type: 'market', quantity: oq, tif: 'ioc' }),
    ),
  );
  const pos = await rec.sub('verify: the position is open', () =>
    waitFor(ctx, `a ${pm.sym.name} position`, {
      timeoutMs: orderMs(ctx),
      intervalMs: 2000,
      probe: async () => (await positions(owner)).find((p) => p.symbol === pm.sym.name && approx(p.size) !== 0) ?? null,
      done: (p) => p !== null,
      show: () => 'no position yet',
    }),
  );
  const size = String(pos!.size);
  const long = approx(size) > 0;
  const closeQty = canonicalDecimal(size.replace(/^-/, ''));
  rec.amount(`perps position`, `${size} ${pm.sym.name} @ ${pos!.avgEntryPrice ?? '?'}`);
  await rec.sub(`perps ${pm.sym.name}: reduce-only market ${long ? 'SELL' : 'BUY'} ${closeQty}`, () =>
    armed(ctx, { expect: [orderExpect({ engine: 'perps', symbolID: pm.sym.id, side: long ? 2 : 1, type: 2, qty: closeQty, reduceOnly: true, label: `perps reduce-only close ${pm.sym.name}` })] }, () =>
      placeOrder('perps', { symbol: pm.sym.name, side: long ? 'sell' : 'buy', type: 'market', quantity: closeQty, reduceOnly: true, tif: 'ioc' }),
    ),
  );
  await rec.sub('verify: flat', () =>
    waitFor(ctx, `the ${pm.sym.name} position to close`, {
      timeoutMs: orderMs(ctx),
      intervalMs: 2000,
      probe: async () => (await positions(owner)).find((p) => p.symbol === pm.sym.name && approx(p.size) !== 0) ?? null,
      done: (p) => p === null,
      show: (p) => (p ? `still ${p.size}` : '-'),
    }),
  );

  // Whatever Perps can release goes back to Spot (the next steps pay from Spot).
  const p1 = await balancesOf(owner, usdc);
  if (unitsOf(p1.perps, udp) > 0n) {
    const back = formatUnits(unitsOf(p1.perps, udp), udp);
    await rec.sub(`Perps -> Spot ${back} USDC (all Perps can release)`, () =>
      armed(ctx, { expect: [engineTransfer('perps', TransferType.SPOT_WITHDRAW, usdc, back, 'Perps -> Spot (collateral back)')] }, () =>
        transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'perps', to: 'spot', amount: back }),
      ),
    );
    await rec.sub('verify: back in Spot', () =>
      waitFor(ctx, 'the collateral back in Spot', { timeoutMs: settleMs(ctx), probe: () => balancesOf(owner, usdc), done: (b) => unitsOf(b.spot, udp) >= unitsOf(p1.spot, udp) + unitsOf(back, udp), show: (b) => `Spot ${b?.spot ?? '?'}, Perps ${b?.perps ?? '?'}` }),
    );
  }
  const p2 = await balancesOf(owner, usdc);
  rec.amount('perps round trip (Perps USDC before collateral -> after)', `${p0.perps} -> ${p1.perps} USDC (fees + PnL)`);
  rec.note(`Spot USDC now ${p2.spot}, Perps ${p2.perps}`);
}

async function stepSpotToEvm(ctx: Ctx): Promise<void> {
  const { owner, rec, cfg } = ctx;
  const usdc = ctx.pre.usdc;
  const soso = ctx.pre.soso;
  const udp = usdc.valuechain.decimals;
  await ensureTrading(ctx);

  const a = canonicalDecimal(cfg.spotToEvm.usdc);
  const units = parseUnits(a, udp);
  const b0 = await balancesOf(owner, usdc);
  if (unitsOf(b0.spot, udp) < units) throw new SafetyStop(`Spot holds ${b0.spot} USDC, less than ${a}`);
  const w0 = await tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner);
  await rec.sub(`Spot -> ValueChain wallet ${a} USDC (transferFunds)`, () =>
    armed(ctx, { expect: [engineTransfer('spot', TransferType.EVM_WITHDRAW, usdc, a, 'Spot -> own wallet (USDC)')] }, () =>
      transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'spot', to: 'evm', amount: a }),
    ),
  );
  await rec.sub('verify: USDC arrived in the ValueChain wallet', () =>
    waitFor(ctx, 'USDC in the ValueChain wallet', { timeoutMs: settleMs(ctx), probe: () => tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner), done: (v) => v >= w0 + units, show: (v) => `wallet USDC ${v === undefined ? '?' : formatUnits(v, udp)} (want >= ${formatUnits(w0 + units, udp)})` }),
  );
  rec.amount('Spot -> wallet USDC', a);

  const sdp = soso.valuechain.decimals;
  const s0 = await balancesOf(owner, soso);
  const amt = cfg.spotToEvm.soso === 'all' ? s0.spot : canonicalDecimal(cfg.spotToEvm.soso);
  if (unitsOf(amt, sdp) === 0n) {
    rec.warn('SOSO', 'Spot holds no SOSO - nothing to move. The ValueChain wallet needs a little SOSO for gas in evm-to-spot / withdraw-valuechain-other.');
    return;
  }
  if (unitsOf(s0.spot, sdp) < unitsOf(amt, sdp)) throw new SafetyStop(`Spot holds ${s0.spot} SOSO, less than ${amt}`);
  const n0 = await nativeBalance(VALUECHAIN_RPC, owner);
  await rec.sub(`Spot -> ValueChain wallet ${amt} SOSO (lands as native SOSO)`, () =>
    armed(ctx, { expect: [engineTransfer('spot', TransferType.EVM_WITHDRAW, soso, amt, 'Spot -> own wallet (SOSO)')] }, () =>
      transferFunds({ owner, provider: ctx.provider, coin: soso, from: 'spot', to: 'evm', amount: amt }),
    ),
  );
  await rec.sub('verify: native SOSO arrived', () =>
    waitFor(ctx, 'SOSO in the ValueChain wallet', { timeoutMs: settleMs(ctx), probe: () => nativeBalance(VALUECHAIN_RPC, owner), done: (v) => v >= n0 + unitsOf(amt, sdp), show: (v) => `wallet SOSO ${v === undefined ? '?' : formatUnits(v, sdp)}` }),
  );
  rec.amount('Spot -> wallet SOSO', amt);
}

/**
 * Wallet -> Spot for USDC through transferFunds -> depositFromWallet. The app
 * does it gaslessly: the token's ERC-2612 Permit (spender: the CallForPermit
 * contract) and a CallForPermit wrapping DepositERC20WithPermit, relayed by
 * SoDEX. Both signatures are pinned to this token, this amount and SoDEX's own
 * contracts; so is the relayed request. (The app's earlier path - backend-built
 * approve + depositERC20 sent by the wallet - is accepted on the same terms.)
 */
async function walletToSpot(ctx: Ctx, amountIn: string, title: string): Promise<void> {
  const { owner, rec } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const amount = canonicalDecimal(amountIn);
  const units = parseUnits(amount, dp);
  const w0 = await tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner);
  if (w0 < units) throw new SafetyStop(`the ValueChain wallet holds ${formatUnits(w0, dp)} USDC, less than ${amount}`);
  const spot0 = unitsOf((await balancesOf(owner, usdc)).spot, dp);
  const token = usdc.valuechain.token.toLowerCase();
  const exchange = ctx.pre.vc.exchange.toLowerCase();
  const permitContract = CALL_FOR_PERMIT_CONTRACT.toLowerCase();
  const gateway = CLOB_GATEWAY.toLowerCase();
  await rec.sub(title, () =>
    armed(
      ctx,
      {
        expect: [
          {
            kind: 'deposit-permit',
            label: `relayed DepositERC20WithPermit ${amount} USDC`,
            check: (r) => (r.deposit?.token === token && r.deposit.amount === units ? null : `deposits ${r.deposit?.amount} of ${r.deposit?.token}, expected ${units} of ${token}`),
          },
          {
            kind: 'deposit-prepare',
            label: `prepare deposit ${amount} USDC`,
            check: (r) => {
              const b = r.body ?? {};
              if (String(b.address).toLowerCase() !== owner) return `for ${b.address}, not this wallet`;
              if (b.coinId !== usdc.assetId) return `coin ${b.coinId}, expected ${usdc.assetId}`;
              if (b.amount !== amount) return `amount ${b.amount}, expected ${amount}`;
              return null;
            },
          },
        ],
        policy: {
          typedData: (td, chainId) => {
            if (chainId !== VALUECHAIN_CHAIN_ID) return 'deposit signatures are signed on ValueChain';
            const d = td.domain as { name?: unknown; verifyingContract?: unknown };
            const m = td.message as Record<string, unknown>;
            if (td.primaryType === 'Permit') {
              // Signature 1: the token's own ERC-2612 permit, spender = SoDEX's CallForPermit contract.
              if (String(d.verifyingContract).toLowerCase() !== token) return `a Permit for token ${String(d.verifyingContract)}, not USDC`;
              if (String(m.owner).toLowerCase() !== owner) return 'a Permit for another owner';
              if (String(m.spender).toLowerCase() !== permitContract) return `a Permit for spender ${String(m.spender)}, not the CallForPermit contract`;
              return String(m.value) === units.toString() ? null : `a Permit for ${String(m.value)}, expected ${units}`;
            }
            if (td.primaryType === 'CallForPermit') {
              // Signature 2: DepositERC20WithPermit into the CLOB gateway, same token and amount.
              if (d.name !== 'SoDexTokenCallForPermit' || String(d.verifyingContract).toLowerCase() !== permitContract) return 'not the SoDEX CallForPermit contract';
              const cmd = (m.cmd ?? {}) as Record<string, unknown>;
              if (String(m.to).toLowerCase() !== gateway) return `a CallForPermit to ${String(m.to)}, not the CLOB gateway`;
              if (String(cmd.token).toLowerCase() !== token || String(cmd.amount) !== units.toString()) return `deposits ${String(cmd.amount)} of ${String(cmd.token)}, expected ${units} of USDC`;
              return null;
            }
            return `unexpected typed data ${td.primaryType}`;
          },
          tx: (t) => {
            if (t.chainId !== VALUECHAIN_CHAIN_ID) return `chain ${t.chainId}, expected ValueChain`;
            if (t.value !== 0n) return 'carries native value';
            try {
              if (t.to === token) {
                const d = decodeFunctionData({ abi: ERC20, data: t.data as `0x${string}` });
                if (d.functionName !== 'approve') return `USDC.${d.functionName} was not expected`;
                const [spender, amt] = d.args as readonly [string, bigint];
                return spender.toLowerCase() === exchange && amt === units ? null : `approve(${spender}, ${amt}) is not approve(exchange, ${units})`;
              }
              if (t.to === exchange) {
                const d = decodeFunctionData({ abi: EXCHANGE, data: t.data as `0x${string}` });
                const [tk, amt] = d.args as readonly [string, bigint];
                return tk.toLowerCase() === token && amt === units ? null : `depositERC20(${tk}, ${amt}) is not depositERC20(USDC, ${units})`;
              }
            } catch {
              return 'calldata is not approve/depositERC20';
            }
            return `to ${t.to}: neither the USDC token nor the exchange`;
          },
        },
      },
      () => transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'evm', to: 'spot', amount }),
    ),
  );
  await rec.sub('verify: Spot credited', () =>
    waitFor(ctx, 'the deposit in Spot', { timeoutMs: settleMs(ctx), probe: async () => unitsOf((await balancesOf(owner, usdc)).spot, dp), done: (s) => s >= spot0 + units, show: (s) => `Spot USDC ${s === undefined ? '?' : formatUnits(s, dp)} (want >= ${formatUnits(spot0 + units, dp)})` }),
  );
  rec.amount('wallet -> Spot USDC', amount);
}

async function stepEvmToSpot(ctx: Ctx): Promise<void> {
  await walletToSpot(ctx, ctx.cfg.evmToSpot.usdc, `ValueChain wallet -> Spot ${ctx.cfg.evmToSpot.usdc} USDC (transferFunds -> depositFromWallet)`);
}

async function stepWithdrawValuechainSelf(ctx: Ctx): Promise<void> {
  const { owner, rec } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const amount = canonicalDecimal(ctx.cfg.withdrawValuechainSelf.amount);
  const units = parseUnits(amount, dp);
  await ensureTrading(ctx);
  const b0 = await balancesOf(owner, usdc);
  if (unitsOf(b0.spot, dp) < units) throw new SafetyStop(`Spot holds ${b0.spot} USDC, less than ${amount}`);
  const w0 = await tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner);
  await rec.sub(`withdrawFunds: ${amount} USDC Spot -> own ValueChain wallet`, () =>
    armed(ctx, { expect: [engineTransfer('spot', TransferType.EVM_WITHDRAW, usdc, amount, 'withdraw to own wallet')] }, () =>
      withdrawFunds({ owner, provider: ctx.provider, coin: usdc, route: 'VALUECHAIN', receiver: owner, amount, sources: { spot: true, perps: false, evm: false } }),
    ),
  );
  await rec.sub('verify: the wallet received it', () =>
    waitFor(ctx, 'USDC in the ValueChain wallet', { timeoutMs: settleMs(ctx), probe: () => tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner), done: (v) => v >= w0 + units, show: (v) => `wallet USDC ${v === undefined ? '?' : formatUnits(v, dp)}` }),
  );
  rec.amount('withdrawn to own wallet', `${amount} USDC`);
}

async function stepWithdrawValuechainOther(ctx: Ctx): Promise<void> {
  const { owner, rec, cfg } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const r = receiverNamed(ctx, cfg.withdrawValuechainOther.receiver);
  const to = r.address;
  const bad = receiverProblem('VALUECHAIN', to);
  if (bad) throw new SafetyStop(`receivers.${cfg.withdrawValuechainOther.receiver}: ${bad}`);
  if (r.self) throw new SafetyStop('the receiver is this wallet itself - withdraw-valuechain-other needs a DIFFERENT address');
  if (!allowedReceivers(ctx).has(to.toLowerCase())) throw new SafetyStop(`${to} is not in the config's receivers`);
  const amount = canonicalDecimal(cfg.withdrawValuechainOther.amount);
  const units = parseUnits(amount, dp);
  await ensureTrading(ctx);
  const b0 = await balancesOf(owner, usdc);
  if (unitsOf(b0.spot, dp) < units) throw new SafetyStop(`Spot holds ${b0.spot} USDC, less than ${amount}`);
  if ((await nativeBalance(VALUECHAIN_RPC, owner)) === 0n) throw new SafetyStop('the ValueChain wallet has no SOSO for the transfer\'s gas');
  const o0 = await tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, to);
  const token = usdc.valuechain.token.toLowerCase();
  const want = erc20TransferData(to, units).toLowerCase();
  const res = await rec.sub(`withdrawFunds: ${amount} USDC Spot -> ${to} on ValueChain`, () =>
    armed(
      ctx,
      {
        expect: [engineTransfer('spot', TransferType.EVM_WITHDRAW, usdc, amount, 'Spot -> own wallet (then on to the receiver)')],
        policy: {
          tx: (t) =>
            t.chainId !== VALUECHAIN_CHAIN_ID ? `chain ${t.chainId}` : t.to !== token ? `to ${t.to}, not USDC` : t.value !== 0n ? 'native value' : t.data !== want ? `not transfer(${to}, ${units})` : null,
        },
      },
      () => withdrawFunds({ owner, provider: ctx.provider, coin: usdc, route: 'VALUECHAIN', receiver: to, amount, sources: { spot: true, perps: false, evm: false } }),
    ),
  );
  if ('txHash' in res && res.txHash) rec.note(`ValueChain transfer ${res.txHash}`);
  await rec.sub('verify: the receiver got it', () =>
    waitFor(ctx, `USDC at ${to}`, { timeoutMs: settleMs(ctx), probe: () => tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, to), done: (v) => v >= o0 + units, show: (v) => `receiver USDC ${v === undefined ? '?' : formatUnits(v, dp)}` }),
  );
  ctx.stepSentAwayUsd += approx(amount);
  rec.amount('sent to another ValueChain address', `${amount} USDC -> ${to}`);
}

/** How to read the receiver's balance on the destination chain (EVM chains the app knows), or null. */
async function destinationReader(route: ChainRoute, holder: string): Promise<{ read: () => Promise<bigint>; decimals: number; symbol: string } | null> {
  const chain = EVM_CHAINS[route.key];
  if (!chain || route.addressKind !== 'evm') return null;
  if (route.isNativeToken) return { read: () => nativeBalance(chain.rpcUrl, holder), decimals: chain.native.decimals, symbol: chain.native.symbol };
  const token = route.tokenAddress?.toLowerCase();
  if (!token || !/^0x[0-9a-f]{40}$/.test(token)) return null;
  const canon = CANONICAL_USDC[route.key];
  let decimals = canon && canon.address === token ? canon.decimals : null;
  if (decimals === null) {
    const hex = (await rpcRead(chain.rpcUrl, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest'])) as string;
    decimals = Number(BigInt(hex));
  }
  return { read: () => tokenBalance(chain.rpcUrl, token, holder), decimals, symbol: token };
}

/** A decimal amount in another token's decimals, cut down. */
const toUnitsCut = (v: string, dp: number): bigint => unitsDown(v, dp);

/**
 * Withdraw `amount` of `coin` from Spot to another chain through the app's
 * withdrawFunds, called as the Withdraw sheet calls it: the on-chain quote
 * first (withdrawQuote), its fee passed back as `expectedFee`. The app then runs
 * SoDEX's own pre-checks (maintenance, the address risk check, blacklist,
 * liquidity), moves Spot -> own ValueChain wallet, has the wallet sign ONE
 * WithdrawToken permit and SoDEX relays it. Followed to the end with
 * withdrawalProgress (the on-chain Withdrawer record) AND the receiver's
 * balance on the destination chain where it can be read.
 */
async function withdrawTo(ctx: Ctx, o: { coin: CoinConfig; route: ChainRoute; receiverName: string; amount: string }): Promise<void> {
  const { owner, rec } = ctx;
  const { coin, route } = o;
  const dp = coin.valuechain.decimals;
  const r = receiverNamed(ctx, o.receiverName);
  const address = r.address.trim();
  // Every check BEFORE anything is signed.
  if (!allowedReceivers(ctx).has(address.toLowerCase())) throw new SafetyStop(`${address} is neither this wallet nor in the config's receivers`);
  if (!route.withdraw.allowed) throw new SafetyStop(`${coin.coin} withdrawals to ${route.label} are closed right now`);
  if (route.addressKind === 'other') throw new SafetyStop(`the app does not offer ${route.label}`);
  if (r.self && route.addressKind !== 'evm') throw new SafetyStop(`"self" is an EVM address; ${route.label} needs a receiver from the config`);
  if (route.memo === 'numeric' && !r.memo && !r.noMemo) throw new SafetyStop(`${route.label} takes a memo: set "memo" or "noMemo": true on receivers.${o.receiverName}`);
  const bad = receiverProblem(route, address) ?? memoProblem(route, r.memo ?? '', r.noMemo === true);
  if (bad) throw new SafetyStop(`receiver ${address}: ${bad}`);
  const amount = canonicalDecimal(o.amount);
  const units = parseUnits(amount, dp);
  if (route.withdraw.min && units < unitsDown(route.withdraw.min, dp)) throw new SafetyStop(`${amount} ${coin.coin} is below the minimum ${route.withdraw.min} on ${route.label}`);
  await ensureTrading(ctx);

  // The fee and liquidity SoDEX's registry states on-chain - what the Withdraw sheet shows and passes back.
  const quote = await rec.sub(
    `SoDEX's on-chain fee and liquidity for ${coin.coin} -> ${route.label} (withdrawQuote)`,
    () => withdrawQuote(coin, route, owner),
    (q) => `fee ${formatUnits(q.fee, dp)} ${coin.coin}, available ${formatUnits(q.available, dp)}`,
  );
  const fee = formatUnits(quote.fee, dp);
  if (route.withdraw.fee !== null && unitsDown(route.withdraw.fee, dp) !== quote.fee) {
    rec.warn('fee', `SoDEX's asset config says ${route.withdraw.fee} ${coin.coin}, the chain says ${fee} - the chain's fee applies`);
  }
  if (units <= quote.fee) throw new SafetyStop(`${amount} ${coin.coin} does not cover the ${fee} fee`);
  if (units > quote.available) throw new SafetyStop(`SoDEX can pay out only ${formatUnits(quote.available, dp)} ${coin.coin} on ${route.label} right now`);
  const feeUsd = approx(fee) * (await usdPrice(coin.coin));
  if (ctx.spend.costUsd + ctx.spend.sentAwayUsd + feeUsd > ctx.cfg.maxSpendUsd + 1e-9) {
    throw new SafetyStop(`budget: the ${fee} ${coin.coin} fee (${usd(feeUsd)}) would take the run past maxSpendUsd ${usd(ctx.cfg.maxSpendUsd)}`);
  }
  const b0 = await balancesOf(owner, coin);
  if (unitsOf(b0.spot, dp) < units) throw new SafetyStop(`Spot holds ${b0.spot} ${coin.coin}, less than ${amount}`);

  const dest = await destinationReader(route, address).catch(() => null);
  const before = dest ? await dest.read() : null;
  const memo = route.memo === 'numeric' && !r.noMemo ? r.memo ?? '' : '';
  // As the app builds it: an EVM receiver checksummed; a memo rides in "address:memo" AND the memo field.
  const permitReceiver = route.addressKind === 'evm' ? toChecksumAddress(address) : memo ? `${address}:${memo}` : address;
  const permitMatches = (p: { coinSymbol: unknown; chain: unknown; receiver: unknown; amount: unknown; memo?: unknown; withdrawType?: unknown }): string | null => {
    if (p.coinSymbol !== coin.coin) return `coin ${String(p.coinSymbol)}`;
    if (p.chain !== route.key) return `chain ${String(p.chain)}`;
    if (p.receiver !== permitReceiver) return `receiver ${String(p.receiver)}, expected ${permitReceiver}`;
    if (String(p.amount) !== units.toString()) return `amount ${String(p.amount)}, expected ${units}`;
    if ((p.memo ?? '') !== memo) return `memo "${String(p.memo)}"`;
    if (p.withdrawType !== undefined && Number(p.withdrawType) !== route.withdrawType) return `withdrawType ${String(p.withdrawType)}`;
    return null;
  };
  const res = await rec.sub(`withdrawFunds: ${amount} ${coin.coin} -> ${route.label} ${o.receiverName === 'self' ? '(this wallet)' : `(${o.receiverName} ${address})`}, fee ${fee}`, () =>
    armed(
      ctx,
      {
        expect: [
          engineTransfer('spot', TransferType.EVM_WITHDRAW, coin, amount, `Spot -> own wallet (${coin.coin}, the permit's source)`),
          ...(route.withdrawType === 0
            ? [{ kind: 'kyt-check' as const, label: `SoDEX address risk check for ${address}`, check: (w: { body: any }) => (String(w.body?.address ?? '') === address ? null : `for ${String(w.body?.address)}, not ${address}`) }]
            : []),
          {
            kind: 'withdraw-permit',
            label: `permit ${amount} ${coin.coin} -> ${route.key} ${permitReceiver}`,
            check: (w) => (w.permit ? permitMatches(w.permit) : 'no permit'),
          },
        ],
        policy: {
          typedData: (td, chainId) => {
            if (td.primaryType !== 'CallForPermit') return `unexpected typed data ${td.primaryType}`;
            if (chainId !== VALUECHAIN_CHAIN_ID) return 'a permit must be signed on ValueChain';
            const d = td.domain as { name?: unknown; verifyingContract?: unknown };
            if (d.name !== 'SoDexTokenCallForPermit' || String(d.verifyingContract).toLowerCase() !== CALL_FOR_PERMIT_CONTRACT.toLowerCase()) return 'not the SoDEX permit contract';
            const m = td.message as { to?: unknown; cmd?: Record<string, unknown> };
            if (String(m.to).toLowerCase() !== WITHDRAW_TOKEN_TARGET.toLowerCase()) return 'not a WithdrawToken command';
            const c = m.cmd ?? {};
            const why = permitMatches({ coinSymbol: c.coinSymbol, chain: c.chain, receiver: c.receiver, amount: c.amount, memo: c.memo, withdrawType: c.withdrawType });
            return why ? `the permit is not what this step expects: ${why}` : null;
          },
        },
      },
      () => withdrawFunds({ owner, provider: ctx.provider, coin, route, receiver: address, memo, amount, sources: { spot: true, perps: false, evm: false }, expectedFee: quote.fee }),
    ),
  );
  const txHash = 'txHash' in res && res.txHash ? res.txHash : '';
  const withdrawId = 'withdrawId' in res ? res.withdrawId : null;
  if (!txHash && !withdrawId && !dest) {
    throw new Error(`SoDEX accepted the withdrawal without a transaction to follow, and ${route.label} cannot be read from here - check the Withdraw sheet before retrying (the app refuses to send a second permit while this one may still run)`);
  }
  if (txHash) rec.tx({ chain: 'VALUECHAIN', hash: txHash, what: `SoDEX relayed permit: ${amount} ${coin.coin} -> ${route.label}`, explorer: explorer(ctx, 'VALUECHAIN', txHash) });
  if (withdrawId) rec.note(`SoDEX withdrawal id ${withdrawId}`);
  const flight = { what: `${amount} ${coin.coin} withdrawal to ${route.label} ${permitReceiver} (fee ${fee})`, since: Date.now(), ref: txHash ? `ValueChain tx ${txHash}` : withdrawId ? `withdrawal ${withdrawId}` : undefined };
  ctx.inFlight.push(flight);
  const net = dSub(amount, fee);
  const want = dest ? toUnitsCut(net, dest.decimals) : 0n;
  const arrived = (bal: bigint | null) => !!dest && before !== null && bal !== null && bal >= before + want;
  // withdrawalProgress is polled as the Withdraw sheet polls it; the destination balance is read alongside,
  // so a record the app cannot read (or a status it never calls final) cannot hang the run.
  const seen = await rec.sub(
    'verify: SoDEX\'s withdrawal record is final (withdrawalProgress, as the Withdraw sheet polls it)',
    () =>
      waitFor(ctx, `the withdrawal to ${route.label}`, {
        timeoutMs: ctx.cfg.timeouts.withdrawMinutes * 60_000,
        intervalMs: 10_000,
        probe: async () => ({
          p: txHash || withdrawId ? await withdrawalProgress({ withdrawId, txHash }).catch(() => null) : null,
          bal: dest ? await dest.read().catch(() => null) : null,
        }),
        done: (v) => !!v.p?.done || arrived(v.bal),
        show: (v) => `${v?.p ? v.p.status : 'no record yet'}${dest && v?.bal !== undefined && v.bal !== null ? `, ${route.label} balance ${formatUnits(v.bal, dest.decimals)}` : ''}`,
      }),
    (v) => v.p?.status ?? 'no record',
  );
  const p = seen.p;
  if (p?.done && !p.ok) {
    flight.what += ` - SoDEX's record says "${p.status}" (a failed withdrawal paid from Spot is credited back to Spot)`;
    throw new Error(`the withdrawal to ${route.label} ended as "${p.status}"`);
  }
  if (!p?.done) {
    rec.warn('withdrawal record', `the funds arrived on ${route.label}, but withdrawalProgress() does not report the withdrawal final (${p ? `"${p.status}"` : 'no record read'}) - the Withdraw sheet would not show "Completed"`);
  }
  if (p?.destinationTx) rec.tx({ chain: route.key, hash: p.destinationTx, what: `SoDEX payout on ${route.label}`, ...(EVM_CHAINS[route.key] ? { explorer: explorer(ctx, route.key, p.destinationTx) } : {}) });
  if (dest && before !== null) {
    const after = await rec.sub(`verify: ${cut(net, 8)} arrived on ${route.label}`, () =>
      waitFor(ctx, `the funds on ${route.label}`, {
        timeoutMs: 15 * 60_000,
        intervalMs: 10_000,
        probe: dest.read,
        done: (v) => v >= before + want,
        show: (v) => `balance ${v === undefined ? '?' : formatUnits(v, dest.decimals)} (want >= ${formatUnits(before + want, dest.decimals)})`,
      }),
    );
    const received = formatUnits(after - before, dest.decimals);
    rec.amount(`withdrawn to ${route.label}`, `${amount} ${coin.coin} sent, ${received} received`);
    rec.fee(`withdrawal ${coin.coin} -> ${route.label}`, `${cut(dSub(amount, received), 12)} ${coin.coin} (on-chain fee ${fee}${p?.fee !== null && p?.fee !== undefined ? `, record says ${formatUnits(p.fee, dp)}` : ''})`);
  } else {
    rec.note(`arrival on ${route.label} cannot be read from here - SoDEX's record "${p?.status ?? '?'}" is the evidence`);
    rec.amount(`withdrawn to ${route.label}`, `${amount} ${coin.coin} (fee ${fee}, net ${net})`);
    rec.fee(`withdrawal ${coin.coin} -> ${route.label}`, `${p?.fee !== null && p?.fee !== undefined ? formatUnits(p.fee, dp) : fee} ${coin.coin}`);
  }
  ctx.inFlight.splice(ctx.inFlight.indexOf(flight), 1);
  if (!r.self) ctx.stepSentAwayUsd += approx(net) * (await usdPrice(coin.coin));
}

const amountFor = async (ctx: Ctx, coin: CoinConfig, route: ChainRoute, spec: string): Promise<string> => {
  if (spec === 'min') {
    if (!route.withdraw.min) throw new SafetyStop(`SoDEX lists no withdrawal minimum for ${coin.coin} on ${route.label} - give an amount`);
    return route.withdraw.min;
  }
  if (spec === 'all') return (await balancesOf(ctx.owner, coin)).spot;
  if (!isDecimal(spec)) throw new SafetyStop(`not an amount: ${spec}`);
  return spec;
};

async function stepWithdrawExternal(ctx: Ctx): Promise<void> {
  const w = ctx.cfg.withdrawExternal;
  const coin = coinNamed(ctx, w.coin);
  const route = routeOf(coin, w.chain);
  await withdrawTo(ctx, { coin, route, receiverName: w.receiver, amount: await amountFor(ctx, coin, route, w.amount) });
}

async function stepExtraDeposits(ctx: Ctx): Promise<void> {
  if (!(await sodexAccountId(ctx.owner))) throw new SafetyStop('extra deposits expect the account to exist (run deposit-external first)');
  for (const d of ctx.cfg.extraDeposits) await depositOne(ctx, d.chain, d.amount);
}

/** Market-buy what is missing of `coin` so Spot holds `amount` (costs a taker fee + spread). */
async function buyOnSpot(ctx: Ctx, coin: CoinConfig, amount: string): Promise<void> {
  const { owner, rec } = ctx;
  const dp = coin.valuechain.decimals;
  const b0 = await balancesOf(owner, coin);
  const missing = dSub(amount, b0.spot);
  if (dCmp(missing, '0') <= 0) return;
  const m = await spotMarketFor(coin);
  const q = toStep(dMax(marketQty(m, 10), dDiv(missing, String(1 - approx(m.sym.takerFee) - 0.0005), 'ceil')), m.sym.stepSize || '0', 'ceil');
  const cost = dMul(q, m.ask);
  const u0 = await balancesOf(owner, ctx.pre.usdc);
  if (approx(u0.spot) < approx(cost) * 1.05) throw new SafetyStop(`buying ${q} ${coin.coin} needs ~${cut(cost, 4)} USDC; Spot holds ${u0.spot}`);
  await rec.sub(`spot ${m.sym.name}: market BUY ${q} ${coin.coin} (~${cut(cost, 4)} USDC) - Spot held ${b0.spot}, needs ${amount}`, () =>
    armed(ctx, { expect: [orderExpect({ engine: 'spot', symbolID: m.sym.id, side: 1, type: 2, qty: q, label: `buy ${coin.coin} for the withdrawal` })] }, () =>
      placeOrder('spot', { symbol: m.sym.name, side: 'buy', type: 'market', quantity: q, tif: 'ioc' }),
    ),
  );
  const b1 = await rec.sub(`verify: Spot holds >= ${amount} ${coin.coin}`, () =>
    waitFor(ctx, `${coin.coin} in Spot`, { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => balancesOf(owner, coin), done: (b) => unitsDown(b.spot, dp) >= unitsDown(amount, dp), show: (b) => `Spot ${coin.coin} ${b?.spot ?? '?'}` }),
  );
  const u1 = await balancesOf(owner, ctx.pre.usdc);
  const udp = ctx.pre.usdc.valuechain.decimals;
  rec.amount(`bought ${coin.coin}`, `${formatUnits(unitsDown(b1.spot, dp) - unitsDown(b0.spot, dp), dp)} ${coin.coin} for ${formatUnits(unitsDown(u0.spot, udp) - unitsDown(u1.spot, udp), udp)} USDC (whatever is not withdrawn stays in Spot)`);
}

async function stepExtraWithdrawals(ctx: Ctx): Promise<void> {
  for (const x of ctx.cfg.extraWithdrawals) {
    const coin = coinNamed(ctx, x.coin);
    const route = routeOf(coin, x.chain);
    const amount = await amountFor(ctx, coin, route, x.amount);
    const held = (await balancesOf(ctx.owner, coin)).spot;
    if (dCmp(held, amount) < 0) {
      if (!x.buyIfMissing) throw new SafetyStop(`Spot holds ${held} ${coin.coin}, less than ${amount} (buyIfMissing is off)`);
      await buyOnSpot(ctx, coin, amount);
    }
    await withdrawTo(ctx, { coin, route, receiverName: x.receiver, amount });
  }
}

async function stepCleanup(ctx: Ctx): Promise<void> {
  const { owner, rec } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  await ensureTrading(ctx);
  const b = await balancesOf(owner, usdc);
  if (unitsOf(b.perps, dp) > 0n) {
    const amt = formatUnits(unitsOf(b.perps, dp), dp);
    await rec.sub(`Perps -> Spot ${amt} USDC`, () =>
      armed(ctx, { expect: [engineTransfer('perps', TransferType.SPOT_WITHDRAW, usdc, amt, 'cleanup Perps -> Spot')] }, () =>
        transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'perps', to: 'spot', amount: amt }),
      ),
    );
    await rec.sub('verify: in Spot', () =>
      waitFor(ctx, 'Perps USDC back in Spot', { timeoutMs: settleMs(ctx), probe: () => balancesOf(owner, usdc), done: (x) => unitsOf(x.spot, dp) >= unitsOf(b.spot, dp) + unitsOf(amt, dp), show: (x) => `Spot ${x?.spot ?? '?'}` }),
    );
  }
  const w = await tokenBalance(VALUECHAIN_RPC, usdc.valuechain.token, owner);
  if (w > 0n) await walletToSpot(ctx, formatUnits(w, dp), `ValueChain wallet -> Spot ${formatUnits(w, dp)} USDC (all)`);
  const route = routeOf(usdc, ctx.cfg.cleanup.chain);
  const spot = (await balancesOf(owner, usdc)).spot;
  if (route.withdraw.min && unitsOf(spot, dp) < unitsDown(route.withdraw.min, dp)) {
    rec.warn('cleanup withdrawal', `Spot holds ${spot} USDC, below the ${route.withdraw.min} minimum on ${route.label} - left in Spot`);
    return;
  }
  await withdrawTo(ctx, { coin: usdc, route, receiverName: 'self', amount: spot });
}

export const STEPS: Record<StepId, (ctx: Ctx) => Promise<void>> = {
  'deposit-external': stepDepositExternal,
  'enable-trading': stepEnableTrading,
  transfers: stepTransfers,
  orders: stepOrders,
  'spot-to-evm': stepSpotToEvm,
  'evm-to-spot': stepEvmToSpot,
  'withdraw-valuechain-self': stepWithdrawValuechainSelf,
  'withdraw-valuechain-other': stepWithdrawValuechainOther,
  'withdraw-external': stepWithdrawExternal,
  'extra-deposits': stepExtraDeposits,
  'extra-withdrawals': stepExtraWithdrawals,
  cleanup: stepCleanup,
};
