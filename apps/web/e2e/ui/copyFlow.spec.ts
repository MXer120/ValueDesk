/**
 * Copying, past the setup: the copy window's rules as the copy receives them, its
 * refusals, and managing a running copy (Portfolio > My copies > Manage copies:
 * Pause, Resume, Activity, Stop, Stop all). Paper copies in this browser: nothing is
 * signed to start one and nothing is sent to SoDEX.
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { copy } from './copy';
import { connectWallet, typeInto, uiSuite, until } from './harness';
import { toast } from './ticket';

const h = uiSuite(import.meta.filename);

type Sub = { id: string; status: string; mode: string; settings: Record<string, unknown> & { leader: { address: string; venue: string } } };
const subs = (page: Page) => page.evaluate(() => window.__vsTest!.copier.list()).then((l) => l.map((v) => v.subscription as unknown as Sub));
const statusOf = async (page: Page, id: string) => (await subs(page)).find((s) => s.id === id)?.status;

const box = (c: ReturnType<typeof copy>, name: string) => c.modal.getByRole('textbox', { name, exact: true });
const sw = (c: ReturnType<typeof copy>, name: string) => c.modal.getByRole('switch', { name, exact: true });

/** The risk controls and market lists sit in a closed details block. */
async function openRisk(c: ReturnType<typeof copy>) {
  const sl = box(c, 'Stop loss');
  if (!(await sl.isVisible())) await c.modal.getByText('Risk controls and markets').click();
  await sl.waitFor({ state: 'visible' });
}

/** A paper copy in this browser with the rules as they stand: terms, Start. Returns the new copy. */
async function startPaper(page: Page, c: ReturnType<typeof copy>, wallet: Parameters<ReturnType<typeof copy>['acceptTerms']>[0]): Promise<Sub> {
  if (await c.step('Accept the copy trading terms').getByRole('button', { name: 'Review' }).isVisible()) await c.acceptTerms(wallet);
  const start = c.modal.getByRole('button', { name: 'Start paper copy', exact: true });
  await until(page, async () => await start.isEnabled(), 'Start paper copy');
  const before = new Set((await subs(page)).map((s) => s.id));
  const mark = wallet.mark();
  await start.click();
  await c.modal.waitFor({ state: 'hidden', timeout: 20_000 });
  assert.deepEqual(wallet.since(mark), [], 'a paper copy signs nothing to start');
  let mine: Sub | undefined;
  await until(page, async () => {
    mine = (await subs(page)).find((s) => !before.has(s.id));
    return !!mine;
  }, 'the copy in the copier', 20_000);
  return mine!;
}

h.test('every rule the window offers is what the copy runs with', async ({ page, wallet }) => {
  await connectWallet(page);
  const c = copy(page);
  await c.open();
  const leader = ((await c.modal.getByRole('heading', { level: 2 }).textContent()) ?? '').match(/0x[0-9a-f]{4}/i)![0]!.toLowerCase();

  // Sizing: % of their size, 25 %.
  await c.modal.getByRole('group', { name: 'Sizing' }).getByRole('button', { name: '% of their size', exact: true }).click();
  await typeInto(box(c, 'Percent of their size'), '25');
  // Limits.
  await typeInto(box(c, 'Max leverage'), '2');
  await typeInto(box(c, 'Max position'), '1000');
  await typeInto(box(c, 'Slippage cap'), '20');
  // Behaviour: existing positions too; paper.
  await sw(c, 'Only copy newly opened positions').uncheck();
  await sw(c, 'Paper copy').check();
  // Risk controls and markets.
  await openRisk(c);
  await typeInto(box(c, 'Stop loss'), '20');
  await typeInto(box(c, 'Take profit'), '50');
  await typeInto(box(c, 'Drawdown stop'), '10');
  await typeInto(box(c, 'Only copy'), 'btc, eth');
  await typeInto(box(c, 'Never copy'), 'sol');
  await sw(c, 'Isolated margin').uncheck();
  // "Ask before each trade" is offered where a person is there to answer: this browser.
  assert.equal(await sw(c, 'Ask before each trade').count(), 0, 'not offered for the executor');
  await c.next();
  await c.place('This browser').check();
  await c.modal.getByRole('button', { name: 'Back', exact: true }).last().click();
  await openRisk(c);
  await sw(c, 'Ask before each trade').check();
  await c.next();
  await typeInto(c.modal.getByLabel('Trade with'), '500');

  const sub = await startPaper(page, c, wallet);
  await toast(page, /^Paper copy of 0x.* started\.$/).waitFor({ state: 'visible' });
  await toast(page, 'Your copies are on the Portfolio page.').waitFor({ state: 'visible' });
  const s = sub.settings;
  assert.equal(sub.mode, 'browser');
  assert.ok(s.leader.address.startsWith(leader), `the trader in the window (${leader})`);
  assert.deepEqual(
    [s.direction, s.sizingMode, s.ratio, s.maxLeverage, s.maxPositionUsd, s.slippageBps, s.copyExisting, s.paper],
    ['copy', 'fixedRatio', 0.25, 2, 1000, 20, true, true],
  );
  assert.deepEqual([s.stopLossPct, s.takeProfitPct, s.drawdownStopPct], [0.2, 0.5, 0.1]);
  assert.deepEqual([s.assetAllow, s.assetDeny], [['BTC', 'ETH'], ['SOL']]);
  assert.deepEqual([s.marginMode, s.approval, s.allocationUsd], ['cross', 'confirm', 500]);
  await page.evaluate((id) => window.__vsTest!.copier.stop(id), sub.id);
}, { path: '/copy', timeout: 150_000 });

h.test('the rules refuse what cannot run, in the units of their fields, and Next / Start say why', async ({ page }) => {
  const c = copy(page);
  await c.open();
  const next = c.modal.getByRole('button', { name: 'Next', exact: true });
  const err = c.modal.locator('.cpy-mfoot__err');

  // The three sizing modes: each shows its own field and its own hint.
  const sizing = c.modal.getByRole('group', { name: 'Sizing' });
  assert.equal(await sizing.getByRole('button', { name: 'Mirror', exact: true }).getAttribute('aria-pressed'), 'true', 'Mirror by default');
  await c.modal.getByText('Mirror the leader as a share of equity: your allocation over theirs.').waitFor({ state: 'visible' });
  await sizing.getByRole('button', { name: '$ per trade', exact: true }).click();
  await box(c, 'Per trade').waitFor({ state: 'visible' });
  await c.modal.getByText('The same dollar amount on every copied open; scale-outs follow the leader.').waitFor({ state: 'visible' });
  await sizing.getByRole('button', { name: '% of their size', exact: true }).click();
  await box(c, 'Percent of their size').waitFor({ state: 'visible' });
  assert.equal(await box(c, 'Per trade').count(), 0);

  // Max leverage: above 0, at most 50.
  await typeInto(box(c, 'Max leverage'), '0');
  await c.modal.getByRole('alert').filter({ hasText: 'Max leverage must be above 0.' }).first().waitFor({ state: 'visible' });
  assert.ok(await next.isDisabled());
  assert.equal(await next.getAttribute('title'), 'Max leverage must be above 0.');
  await typeInto(box(c, 'Max leverage'), '60');
  await err.filter({ hasText: 'Max leverage can be at most 50.' }).waitFor({ state: 'visible' });
  await typeInto(box(c, 'Max leverage'), '3');
  await until(page, async () => await next.isEnabled(), 'Next on again');

  // A coin on both lists.
  await openRisk(c);
  await typeInto(box(c, 'Only copy'), 'BTC');
  await typeInto(box(c, 'Never copy'), 'btc');
  await err.filter({ hasText: 'BTC is on both lists.' }).waitFor({ state: 'visible' });
  await typeInto(box(c, 'Never copy'), '');

  // A 0,5 % stop loss passes the form and not the copier's rules: said in percent.
  await typeInto(box(c, 'Stop loss'), '0,5');
  await err.filter({ hasText: 'Stop loss must be between 1 % and 100 %.' }).waitFor({ state: 'visible' });
  assert.ok(await next.isDisabled());
  await typeInto(box(c, 'Stop loss'), '50');
  await until(page, async () => await next.isEnabled(), 'Next on again');

  // Step 2: an amount under the $10 minimum - the box is marked and the footer says why, not "Ready".
  await sw(c, 'Paper copy').check();
  await c.next();
  await c.place('This browser').check();
  await typeInto(c.modal.getByLabel('Trade with'), '5');
  await err.filter({ hasText: 'Allocation must be between $10 and $10.000.000.' }).waitFor({ state: 'visible' });
  assert.ok(await c.modal.locator('.cpy-alloc__box').evaluate((el) => el.classList.contains('is-bad')), 'the box is marked');
  assert.ok(await c.modal.getByRole('button', { name: 'Start paper copy', exact: true }).isDisabled());
  await typeInto(c.modal.getByLabel('Trade with'), '1000');

  // Counter-trade: the opposite side, its own start label; the executor refuses it where it cannot.
  await c.modal.getByRole('button', { name: 'Back', exact: true }).last().click();
  await c.modal.getByRole('radiogroup', { name: 'Direction' }).getByRole('radio', { name: 'Counter-trade', exact: true }).click();
  // The window is named by the direction now: "Counter-trade 0x...".
  const counter = page.getByRole('dialog', { name: /^Counter-trade 0x/ });
  await counter.getByText(/^You take the opposite side of every trade/).waitFor({ state: 'visible' });
  await counter.getByRole('button', { name: 'Next', exact: true }).click();
  await counter.getByRole('button', { name: 'Start paper counter-trade', exact: true }).waitFor({ state: 'visible' });
  await counter.getByRole('radiogroup', { name: 'Where the copier runs' }).getByRole('radio', { name: /^ValueDesk executor / }).check();
  // An executor that counter-trades (the local one does) waits for its steps; one that does not says so.
  await until(page, async () => /does not run counter-trades yet|This copier cannot counter-trade\.|Finish the steps on the right first\./.test((await counter.textContent()) ?? ''), 'what the executor says about counter-trading');
  assert.ok(await counter.getByRole('button', { name: 'Start paper counter-trade' }).isDisabled(), 'nothing starts without the wallet');
}, { path: '/copy', timeout: 120_000 });

h.test('a running copy is managed from Portfolio > My copies: Pause, Resume, Activity, Stop (asked first), Stop all', async ({ page, wallet }) => {
  await connectWallet(page);
  const c = copy(page);
  await c.open();
  await sw(c, 'Paper copy').check();
  await c.next();
  await c.place('This browser').check();
  const sub = await startPaper(page, c, wallet);
  // A second one through the test bridge (the same rules, another id), for Stop all.
  const second = await page.evaluate((s) => window.__vsTest!.copier.start(s as never), sub.settings);
  await until(page, async () => (await subs(page)).filter((s) => s.status !== 'stopped').length === 2, 'two copies running');

  // The Portfolio page, in this tab (the copier keeps running): the card, then Manage copies.
  await page.getByRole('link', { name: 'Portfolio', exact: true }).first().click();
  const card = page.getByText('2 paper copies running as well.');
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('button', { name: 'Manage copies', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'My copies' });
  await dlg.waitFor({ state: 'visible' });
  await dlg.getByRole('tab', { name: 'My copies (2)' }).waitFor({ state: 'visible' });
  const row = dlg.locator('tbody tr').filter({ has: page.getByRole('button', { name: `Copy Copy ID ${sub.id}` }) });
  await row.waitFor({ state: 'visible' });
  assert.match((await row.textContent()) ?? '', /This browser · paper/);
  assert.match((await row.textContent()) ?? '', /Copying/);

  // Pause -> Paused, Resume -> Copying.
  await row.getByRole('button', { name: 'Pause', exact: true }).click();
  await until(page, async () => (await statusOf(page, sub.id)) === 'paused', 'paused');
  await row.getByText('Paused', { exact: true }).waitFor({ state: 'visible' });
  await row.getByRole('button', { name: 'Resume', exact: true }).click();
  await until(page, async () => (await statusOf(page, sub.id)) === 'active', 'copying again');

  // Activity: its own tab, with the copy's id and an export.
  await row.getByRole('button', { name: 'Activity', exact: true }).click();
  await dlg.getByRole('tab', { name: /^Activity · 0x/ }).waitFor({ state: 'visible' });
  await dlg.getByRole('button', { name: 'Export CSV', exact: true }).waitFor({ state: 'visible' });
  await dlg.getByRole('tab', { name: /^My copies/ }).click();

  // Stop asks first; "Keep copying" changes nothing.
  await row.getByRole('button', { name: 'Stop', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Stop copying' });
  await ask.waitFor({ state: 'visible' });
  assert.match((await ask.textContent()) ?? '', /Its open positions stay in your SoDEX account/);
  await ask.getByRole('button', { name: 'Keep copying', exact: true }).click();
  await ask.waitFor({ state: 'hidden' });
  assert.equal(await statusOf(page, sub.id), 'active');
  await row.getByRole('button', { name: 'Stop', exact: true }).click();
  await ask.getByRole('button', { name: 'Stop copying', exact: true }).click();
  await until(page, async () => (await statusOf(page, sub.id)) === 'stopped', 'stopped');
  await row.getByText('Stopped', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await row.getByRole('button', { name: 'Pause' }).count(), 0, 'a stopped copy has no Pause');

  // Stop all: the other one, asked first, with the choice to close positions.
  await dlg.getByRole('button', { name: 'Stop all', exact: true }).click();
  const all = page.getByRole('dialog', { name: 'Stop all copies' });
  await all.waitFor({ state: 'visible' });
  await all.getByRole('checkbox', { name: /Also close every copied position at the market/ }).waitFor({ state: 'visible' });
  await all.getByRole('button', { name: 'Stop all', exact: true }).click();
  await toast(page, 'Every copy is stopped.').waitFor({ state: 'visible' });
  await until(page, async () => (await statusOf(page, second)) === 'stopped', 'every copy stopped');
  await dlg.getByRole('tab', { name: 'My copies (0)' }).waitFor({ state: 'visible' });
}, { path: '/copy', timeout: 180_000 });
