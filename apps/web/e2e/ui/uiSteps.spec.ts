/**
 * The live suite's UI steps (uiSteps.ts), offline: the very steps the browser target clicks
 * with real money (apps/executor/tools/live-test/scenarios/ui.ts), against the fake SoDEX
 * account in its stateful form (sodexFake.ts: orders rest and fill, stops rest, leverage is
 * kept; nothing reaches SoDEX's write routes) and a fake leader whose trades are printed on
 * the routed public stream, as SoDEX prints them.
 *
 *   ticket.limit-cancel    a limit 2% under the bid rests; the open orders' Cancel takes it off
 *   ticket.market-close    a market buy fills into the position; the positions' Close sells it reduce-only
 *   ticket.tpsl            a market buy with TP/SL: two reduce-only stops at the prices the ticket shows; Close
 *   ticket.leverage        the popover's leverage and margin mode, sent and kept; set back
 *   copy.ui-close          a copy from the copy window follows the leader; Manage copies' Close closes it
 *   copy.ui-confirm        "Ask before each trade": the prompt's Copy it sends, Skip does not
 *   algo.ui-cancel-exits   a bracket from the algo ticket; the Algos table pulls its exits
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { copy } from './copy';
import { uiSuite, until, type TestEnv } from './harness';
import type { FakeSodex, FakeWrite } from './sodexFake';
import { ticket, toast } from './ticket';
import { enableTrading, type Leg } from './trade';
import { UI_STEPS, inApp } from './uiSteps';

const h = uiSuite(import.meta.filename);

const SYM = 'BTC-USD';
/** A leader wallet SoDEX never saw: the fake answers its reads and prints its trades. */
const LEADER = '0x' + '5e'.repeat(20);
const legs = (w: FakeWrite) => (w.body as { orders: Leg[] }).orders;

/** The ticket's last price, and a size of about $12 (SoDEX's $10 minimum plus 20%) in BTC's 0.00001 steps. */
async function sizes(page: Page): Promise<{ last: number; qty: number }> {
  const last = await ticket(page).ready();
  return { last, qty: Math.ceil(12 / last / 0.00001) * 0.00001 };
}
const round5 = (n: number) => Number(n.toFixed(5));

async function trading(env: TestEnv, leader = false): Promise<FakeSodex> {
  return enableTrading(env, { stateful: true, ...(leader ? { leader: { address: LEADER } } : {}) });
}

h.test('ticket.limit-cancel: a limit 2% under the bid rests at the price typed; the open orders\' Cancel takes it off', async (env) => {
  const sx = await trading(env);
  const { page } = env;
  const { last, qty } = await sizes(page);
  const price = Math.floor(last * 0.98);
  const r = await UI_STEPS['ticket.limit'](page, { symbol: SYM, side: 'buy', price, quantity: round5(qty) });
  assert.match(r.review, /BUY \/ LONG/);
  assert.match(r.placed, /^Limit long placed/);
  const [o] = legs(sx.orders()[0]!);
  assert.deepEqual([o!.side, o!.type, o!.timeInForce, Number(o!.price), Number(o!.quantity), o!.reduceOnly], [1, 1, 1, price, round5(qty), false], 'a GTC limit buy at the price and size typed');
  assert.equal(sx.resting(SYM).length, 1, 'it rests');
  const id = sx.resting(SYM)[0]!.orderID;

  const mark = sx.mark();
  await UI_STEPS['orders.cancel'](page, { symbol: SYM, price });
  await until(page, () => sx.since(mark).some((w) => w.method === 'DELETE'), 'the cancel');
  const cancel = sx.since(mark).find((w) => w.method === 'DELETE')!;
  assert.equal(sx.signer(cancel), sx.keys[0]!.publicKey, 'signed by the trading key');
  assert.equal((cancel.body as { cancels: Array<{ orderID?: number }> }).cancels[0]!.orderID, id, 'the cancel names that order');
  assert.equal(sx.resting(SYM).length, 0, 'nothing rests');
  assert.equal(sx.position(SYM), 0, 'nothing filled');
}, { timeout: 120_000 });

h.test('ticket.market-close: a market buy fills into the position; Close (asked first) sells all of it reduce-only', async (env) => {
  const sx = await trading(env);
  const { page } = env;
  const { qty } = await sizes(page);
  const r = await UI_STEPS['ticket.market'](page, { symbol: SYM, side: 'buy', quantity: round5(qty) });
  assert.match(r.review, /market · fills at the book/);
  assert.match(r.placed, /^Market long placed/);
  const [o] = legs(sx.orders()[0]!);
  assert.deepEqual([o!.side, o!.type, o!.timeInForce, o!.reduceOnly], [1, 2, 3, false], 'a market (IOC) buy');
  assert.equal(sx.position(SYM), round5(qty), 'the position is the size typed');

  const r2 = await UI_STEPS['positions.close'](page, { symbol: SYM });
  assert.match(r2.asked, /SELL market, reduce-only/);
  await until(page, () => sx.orders().length === 2, 'the close');
  const [c] = legs(sx.orders()[1]!);
  assert.deepEqual([c!.side, c!.type, c!.reduceOnly, Number(c!.quantity)], [2, 2, true, round5(qty)], 'one reduce-only market sell of the whole position');
  assert.equal(sx.position(SYM), 0, 'flat');
}, { timeout: 120_000 });

h.test('ticket.tpsl: a market buy with TP and SL rests two reduce-only stops at the prices the ticket shows; Close', async (env) => {
  const sx = await trading(env);
  const { page } = env;
  const { last, qty } = await sizes(page);
  const r = await UI_STEPS['ticket.market'](page, { symbol: SYM, side: 'buy', quantity: round5(qty), exits: { movePct: 1 } });
  assert.ok(r.tp !== null && r.sl !== null, 'the ticket showed both prices');
  assert.ok(Math.abs(r.tp! / last - 1.01) < 0.003 && Math.abs(r.sl! / last - 0.99) < 0.003, `1% either side of the entry (TP ${r.tp}, SL ${r.sl}, last ${last}, ${r.leverage}x)`);
  assert.match(r.review, /Take profit/);
  assert.match(r.placed, /\+2 exit orders/);
  const l = legs(sx.orders()[0]!);
  assert.equal(l.length, 3, 'the entry and its two exits in one order');
  const stops = sx.resting(SYM).filter((x) => x.stopType);
  assert.equal(stops.length, 2, 'two stops rest');
  for (const [kind, want] of [['TAKE_PROFIT', r.tp], ['STOP_LOSS', r.sl]] as const) {
    const s = stops.find((x) => x.stopType === kind)!;
    assert.equal(Number(s.stopPrice), want, `the ${kind} at the price the ticket showed`);
    assert.deepEqual([s.side, s.reduceOnly, Number(s.quantity)], ['SELL', true, round5(qty)], `the ${kind} sells the position, reduce-only`);
  }
  await UI_STEPS['positions.close'](page, { symbol: SYM });
  await until(page, () => sx.position(SYM) === 0, 'flat');
  const [c] = legs(sx.orders()[sx.orders().length - 1]!);
  assert.deepEqual([c!.side, c!.reduceOnly], [2, true], 'the close is a reduce-only sell');
}, { timeout: 120_000 });

h.test('ticket.leverage: the popover\'s leverage and the margin mode are sent and kept; set back the same way', async (env) => {
  const sx = await trading(env);
  const { page } = env;
  await ticket(page).ready();
  const lev = () => sx.writes.filter((w) => w.path === '/api/v1/perps/trade/leverage').map((w) => w.body as { leverage: number; marginMode: number });
  const r = await UI_STEPS['ticket.leverage'](page, { symbol: SYM, leverage: 2, marginMode: 'isolated' });
  assert.deepEqual([r.shown, r.mode], ['2x', 'isolated']);
  await until(page, () => sx.leverage(SYM)?.marginMode === 'isolated', 'isolated sent');
  assert.deepEqual(sx.leverage(SYM), { leverage: 2, marginMode: 'isolated' });
  assert.ok(lev().every((b) => b.leverage === 2), `every change carried 2x (${JSON.stringify(lev())})`);
  const back = await UI_STEPS['ticket.leverage'](page, { symbol: SYM, leverage: 1, marginMode: 'cross' });
  assert.deepEqual([back.shown, back.mode], ['1x', 'cross']);
  await until(page, () => sx.leverage(SYM)?.marginMode === 'cross', 'cross sent');
  assert.deepEqual(sx.leverage(SYM), { leverage: 1, marginMode: 'cross' });
}, { timeout: 120_000 });

/**
 * This browser set up for live copies, through the copy window's own steps (as the live
 * suite's bootstrap does through the bridge): the copy terms, the copy fee, the copy key -
 * each one wallet signature, each registered on the fake account. Then the window is closed.
 */
async function browserCopiesReady(env: TestEnv): Promise<void> {
  const { page, wallet } = env;
  await inApp(page, `/copy?address=${LEADER}&venue=sodex&direction=copy`);
  const c = copy(page);
  await c.modal.waitFor({ state: 'visible', timeout: 30_000 });
  await c.next();
  await c.place('This browser').check();
  const review = c.step('Accept the copy trading terms').getByRole('button', { name: 'Review', exact: true });
  if (await review.isVisible()) {
    await review.click();
    for (const s of [/^I am at least 18/, /^I am not a US person/, /^I chose the trader/, /^I have read the copy trading terms/]) await c.modal.getByRole('checkbox', { name: s }).check();
    await c.modal.getByRole('button', { name: 'Sign and accept', exact: true }).click();
    await toast(page, 'Copy trading terms accepted.').waitFor({ state: 'visible', timeout: 30_000 });
  }
  for (const step of ['Approve the copy fee', 'Approve the copy key']) {
    const approve = c.step(step).getByRole('button', { name: 'Approve', exact: true });
    if (await approve.isVisible().catch(() => false)) {
      const m = wallet.mark();
      await approve.click();
      await until(page, () => wallet.since(m).some((r) => r.outcome === 'signed'), `${step}: the wallet's signature`, 30_000);
    }
  }
  const start = c.modal.getByRole('button', { name: 'Start copying', exact: true });
  await until(page, async () => await start.isEnabled(), 'every step of this browser done (Start copying on)', 60_000);
  await page.keyboard.press('Escape');
  await c.modal.waitFor({ state: 'hidden' });
  await inApp(page, '/trade');
}

type CopyRow = { subscription: { id: string; status: string }; positions: Array<{ symbol: string; size: number }> };
const copyView = (page: Page, id: string) => page.evaluate((x) => window.__vsTest!.copier.list().then((l) => l.find((v) => v.subscription.id === x)), id) as Promise<CopyRow | undefined>;

/** The copy is running and its leader seeded (the fake leader's account read), so a print counts. */
async function copyReady(page: Page, sx: FakeSodex, id: string): Promise<void> {
  await until(page, async () => (await copyView(page, id))?.subscription.status === 'active', 'the copy active', 30_000);
  await until(page, () => sx.sockets() > 0, 'the copier\'s stream routed', 30_000);
  await page.waitForTimeout(3_000);
}

h.test('copy.ui-close: a copy from the copy window follows the leader; Manage copies\' Close stops it and sells reduce-only', async (env) => {
  const sx = await trading(env, true);
  const { page } = env;
  const { last } = await sizes(page);
  await browserCopiesReady(env);
  const { id } = await UI_STEPS['copy.start'](page, { leader: LEADER, venue: 'sodex', perTradeUsd: 12, maxLeverage: 2, coins: ['BTC'], isolated: true, allocationUsd: 100 });
  const s = (await page.evaluate((x) => window.__vsTest!.copier.list().then((l) => l.find((v) => v.subscription.id === x)!.subscription.settings), id)) as unknown as Record<string, unknown> & { leader: { address: string } };
  assert.deepEqual([s.leader.address, s.sizingMode, s.fixedNotionalUsd, s.maxLeverage, s.marginMode, s.approval, s.paper, s.assetAllow], [LEADER, 'fixedNotional', 12, 2, 'isolated', 'auto', false, ['BTC']], 'the rules typed in the window');
  await copyReady(page, sx, id);

  sx.leaderTrade(SYM, 'buy', 0.001, last);
  await until(page, () => sx.position(SYM) > 0, 'the copy\'s open filled on the (fake) account', 45_000);
  const open = sx.orders().find((w) => legs(w).some((l) => l.clOrdID.startsWith('vdc-')))!;
  assert.ok(open, 'the copier\'s own order (vdc-)');
  await until(page, async () => ((await copyView(page, id))?.positions.length ?? 0) > 0, 'the copy books its position', 30_000);

  await UI_STEPS['copy.manage'](page, { id, close: true });
  await until(page, async () => (await copyView(page, id))?.subscription.status === 'stopped', 'the copy stopped');
  await until(page, () => sx.position(SYM) === 0, 'Close left the account flat', 30_000);
  const close = sx.orders().filter((w) => legs(w).some((l) => l.clOrdID.startsWith('vdc-'))).at(-1)!;
  const [c] = legs(close);
  assert.deepEqual([c!.side, c!.reduceOnly], [2, true], 'the close is the copy\'s reduce-only sell');
}, { timeout: 180_000 });

h.test('copy.ui-confirm: "Ask before each trade" - the prompt\'s Copy it sends the copy, Skip sends nothing', async (env) => {
  const sx = await trading(env, true);
  const { page } = env;
  const { last } = await sizes(page);
  await browserCopiesReady(env);
  const { id } = await UI_STEPS['copy.start'](page, { leader: LEADER, venue: 'sodex', perTradeUsd: 12, maxLeverage: 2, coins: ['BTC'], ask: true, isolated: true, allocationUsd: 100 });
  await copyReady(page, sx, id);
  const copyOrders = () => sx.orders().filter((w) => legs(w).some((l) => l.clOrdID.startsWith('vdc-')));

  sx.leaderTrade(SYM, 'buy', 0.001, last);
  const yes = await UI_STEPS['copy.answer'](page, { yes: true });
  assert.match(yes.asked, /moved BTC-USD from 0 to 0[.,]001/);
  await until(page, () => sx.position(SYM) > 0, 'Copy it: the copy opened', 30_000);
  assert.equal(copyOrders().length, 1);

  sx.leaderTrade(SYM, 'buy', 0.001, last);
  await UI_STEPS['copy.answer'](page, { yes: false });
  await until(page, async () => ((await page.evaluate((x) => window.__vsTest!.copier.events(x), id)) as Array<{ kind: string; reason?: string }>).some((e) => e.kind === 'skip' && e.reason === 'declined'), 'Skip: declined in the activity', 15_000);
  await page.waitForTimeout(2_000);
  assert.equal(copyOrders().length, 1, 'Skip sent nothing');

  sx.leaderTrade(SYM, 'sell', 0.002, last);
  await UI_STEPS['copy.answer'](page, { yes: true });
  await until(page, () => sx.position(SYM) === 0, 'the leader\'s close, answered Copy it, closed the copy', 30_000);
  const [c] = legs(copyOrders().at(-1)!);
  assert.deepEqual([c!.side, c!.reduceOnly], [2, true]);
  await page.evaluate((x) => window.__vsTest!.copier.stop(x), id);
}, { timeout: 180_000 });

h.test('algo.ui-cancel-exits: a bracket from the algo ticket; the Algos table\'s row pulls its exits', async ({ page }) => {
  const { qty } = await sizes(page);
  const { id } = await UI_STEPS['algo.bracket'](page, { symbol: SYM, quantity: round5(qty), tpPct: 2, slPct: 2, practice: true });
  type V = { algo: { id: string; status: string; filled: number; spec: Record<string, unknown> }; exits?: Array<{ live: boolean }> };
  const view = () => page.evaluate((x) => window.__vsTest!.algos.list().then((l) => l.find((v) => v.algo.id === x)), id) as Promise<V | undefined>;
  const v = (await view())!;
  assert.deepEqual([v.algo.spec.kind, v.algo.spec.entry, v.algo.spec.paper, v.algo.spec.quantity], ['bracket', 'market', true, String(round5(qty))]);
  const x = v.algo.spec.exits as { tpPct: number; slPct: number };
  assert.deepEqual([x.tpPct, x.slPct], [0.02, 0.02], 'the exits as typed, 2% each');
  await until(page, async () => ((await view())?.algo.filled ?? 0) > 0, 'the entry filled (paper)', 60_000);
  // While it runs the row offers Cancel, which ends it and leaves the exits guarding what filled ("Exits live");
  // then Cancel exits pulls them.
  let r = await UI_STEPS['algo.cancelExits'](page, { id });
  const clicked = [r.button];
  if (r.button === 'Cancel') {
    await until(page, async () => ['cancelled', 'done', 'expired'].includes((await view())?.algo.status ?? ''), 'the bracket ended', 20_000);
    assert.ok(((await view())?.exits ?? []).some((x) => x.live), 'Cancel leaves its exits live (they protect what filled)');
    assert.equal(r.next, 'Cancel exits', 'the row then offers Cancel exits');
    assert.equal(r.status, 'Exits live');
    r = await UI_STEPS['algo.cancelExits'](page, { id });
    clicked.push(r.button);
  }
  assert.equal(clicked.at(-1), 'Cancel exits');
  assert.equal(r.next, null, 'nothing left to cancel on the row');
  await until(page, async () => !((await view())?.exits ?? []).some((x) => x.live), 'no exit is live', 20_000);
}, { timeout: 150_000 });
