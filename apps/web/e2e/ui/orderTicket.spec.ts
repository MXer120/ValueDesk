/**
 * The order ticket (src/components/OrderEntry.tsx): the order types, the TIF notes,
 * the size units and MAX. No wallet unless a test says so: nothing here can sign.
 */
import assert from 'node:assert/strict';
import { connectWallet, dec, num, typeInto, uiSuite, until, waitValue } from './harness';
import { ticket } from './ticket';

const h = uiSuite(import.meta.filename);

/** The ticket on BTC-USD futures, its rules loaded; and the last price it started with (the Limit price box's). */
async function btc(page: import('playwright-core').Page) {
  const t = ticket(page);
  const last = await t.ready();
  return { t, last };
}

h.test('Market, Limit and Stop each show their own fields', async ({ page }) => {
  const { t } = await btc(page);
  // Limit: a price, MID, and a TIF to choose.
  assert.ok(await t.price.isVisible(), 'Limit has a Price box');
  assert.ok(await t.mid.isVisible(), 'Limit has MID');
  assert.equal(await t.value(t.tif), 'GTC', 'a new limit is GTC');

  // Market: no price, and the TIF is IOC, fixed (it cannot rest).
  await t.type('Market');
  await until(page, async () => !(await t.price.isVisible()), 'the Price box to go');
  assert.equal(await t.tif.count(), 0, 'no TIF choice for a market order');
  assert.match((await t.g.locator('.oe-compact--fixed').textContent()) ?? '', /TIF\s*IOC/);
  assert.ok(await t.amount.isVisible(), 'Market keeps the amount');

  // Stop: a trigger, its kind, how it executes; a stop-limit adds the limit price.
  await t.type('Stop');
  assert.ok(await t.trigger.isVisible(), 'Stop has a Trigger box');
  assert.equal(await t.kind.inputValue(), 'sl', 'a new stop is a stop-loss');
  assert.equal(await t.executesAs.inputValue(), 'market');
  assert.ok(!(await t.price.isVisible()), 'a stop-market has no limit price');
  await t.executesAs.selectOption('limit');
  await t.price.waitFor({ state: 'visible' });
  assert.ok(await t.tif.isVisible(), 'a stop-limit has a TIF');
  await t.kind.selectOption('tp');
  assert.equal(await t.kind.inputValue(), 'tp');

  // Back to Limit: the price box is there again.
  await t.type('Limit');
  await t.price.waitFor({ state: 'visible' });
});

h.test('GTC says nothing, IOC below the touch says it would cancel, post-only through the touch is refused', async ({ page }) => {
  const { t, last } = await btc(page);
  const far = Math.round(last * 0.5);
  const through = Math.round(last * 1.5);
  await t.limit(far, 0.001);

  // GTC resting below the market: nothing to say.
  assert.equal(await t.hints.count(), 0, 'GTC at a resting price has no note');

  // IOC that cannot fill: said on the ticket, as a plain note (not a refusal).
  await t.pickTif('IOC');
  const ioc = t.hints.filter({ hasText: 'IOC: nothing fills at this price, so it would be cancelled at once.' });
  await ioc.waitFor({ state: 'visible' });
  assert.ok(!(await ioc.evaluate((el) => el.classList.contains('oe-hint--bad'))), 'the IOC note does not block');

  // IOC through the touch fills up to its price: normal, no note (owner, 2026-10-29).
  await typeInto(t.price, String(through));
  await until(page, async () => (await t.hints.count()) === 0, 'the IOC note to go once the limit crosses');

  // Post only through the touch: refused before signing, and the line says why.
  await t.pickTif('GTX');
  const gtx = t.hints.filter({ hasText: 'Post only: at this price it would take, so SoDEX would reject it. Set a price below the best ask.' });
  await gtx.waitFor({ state: 'visible' });
  assert.ok(await gtx.evaluate((el) => el.classList.contains('oe-hint--bad')), 'the post-only note blocks');

  // Post only resting: fine.
  await typeInto(t.price, String(far));
  await until(page, async () => (await t.hints.count()) === 0, 'the post-only note to go at a resting price');

  // A short is judged against the bid.
  await t.direction('Short').check();
  await typeInto(t.price, String(far));
  await t.hints.filter({ hasText: 'Set a price above the best bid.' }).waitFor({ state: 'visible' });
});

h.test('the amount switches between the coin and USDC at the order price', async ({ page }) => {
  const { t } = await btc(page);
  await t.limit(80000, 0.01);
  const coin = await t.unitNow();
  assert.ok(coin && !/USD/.test(coin), `the amount starts in the coin (${coin})`);
  assert.match((await t.unit.getAttribute('aria-label')) ?? '', /^Size in USDC$/, 'the toggle names the unit it switches to');

  await t.unit.click();
  await until(page, async () => (await t.unitNow()) === 'USDC', 'USDC');
  assert.equal(num(await t.value(t.amount)), 800, '0.01 at 80000 is 800 USDC');

  await typeInto(t.amount, '1200');
  await t.unit.click();
  await until(page, async () => (await t.unitNow()) === coin, coin);
  assert.equal(num(await t.value(t.amount)), 0.015, '1200 USDC at 80000 is 0.015');

  // Market sizes at the last price: the same toggle, still a coin amount.
  await t.type('Market');
  assert.equal(await t.unitNow(), coin);
});

h.test('MAX is the whole available balance: 100 %, and no size without a balance', async ({ page }) => {
  const { t } = await btc(page);
  await t.max.click();
  await waitValue(t.pct, (v) => v === '100', 'the percentage box at 100');
  assert.equal(await t.slider.inputValue(), '100');
  // No wallet, so no balance to size from: the amount stays empty rather than inventing one.
  assert.equal(await t.value(t.amount), '');
  // A typed amount wins over the percentage; a typed "." is the decimal mark in the default "1.234,5" format.
  await typeInto(t.amount, '0.002');
  assert.equal(await t.value(t.amount), dec(0.002));
});

h.test('a connected wallet without funds: MAX still sizes nothing, the button asks to create the account', async ({ page }) => {
  await connectWallet(page);
  const { t } = await btc(page);
  await t.max.click();
  await waitValue(t.pct, (v) => v === '100', 'the percentage box at 100');
  await page.waitForTimeout(1_000);
  assert.equal(await t.value(t.amount), '', 'a throwaway wallet has nothing to size from');
  await t.g.getByRole('button', { name: 'Create account' }).waitFor({ state: 'visible' });
}, { throwaway: 'a funded wallet has a balance to size from' });

h.test('MAX sizes to the funded balance', async ({ page }) => {
  await connectWallet(page);
  const { t, last } = await btc(page);
  await typeInto(t.price, String(Math.round(last * 0.5)));
  await t.max.click();
  const amount = await waitValue(t.amount, (v) => num(v) > 0, 'an amount from the balance', 20_000);
  assert.ok(num(amount) > 0);
}, { live: 'needs a funded wallet (VS_E2E_KEY)' });
