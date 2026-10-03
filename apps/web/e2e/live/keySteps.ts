/**
 * The trading key's whole life, through the app's own functions:
 *
 *   restore            restoreTrading() after the session was dropped - what a
 *                      page reload does. The key comes back from the vault and
 *                      signs an order that SoDEX accepts.
 *   still registered   keyStillRegistered() - the app's own question to SoDEX -
 *                      says yes, and each engine's key list holds the key.
 *   disable + revoke   disableTrading({ revoke: true }): the WALLET signs one
 *                      revocation per engine, on ValueChain. The wallet signs an
 *                      ExchangeAction here, which could carry any engine action -
 *                      so its policy lets exactly this revocation's payload hash
 *                      through and nothing else (trading.ts keyRevocationPolicy).
 *   the old key        an order signed with the key BEFORE it was revoked, sent
 *                      after: SoDEX must reject it. The same order (same market,
 *                      price and size) was accepted minutes earlier with the key
 *                      registered, so the rejection is the revocation's doing.
 *                      It leaves through the guard as `direct-order`: exactly
 *                      those bytes, once.
 *   enable again       enableTrading() registers a new key under the same name;
 *                      the steps after this one sign with it.
 *
 * Nothing here costs anything: the orders rest far below the market and are
 * cancelled.
 */
import { TransferType } from '@sodex-core';
import { api } from '../../src/api';
import { symbolFor } from '../../src/trading/actions';
import { balancesOf, transferFunds, unitsDown } from '../../src/trading/funds';
import { placeOrderAction, type MarketSymbol } from '../../src/trading/orderParams';
import { disableTrading, getTradingState, keyStillRegistered, requireSigner, restoreTrading } from '../../src/trading/session';
import type { StoredKey } from '../../src/trading/vault';
import { appOrderBuilder } from './app';
import { CheckFailure, SafetyStop, armed, scenario, type Ctx } from './context';
import {
  clearLeftovers,
  cancel,
  engineTransfer,
  expectGone,
  expectOpen,
  idText,
  isOurs,
  mustPlace,
  openOn,
  prepareDirect,
  rememberMarket,
  sendPrepared,
  settleMs,
  ticketOf,
  waitFor,
  type OrderSpec,
  type Placed,
  type PreparedOrder,
} from './orders';
import { readMarket, restingBuy, type Market } from './plan';
import { apiKeys, type ApiKeyRow } from './reads';
import { keyRevocationExpect, keyRevocationPolicy, registerKey } from './trading';
import { cut, dMul, errText } from './util';

const KEY_IDS = ['key-restore', 'key-still-registered', 'key-disable-revoke', 'key-old-key-rejected', 'key-reenable'] as const;

const notRun = (ctx: Ctx, ids: readonly string[], why: string): void => {
  for (const id of ids) if (!ctx.checks.get(id)) ctx.checks.set(id, 'not-run', why);
};

/** What both engines list under this key name. */
async function listed(owner: string, name: string): Promise<Record<'spot' | 'perps', ApiKeyRow | null>> {
  const [spot, perps] = await Promise.all([apiKeys('spot', owner), apiKeys('perps', owner)]);
  return { spot: spot.find((k) => k.name === name) ?? null, perps: perps.find((k) => k.name === name) ?? null };
}

const sameKey = (row: ApiKeyRow | null, address: string): boolean => !!row && row.publicKey.toLowerCase() === address.toLowerCase();

/** Words SoDEX uses when it does not know the key that signed (not an order problem). */
const KEY_WORDS = /api key|key not found|unknown.*key|signature|unauthori[sz]ed|not registered|revoked|expired/i;

export async function stepKeyLifecycle(ctx: Ctx): Promise<void> {
  const { owner, rec, cfg } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const st0 = getTradingState();
  if (st0.status !== 'enabled' || st0.owner !== owner || !st0.accountId || !st0.keyAddress || !st0.keyName) {
    // Nothing to restore in this process (a resumed run): enable first, so there is a key to take through its life.
    await rec.sub('enable trading first (one wallet signature, no funds move)', () => registerKey(ctx));
  }
  const start = getTradingState();
  if (start.status !== 'enabled' || !start.accountId || !start.keyAddress || !start.keyName) throw new SafetyStop('trading is not enabled');
  const accountId = start.accountId;
  const name = start.keyName;
  const oldKey = start.keyAddress;

  // The proof orders rest on the SPOT book (a resting perps order needs margin in Perps, which the run has moved back).
  const fresh = async (): Promise<Market> => {
    const m = await readMarket('spot', cfg.orders.spotSymbol);
    rememberMarket(m);
    return m;
  };
  let m = await fresh();
  await clearLeftovers(ctx, m, 'key-lifecycle');
  const rb0 = restingBuy(m, cfg.orders.spotLimitOffsetPct);
  const need = dMul(rb0.lock, '1.05');
  const b0 = await balancesOf(owner, usdc);
  if (unitsDown(b0.spot, dp) < unitsDown(need, dp)) {
    // Perps may still hold what an earlier stop left there: bring it over rather than give up.
    if (unitsDown(b0.spot, dp) + unitsDown(b0.perps, dp) < unitsDown(need, dp)) {
      throw new SafetyStop(`Spot holds ${b0.spot} USDC (Perps ${b0.perps}); the resting order that proves a key signs locks ~${cut(need, 4)} USDC`);
    }
    await rec.sub(`Perps -> Spot ${b0.perps} USDC (the proof orders lock ~${cut(need, 4)} USDC in Spot)`, () =>
      armed(ctx, { expect: [engineTransfer('perps', TransferType.SPOT_WITHDRAW, usdc, b0.perps, 'Perps -> Spot')] }, () => transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'perps', to: 'spot', amount: b0.perps })),
    );
    await waitFor(ctx, 'the USDC in Spot', { timeoutMs: settleMs(ctx), probe: () => balancesOf(owner, usdc), done: (b) => unitsDown(b.spot, dp) >= unitsDown(need, dp), show: (b) => `Spot ${b?.spot ?? '?'}` });
  }

  /** One resting order through the APP, seen on the book, cancelled again: the key in the session signs, and SoDEX takes it. */
  const proveSigns = async (tag: string, what: string): Promise<{ id: Placed; price: string; qty: string }> => {
    m = await fresh();
    const rb = restingBuy(m, cfg.orders.spotLimitOffsetPct);
    const spec: OrderSpec = { market: m, side: 'buy', type: 'limit', tif: 'gtc', price: rb.price, quantity: rb.qty, tag, label: what };
    const r = await mustPlace(ctx, spec);
    await expectOpen(ctx, m, r.id, what);
    await cancel(ctx, m, r.id, `${what}: cancel`, tag);
    await expectGone(ctx, m, r.id, what);
    return { id: r.id, price: rb.price, qty: rb.qty };
  };
  const clean = async (tag: string): Promise<void> => {
    const st = getTradingState();
    if (st.status !== 'enabled' || st.owner !== owner) return; // nothing can be signed; the next scenario re-enables
    const open = await openOn(ctx, m);
    for (const o of open) await cancel(ctx, m, { orderID: o.orderID ?? null, clOrdID: o.clOrdID ?? null }, `cancel what ${tag} left`, tag);
  };

  // --- 1. restore -----------------------------------------------------------------------------------------------
  await scenario(
    ctx,
    'key-restore',
    async () => {
      // What a page reload does to the session: gone from memory, read back from the vault.
      await restoreTrading(null);
      const off = getTradingState();
      if (off.status === 'enabled') throw new CheckFailure('the session still says trading is enabled after the wallet was disconnected');
      const back = await restoreTrading(owner);
      if (back.status !== 'enabled') throw new CheckFailure(`after restoreTrading() trading is "${back.status}"${back.reason ? ` (${back.reason})` : ''} - the key did not come back from the vault`);
      if (back.keyAddress !== oldKey || back.keyName !== name || back.accountId !== accountId) {
        throw new CheckFailure(`restoreTrading() brought back key ${String(back.keyAddress)} "${String(back.keyName)}" for account ${String(back.accountId)}, not ${oldKey} "${name}" for ${accountId}`);
      }
      const p = await proveSigns('key-restore', 'a resting order signed with the restored key');
      ctx.checks.pass(
        'key-restore',
        `the session was dropped and restoreTrading() brought key ${oldKey} back from the vault; an order signed with it (${p.qty} @ ${p.price}, ${idText(p.id)}) was accepted, rested and was cancelled. (The run's vault is in memory; the browser's seals the key in IndexedDB - the app's own vault tests cover that.)`,
        { key: oldKey, name, orderID: p.id.orderID },
      );
    },
    async () => {
      // Whatever happened, the steps below need a key in the session.
      const st = getTradingState();
      if (st.status !== 'enabled' || st.owner !== owner) await registerKey(ctx);
      await clean('key-restore');
    },
  );

  // --- 2. still registered -----------------------------------------------------------------------------------------
  const cur = getTradingState();
  const curKey = cur.keyAddress ?? oldKey;
  let meta = null as StoredKey | null;
  await scenario(ctx, 'key-still-registered', async () => {
    meta = { ...requireSigner(owner).meta };
    const live = await keyStillRegistered(meta);
    if (live !== true) throw new CheckFailure(live === null ? 'the app could not ask SoDEX (keyStillRegistered answered null)' : `the app says key ${meta.keyAddress} is NOT the one SoDEX holds under "${meta.name}" - although an order signed with it was just accepted`);
    const rows = await listed(owner, meta.name);
    const missing = (['spot', 'perps'] as const).filter((e) => !sameKey(rows[e], meta!.keyAddress));
    if (missing.length) throw new CheckFailure(`keyStillRegistered says yes, but ${missing.join(' and ')} list${missing.length === 1 ? 's' : ''} ${missing.map((e) => rows[e]?.publicKey ?? 'no key').join(' / ')} under "${meta.name}"`, { rows });
    ctx.checks.pass('key-still-registered', `keyStillRegistered() says yes; spot and perps both list ${meta.keyAddress} under "${meta.name}"${rows.spot?.expiresAt ? `, expiring ${new Date(rows.spot.expiresAt).toISOString()}` : ''}`, { key: meta.keyAddress, name: meta.name, expiresAt: rows.spot?.expiresAt ?? null });
  });

  // --- 3. the order the OLD key signs, prepared while the key is still registered --------------------------------------
  let prepared = null as { req: PreparedOrder; price: string; qty: string; clOrdID: string } | null;
  let revoked = false as boolean;
  await scenario(
    ctx,
    'key-disable-revoke',
    async () => {
      const m1 = await fresh();
      const rb = restingBuy(m1, cfg.orders.spotLimitOffsetPct);
      const spec: OrderSpec = { market: m1, side: 'buy', type: 'limit', tif: 'gtc', price: rb.price, quantity: rb.qty, tag: 'key-old-key-rejected', label: 'an order signed with the revoked key' };
      const sym = (await symbolFor('spot', m1.sym.name)) as MarketSymbol;
      // Built by the app's own order builder, with the builder the app attaches now; signed here with the key about to be revoked.
      const built = placeOrderAction('spot', ticketOf(spec), sym, accountId, appOrderBuilder('spot'));
      const req = await prepareDirect(ctx, 'spot', built.action);
      const clOrdID = String((JSON.parse(req.body) as { orders?: Array<{ clOrdID?: unknown }> }).orders?.[0]?.clOrdID ?? '');
      prepared = { req, price: rb.price, qty: rb.qty, clOrdID };
      rec.line(`prepared (not sent): a resting buy ${rb.qty} @ ${rb.price} signed with key ${curKey} - it is sent AFTER the revocation, and must be rejected`, 5);

      await rec.sub(`disableTrading({ revoke: true }): the wallet signs one revocation per engine (on ValueChain)`, () =>
        armed(ctx, { expect: [keyRevocationExpect(accountId, name)], policy: keyRevocationPolicy(accountId, name) }, () =>
          disableTrading({ revoke: true, provider: ctx.provider, chainParams: () => api.depositChain() }),
        ),
      );
      const st = getTradingState();
      if (st.status === 'enabled') throw new CheckFailure('trading is still enabled in the app after disableTrading()');
      const again = await restoreTrading(owner);
      if (again.status === 'enabled') throw new CheckFailure('the key is still in the vault: restoreTrading() switched trading on again after disableTrading()');
      const rows = await waitFor(ctx, `"${name}" to leave both engines' key lists`, {
        timeoutMs: Math.max(settleMs(ctx), 180_000),
        intervalMs: 10_000,
        probe: () => listed(owner, name),
        done: (r) => !sameKey(r.spot, curKey) && !sameKey(r.perps, curKey),
        show: (r) => (r ? `spot: ${sameKey(r.spot, curKey) ? 'still listed' : 'gone'}, perps: ${sameKey(r.perps, curKey) ? 'still listed' : 'gone'} (indexed reads lag a revocation)` : 'no answer'),
      });
      revoked = true;
      const appSays = meta ? await keyStillRegistered(meta) : null;
      if (appSays === true) throw new CheckFailure('both engines no longer list the key, but the app\'s keyStillRegistered() still says yes', { rows });
      ctx.checks.pass(
        'key-disable-revoke',
        `the wallet signed two revocations (spot and perps); neither engine lists ${curKey} under "${name}" any more; the app's vault is empty, trading is off${appSays === false ? ', and keyStillRegistered() now says no' : ''}`,
        { key: curKey, name, appSaysStillRegistered: appSays },
      );
    },
    async () => {
      /* the key is re-registered below, whatever state the revocation ended in */
    },
  );

  // --- 4. the old key's order must be rejected ----------------------------------------------------------------------------
  let leftover = null as Placed | null;
  await scenario(ctx, 'key-old-key-rejected', async () => {
    if (!prepared) {
      ctx.checks.set('key-old-key-rejected', 'not-run', 'no order was prepared with the old key (key-disable-revoke failed before)');
      return;
    }
    if (!revoked) {
      ctx.checks.set('key-old-key-rejected', 'not-run', 'the key was not revoked on both engines (key-disable-revoke): sending its order would simply place it');
      return;
    }
    const r = await sendPrepared(ctx, 'spot', prepared.req, { tag: 'key-old-key-rejected', label: `resting buy ${prepared.qty} @ ${prepared.price} signed with the revoked key ${curKey}`, purpose: 'a copy of the trading key used after it was revoked' });
    if (r.accepted) {
      leftover = r.id.orderID !== null || r.id.clOrdID !== null ? r.id : { orderID: null, clOrdID: prepared.clOrdID };
      ctx.checks.fail('key-old-key-rejected', `SoDEX ACCEPTED an order signed with the revoked key (${idText(leftover)}) - a copy of a revoked key can still trade. It rests far below the market and is cancelled once trading is enabled again.`, { orderID: r.id.orderID, key: curKey });
      return;
    }
    const why = r.rejection ?? '';
    if (KEY_WORDS.test(why)) ctx.checks.pass('key-old-key-rejected', `SoDEX rejected the order signed with the revoked key: "${why}"`, { rejection: why, key: curKey });
    else {
      ctx.checks.finding(
        'key-old-key-rejected',
        `SoDEX rejected the order signed with the revoked key, in words that do not name the key: "${why}". The same order (same market, price and size) was accepted minutes earlier while the key was registered.`,
        { rejection: why, key: curKey },
      );
    }
  });

  // --- 5. enable again ------------------------------------------------------------------------------------------------------
  await scenario(
    ctx,
    'key-reenable',
    async () => {
      await rec.sub('enable trading again (one wallet signature: a new key under the same name)', () => registerKey(ctx));
      const st = getTradingState();
      const now = st.keyAddress ?? '';
      if (st.status !== 'enabled' || !now) throw new CheckFailure(`trading did not switch on again (status ${st.status})`);
      if (now === curKey) throw new CheckFailure('enabling again registered the SAME key address - a revoked key was put back');
      await waitFor(ctx, 'the new key in both engines\' key lists', {
        timeoutMs: Math.max(settleMs(ctx), 180_000),
        intervalMs: 10_000,
        probe: () => listed(owner, name),
        done: (r) => sameKey(r.spot, now) && sameKey(r.perps, now),
        show: (r) => (r ? `spot: ${r.spot?.publicKey ?? 'none'}, perps: ${r.perps?.publicKey ?? 'none'} (indexed reads lag a fresh key)` : 'no answer'),
      });
      if (leftover) {
        const still = (await openOn(ctx, m)).find((o) => isOurs(o, leftover!));
        if (still) {
          const id: Placed = { orderID: still.orderID ?? null, clOrdID: still.clOrdID ?? null };
          await cancel(ctx, m, id, 'cancel the order the revoked key placed', 'key-old-key-rejected');
          await expectGone(ctx, m, id, 'the order the revoked key placed');
        }
      }
      const p = await proveSigns('key-reenable', 'a resting order signed with the new key');
      ctx.checks.pass('key-reenable', `a new key ${now} is registered under "${name}" on both engines (the revoked one was ${curKey}); an order signed with it (${idText(p.id)}) was accepted, rested and was cancelled`, { key: now, revoked: curKey, orderID: p.id.orderID });
    },
    async () => {
      try {
        const st = getTradingState();
        if (st.status !== 'enabled' || st.owner !== owner) await registerKey(ctx);
        await clean('key-reenable');
      } catch (e) {
        throw new SafetyStop(`trading could not be enabled again after the key test: ${errText(e)}`);
      }
    },
  );
  notRun(ctx, KEY_IDS, 'the step ended before this check');
  const end = await balancesOf(owner, usdc);
  rec.note(`trading key now ${getTradingState().keyAddress ?? '(none)'}; Spot USDC ${end.spot}`);
}
