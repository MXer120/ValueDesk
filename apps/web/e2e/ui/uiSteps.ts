/**
 * What a person does on ValueDesk's own pages, one step at a time, by ARIA role and
 * accessible name: the order ticket and its review, the account tables' Cancel and
 * Close, the copy window, Manage copies, the "Copy this trade?" prompt, the algo
 * ticket and the Algos table.
 *
 * TWO CALLERS, THE SAME STEPS. The live suite's browser target runs them with real
 * money (apps/executor/tools/live-test/scenarios/ui.ts, through bridgeSession.ts
 * `ui(step, args)`), and the UI specs run them against the fake SoDEX account
 * (uiSteps.spec.ts): what passes offline is the very code that clicks live.
 *
 * Every step takes plain JSON and answers plain JSON (it crosses from the live runner
 * as it is), leaves the page where a later step finds it (the trade page, unless the
 * step is about another one) and throws with what the page said when it cannot do
 * what it was asked: a refusal on the ticket, a step of the copy window not done.
 */
import type { Locator, Page } from 'playwright-core';
import { algo } from './algo';
import { dec, num, typeInto, until, waitValue } from './harness';
import { ticket, toast } from './ticket';

/** The page's own copier and algo runner, read through the dev-only test bridge (ids only: what a step started). */
const bridgeCopies = (page: Page) => page.evaluate(() => window.__vsTest!.copier.list().then((l) => l.map((v) => ({ id: v.subscription.id, status: v.subscription.status }))));
const bridgeAlgos = (page: Page) => page.evaluate(() => window.__vsTest!.algos.list().then((l) => l.map((v) => ({ id: v.algo.id, status: v.algo.status, parent: (v.algo.spec as { parentId?: string }).parentId ?? null }))));

/** Another page of the app, in this tab, as its nav does (history + popstate): no reload, so the runners in the tab go on. */
export async function inApp(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    if (`${location.pathname}${location.search}` === p) return;
    history.pushState(null, '', p);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/** The trade page, with the order ticket ready. */
async function tradePage(page: Page): Promise<void> {
  if (new URL(page.url()).pathname !== '/trade') await inApp(page, '/trade');
  await ticket(page).show();
}

/**
 * A market picked as a person picks one: the header's market button ("BTC-USD futures: change
 * market") opens the search, `query` is typed, and the first result of that kind (a perp's
 * second line says "Perp", a spot market's "Spot") whose name starts with it is chosen.
 */
export async function pickMarket(page: Page, query: string, kind: 'perp' | 'spot'): Promise<void> {
  await page.getByRole('button', { name: /(futures|spot): change market$/ }).first().click();
  const search = page.getByRole('dialog', { name: 'Search traders and markets' });
  await search.waitFor({ state: 'visible' });
  await typeInto(search.getByRole('combobox', { name: 'Search traders, markets, pages or addresses' }), query);
  const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = search.getByRole('option').filter({ hasText: new RegExp(`^\\s*${esc}`, 'i') }).filter({ hasText: kind === 'perp' ? /Perp/ : /Spot/ }).first();
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  await row.click();
  await search.waitFor({ state: 'hidden', timeout: 10_000 });
}

/** The perps market on the trade page (its header button names it); another one picked through the search. */
export async function selectMarket(page: Page, symbol: string): Promise<void> {
  await tradePage(page);
  const btn = page.getByRole('button', { name: /(futures|spot): change market$/ }).first();
  await btn.waitFor({ state: 'visible', timeout: 30_000 });
  const showing = async () => ((await btn.getAttribute('aria-label')) ?? '').toUpperCase();
  const want = `${symbol.toUpperCase()} FUTURES`;
  if ((await showing()).startsWith(want)) return;
  await pickMarket(page, symbol, 'perp');
  await until(page, async () => (await showing()).startsWith(want), `the market ${symbol} on the trade page (the button says ${await showing()})`, 20_000);
  await ticket(page).show();
}

/** A positions row's Liq. (6th column) and Margin (8th): Market, Size, Value, Entry, Mark, Liq., PnL, Margin. */
async function positionCells(row: Locator): Promise<{ liq: number | null; margin: number | null }> {
  // The app's number format ("$6,20", "76.238,1"): num reads it.
  const cell = async (i: number) => num((await row.locator('td').nth(i).textContent()) ?? '') || null;
  return { liq: await cell(5), margin: await cell(7) };
}

export type Side = 'buy' | 'sell';
const dir = (s: Side) => (s === 'buy' ? 'Long' : 'Short');

/**
 * The ticket's button, then its review (Place; the liquidation acknowledgement first when it
 * asks), until the ticket says "placed" - or says why not, which is thrown. `last` runs right
 * before the click that sends it (what the ticket shows then is what goes out).
 */
async function place(page: Page, last?: () => Promise<void>): Promise<{ review: string; placed: string }> {
  const t = ticket(page);
  const btn = t.g.locator('.oe-side__btn');
  await until(page, async () => await btn.isEnabled(), `the ${((await btn.textContent()) ?? '').trim() || 'order'} button to be enabled`, 20_000).catch(async (e) => {
    const hints = (await t.hints.allInnerTexts().catch(() => [] as string[])).join(' | ');
    throw new Error(`${(e as Error).message}${hints ? `; the ticket says: ${hints}` : ''} (button: ${(await btn.getAttribute('title')) ?? ((await btn.textContent()) ?? '').trim()})`);
  });
  const toasts = await toast(page, /placed/).count();
  // A new "placed" toast is watched for as it is added: the stack holds four (toast.tsx MAX), so with it full the
  // new one pushes the oldest out and the count of "placed" toasts can stay the same (live 2026-10-31, ticket.stop:
  // the stop orders were on SoDEX, the step timed out).
  await page.evaluate(() => {
    const w = window as unknown as { __placedAdded?: number; __placedObs?: MutationObserver };
    w.__placedObs?.disconnect();
    w.__placedAdded = 0;
    w.__placedObs = new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        const el = n.matches('.toast') ? n : n.querySelector('.toast');
        if (el && /placed/.test(el.textContent ?? '')) w.__placedAdded = (w.__placedAdded ?? 0) + 1;
      }
    });
    w.__placedObs.observe(document.body, { childList: true, subtree: true });
  }).catch(() => {});
  // "Don't ask again" was ticked in this browser: the button sends it at once.
  const reviewed = await page.evaluate(() => localStorage.getItem('opentrade.review.suppress') !== '1').catch(() => true);
  if (!reviewed) await last?.();
  await btn.click();
  const review = page.getByRole('dialog', { name: /^Review order/ });
  let text = '';
  await review.waitFor({ state: 'visible', timeout: reviewed ? 10_000 : 2_000 }).catch(() => {});
  if (await review.isVisible()) {
    text = ((await review.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    const ack = review.getByRole('checkbox', { name: /^I understand liquidation would happen/ });
    if (await ack.count()) await ack.check();
    if (reviewed) await last?.();
    await review.getByRole('button', { name: /^Place (buy \/ long|sell \/ short)$/ }).click();
    await review.waitFor({ state: 'hidden', timeout: 20_000 });
  }
  const status = t.g.locator('p.status');
  let placed = '';
  await until(page, async () => {
    const added = await page.evaluate(() => (window as unknown as { __placedAdded?: number }).__placedAdded ?? 0).catch(() => 0);
    if (added > 0 || (await toast(page, /placed/).count()) > toasts) {
      placed = ((await toast(page, /placed/).last().textContent()) ?? '').trim();
      return true;
    }
    const said = (await status.allInnerTexts().catch(() => [] as string[])).join(' ').trim();
    if (said && !/^Working/i.test(said)) throw new Error(`the ticket says: ${said}`);
    return false;
  }, 'the ticket to say the order was placed', 30_000).catch(async (e) => {
    const said = (await status.allInnerTexts().catch(() => [] as string[])).join(' ').trim();
    throw new Error(said ? `the order was not placed: ${said}` : (e as Error).message);
  });
  return { review: text, placed };
}

/* ------------------------------------------------------------------ the steps ----- */

export interface TicketLimitArgs { symbol: string; side: Side; price: number; quantity: number }
export interface TicketMarketArgs {
  symbol: string;
  side: Side;
  quantity: number;
  /**
   * Take-profit / stop-loss on the entry, as the ticket's Gain and Loss in % (return on margin);
   * `movePct`: both at that price move from the entry (Gain = Loss = movePct x the ticket's leverage).
   */
  exits?: { gainPct?: number; lossPct?: number; movePct?: number };
}
export interface TicketLeverageArgs { symbol: string; leverage: number; marginMode?: 'cross' | 'isolated' }
export interface CopyStartArgs {
  leader: string;
  venue: 'sodex' | 'hyperliquid';
  perTradeUsd: number;
  maxLeverage: number;
  /** "Only copy": the leader's coins to copy (BTC, ETH). */
  coins: string[];
  /** "Ask before each trade" (offered in this browser only). */
  ask?: boolean;
  paper?: boolean;
  isolated?: boolean;
  allocationUsd: number;
}
export interface AlgoBracketArgs { symbol: string; quantity: number; tpPct: number; slPct: number; practice: boolean }

export const UI_STEPS = {
  /** The market the trade page shows. */
  async 'market.select'(page: Page, a: { symbol: string }) {
    await selectMarket(page, a.symbol);
    return { symbol: a.symbol };
  },

  /** A limit order through the ticket and its review. */
  async 'ticket.limit'(page: Page, a: TicketLimitArgs) {
    await selectMarket(page, a.symbol);
    const t = ticket(page);
    await t.ready();
    await t.limit(a.price, a.quantity, dir(a.side));
    return place(page);
  },

  /**
   * A market order through the ticket and its review; with `exits`, its TP/SL switch on and
   * Gain / Loss typed in %. Answers the TP and SL prices the ticket showed (what the order carries).
   */
  async 'ticket.market'(page: Page, a: TicketMarketArgs) {
    await selectMarket(page, a.symbol);
    const t = ticket(page);
    await t.ready();
    await t.type('Market');
    await t.direction(dir(a.side)).check();
    await t.setUnit(await baseUnitOf(t.unit));
    await typeInto(t.amount, dec(a.quantity));
    await waitValue(t.amount, (v) => num(v) === a.quantity, `the amount ${a.quantity}`);
    let tp: number | null = null;
    let sl: number | null = null;
    const leverage = num(await t.value(t.leverage));
    if (a.exits) {
      await t.exits.check();
      await t.tp.waitFor({ state: 'visible' });
      if (await t.toPct.isVisible().catch(() => false)) await t.toPct.click();
      await t.toUsd.waitFor({ state: 'visible' });
      const gain = a.exits.movePct !== undefined ? a.exits.movePct * leverage : a.exits.gainPct ?? 0;
      const loss = a.exits.movePct !== undefined ? a.exits.movePct * leverage : a.exits.lossPct ?? 0;
      if (gain > 0) await typeInto(t.gain, dec(gain));
      if (loss > 0) await typeInto(t.loss, dec(loss));
      if (gain > 0) await waitValue(t.tp, (v) => num(v) > 0, 'the TP price');
      if (loss > 0) await waitValue(t.sl, (v) => num(v) > 0, 'the SL price');
    }
    const r = await place(page, async () => {
      if (!a.exits) return;
      tp = num(await t.value(t.tp)) || null;
      sl = num(await t.value(t.sl)) || null;
    });
    // What the ticket showed when it was placed (a market order's exits follow the last price until then).
    return { ...r, tp, sl, leverage };
  },

  /** The ticket's leverage popover (a preset, Confirm); then the margin mode, when asked for. Answers what the ticket shows. */
  async 'ticket.leverage'(page: Page, a: TicketLeverageArgs) {
    await selectMarket(page, a.symbol);
    const t = ticket(page);
    await t.ready();
    // Typed into the multiplier (any whole leverage, not only a preset), then Confirm.
    await t.leverage.click();
    const pop = page.getByRole('dialog', { name: 'Leverage' });
    await pop.waitFor({ state: 'visible' });
    const box = pop.getByRole('textbox', { name: 'Leverage multiplier' });
    // One input event with the whole number: emptied first, the box puts its minimum back before a key lands.
    await box.fill(String(a.leverage));
    await waitValue(box, (v) => num(v) === a.leverage, `the draft at ${a.leverage}x`);
    await pop.getByRole('button', { name: `Confirm ${a.leverage}x` }).click();
    await waitValue(t.leverage, (v) => v === `${a.leverage}x`, `${a.leverage}x on the ticket`);
    if (a.marginMode) {
      const want = a.marginMode === 'isolated' ? 'Isolated' : 'Cross';
      const other = want === 'Isolated' ? 'Cross' : 'Isolated';
      const now = t.g.getByRole('button', { name: other, exact: true });
      if (await now.isVisible().catch(() => false)) {
        await now.click();
        const mm = page.getByRole('dialog', { name: 'Margin mode' });
        await mm.getByRole('button', { name: new RegExp(`^${want}`) }).click();
        await t.g.getByRole('button', { name: want, exact: true }).waitFor({ state: 'visible' });
      }
    }
    // The change is signed and sent after the popover closes: let it go out before the page is read.
    await page.waitForTimeout(1_500);
    const shown = await t.value(t.leverage);
    const mode = (await t.g.getByRole('button', { name: 'Isolated', exact: true }).isVisible().catch(() => false)) ? 'isolated' : 'cross';
    return { shown, mode };
  },

  /** Open orders: the row of this market (at this price, when it lists several), its Cancel. */
  async 'orders.cancel'(page: Page, a: { symbol: string; price: number }) {
    await tradePage(page);
    const activity = page.getByRole('group', { name: 'Account activity' });
    await activity.getByRole('tab', { name: /^Open Orders/ }).click();
    const rows = activity.locator('tbody tr').filter({ hasText: a.symbol.split('-')[0]! });
    const row = await rowWithPrice(page, rows, a.price, `an open order of ${a.symbol} at ${a.price}`);
    const text = ((await row.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    const said = await toast(page, /cancel/i).count();
    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('dialog', { name: 'Cancel this order?' }).getByRole('button', { name: 'Cancel order' }).click({ timeout: 10_000 });
    await until(page, async () => (await toast(page, /cancel/i).count()) > said || !(await row.isVisible().catch(() => false)), 'the cancel to be sent', 20_000);
    return { row: text };
  },

  /**
   * Open orders: the row at `price`, its Modify; the new price and size typed in its form, Save.
   * Answers what the form said ("Modified." / "Changed: ... placed again ...").
   */
  async 'orders.modify'(page: Page, a: { symbol: string; price: number; newPrice: number; newQuantity: number }) {
    await tradePage(page);
    const activity = page.getByRole('group', { name: 'Account activity' });
    await activity.getByRole('tab', { name: /^Open Orders/ }).click();
    const rows = activity.locator('tbody tr').filter({ hasText: a.symbol.split('-')[0]! });
    const row = await rowWithPrice(page, rows, a.price, `an open order of ${a.symbol} at ${a.price}`);
    await row.getByRole('button', { name: 'Modify', exact: true }).click();
    const form = activity.locator('.acct-modify').filter({ hasText: /^Modify / });
    await form.waitFor({ state: 'visible' });
    await typeInto(form.getByRole('textbox', { name: 'Price', exact: true }), dec(a.newPrice));
    await typeInto(form.getByRole('textbox', { name: 'Size', exact: true }), dec(a.newQuantity));
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    let said = '';
    await until(page, async () => {
      if (!(await form.isVisible().catch(() => false))) return true; // saved: the form closes
      said = ((await form.locator('p.status').allInnerTexts().catch(() => [] as string[])).join(' ')).trim();
      if (said && !/^Working/i.test(said)) throw new Error(`the Modify form says: ${said}`);
      return false;
    }, 'the change to be saved', 30_000);
    return { said };
  },

  /** Open orders: Cancel all, asked first, "Cancel every open order". */
  async 'orders.cancelAll'(page: Page) {
    await tradePage(page);
    const activity = page.getByRole('group', { name: 'Account activity' });
    await activity.getByRole('tab', { name: /^Open Orders/ }).click();
    await activity.getByRole('button', { name: 'Cancel all', exact: true }).click({ timeout: 30_000 });
    const ask = page.getByRole('dialog', { name: 'Cancel all perps orders' });
    await ask.waitFor({ state: 'visible' });
    const asked = ((await ask.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    await ask.getByRole('button', { name: 'Cancel every open order', exact: true }).click();
    await ask.waitFor({ state: 'hidden', timeout: 20_000 });
    return { asked };
  },

  /** A stop order through the ticket: trigger, kind, executes as market or (with `limitPrice`) a limit; its review. */
  async 'ticket.stop'(page: Page, a: { symbol: string; side: Side; quantity: number; trigger: number; kind: 'sl' | 'tp'; limitPrice?: number }) {
    await selectMarket(page, a.symbol);
    const t = ticket(page);
    await t.ready();
    await t.type('Stop');
    await t.direction(dir(a.side)).check();
    // The ticket keeps the TP/SL switch as the last order left it (ticket.tpsl turns it on): a plain stop has none.
    if ((await t.exits.getAttribute('aria-checked')) === 'true') await t.exits.click();
    await t.setUnit(await baseUnitOf(t.unit));
    await typeInto(t.amount, dec(a.quantity));
    await waitValue(t.amount, (v) => num(v) === a.quantity, `the amount ${a.quantity}`);
    await t.kind.selectOption(a.kind);
    await typeInto(t.trigger, dec(a.trigger));
    await waitValue(t.trigger, (v) => num(v) === a.trigger, `the trigger ${a.trigger}`);
    await t.executesAs.selectOption(a.limitPrice ? 'limit' : 'market');
    if (a.limitPrice) {
      await t.price.waitFor({ state: 'visible' });
      await typeInto(t.price, dec(a.limitPrice));
      await waitValue(t.price, (v) => num(v) === a.limitPrice, `the limit ${a.limitPrice}`);
      await t.pickTif('GTC');
    }
    return place(page);
  },

  /**
   * Positions: the market's TP/SL sheet ("Edit TP/SL on BTC-USD"), the take-profit and stop-loss
   * prices typed (an exit already working is changed), Confirm.
   */
  async 'positions.tpsl'(page: Page, a: { symbol: string; tp: number; sl: number }) {
    await tradePage(page);
    const activity = page.getByRole('group', { name: 'Account activity' });
    await activity.getByRole('tab', { name: /^Positions/ }).click();
    const edit = activity.getByRole('button', { name: `Edit TP/SL on ${a.symbol}` });
    await edit.waitFor({ state: 'visible', timeout: 30_000 });
    await edit.click();
    const sheet = page.getByRole('dialog', { name: 'Take Profit & Stop Loss' });
    await sheet.waitFor({ state: 'visible' });
    const tp = sheet.getByRole('textbox', { name: 'Take Profit price' });
    const sl = sheet.getByRole('textbox', { name: 'Stop Loss price' });
    const was = { tp: num(await tp.inputValue()), sl: num(await sl.inputValue()) };
    await typeInto(tp, dec(a.tp));
    await typeInto(sl, dec(a.sl));
    const confirm = sheet.getByRole('button', { name: 'Confirm', exact: true });
    await until(page, async () => await confirm.isEnabled(), 'Confirm on the sheet', 10_000).catch(async () => {
      throw new Error(`the TP/SL sheet will not confirm: ${((await sheet.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
    });
    await confirm.click();
    await page.getByRole('dialog', { name: 'Confirm take profit and stop loss' }).getByRole('button', { name: 'Send exits' }).click({ timeout: 10_000 });
    await sheet.waitFor({ state: 'hidden', timeout: 30_000 }).catch(async () => {
      throw new Error(`the TP/SL sheet stayed open: ${((await sheet.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
    });
    return { was };
  },

  /**
   * A spot order through the ticket: Market type Spot, the market picked through the search (a spot
   * market's name, "BTC/USDC"), a market buy or sell of `quantity` (in the coin) or of `pct` of the
   * balance; its review. Back to Futures after.
   */
  async 'spot.order'(page: Page, a: { display: string; side: Side; quantity?: number; pct?: number }) {
    await tradePage(page);
    const kind = page.getByRole('radiogroup', { name: 'Market type' });
    await kind.getByRole('radio', { name: 'Spot', exact: true }).click();
    const btn = page.getByRole('button', { name: /(futures|spot): change market$/ }).first();
    const want = `${a.display.toUpperCase()} SPOT`;
    await until(page, async () => /spot: change market$/.test((await btn.getAttribute('aria-label')) ?? ''), 'a spot market on the trade page', 20_000);
    if (!((await btn.getAttribute('aria-label')) ?? '').toUpperCase().startsWith(want)) {
      await pickMarket(page, a.display.split('/')[0]!, 'spot');
      await until(page, async () => ((await btn.getAttribute('aria-label')) ?? '').toUpperCase().startsWith(want), `${a.display} on the trade page`, 20_000);
    }
    const t = ticket(page);
    try {
      await t.ready();
      await t.type('Market');
      await t.direction(a.side === 'buy' ? 'Buy' : 'Sell').check();
      await t.setUnit(await baseUnitOf(t.unit));
      if (a.pct !== undefined) {
        await typeInto(t.pct, dec(a.pct));
        await waitValue(t.amount, (v) => num(v) > 0, 'the amount from the percentage');
      } else {
        await typeInto(t.amount, dec(a.quantity ?? 0));
        await waitValue(t.amount, (v) => num(v) === a.quantity, `the amount ${a.quantity}`);
      }
      const quantity = num(await t.value(t.amount));
      return { ...(await place(page)), quantity };
    } finally {
      await kind.getByRole('radio', { name: 'Futures', exact: true }).click().catch(() => {});
    }
  },

  /**
   * Positions: the market's isolated margin pencil ("Edit isolated margin on BTC-USD"), the amount
   * typed, Add or Remove, asked first ("Add margin" / "Remove margin"), until the table says so (or
   * why not, which is thrown). Answers the row's Liq. and Margin before and after (what a person reads).
   */
  async 'positions.margin'(page: Page, a: { symbol: string; amount: number; add: boolean }) {
    await tradePage(page);
    const activity = page.getByRole('group', { name: 'Account activity' });
    await activity.getByRole('tab', { name: /^Positions/ }).click();
    const row = activity.locator('tbody tr').filter({ has: page.getByRole('button', { name: `Edit isolated margin on ${a.symbol}` }) });
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    const cells = () => positionCells(row);
    const before = await cells();
    await row.getByRole('button', { name: `Edit isolated margin on ${a.symbol}` }).click();
    const form = activity.locator('.acct-modify').filter({ hasText: `Isolated margin · ${a.symbol}` });
    await form.waitFor({ state: 'visible' });
    await typeInto(form.getByRole('textbox', { name: 'Amount', exact: true }), dec(a.amount));
    // The last change's status line stays 8 s (12 s an error): gone first, so the line read below is this one's.
    await until(page, async () => (await activity.locator('p.status').count()) === 0, 'the last status line to clear', 20_000);
    await form.getByRole('button', { name: a.add ? 'Add' : 'Remove', exact: true }).click();
    const ask = page.getByRole('dialog', { name: a.add ? 'Add isolated margin' : 'Remove isolated margin' });
    await ask.waitFor({ state: 'visible' });
    const asked = ((await ask.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    await ask.getByRole('button', { name: a.add ? 'Add margin' : 'Remove margin', exact: true }).click();
    await ask.waitFor({ state: 'hidden', timeout: 20_000 });
    // The table answers in its status line (useStatus): "Margin added." / "Margin removed.", or SoDEX's refusal.
    // (until swallows what its check throws: a refusal is kept here and thrown after.)
    let refused = '';
    await until(page, async () => {
      if (await activity.locator('p.status.ok').filter({ hasText: /^Margin (added|removed)\./ }).count()) return true;
      refused = (await activity.locator('p.status.err').allInnerTexts().catch(() => [] as string[])).join(' ').trim();
      return refused !== '';
    }, `the margin to be ${a.add ? 'added' : 'removed'}`, 30_000).catch(async (e) => {
      const shown = ((await page.locator('p.status, [role="alert"], .toast').allInnerTexts().catch(() => [] as string[])).join(' | ')).slice(0, 300);
      throw new Error(`${(e as Error).message}${shown ? `; the page shows: ${shown}` : ''}`);
    });
    if (refused) throw new Error(`the positions table says: ${refused}`);
    // The table reads the position again: wait until its Margin moved.
    await until(page, async () => ((await cells()).margin ?? 0) !== (before.margin ?? 0), 'the Margin cell to show the change', 30_000).catch(() => {});
    return { asked, before, after: await cells() };
  },

  /**
   * The bell: opened, its rows read (title and text, newest first), closed again. `match` keeps only
   * the rows whose title it matches (a regular expression's source). Answers the rows and the bell's
   * label before it opened ("Notifications, 2 unread").
   */
  async 'bell.read'(page: Page, a: { match?: string } = {}) {
    const button = page.getByRole('banner').getByRole('button', { name: /^Notifications/ });
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await button.first().waitFor({ state: 'visible', timeout: 20_000 });
    const label = (await button.first().getAttribute('aria-label')) ?? '';
    if (!(await panel.isVisible())) await button.first().click();
    await panel.waitFor({ state: 'visible' });
    const rows = await panel.locator('.navnotes__k').evaluateAll((els) => els.map((el) => {
      const row = el.closest('li') ?? el.parentElement;
      return { title: (el.textContent ?? '').trim(), text: ((row?.textContent ?? '').replace(/\s+/g, ' ')).trim() };
    }));
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden', timeout: 5_000 }).catch(async () => {
      await page.getByRole('button', { name: 'Close notifications' }).click({ position: { x: 4, y: 4 } }).catch(() => {});
    });
    const re = a.match ? new RegExp(a.match) : null;
    return { label, rows: re ? rows.filter((r) => re.test(r.title)) : rows };
  },

  /** Positions: the market's row as it reads now (Liq. and Margin), nothing clicked but the tab. */
  async 'positions.read'(page: Page, a: { symbol: string }) {
    await tradePage(page);
    const activity = page.getByRole('group', { name: 'Account activity' });
    await activity.getByRole('tab', { name: /^Positions/ }).click();
    const row = activity.locator('tbody tr').filter({ has: page.getByRole('button', { name: `Close ${a.symbol} at market` }) });
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    return { after: await positionCells(row) };
  },

  /** Positions: the market's Close (x), asked first, "Close at market". */
  async 'positions.close'(page: Page, a: { symbol: string }) {
    await tradePage(page);
    const activity = page.getByRole('group', { name: 'Account activity' });
    await activity.getByRole('tab', { name: /^Positions/ }).click();
    const close = activity.getByRole('button', { name: `Close ${a.symbol} at market` });
    await close.waitFor({ state: 'visible', timeout: 30_000 });
    await close.click();
    const ask = page.getByRole('dialog', { name: 'Close position at market' });
    await ask.waitFor({ state: 'visible' });
    const text = ((await ask.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    await ask.getByRole('button', { name: 'Close at market' }).click();
    await ask.waitFor({ state: 'hidden', timeout: 20_000 });
    return { asked: text };
  },

  /**
   * A copy through the copy window, as from the trader's Copy button (/copy?address=&venue=):
   * $ per trade, max leverage, the coins, isolated, "Ask before each trade"; This browser; the
   * amount; Start. Every step of the place must be done already (terms, fee, key): a step left
   * is thrown, named. Answers the new copy's id.
   */
  async 'copy.start'(page: Page, a: CopyStartArgs) {
    // The copy page reads the trader from the link when it mounts: arrive from another page.
    if (new URL(page.url()).pathname === '/copy') await inApp(page, '/trade');
    await inApp(page, `/copy?address=${a.leader.toLowerCase()}&venue=${a.venue}&direction=copy`);
    const modal = page.getByRole('dialog', { name: /^Copy 0x/ });
    await modal.waitFor({ state: 'visible', timeout: 30_000 });
    const box = (name: string) => modal.getByRole('textbox', { name, exact: true });
    const sw = (name: string) => modal.getByRole('switch', { name, exact: true });
    const places = modal.getByRole('radiogroup', { name: 'Where the copier runs' });
    const next = async () => {
      await modal.getByRole('button', { name: 'Next', exact: true }).click();
      await places.waitFor({ state: 'visible' });
    };
    const openRisk = async () => {
      if (!(await box('Stop loss').isVisible())) await modal.getByText('Risk controls and markets').click();
      await box('Stop loss').waitFor({ state: 'visible' });
    };
    await modal.getByRole('group', { name: 'Sizing' }).getByRole('button', { name: '$ per trade', exact: true }).click();
    await typeInto(box('Per trade'), dec(a.perTradeUsd));
    await typeInto(box('Max leverage'), dec(a.maxLeverage));
    if (a.paper) await sw('Paper copy').check();
    else await sw('Paper copy').uncheck();
    await openRisk();
    await typeInto(box('Only copy'), a.coins.join(', '));
    if (a.isolated !== false) await sw('Isolated margin').check();
    else await sw('Isolated margin').uncheck();
    await next();
    await places.getByRole('radio', { name: /^This browser / }).check();
    if (a.ask) {
      // Offered where a person is there to answer: this browser (picked above), set on the rules page.
      await modal.getByRole('button', { name: 'Back', exact: true }).last().click();
      await openRisk();
      await sw('Ask before each trade').check();
      await next();
      await places.getByRole('radio', { name: /^This browser / }).check();
    }
    await typeInto(modal.getByLabel('Trade with'), dec(a.allocationUsd));
    const start = modal.getByRole('button', { name: a.paper ? 'Start paper copy' : 'Start copying', exact: true });
    await until(page, async () => await start.isEnabled(), `${a.paper ? 'Start paper copy' : 'Start copying'} to be enabled`, 30_000).catch(async () => {
      const steps = (await modal.locator('.cs-step__t').allTextContents()).map((s) => s.trim());
      const why = ((await modal.locator('.cpy-mfoot__err').allInnerTexts().catch(() => [] as string[])).join(' ') || (await start.getAttribute('title')) || '').trim();
      throw new Error(`the copy window cannot start the copy: ${why || 'Start stays disabled'} (its steps: ${steps.join(' | ')})`);
    });
    const before = new Set((await bridgeCopies(page)).map((c) => c.id));
    await start.click();
    await modal.waitFor({ state: 'hidden', timeout: 30_000 });
    let id = '';
    await until(page, async () => {
      id = (await bridgeCopies(page)).find((c) => !before.has(c.id))?.id ?? '';
      return !!id;
    }, 'the new copy in this browser\'s copier', 20_000);
    await inApp(page, '/trade');
    return { id };
  },

  /**
   * Portfolio > My copies > Manage copies: the copy's row, then Close ("Stop and close positions";
   * the row offers it while the copy holds a position) or Stop ("Stop copying").
   */
  async 'copy.manage'(page: Page, a: { id: string; close: boolean }) {
    await inApp(page, '/portfolio');
    await page.getByRole('button', { name: 'Manage copies', exact: true }).click({ timeout: 30_000 });
    const dlg = page.getByRole('dialog', { name: 'My copies' });
    await dlg.waitFor({ state: 'visible' });
    const row = dlg.locator('tbody tr').filter({ has: page.getByRole('button', { name: `Copy Copy ID ${a.id}` }) });
    await row.waitFor({ state: 'visible', timeout: 20_000 });
    const label = a.close ? 'Close' : 'Stop';
    await row.getByRole('button', { name: label, exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    const text = ((await row.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    await row.getByRole('button', { name: label, exact: true }).click();
    const ask = page.getByRole('dialog', { name: a.close ? 'Stop and close' : 'Stop copying' });
    await ask.waitFor({ state: 'visible' });
    await ask.getByRole('button', { name: a.close ? 'Stop and close positions' : 'Stop copying', exact: true }).click();
    await ask.waitFor({ state: 'hidden', timeout: 20_000 });
    await row.getByText('Stopped', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.keyboard.press('Escape');
    await inApp(page, '/trade');
    return { row: text };
  },

  /** The "Copy this trade?" prompt at the bottom of the page: Copy it, or Skip. Answers what it asked. */
  async 'copy.answer'(page: Page, a: { yes: boolean; timeoutMs?: number }) {
    const prompt = page.getByRole('alertdialog', { name: 'Copy this trade?' }).first();
    await prompt.waitFor({ state: 'visible', timeout: a.timeoutMs ?? 45_000 });
    const asked = ((await prompt.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    const n = await page.getByRole('alertdialog', { name: 'Copy this trade?' }).count();
    await prompt.getByRole('button', { name: a.yes ? 'Copy it' : 'Skip', exact: true }).click();
    await until(page, async () => (await page.getByRole('alertdialog', { name: 'Copy this trade?' }).count()) < n, 'the prompt to go once answered', 10_000);
    return { asked };
  },

  /**
   * A bracket from the algo ticket: market entry of `quantity`, take-profit and stop-loss in %,
   * run in this browser (a practice run, or real); the Summary's slide starts it. Answers its id.
   */
  async 'algo.bracket'(page: Page, a: AlgoBracketArgs) {
    await selectMarket(page, a.symbol);
    const x = algo(page);
    await x.t.ready();
    await x.pick('Bracket');
    await x.t.setUnit(await baseUnitOf(x.t.unit));
    await typeInto(x.t.amount, dec(a.quantity));
    const field = (name: string) => x.t.g.getByRole('textbox', { name, exact: true });
    await typeInto(field('Take-profit'), dec(a.tpPct));
    await typeInto(field('Stop-loss'), dec(a.slPct));
    const d = await x.open('Bracket', 'Runs on');
    await x.place(d, 'This browser').check();
    if (a.practice) await x.practice(d).check();
    else await x.practice(d).uncheck();
    await x.done('Bracket');
    const before = new Set((await bridgeAlgos(page)).map((v) => v.id));
    await until(page, async () => await x.button.isEnabled(), 'the Start button', 20_000).catch(async (e) => {
      throw new Error(`${(e as Error).message}: ${(await x.button.getAttribute('title')) ?? ''}`);
    });
    await x.button.click();
    await x.settings('Bracket').getByRole('heading', { name: 'Summary', level: 3 }).waitFor({ state: 'visible' });
    const summary = x.settings('Bracket').getByRole('region', { name: 'Summary' });
    const slide = summary.getByRole('slider', { name: a.practice ? /^Slide to start the practice / : /^Slide to (buy|sell) / });
    await slide.waitFor({ state: 'visible' }).catch(async () => {
      throw new Error(`the Summary offers no slide to start it: ${((await summary.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
    });
    if ((await slide.getAttribute('aria-disabled')) === 'true') throw new Error(`the Summary will not start it: ${((await summary.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
    await slide.focus();
    await page.keyboard.press('End');
    let id = '';
    await until(page, async () => {
      id = (await bridgeAlgos(page)).find((v) => !before.has(v.id) && !v.parent)?.id ?? '';
      return !!id;
    }, 'the new bracket in this browser\'s runner', 20_000);
    await x.settings('Bracket').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    return { id };
  },

  /**
   * The Algos table: the algo's row (its details name its id), and the one cancel it offers - Cancel
   * while it runs (its exits stay to protect what filled: the row then says "Exits live"), Cancel
   * exits once it ended with exits still live (they are pulled). One click; answers which it was and
   * what the row offers after it, so a caller can take the next one.
   */
  async 'algo.cancelExits'(page: Page, a: { id: string }) {
    await tradePage(page);
    const activity = page.getByRole('group', { name: 'Account activity' });
    await activity.getByRole('tab', { name: /^Algos/ }).click();
    await activity.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click().catch(() => {});
    const table = activity.locator('table.algo-t');
    const row = await algoRow(page, table, a.id);
    const btn = row.getByRole('button', { name: /^(Cancel exits|Cancel)$/ });
    await btn.first().waitFor({ state: 'visible', timeout: 20_000 });
    const label = ((await btn.first().textContent()) ?? '').trim();
    await btn.first().click();
    // The row changes once the runner has it: Cancel -> Cancel exits (exits live) or nothing; Cancel exits -> nothing.
    let next = '';
    await until(page, async () => {
      next = (await btn.count()) ? ((await btn.first().textContent()) ?? '').trim() : '';
      return next !== label;
    }, `the row to move on from ${label}`, 20_000);
    return { button: label, next: next || null, status: ((await row.locator('.algo-status').first().textContent()) ?? '').trim() };
  },
} as const;

export type UiStepName = keyof typeof UI_STEPS;

/** Run one step by name (the live suite's browser target: bridgeSession.ts ui()). */
export async function runUiStep(page: Page, name: string, args: unknown): Promise<unknown> {
  const step = (UI_STEPS as Record<string, (p: Page, a: never) => Promise<unknown>>)[name];
  if (!step) throw new Error(`no UI step "${name}" (uiSteps.ts has ${Object.keys(UI_STEPS).join(', ')})`);
  return step(page, (args ?? {}) as never);
}

/* ------------------------------------------------------------------ helpers ----- */

/** The base coin's label on the unit toggle (BTC), whichever unit it shows now. */
async function baseUnitOf(unit: Locator): Promise<string> {
  const shown = (await unit.locator('.oe-unitlabel').textContent())?.trim() ?? '';
  const other = ((await unit.getAttribute('aria-label')) ?? '').replace(/^Size in /, '');
  return /^(USDC|USD|USDT|vUSDC)$/i.test(shown) ? other : shown;
}

/** The digits of a price as a row prints it, in any grouping: 68123.5 -> "681235". */
const digitsOf = (n: number) => String(n).replace(/[^0-9]/g, '').replace(/^0+/, '');

/** The one row of `rows` (or the one whose text holds the price's digits). */
async function rowWithPrice(page: Page, rows: Locator, price: number, what: string): Promise<Locator> {
  await until(page, async () => (await rows.count()) > 0, what, 30_000);
  const want = digitsOf(price);
  let hit: Locator | null = null;
  await until(page, async () => {
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const r = rows.nth(i);
      if (((await r.textContent()) ?? '').replace(/[^0-9]/g, '').includes(want)) {
        hit = r;
        return true;
      }
    }
    return false;
  }, what, 30_000);
  return hit!;
}

/** The Algos table's row of an algo: each row's details (opened by a click) carry its id. */
async function algoRow(page: Page, table: Locator, id: string): Promise<Locator> {
  const rows = table.locator('tbody tr.algo-tr');
  let hit: Locator | null = null;
  await until(page, async () => {
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const r = rows.nth(i);
      const chip = (x: Locator) => x.getByRole('button', { name: `Copy Algo ID ${id}` });
      if (await chip(r).count()) {
        hit = r;
        return true;
      }
      if ((await r.getAttribute('aria-expanded')) !== 'true') await r.click();
      if (await chip(r.locator('xpath=following-sibling::tr[1]')).count()) {
        hit = r;
        return true;
      }
      await r.click();
    }
    return false;
  }, `the row of algo ${id} in the Algos table`, 30_000);
  return hit!;
}

