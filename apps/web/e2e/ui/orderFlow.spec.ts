/**
 * The order ticket end to end, with trading enabled on a fake SoDEX account
 * (sodexFake.ts: every write is answered in the browser context and never reaches
 * SoDEX; the wallet is a throwaway key with no SoDEX account besides).
 *
 * What the user sees (the review, the toasts, the refusals) and what the app
 * would have sent: each order's signed body, decoded, and the key that signed it.
 *
 *   side      1 buy, 2 sell           type      1 limit, 2 market
 *   tif       1 GTC, 3 IOC, 4 GTX     modifier  1 normal, 2 stop, 3 bracket, 4 attached stop
 *   stopType  1 stop-loss, 2 take-profit;  triggerType 2 mark
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { dec, num, typeInto, uiSuite, until, waitValue } from './harness';
import { ticket, toast } from './ticket';
import { enableTrading, placeViaReview, sideButton, type Leg } from './trade';
import { pickMarket } from './uiSteps';
import type { FakeSodex, FakeWrite } from './sodexFake';

const h = uiSuite(import.meta.filename);

type OrderBody = { accountID: number; symbolID: number; orders: Leg[]; builder?: { id: number; fee: number } };
const legsOf = (w: FakeWrite) => (w.body as OrderBody).orders;

/** Signed by the trading key the wallet registered, as the browser's own key (X-API-Key). */
function assertSignedByKey(sx: FakeSodex, w: FakeWrite) {
  assert.equal(sx.signer(w), sx.keys[0]!.publicKey, 'the order is signed by the registered trading key');
  assert.equal(w.headers['x-api-key'], sx.keys[0]!.name, 'X-API-Key names that key');
  assert.equal((w.body as OrderBody).accountID, sx.accountId, 'on the wallet\'s own account');
}

async function ready(page: Page) {
  const t = ticket(page);
  const last = await t.ready();
  return { t, last };
}

h.test('Enable trading: ValueDesk terms, the builder fee and one trading key, then the button is Long', async (env) => {
  const sx = await enableTrading(env);
  // The key is registered on both engines with one signature; the builder fee at most the build's cap.
  const reg = sx.writes.filter((w) => w.path.endsWith('/exchange'));
  assert.deepEqual(reg.map((w) => w.path).sort(), ['/api/v1/perps/exchange', '/api/v1/spot/exchange']);
  assert.equal((reg[0]!.body as { type: string }).type, 'addAPIKey');
  const fee = sx.writes.find((w) => /\/builders$/.test(w.path))!;
  assert.ok(fee, 'the builder approval was sent');
  const b = fee.body as { accountID: number; builderID: number; maxFeeRate: number };
  assert.equal(b.accountID, sx.accountId);
  assert.ok(b.builderID > 0 && b.maxFeeRate > 0 && b.maxFeeRate <= 25, `builder ${b.builderID} at most 0.025% (${b.maxFeeRate} tenths of a bp)`);
  assert.equal(sx.orders().length, 0, 'enabling trading places nothing');
  assert.equal(await sideButton(env.page).textContent(), 'Long');
});

h.test('a limit long: the review shows the order, Place sends exactly it, signed by the trading key', async (env) => {
  const sx = await enableTrading(env);
  const { page } = env;
  const { t, last } = await ready(page);
  const price = Math.round(last * 0.6);
  await t.limit(price, 0.002);
  // The read-out under the button: the exact order value, in the app's number format.
  const value = t.g.locator('.oe-out__row').filter({ hasText: 'Order value' }).locator('dd');
  await waitValue(value, (v) => Math.abs(num(v) - price * 0.002) < 1e-6, `Order value ${price * 0.002}`);
  assert.equal(num(await t.value(t.g.locator('.oe-out__row').filter({ hasText: 'Margin required' }).locator('dd'))), Math.round((price * 0.002 / num(await t.value(t.leverage))) * 100) / 100, 'margin = value / leverage');
  await sideButton(page).click();
  const review = page.getByRole('dialog', { name: /^Review order/ });
  await review.waitFor({ state: 'visible' });
  const text = (await review.textContent()) ?? '';
  assert.match(text, /BUY \/ LONG/);
  assert.match(text, /limit @ /);
  assert.match(text, /· GTC/);
  assert.match(text, /cross \d+x/);
  for (const row of ['Size', 'Entry (limit)', 'Order value', 'Margin required', 'Est. liquidation', 'Est. entry fee', 'Est. ValueDesk fee', 'Signs as']) {
    assert.ok(text.includes(row), `the review shows ${row}`);
  }
  assert.ok(!text.includes('Exits'), 'no exits block without exits');
  // Mainnet: the title says real funds.
  assert.match((await review.getByRole('heading', { level: 2 }).textContent()) ?? '', /real funds/);
  await review.getByRole('button', { name: 'Place buy / long' }).click();
  await review.waitFor({ state: 'hidden' });
  await until(page, () => sx.orders().length === 1, 'the order');
  const w = sx.orders()[0]!;
  assert.equal(w.path, '/api/v1/perps/trade/orders');
  assertSignedByKey(sx, w);
  const legs = legsOf(w);
  assert.equal(legs.length, 1);
  const [o] = legs;
  assert.equal(o!.side, 1, 'buy');
  assert.equal(o!.type, 1, 'limit');
  assert.equal(o!.timeInForce, 1, 'GTC');
  assert.equal(o!.modifier, 1, 'a plain order');
  assert.equal(Number(o!.price), price);
  assert.equal(Number(o!.quantity), 0.002);
  assert.equal(o!.reduceOnly, false);
  const builder = (w.body as OrderBody).builder;
  assert.equal(builder?.id, sx.builders[0]?.builderID, 'the order carries the builder the wallet approved');
  assert.ok(builder!.fee > 0 && builder!.fee <= sx.builders[0]!.feeRate, `at a fee within the approval (${builder!.fee} <= ${sx.builders[0]!.feeRate})`);
  await toast(page, /^Limit long placed/).waitFor({ state: 'visible' });
  assert.match((await toast(page, /^Limit long placed/).textContent()) ?? '', /0[.,]002 BTC @/);
});

h.test('a market short: IOC at the touch within the slippage cap, the review says it fills at the book', async (env) => {
  const sx = await enableTrading(env);
  const { page } = env;
  const { t, last } = await ready(page);
  await t.type('Market');
  await t.direction('Short').check();
  await typeInto(t.amount, dec(0.001));
  await until(page, async () => ((await sideButton(page).textContent()) ?? '') === 'Short', 'the Short button');
  await sideButton(page).click();
  const review = page.getByRole('dialog', { name: /^Review order/ });
  await review.waitFor({ state: 'visible' });
  assert.match((await review.textContent()) ?? '', /SELL \/ SHORT.*market · fills at the book/s);
  await review.getByRole('button', { name: 'Place sell / short' }).click();
  await until(page, () => sx.orders().length === 1, 'the order');
  const [o] = legsOf(sx.orders()[0]!);
  assert.equal(o!.side, 2, 'sell');
  assert.equal(o!.type, 2, 'market');
  assert.equal(o!.timeInForce, 3, 'a market order is IOC');
  // The worst price it may fill at: the bid less the max slippage (0.10 % by default), so near the market.
  const px = Number(o!.price);
  assert.ok(px < last * 1.01 && px > last * 0.98, `a market sell's limit ${px} sits just under the market ${last}`);
  await toast(page, /^Market short placed/).waitFor({ state: 'visible' });
});

h.test('a stop: trigger, kind and executes-as go into the order; a stop-limit carries its price and TIF', async (env) => {
  const sx = await enableTrading(env);
  const { page } = env;
  const { t, last } = await ready(page);
  await t.type('Stop');
  await t.direction('Long').check();
  await typeInto(t.amount, dec(0.001));
  // A buy stop-loss triggers above the market.
  const trigger = Math.round(last * 1.2);
  await typeInto(t.trigger, String(trigger));
  const w = await placeViaReview(page, sx);
  const [o] = legsOf(w);
  assert.equal(o!.modifier, 2, 'a stop order');
  assert.equal(Number(o!.stopPrice), trigger);
  assert.equal(o!.stopType, 1, 'stop-loss');
  assert.equal(o!.triggerType, 2, 'on the mark');
  assert.equal(o!.type, 2, 'executes as market');
  assert.equal(o!.timeInForce, 3);

  // Take-profit, executing as a limit: the price and its TIF.
  await t.kind.selectOption('tp');
  await t.direction('Short').check();
  await typeInto(t.trigger, String(Math.round(last * 0.8)));
  await t.executesAs.selectOption('limit');
  await t.price.waitFor({ state: 'visible' });
  const lim = Math.round(last * 0.79);
  await typeInto(t.price, String(lim));
  await t.pickTif('IOC');
  const w2 = await placeViaReview(page, sx);
  const [o2] = legsOf(w2);
  assert.equal(o2!.stopType, 2, 'take-profit');
  assert.equal(o2!.side, 2);
  assert.equal(o2!.type, 1, 'executes as a limit');
  assert.equal(Number(o2!.price), lim);
  assert.equal(o2!.timeInForce, 3, 'IOC');
  await toast(page, /^Stop short placed/).waitFor({ state: 'visible' });
});

h.test('TP/SL on an entry: a bracket with two reduce-only exits of the same size, shown in the review', async (env) => {
  const sx = await enableTrading(env);
  const { page } = env;
  const { t, last } = await ready(page);
  const price = Math.round(last * 0.6);
  await t.limit(price, 0.002);
  await t.exits.check();
  await typeInto(t.gain, '10');
  await typeInto(t.loss, '5');
  const tp = price + 10 / 0.002;
  const sl = price - 5 / 0.002;
  await waitValue(t.tp, (v) => num(v) === tp, `TP ${tp}`);
  await waitValue(t.sl, (v) => num(v) === sl, `SL ${sl}`);
  await sideButton(page).click();
  const review = page.getByRole('dialog', { name: /^Review order/ });
  await review.waitFor({ state: 'visible' });
  const text = (await review.textContent()) ?? '';
  for (const s of ['Exits', 'Take profit', 'Stop loss', 'PnL is price movement only']) assert.ok(text.includes(s), `the review shows ${s}`);
  // At 20x this stop sits past the estimated liquidation: said, and Place waits for the acknowledgement.
  assert.match(text, /This stop cannot protect the position\. Stop loss is past estimated liquidation/);
  const place = review.getByRole('button', { name: 'Place buy / long' });
  assert.ok(await place.isDisabled(), 'Place waits for the acknowledgement');
  await review.getByRole('checkbox', { name: 'I understand liquidation would happen before this stop loss.' }).check();
  await place.click();
  await until(page, () => sx.orders().length === 1, 'the order');
  const legs = legsOf(sx.orders()[0]!);
  assert.equal(legs.length, 3, 'the entry and two exits in one signed order');
  assert.equal(legs[0]!.modifier, 3, 'the entry is a bracket');
  assert.equal(legs[0]!.reduceOnly, false);
  const [tpLeg, slLeg] = [legs.find((l) => l.stopType === 2)!, legs.find((l) => l.stopType === 1)!];
  for (const [leg, want] of [[tpLeg, tp], [slLeg, sl]] as const) {
    assert.equal(leg.modifier, 4, 'an attached stop');
    assert.equal(leg.side, 2, 'the opposite side');
    assert.equal(leg.type, 2, 'executes at the market');
    assert.equal(leg.reduceOnly, true, 'only ever closes');
    assert.equal(leg.quantity, legs[0]!.quantity, 'the same size as the entry');
    assert.equal(Number(leg.stopPrice), want);
  }
  await toast(page, /\+2 exit orders/).waitFor({ state: 'visible' });
});

h.test('Back to ticket sends nothing; "Don\'t show this review again" skips it next time (under $10,000)', async (env) => {
  const sx = await enableTrading(env);
  const { page } = env;
  const { t, last } = await ready(page);
  await t.limit(Math.round(last * 0.6), 0.001);
  await sideButton(page).click();
  const review = page.getByRole('dialog', { name: /^Review order/ });
  await review.waitFor({ state: 'visible' });
  await review.getByRole('button', { name: 'Back to ticket' }).click();
  await review.waitFor({ state: 'hidden' });
  await page.waitForTimeout(500);
  assert.equal(sx.orders().length, 0, 'Back to ticket sends nothing');

  // Tick "don't show again", then Place: only then is it remembered.
  await sideButton(page).click();
  await review.waitFor({ state: 'visible' });
  await review.getByRole('checkbox', { name: "Don't show this review again" }).check();
  assert.match((await review.textContent()) ?? '', /Mainnet orders of \$10[.,]000 or more always show it regardless\./);
  await review.getByRole('button', { name: 'Place buy / long' }).click();
  await until(page, () => sx.orders().length === 1, 'the first order');
  assert.equal(await page.evaluate(() => localStorage.getItem('opentrade.review.suppress')), '1');
  // The next small order goes without a review.
  await placeViaReview(page, sx, { review: false });
  assert.equal(await review.count(), 0, 'no review for an order under $10,000');
  assert.equal(sx.orders().length, 2);
});

h.test('refusals: reduce-only with exits, a stop with exits, below the minimum, post-only through the touch - nothing is sent', async (env) => {
  const sx = await enableTrading(env);
  const { page } = env;
  const { t, last } = await ready(page);
  const status = t.g.locator('p.status');

  // Below SoDEX's minimum order value: said under the amount, and the button is off.
  await t.limit(Math.round(last * 0.6), 0.0001);
  await t.hints.filter({ hasText: /^Below minimum / }).waitFor({ state: 'visible' });
  assert.ok(await sideButton(page).isDisabled(), 'no order below the minimum');

  // Post-only through the touch: refused on the ticket.
  await typeInto(t.amount, dec(0.001));
  await typeInto(t.price, String(Math.round(last * 1.5)));
  await t.pickTif('GTX');
  await t.hints.filter({ hasText: /^Post only: at this price it would take/ }).waitFor({ state: 'visible' });
  assert.ok(await sideButton(page).isDisabled(), 'post-only that would take is not sent');
  await t.pickTif('GTC');
  await typeInto(t.price, String(Math.round(last * 0.6)));

  // Reduce only + TP/SL: the order names why, on Place, and nothing is signed.
  await t.reduceOnly.check();
  await t.exits.check();
  await typeInto(t.gain, '5');
  await sideButton(page).click();
  const review = page.getByRole('dialog', { name: /^Review order/ });
  if (await review.isVisible().catch(() => false)) await review.getByRole('button', { name: /^Place / }).click();
  else {
    await review.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
    if (await review.isVisible()) await review.getByRole('button', { name: /^Place / }).click();
  }
  await status.filter({ hasText: /cannot be reduce-only/ }).waitFor({ state: 'visible' });
  assert.equal(sx.orders().length, 0, 'reduce-only with exits is refused before signing');
  await t.reduceOnly.uncheck();

  // A stop with exits: refused the same way.
  await t.type('Stop');
  await t.direction('Long').check();
  await typeInto(t.trigger, String(Math.round(last * 1.2)));
  await sideButton(page).click();
  await review.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
  if (await review.isVisible()) await review.getByRole('button', { name: /^Place / }).click();
  await status.filter({ hasText: /A trigger order cannot carry its own take-profit or stop-loss here/ }).waitFor({ state: 'visible' });
  assert.equal(sx.orders().length, 0, 'a stop with exits is refused before signing');
});

h.test('SoDEX rejecting the order is said on the ticket; nothing is claimed placed', async (env) => {
  const sx = await enableTrading(env);
  const { page } = env;
  const { t, last } = await ready(page);
  await t.limit(Math.round(last * 0.6), 0.001);
  sx.rejectNextOrder('insufficient margin');
  await placeViaReview(page, sx);
  await t.g.locator('p.status').filter({ hasText: /SoDEX rejected the order: the order: insufficient margin/ }).waitFor({ state: 'visible' });
  assert.equal(await toast(page, /^(Limit|Market|Stop) (long|short|buy|sell) placed/).count(), 0, 'no "placed" toast for a rejected order');
});

h.test('leverage and margin mode: the popover sends one leverage change, Cross <-> Isolated another', async (env) => {
  const sx = await enableTrading(env);
  const { page } = env;
  const { t } = await ready(page);
  const lev = () => sx.writes.filter((w) => w.path === '/api/v1/perps/trade/leverage');

  // The popover: a preset, the slider and the typed multiplier agree, then Confirm.
  await t.leverage.click();
  const pop = page.getByRole('dialog', { name: 'Leverage' });
  await pop.waitFor({ state: 'visible' });
  const max = num((await pop.textContent())?.match(/max (\d+)x/)?.[1] ?? '');
  assert.ok(max >= 10, `the market's maximum is shown (${max}x)`);
  await typeInto(pop.getByRole('textbox', { name: 'Leverage multiplier' }), String(max + 50));
  await waitValue(pop.getByRole('textbox', { name: 'Leverage multiplier' }), (v) => num(v) === max, 'clamped to the maximum');
  await pop.getByRole('button', { name: '5x', exact: true }).click();
  assert.equal(await pop.getByRole('slider', { name: 'Leverage slider' }).inputValue(), '5');
  await pop.getByRole('button', { name: 'Confirm 5x' }).click();
  await waitValue(t.leverage, (v) => v === '5x', '5x on the ticket');
  await until(page, () => lev().length === 1, 'the leverage change to be sent');
  const a = lev()[0]!;
  assert.equal(sx.signer(a), sx.keys[0]!.publicKey, 'signed by the trading key');
  const body = a.body as { accountID: number; symbolID: number; leverage: number; marginMode: number };
  assert.equal(body.leverage, 5);
  assert.equal(body.marginMode, 2, 'cross');

  // Margin mode: Isolated, sent with the same leverage.
  await t.g.getByRole('button', { name: 'Cross', exact: true }).click();
  const mm = page.getByRole('dialog', { name: 'Margin mode' });
  await mm.getByRole('button', { name: /^Isolated/ }).click();
  await t.g.getByRole('button', { name: 'Isolated', exact: true }).waitFor({ state: 'visible' });
  await until(page, () => lev().length === 2, 'the margin mode change');
  assert.deepEqual([(lev()[1]!.body as typeof body).leverage, (lev()[1]!.body as typeof body).marginMode], [5, 1], 'isolated at 5x');

  // The next order says isolated in its review.
  const last = await t.ready();
  await t.limit(Math.round(last * 0.6), 0.001);
  await sideButton(page).click();
  const review = page.getByRole('dialog', { name: /^Review order/ });
  await review.waitFor({ state: 'visible' });
  assert.match((await review.textContent()) ?? '', /isolated 5x/);
  await review.getByRole('button', { name: 'Back to ticket' }).click();
});

h.test('sizing with a balance: MAX and the percentage are balance x leverage at the price; USDC sizes convert to the coin', async (env) => {
  const sx = await enableTrading(env, { balance: 1_000 });
  const { page } = env;
  const { t } = await ready(page);
  await t.limit(50_000, 0.001);
  await t.setLeverage(10);
  // 100 % of $1,000 at 10x = $10,000 of BTC at 50,000 = 0.2.
  await t.max.click();
  await waitValue(t.amount, (v) => Math.abs(num(v) - 0.2) < 0.0005, 'MAX = 0.2 BTC');
  await typeInto(t.pct, '25');
  await waitValue(t.amount, (v) => Math.abs(num(v) - 0.05) < 0.0005, '25 % = 0.05 BTC');
  // In USDC: 500 USDC at 50,000 is 0.01 BTC on the wire.
  await t.setUnit('USDC');
  await typeInto(t.amount, '500');
  const w = await placeViaReview(page, sx);
  assert.equal(Number(legsOf(w)[0]!.quantity), 0.01, 'the order is sized in the coin');
});

h.test('spot: Buy / Sell, Market and Limit only, no leverage or TP/SL; a spot order is a batch on the spot engine', async (env) => {
  const sx = await enableTrading(env);
  const { page } = env;
  const kind = page.getByRole('radiogroup', { name: 'Market type' });
  if (await kind.isVisible().catch(() => false)) await kind.getByRole('radio', { name: 'Spot', exact: true }).click();
  else {
    // A phone's bar has no Futures / Spot switch: a spot market is picked in the market search.
    await pickMarket(page, 'BTC', 'spot');
    await page.getByRole('button', { name: /spot: change market$/ }).first().waitFor({ state: 'visible', timeout: 20_000 });
  }
  const t = ticket(page);
  const dir = t.g.getByRole('radiogroup', { name: 'Direction' });
  await dir.getByRole('radio', { name: 'Buy', exact: true }).waitFor({ state: 'visible' });
  const tabs = (await t.g.getByRole('tablist', { name: 'Order type' }).getByRole('tab').allTextContents()).map((s) => s.trim());
  assert.deepEqual(tabs, ['Market', 'Limit'], 'spot has market and limit');
  assert.equal(await t.exits.count(), 0, 'no TP/SL on spot');
  assert.equal(await t.leverage.count(), 0, 'no leverage on spot');
  const last = await t.ready();
  await dir.getByRole('radio', { name: 'Buy', exact: true }).check();
  const price = Math.round(last * 0.6);
  await typeInto(t.price, String(price));
  await typeInto(t.amount, dec(0.001));
  await until(page, async () => ((await sideButton(page).textContent()) ?? '') === 'Buy', 'the Buy button');
  const w = await placeViaReview(page, sx);
  assert.equal(w.path, '/api/v1/spot/trade/orders/batch');
  assert.equal(sx.signer(w), sx.keys[0]!.publicKey, 'signed by the same trading key (registered on spot too)');
  const o = (w.body as OrderBody).orders[0]! as Leg & { symbolID: number };
  assert.equal(o.side, 1);
  assert.equal(o.type, 1);
  assert.equal(Number(o.price), price);
  assert.equal(Number(o.quantity), 0.001);
  await toast(page, /^Limit buy placed/).waitFor({ state: 'visible' });
}, { timeout: 120_000 });
