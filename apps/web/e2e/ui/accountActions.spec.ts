/**
 * The account tables' own actions on what the order ticket made (components/Account.tsx,
 * TpSlSheet.tsx): Close a position at market, its TP/SL sheet, Cancel a resting order.
 * Against the fake SoDEX account (sodexFake.ts) seeded with one BTC-USD long and one
 * resting limit order: every write is answered in the browser context, never sent.
 */
import assert from 'node:assert/strict';
import { typeInto, uiSuite, until } from './harness';
import { toast } from './ticket';
import { enableTrading, type Leg } from './trade';
import type { FakeWrite } from './sodexFake';

const h = uiSuite(import.meta.filename);

const legs = (w: FakeWrite) => (w.body as { orders: Leg[] }).orders;
const SEED = { position: { symbol: 'BTC-USD', size: '0.01', entry: '70000', leverage: 10 }, openOrder: { symbol: 'BTC-USD', side: 'BUY' as const, price: '40000', quantity: '0.002' } };

h.test('Positions: Close asks first, then sends one reduce-only market sell of the whole position', async (env) => {
  const sx = await enableTrading(env, SEED);
  const { page } = env;
  const activity = page.getByRole('group', { name: 'Account activity' });
  await activity.getByRole('tab', { name: /^Positions/ }).click();
  const close = activity.getByRole('button', { name: 'Close BTC-USD at market' });
  await close.waitFor({ state: 'visible', timeout: 20_000 });
  await close.click();
  const ask = page.getByRole('dialog', { name: 'Close position at market' });
  await ask.waitFor({ state: 'visible' });
  assert.match((await ask.textContent()) ?? '', /SELL market, reduce-only/);
  // Keep position: nothing is sent.
  await ask.getByRole('button', { name: 'Keep position' }).click();
  await ask.waitFor({ state: 'hidden' });
  assert.equal(sx.orders().length, 0);
  await close.click();
  await ask.getByRole('button', { name: 'Close at market' }).click();
  await until(page, () => sx.orders().length === 1, 'the close order');
  const w = sx.orders()[0]!;
  assert.equal(sx.signer(w), sx.keys[0]!.publicKey);
  const [o] = legs(w);
  assert.deepEqual([o!.side, o!.type, o!.reduceOnly, Number(o!.quantity)], [2, 2, true, 0.01], 'sell 0.01 at market, reduce-only');
});

h.test('Positions: the TP/SL sheet sends position exits (stops, reduce-only) on the right sides', async (env) => {
  const sx = await enableTrading(env, SEED);
  const { page } = env;
  const activity = page.getByRole('group', { name: 'Account activity' });
  await activity.getByRole('tab', { name: /^Positions/ }).click();
  const edit = activity.getByRole('button', { name: 'Edit TP/SL on BTC-USD' });
  await edit.waitFor({ state: 'visible', timeout: 20_000 });
  await edit.click();
  const sheet = page.getByRole('dialog', { name: 'Take Profit & Stop Loss' });
  await sheet.waitFor({ state: 'visible' });
  const confirm = sheet.getByRole('button', { name: 'Confirm', exact: true });
  // A long's take-profit under the mark is refused before anything is sent; the sheet says where it must be.
  await typeInto(sheet.getByRole('textbox', { name: 'Take Profit price' }), '60000');
  await sheet.getByText('Above the mark.', { exact: true }).waitFor({ state: 'visible' });
  assert.ok(await confirm.isDisabled());
  await typeInto(sheet.getByRole('textbox', { name: 'Take Profit price' }), '150000');
  await typeInto(sheet.getByRole('textbox', { name: 'Stop Loss price' }), '50000');
  await until(page, async () => await confirm.isEnabled(), 'Confirm');
  await confirm.click();
  await until(page, () => sx.orders().length >= 1, 'the exits to be sent');
  const all = sx.orders().flatMap(legs);
  const tp = all.find((l) => l.stopType === 2);
  const sl = all.find((l) => l.stopType === 1);
  assert.ok(tp && sl, `a take-profit and a stop-loss (${JSON.stringify(all)})`);
  for (const [leg, px] of [[tp!, 150_000], [sl!, 50_000]] as const) {
    assert.equal(leg.side, 2, 'they sell: the position is long');
    assert.equal(leg.reduceOnly, true, 'they only close');
    assert.equal(Number(leg.stopPrice), px);
  }
});

h.test('Open orders: Cancel sends one cancel for that order; Cancel all asks first', async (env) => {
  const sx = await enableTrading(env, SEED);
  const { page } = env;
  const activity = page.getByRole('group', { name: 'Account activity' });
  await activity.getByRole('tab', { name: /^Open Orders/ }).click();
  const row = activity.locator('tbody tr').filter({ hasText: 'BTC' }).first();
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  // Cancel all: asked first, "Keep them" sends nothing.
  await activity.getByRole('button', { name: 'Cancel all', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Cancel all perps orders' });
  await ask.waitFor({ state: 'visible' });
  await ask.getByRole('button', { name: 'Keep them' }).click();
  await ask.waitFor({ state: 'hidden' });
  const mark = sx.mark();
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await until(page, () => sx.since(mark).some((w) => w.method === 'DELETE'), 'the cancel');
  const w = sx.since(mark).find((w) => w.method === 'DELETE')!;
  assert.equal(w.path, '/api/v1/perps/trade/orders');
  assert.equal(sx.signer(w), sx.keys[0]!.publicKey);
  assert.match(w.raw, /777001|e2e-resting-1/, 'the cancel names that order');
  await toast(page, /BTC-USD long cancelled|cancelled/).first().waitFor({ state: 'visible' });
});
