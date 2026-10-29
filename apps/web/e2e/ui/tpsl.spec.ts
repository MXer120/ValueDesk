/**
 * TP/SL on the order ticket (OrderEntry.tsx, exitEntry.ts): Gain and Loss in $ and %,
 * for a long and a short. A limit order is used throughout: its entry is its own price,
 * so every expected trigger is exact arithmetic.
 *
 *   $   TP = entry ± Gain / size,  SL = entry ∓ Loss / size   (+ for a long)
 *   %   return on margin: the amount is pct/100 × entry × size / leverage
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { connectWallet, dec, num, typeInto, uiSuite, until, waitValue } from './harness';
import { ticket, toast } from './ticket';

const h = uiSuite(import.meta.filename);

async function withExits(page: Page, side: 'Long' | 'Short', price = 80_000, amount = 0.01) {
  const t = ticket(page);
  await t.ready();
  await t.limit(price, amount, side);
  await t.exits.check();
  await t.tp.waitFor({ state: 'visible' });
  return t;
}

const priceOf = async (loc: import('playwright-core').Locator, want: number, what: string) =>
  num(await waitValue(loc, (v) => num(v) === want, `${what} = ${want}`));

h.test('long, in $: Gain and Loss are sizes - the stop lands below entry', async ({ page }) => {
  const t = await withExits(page, 'Long');
  await typeInto(t.gain, '100');
  await priceOf(t.tp, 90_000, 'TP');
  await typeInto(t.loss, '100');
  // "Loss 100" is a $100 loss: below a long's entry, never next to the take-profit (owner's report, 2026-10-29).
  await priceOf(t.sl, 70_000, 'SL');
  // Typing a price shows the amount it means, as a size with no sign.
  await typeInto(t.sl, '75000');
  await waitValue(t.loss, (v) => num(v) === 50, 'Loss 50');
  await typeInto(t.tp, '85000');
  await waitValue(t.gain, (v) => num(v) === 50, 'Gain 50');
  // A minus sign is not part of a size: the field takes the digits.
  await typeInto(t.loss, '-30');
  await priceOf(t.sl, 77_000, 'SL for a loss of 30');
});

h.test('short, in $: the take-profit is below entry and the stop above', async ({ page }) => {
  const t = await withExits(page, 'Short');
  await typeInto(t.gain, '100');
  await priceOf(t.tp, 70_000, 'TP');
  await typeInto(t.loss, '50');
  await priceOf(t.sl, 85_000, 'SL');
});

h.test('in %: return on the margin the order ties up, for a long and a short', async ({ page }) => {
  const t = await withExits(page, 'Long');
  const lev = num(await t.value(t.leverage));
  assert.ok(lev > 0, 'a leverage is shown');
  await t.toPct.click();
  await t.toUsd.waitFor({ state: 'visible' });
  // 50 % of 80000 × 0.01 / lev, over 0.01 BTC, above entry.
  await typeInto(t.gain, '50');
  await priceOf(t.tp, 80_000 + (0.5 * 800) / lev / 0.01, 'TP at +50 %');
  await typeInto(t.loss, '25');
  await priceOf(t.sl, 80_000 - (0.25 * 800) / lev / 0.01, 'SL at -25 %');

  await t.direction('Short').check();
  await priceOf(t.tp, 80_000 - (0.5 * 800) / lev / 0.01, 'a short TP at +50 %');
  await priceOf(t.sl, 80_000 + (0.25 * 800) / lev / 0.01, 'a short SL at -25 %');

  // Back to $: the same triggers, read as money.
  await t.toUsd.click();
  await waitValue(t.gain, (v) => num(v) === (0.5 * 800) / lev, 'Gain in $');
});

h.test('a typed Gain/Loss is held: the trigger follows entry, size and leverage; a typed price lets go', async ({ page }) => {
  const t = await withExits(page, 'Long');
  await typeInto(t.gain, '100');
  await typeInto(t.loss, '50');
  await priceOf(t.tp, 90_000, 'TP');
  await priceOf(t.sl, 75_000, 'SL');

  // Entry moves: the same $100 / $50, solved again.
  await typeInto(t.price, '70000');
  await priceOf(t.tp, 80_000, 'TP after the entry moved');
  await priceOf(t.sl, 65_000, 'SL after the entry moved');

  // Size doubles: half the distance.
  await typeInto(t.amount, dec(0.02));
  await priceOf(t.tp, 75_000, 'TP after the size doubled');
  await priceOf(t.sl, 67_500, 'SL after the size doubled');

  // Leverage moves a % exit (return on margin), not a $ one.
  await typeInto(t.amount, dec(0.01));
  await typeInto(t.price, '80000');
  await t.toPct.click();
  await typeInto(t.gain, '50');
  await t.setLeverage(10);
  await priceOf(t.tp, 80_000 + (0.5 * 800) / 10 / 0.01, 'TP at +50 % on 10x');
  await t.setLeverage(20);
  await priceOf(t.tp, 80_000 + (0.5 * 800) / 20 / 0.01, 'TP at +50 % on 20x');

  // A typed trigger price is not held: the entry moving leaves it where it was typed.
  await typeInto(t.tp, '95000');
  await typeInto(t.price, '81000');
  await page.waitForTimeout(500);
  assert.equal(num(await t.value(t.tp)), 95_000);
});

h.test('a wrong-side TP or SL is a notification, not a line on the ticket', async ({ page }) => {
  const t = await withExits(page, 'Long');
  // A long's take-profit under its entry.
  await typeInto(t.tp, '70000');
  await toast(page, 'Take profit is at or below entry — it would trigger immediately.').waitFor({ state: 'visible' });
  assert.equal(await t.hints.filter({ hasText: 'trigger immediately' }).count(), 0, 'not said inline');
  await typeInto(t.tp, '');

  // A long's stop-loss over its entry.
  await typeInto(t.sl, '85000');
  await toast(page, 'Stop loss is at or above entry — it would trigger immediately.').waitFor({ state: 'visible' });
  assert.equal(await t.hints.filter({ hasText: 'trigger immediately' }).count(), 0, 'not said inline');

  // The same prices are right for a short: no new notification.
  await page.locator('.toasts .toast__x').evaluateAll((xs) => xs.forEach((x) => (x as HTMLButtonElement).click()));
  await until(page, async () => (await toast(page, 'trigger immediately').count()) === 0, 'the notifications to clear');
  await t.direction('Short').check();
  await typeInto(t.tp, '70000');
  await page.waitForTimeout(1_200);
  assert.equal(await toast(page, 'trigger immediately').count(), 0, 'a short TP below entry and SL above it are right');

  // A short's take-profit over its entry.
  await typeInto(t.tp, '90000');
  await toast(page, 'Take profit is at or above entry — it would trigger immediately.').waitFor({ state: 'visible' });
});

h.test('a Stop order on the wrong side of the market is a notification', async ({ page }) => {
  const t = ticket(page);
  const last = await t.ready();
  await t.type('Stop');
  await t.direction('Long').check();
  await typeInto(t.amount, dec(0.001));
  // A buy stop-loss (closing a short, a breakout entry) triggers ABOVE the market: under it, it fires at once.
  const under = Math.round(last * 0.9);
  await typeInto(t.trigger, String(under));
  await toast(page, `A buy stop-loss triggers above the market`).waitFor({ state: 'visible' });
  assert.equal(await t.hints.filter({ hasText: 'trigger immediately' }).count(), 0, 'not said inline');

  // Over the market it is where it belongs: nothing new.
  await page.locator('.toasts .toast__x').evaluateAll((xs) => xs.forEach((x) => (x as HTMLButtonElement).click()));
  await until(page, async () => (await toast(page, 'triggers above the market').count()) === 0, 'the notification to clear');
  await typeInto(t.trigger, String(Math.round(last * 1.1)));
  await page.waitForTimeout(1_200);
  assert.equal(await toast(page, 'trigger immediately').count(), 0);

  // A buy take-profit is the other way round: over the market it fires at once.
  await t.kind.selectOption('tp');
  await toast(page, 'A buy take-profit triggers below the market').waitFor({ state: 'visible' });
});

h.test('the review sheet shows the order and its exits, and Back to ticket sends nothing', async ({ page, wallet }) => {
  await connectWallet(page);
  const t = ticket(page);
  await t.ready();
  // Enable trading: the one wallet signature that registers a trading key (and the builder approval, if asked).
  const enable = t.g.getByRole('button', { name: 'Enable trading' });
  if (await enable.isVisible()) {
    await enable.click();
    await until(page, async () => !(await enable.isVisible()), 'trading to be enabled', 90_000);
  }
  const last = await t.ready();
  const price = Math.round(last * 0.6);
  await t.limit(price, 0.001);
  await t.exits.check();
  await typeInto(t.gain, '5');
  await typeInto(t.loss, '5');
  const before = wallet.mark();
  await t.g.locator('.oe-side__btn').click();
  const review = page.getByRole('dialog', { name: /^Review order/ });
  await review.waitFor({ state: 'visible' });
  const text = (await review.textContent()) ?? '';
  for (const want of ['Size', 'Entry (limit)', 'Order value', 'Margin required', 'Est. liquidation', 'Est. entry fee', 'Exits', 'Take profit', 'Stop loss']) {
    assert.ok(text.includes(want), `the review shows ${want}`);
  }
  await review.getByRole('button', { name: 'Back to ticket' }).click();
  await review.waitFor({ state: 'hidden' });
  assert.deepEqual(wallet.since(before), [], 'nothing was signed from the review');
  assert.equal(num(await t.value(t.price)), price, 'the ticket is as it was');
}, { live: 'the review opens only with trading enabled, which needs a SoDEX account (VS_E2E_KEY)', timeout: 180_000 });
