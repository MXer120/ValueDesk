/**
 * Trading enabled for the throwaway wallet against the fake SoDEX account
 * (sodexFake.ts): Connect, Enable trading - ValueDesk's terms, the builder fee,
 * the trading key, one wallet signature each - and the order ticket ready.
 * Nothing reaches SoDEX's write routes; see sodexFake.ts.
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { connectWallet, until } from './harness';
import { fakeSodexAccount, type FakeAccountOptions, type FakeSodex } from './sodexFake';
import { ticket } from './ticket';
import type { TestEnv } from './harness';

/** The ticket's one action button (Long / Short / Buy / Sell, or what the gate asks for). */
export const sideButton = (page: Page) => ticket(page).g.locator('.oe-side__btn');

/**
 * Connect, then press Enable trading and answer what it opens: ValueDesk's terms
 * ("Only necessary"), the builder-fee disclosure (Approve). Returns the fake account
 * once the button is a side again.
 */
export async function enableTrading(env: Pick<TestEnv, 'page' | 'ctx' | 'wallet'>, o: FakeAccountOptions = {}): Promise<FakeSodex> {
  const { page, ctx, wallet } = env;
  const sx = await fakeSodexAccount(ctx, wallet.address, o);
  await connectWallet(page);
  const t = ticket(page);
  await t.ready();
  const btn = sideButton(page);
  await until(page, async () => ((await btn.textContent()) ?? '').trim() === 'Enable trading', 'Enable trading on the button', 20_000);
  const mark = wallet.mark();
  await btn.click();
  const site = page.getByRole('dialog', { name: 'Sign the terms to continue' });
  const fee = page.getByRole('dialog', { name: 'Builder fee' });
  await until(page, async () => (await site.isVisible()) || (await fee.isVisible()), 'the terms or the builder fee to be asked', 20_000);
  if (await site.isVisible()) {
    await site.getByRole('checkbox', { name: /^I confirm that/ }).check();
    await site.getByRole('button', { name: 'Only necessary', exact: true }).click();
  }
  await fee.waitFor({ state: 'visible', timeout: 20_000 });
  await fee.getByRole('button', { name: 'Approve', exact: true }).click();
  await until(page, async () => /^(Long|Short|Buy|Sell)$/.test(((await btn.textContent()) ?? '').trim()), 'trading to be enabled', 30_000);
  const signed = wallet.since(mark).map((r) => [r.kind ?? r.method, r.outcome]);
  assert.deepEqual(signed.filter(([k]) => k !== 'site-terms'), [['builder', 'signed'], ['trading-key', 'signed']], `the builder fee, then the trading key (wallet: ${JSON.stringify(signed)})`);
  assert.equal(sx.keys.length, 1, 'one trading key registered');
  return sx;
}

/** The ticket's button pressed, the review opened (when it is shown), Place pressed; the order write returned. */
export async function placeViaReview(page: Page, sx: FakeSodex, o: { review?: boolean } = {}) {
  const before = sx.orders().length;
  await until(page, async () => await sideButton(page).isEnabled(), 'the side button to be enabled');
  await sideButton(page).click();
  if (o.review !== false) {
    const review = page.getByRole('dialog', { name: /^Review order/ });
    await review.waitFor({ state: 'visible' });
    await review.getByRole('button', { name: /^Place (buy \/ long|sell \/ short)$/ }).click();
    await review.waitFor({ state: 'hidden' });
  }
  await until(page, () => sx.orders().length > before, 'the order to be sent', 15_000);
  return sx.orders()[sx.orders().length - 1]!;
}

/** One leg of a perps newOrder body, as the app built it. */
export interface Leg {
  clOrdID: string;
  modifier: number;
  side: number;
  type: number;
  timeInForce: number;
  price?: string;
  quantity?: string;
  reduceOnly?: boolean;
  stopPrice?: string;
  stopType?: number;
  triggerType?: number;
  positionSide?: number;
}
