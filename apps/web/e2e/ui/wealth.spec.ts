/**
 * Wealth on a fake SoDEX account (sodexFake.ts answers every write; NOTHING reaches SoDEX's writes, the wallet signs
 * no transaction): creating an index is early access; a custom index of the SSI spot tokens is made through Details &
 * Review and bought, one market order per leg for its share of the amount; ValueDesk's own index either sends one
 * order per leg or, while SoDEX has its funds paused, refuses before anything is sent; a subscription (USDC Earn)
 * goes no further than the wallet's prompt for its transaction.
 *
 *   npx tsx e2e/ui/run.ts --only wealth --viewport desktop
 */
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright-core';
import { connectWallet, typeInto, uiSuite, until } from './harness';
import { enableTrading } from './trade';
import type { FakeWrite } from './sodexFake';

const h = uiSuite(import.meta.filename);

/** The early-access list as server 1 answers it for this wallet. */
const listed = (ctx: BrowserContext, on: boolean) => ctx.route(/\/api\/vs\/beta\/listed/, (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, listed: on, bots: on }),
}));

/** The dev build's dock and toasts float over the page (none is in production). */
const clearOverlays = (p: Page) => p.addStyleTag({ content: '[aria-label="Developer"], .toast, .pfv-switch, .wv-switch { display: none !important; }' });

/** The spot orders in these writes: market id, side (1 buy, 2 sell), funds or quantity. */
const spotOrders = (ws: FakeWrite[]) => ws
  .filter((w) => w.engine === 'spot' && w.method === 'POST' && /\/trade\/orders(\/batch)?$/.test(w.path))
  .flatMap((w) => ((w.body as { orders?: unknown[] }).orders ?? [w.body]) as Array<{ symbolID: number; side: number; type: number; funds?: string; quantity?: string }>);

const go = async (p: Page, origin: string, path: string) => {
  await p.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')); }, path);
  await p.waitForURL((u) => u.pathname === path.split('?')[0], { timeout: 10_000 });
  void origin;
};

h.test('creating an index is early access: a wallet off the list sees the lock, not the builder', async ({ page: p, ctx, origin }) => {
  await listed(ctx, false);
  await connectWallet(p);
  await go(p, origin, '/wealth/index/new');
  await clearOverlays(p);
  await p.getByText('Creating indexes is in early access').waitFor({ timeout: 20_000 });
  assert.ok(await p.getByRole('button', { name: 'Get access' }).isVisible(), 'Get access offered');
  assert.equal(await p.getByRole('button', { name: 'Details & Review' }).count(), 0, 'no builder');
});

h.test('a custom SSI index: Details & Review, Create, then bought as one market order per leg', async ({ page: p, ctx, wallet, origin }) => {
  await listed(ctx, true);
  const sx = await enableTrading({ page: p, ctx, wallet }, { spot: { vUSDC: 100 }, balance: 0, stateful: true });
  await go(p, origin, '/wealth/index/new');
  await clearOverlays(p);
  await p.getByRole('heading', { name: 'Create an index' }).waitFor({ timeout: 20_000 });
  await typeInto(p.locator('#wp-name'), 'Crypto pair');
  const search = p.getByRole('searchbox', { name: 'Search funds' });
  for (const [q, name] of [['MAG7', /MAG7\.ssi/], ['DEFI', /DEFI\.ssi/]] as const) {
    await search.fill(q);
    await p.locator('.wp-pick__row').filter({ hasText: name }).first().click();
  }
  await p.getByRole('button', { name: 'Equal' }).click();
  // Review first: every fund and what it holds, then the two ways to make it.
  await p.getByRole('button', { name: 'Details & Review' }).click();
  await p.getByRole('heading', { name: 'Crypto pair' }).waitFor({ timeout: 10_000 });
  assert.equal(await p.locator('.wp-leg').count(), 2, 'both constituents listed');
  const publish = p.locator('.wp-review__opt').filter({ hasText: 'Publish' });
  assert.ok(await publish.getByText('Coming soon').isVisible(), 'Publish is coming soon');
  assert.ok(await publish.getByRole('button', { name: 'Publish' }).isDisabled(), 'Publish cannot be pressed');
  await p.getByRole('button', { name: 'Create index' }).click();
  await p.waitForURL(/\/wealth\/index\//, { timeout: 10_000 });

  // Buy $20: $10 of each, each a spot market order in USDC.
  const amount = p.locator('#it-amt');
  await amount.waitFor({ timeout: 20_000 });
  await until(p, async () => /\$100/.test((await p.locator('.oe-out').innerText()) || ''), 'the Spot balance to be read', 20_000);
  await typeInto(amount, '20');
  const buy = p.getByRole('button', { name: 'Buy 2 funds' });
  await until(p, () => buy.isEnabled(), 'Buy to be pressable', 10_000);
  const mark = sx.mark();
  await buy.click();
  await p.getByText('Every leg was sent.').waitFor({ timeout: 20_000 });
  const orders = spotOrders(sx.since(mark));
  assert.deepEqual(orders.map((o) => o.symbolID).sort((a, b) => a - b), [3, 24], `MAG7.ssi (3) and DEFI.ssi (24): ${JSON.stringify(orders)}`);
  for (const o of orders) {
    assert.equal(o.side, 1, 'a buy');
    assert.equal(Number(o.funds), 10, `$10 each: ${JSON.stringify(o)}`);
  }
  assert.equal(wallet.log.filter((r) => r.method === 'eth_sendTransaction').length, 0, 'no transaction asked of the wallet');
});

h.test('ValueDesk Balanced: one order per leg, or refused before anything is sent while SoDEX has it paused', async ({ page: p, ctx, wallet, origin }) => {
  const sx = await enableTrading({ page: p, ctx, wallet }, { spot: { vUSDC: 500 }, balance: 0, stateful: true });
  await go(p, origin, '/wealth/index/balanced');
  await clearOverlays(p);
  const amount = p.locator('#it-amt');
  await amount.waitFor({ timeout: 20_000 });
  await typeInto(amount, '100');
  const legs = p.locator('.it-legs > li');
  await until(p, async () => (await legs.count()) >= 2, 'the legs', 10_000);
  const buy = p.locator('.oe-side__btn.is-buy');
  const err = p.locator('.it-err');
  const mark = sx.mark();
  // Once SoDEX's status and the balances are read: refused with its reason (a paused fund, too little USDC in the
  // wallet for the subscription legs), or open.
  await until(p, async () => (await err.count()) > 0 || (await buy.isEnabled()), 'the ticket to decide', 20_000);
  if (await err.count()) {
    const why = await err.first().innerText();
    assert.match(why, /temporarily unavailable|Coming soon|Not enough USDC|starts at/i, `a reason: ${why}`);
    assert.ok(await buy.isDisabled(), `Buy cannot be pressed: ${why}`);
    await p.waitForTimeout(500);
    assert.equal(spotOrders(sx.since(mark)).length, 0, 'nothing sent');
    assert.equal(wallet.log.filter((r) => r.method === 'eth_sendTransaction').length, 0, 'no transaction asked');
    console.log(`ui-e2e: wealth: Balanced refused before sending: ${why.replace(/\s+/g, ' ')}`);
    return;
  }
  // Open: any subscription leg stops at the wallet (refused here); order-book legs are orders.
  await buy.click();
  await until(p, async () => (await p.locator('.it-ok, .it-err').count()) > 0, 'the buy to finish', 30_000);
  assert.ok(spotOrders(sx.since(mark)).every((o) => o.side === 1), 'only buys');
});

h.test('USDC Earn: Subscribe goes no further than the wallet prompt for its transaction', async ({ page: p, ctx, wallet, origin }) => {
  void ctx;
  await connectWallet(p);
  await go(p, origin, '/wealth/fund/Morpho-Earn');
  await clearOverlays(p);
  const sub = p.getByRole('button', { name: /^Subscribe/ }).first();
  await sub.waitFor({ timeout: 20_000 });
  await sub.click();
  const sheet = p.getByRole('dialog').last();
  await sheet.waitFor({ timeout: 10_000 });
  // A throwaway wallet holds no USDC: the sheet says so and asks nothing of the wallet.
  const before = wallet.log.length;
  const txt = await sheet.innerText();
  assert.ok(/USDC/.test(txt), 'the sheet names USDC');
  assert.equal(wallet.log.slice(before).filter((r) => r.method === 'eth_sendTransaction' && r.outcome !== 'refused').length, 0, 'no transaction sent');
});

// --- real money (--live): the funded test wallet ---------------------------------------------------------------------

/** The wallet's free spot balances on SoDEX itself, by coin (read from Node, not through the page). */
async function spotState(address: string): Promise<Map<string, number>> {
  const r = await fetch(`https://mainnet-gw.sodex.dev/api/v1/spot/accounts/${address}/state`);
  const j = (await r.json()) as { data?: { B?: Array<{ a: string; t?: string; wb?: string; l?: string }> } };
  return new Map((j.data?.B ?? []).map((x) => [x.a, Number(x.t ?? x.wb ?? 0) - Number(x.l ?? 0)]));
}

/**
 * Enable trading for real from the index ticket where it is not yet (the ticket's own Enable trading): the trading key,
 * and the terms or builder fee if SoDEX asks. Waits for the ticket to know first (it may still be restoring a key).
 */
async function liveTrading(p: Page) {
  const btn = p.locator('.it .oe-side__btn');
  await until(p, async () => !/Checking trading/.test((await btn.first().textContent()) ?? ''), 'the trading key to be checked', 30_000);
  const enable = p.locator('.it').getByRole('button', { name: 'Enable trading' });
  if (!(await enable.isVisible())) return false;
  await enable.click();
  const site = p.getByRole('dialog', { name: 'Sign the terms to continue' });
  const fee = p.getByRole('dialog', { name: 'Builder fee' });
  for (let i = 0; i < 90 && (await enable.isVisible()); i++) {
    if (await site.isVisible()) {
      await site.getByRole('checkbox', { name: /^I confirm that/ }).check();
      await site.getByRole('button', { name: 'Only necessary', exact: true }).click();
    }
    if (await fee.isVisible()) await fee.getByRole('button', { name: 'Approve', exact: true }).click();
    await p.waitForTimeout(1_000);
  }
  assert.ok(!(await enable.isVisible()), 'trading enabled from the index ticket');
  return true;
}

h.test('LIVE: a custom SSI index bought for $12 and sold back, nothing left but dust', async ({ page: p, ctx, wallet, origin }) => {
  await listed(ctx, true);
  const before = await spotState(wallet.address);
  const usdc0 = before.get('vUSDC') ?? 0;
  assert.ok(usdc0 >= 13, `at least $13 in Spot (${usdc0})`);
  await connectWallet(p);
  await go(p, origin, '/wealth/index/new');
  await clearOverlays(p);
  await typeInto(p.locator('#wp-name'), 'Live test pair');
  const search = p.getByRole('searchbox', { name: 'Search funds' });
  for (const [q, name] of [['MAG7', /MAG7\.ssi/], ['DEFI', /DEFI\.ssi/]] as const) {
    await search.fill(q);
    await p.locator('.wp-pick__row').filter({ hasText: name }).first().click();
  }
  await p.getByRole('button', { name: 'Equal' }).click();
  await p.getByRole('button', { name: 'Details & Review' }).click();
  await p.getByRole('button', { name: 'Create index' }).click();
  await p.waitForURL(/\/wealth\/index\//, { timeout: 10_000 });

  const amount = p.locator('#it-amt');
  await amount.waitFor({ timeout: 20_000 });
  await typeInto(amount, '12');
  const enabled = await liveTrading(p);
  console.log(`ui-e2e: wealth LIVE: ${enabled ? 'enabled trading from the index ticket' : 'trading was already enabled'}`);
  const buy = p.getByRole('button', { name: 'Buy 2 funds' });
  await until(p, () => buy.isEnabled(), 'Buy to be pressable', 20_000);
  await buy.click();
  await until(p, async () => (await p.locator('.it-ok, .it-err').count()) > 0, 'the buy to finish', 60_000);
  const buyErr = (await p.locator('.it-err').count()) ? await p.locator('.it-err').first().innerText() : null;
  let mid = await spotState(wallet.address);
  for (let i = 0; i < 20 && !((mid.get('vMAG7.ssi') ?? 0) > (before.get('vMAG7.ssi') ?? 0) && (mid.get('vDEFI.ssi') ?? 0) > (before.get('vDEFI.ssi') ?? 0)); i++) {
    await p.waitForTimeout(1_000);
    mid = await spotState(wallet.address);
  }
  const got = { mag7: (mid.get('vMAG7.ssi') ?? 0) - (before.get('vMAG7.ssi') ?? 0), defi: (mid.get('vDEFI.ssi') ?? 0) - (before.get('vDEFI.ssi') ?? 0), usdc: usdc0 - (mid.get('vUSDC') ?? 0) };
  console.log(`ui-e2e: wealth LIVE bought: ${JSON.stringify(got)}${buyErr ? ` (ticket: ${buyErr})` : ''}`);

  // Sell everything back through the ticket's Sell tab, whatever the buy left.
  await p.getByRole('tab', { name: 'Sell' }).click();
  await p.locator('.it-pcts').getByRole('button', { name: 'All' }).click();
  const sell = p.getByRole('button', { name: 'Sell 100% of each' });
  await until(p, () => sell.isEnabled(), 'Sell to be pressable (the SSI balances read)', 30_000);
  await sell.click();
  await p.waitForTimeout(3_000);
  let after = await spotState(wallet.address);
  for (let i = 0; i < 20 && ((after.get('vMAG7.ssi') ?? 0) - (before.get('vMAG7.ssi') ?? 0) > 0.011 || (after.get('vDEFI.ssi') ?? 0) - (before.get('vDEFI.ssi') ?? 0) > 0.011); i++) {
    await p.waitForTimeout(1_000);
    after = await spotState(wallet.address);
  }
  const sellErr = (await p.locator('.it-err').count()) ? await p.locator('.it-err').first().innerText() : null;
  const left = { mag7: (after.get('vMAG7.ssi') ?? 0) - (before.get('vMAG7.ssi') ?? 0), defi: (after.get('vDEFI.ssi') ?? 0) - (before.get('vDEFI.ssi') ?? 0) };
  const cost = usdc0 - (after.get('vUSDC') ?? 0);
  console.log(`ui-e2e: wealth LIVE round trip: cost $${cost.toFixed(4)} (fees + spread), left ${JSON.stringify(left)}${sellErr ? ` (ticket: ${sellErr})` : ''}`);
  assert.equal(buyErr, null, `the buy went through: ${buyErr}`);
  assert.ok(got.mag7 > 0 && got.defi > 0, 'both legs filled');
  assert.ok(left.mag7 <= 0.011 && left.defi <= 0.011, `sold back to dust (one 0.01 step at most): ${JSON.stringify(left)}`);
  assert.ok(cost >= 0 && cost < 0.1, `cheap: $${cost.toFixed(4)}`);
}, { live: 'spends about 2 cents of the funded wallet (VS_E2E_KEY)', timeout: 300_000 });
