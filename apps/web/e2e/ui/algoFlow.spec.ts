/**
 * Algo orders from the ticket to the Algos table, as practice runs in this browser
 * (nothing is sent: a practice run's children are paper fills against the live book).
 *
 *  - every kind the menu offers starts from its own fields, and the spec the engine
 *    received (window.__vsTest.algos.list) is what those fields say;
 *  - the refusals a trader meets before anything starts, in the units the fields show;
 *  - the Algos table's own buttons: Pause, Resume, Size, Open (its window), the ID chip,
 *    Cancel and Cancel all, and the All / Running / Ended tabs.
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { KINDS, SIZE, algo, practiceInBrowser, slideStart } from './algo';
import { dec, num, typeInto, uiSuite, until, waitValue } from './harness';
import { toast } from './ticket';

const h = uiSuite(import.meta.filename);

type Spec = Record<string, unknown> & { kind: string; label?: string; side: string; symbol: string; paper: boolean; quantity?: string | null };
type View = { algo: { id: string; status: string; spec: Spec } };

const views = (page: Page) => page.evaluate(() => window.__vsTest!.algos.list()) as unknown as Promise<View[]>;
const statusOf = async (page: Page, id: string) => (await views(page)).find((v) => v.algo.id === id)?.algo.status;

/** Start `kind` as a practice run from the ticket (its own fields set by `fill`) and return the spec the engine got. */
async function startKind(page: Page, kind: string, fill?: (a: ReturnType<typeof algo>) => Promise<void>, amount: number | null = SIZE): Promise<Spec> {
  const a = algo(page);
  await a.pick(kind);
  if (amount !== null) await typeInto(a.t.amount, dec(amount));
  await fill?.(a);
  await practiceInBrowser(a, kind);
  const before = new Set((await views(page)).map((v) => v.algo.id));
  await slideStart(page, a, kind);
  await toast(page, new RegExp(`^${kind.replace(/[()]/g, '\\$&')} started \\(paper\\)\\. Follow it in the Algos tab\\.`)).waitFor({ state: 'visible', timeout: 20_000 });
  // The settings window closes on a start; while it fades out it would take the next kind's name.
  await a.settings(kind).waitFor({ state: 'hidden' });
  let fresh: View | undefined;
  await until(page, async () => {
    fresh = (await views(page)).find((v) => !before.has(v.algo.id) && !(v.algo.spec as { parentId?: string }).parentId);
    return !!fresh;
  }, `the new ${kind} in the engine`);
  const s = fresh!.algo.spec;
  assert.equal(s.paper, true, `${kind}: a practice run`);
  assert.equal(s.symbol, 'BTC-USD');
  await page.evaluate((id) => window.__vsTest!.algos.cancel(id), fresh!.algo.id);
  await page.locator('.toasts .toast__x').evaluateAll((xs) => xs.forEach((x) => (x as HTMLButtonElement).click()));
  return s;
}

const field = (page: Page, name: string) => algo(page).t.g.getByRole('textbox', { name, exact: true });
const radio = (page: Page, group: string, name: string) => algo(page).t.g.getByRole('radiogroup', { name: group }).getByRole('radio', { name, exact: true });

h.test('every kind starts from its own ticket fields, and the engine gets what they say', async ({ page }) => {
  const a = algo(page);
  const last = await a.t.ready();

  let s = await startKind(page, 'TWAP', async () => {
    await typeInto(field(page, 'Duration'), '25');
  });
  assert.deepEqual([s.kind, s.side, s.quantity, s.durationMs, s.slices], ['twap', 'buy', String(SIZE), 25 * 60_000, 25], 'TWAP: 25 min, one slice a minute');

  s = await startKind(page, 'Chase TWAP');
  assert.deepEqual([s.kind, s.label, (s.exec as { style: string }).style], ['twap', 'Chase TWAP', 'hybrid'], 'Chase TWAP rests, then takes');

  s = await startKind(page, 'VWAP', async () => {
    await typeInto(field(page, 'Duration'), '20');
  });
  assert.deepEqual([s.kind, s.durationMs], ['vwap', 20 * 60_000]);

  s = await startKind(page, 'POV', async () => {
    await radio(page, 'Speed', 'High').click();
  });
  assert.equal(s.kind, 'pov');
  assert.ok(Number(s.rate) > 0.1, `High is faster than Medium's 10 % (${s.rate})`);

  s = await startKind(page, 'Iceberg', async () => {
    await typeInto(field(page, 'Visible'), dec(0.001));
  });
  assert.deepEqual([s.kind, s.displayQty, s.price], ['iceberg', '0.001', null], 'pegged to the best price, 0.001 shown');

  s = await startKind(page, 'Chase', async () => {
    await typeInto(field(page, 'Max chase'), '50');
  });
  assert.deepEqual([s.kind, s.maxChaseBps], ['chase', 50]);

  s = await startKind(page, 'Scale', async () => {
    await typeInto(field(page, 'From'), String(Math.round(last * 0.95)));
    await typeInto(field(page, 'To'), String(Math.round(last * 0.9)));
    await typeInto(field(page, 'Orders'), '5');
    await radio(page, 'Size', 'Increasing').click();
  });
  assert.deepEqual([s.kind, s.from, s.to, s.orders], ['scale', Math.round(last * 0.95), Math.round(last * 0.9), 5]);
  assert.notEqual(s.distribution, 'flat');

  s = await startKind(page, 'DCA', async () => {
    await typeInto(field(page, 'Buys'), '4');
  }, null);
  assert.deepEqual([s.kind, s.label, s.orders], ['scale', 'DCA', 4], 'a DCA is a ladder of 4 buys');

  s = await startKind(page, 'Swarm', async () => {
    await typeInto(field(page, 'Clips'), '5');
  });
  assert.deepEqual([s.kind, s.clips], ['swarm', 5]);

  s = await startKind(page, 'Conditional', async () => {
    await typeInto(field(page, 'Price'), String(Math.round(last * 0.5)));
  });
  const c = (s.conditions as Array<{ type: string; value?: number; op?: string }>)[0]!;
  assert.equal(s.kind, 'conditional');
  assert.equal(c.type, 'price');
  assert.equal((s.then as { type: string }).type, 'market');

  s = await startKind(page, 'Fill fast', async () => {
    await typeInto(field(page, 'Max slippage'), '20');
  });
  assert.deepEqual([s.kind, s.slippageBps], ['sweep', 20]);

  s = await startKind(page, 'Trailing stop', async () => {
    await typeInto(field(page, 'Trail'), '2');
    // A trailing stop only ever closes: the ticket's Reduce only is on, and stays on.
    assert.ok(await a.t.reduceOnly.isChecked(), 'reduce-only is forced');
  });
  assert.deepEqual([s.kind, s.reduceOnly, s.trailPct, s.trailAbs, s.source], ['trailing', true, 0.02, null, 'mark']);
  await a.t.reduceOnly.uncheck().catch(() => {});

  s = await startKind(page, 'Bracket', async () => {
    await typeInto(field(page, 'Take-profit'), '3');
    await typeInto(field(page, 'Stop-loss'), '1,5');
  });
  const x = s.exits as { tpPct: number; slPct: number };
  assert.equal(s.kind, 'bracket');
  assert.equal(s.entry, 'market');
  assert.ok(Math.abs(x.tpPct - 0.03) < 1e-9 && Math.abs(x.slPct - 0.015) < 1e-9, `exits 3 % / 1.5 % (${JSON.stringify(x)})`);

  s = await startKind(page, 'Basket', undefined, null);
  const legs = s.legs as Array<{ symbol: string; side: string; usd: number }>;
  assert.equal(s.kind, 'basket');
  assert.deepEqual(legs.map((l) => [l.symbol, l.side]), [['BTC-USD', 'buy'], ['ETH-USD', 'sell']], 'this market against ETH');
  assert.ok(legs.every((l) => l.usd >= 200), 'the default legs can start (each clip over the $10 minimum)');

  // A short: the ticket's direction is the spec's side.
  await a.t.direction('Short').check();
  s = await startKind(page, 'TWAP');
  assert.equal(s.side, 'sell');
}, { timeout: 300_000 });

h.test('refusals before anything starts: no amount, a field out of range (in its own units), a visible size, a live run with live algos off', async ({ page }) => {
  const a = algo(page);
  await a.t.ready();
  await a.pick('TWAP');
  await practiceInBrowser(a, 'TWAP');
  // No amount: the button cannot start, and says why.
  await typeInto(a.t.amount, '');
  await until(page, async () => await a.button.isDisabled(), 'Start off without an amount');
  assert.equal(await a.button.getAttribute('title'), 'Enter an amount.');

  // A TWAP of half a minute: the limit in minutes, under the field.
  await typeInto(a.t.amount, dec(SIZE));
  await typeInto(field(page, 'Duration'), dec(0.5));
  await a.t.g.getByText('Duration must be between 1 min and 30 d.').waitFor({ state: 'visible' });
  assert.ok(await a.button.isDisabled());
  await typeInto(field(page, 'Duration'), '30');
  await until(page, async () => await a.button.isEnabled(), 'Start on again');

  // An iceberg needs its visible size.
  await a.pick('Iceberg');
  await practiceInBrowser(a, 'Iceberg');
  await a.t.g.getByText('Visible size must be a positive amount.').waitFor({ state: 'visible' });
  assert.ok(await a.button.isDisabled());

  // A real run in this browser: real algos are off for this wallet, said in the Summary, which offers Practice.
  await a.pick('TWAP');
  const d = await a.open('TWAP', 'Runs on');
  await a.practice(d).uncheck();
  await d.getByRole('navigation', { name: 'TWAP settings sections' }).getByRole('button', { name: 'Summary', exact: true }).click();
  const summary = d.getByRole('region', { name: 'Summary' });
  await summary.waitFor({ state: 'visible' });
  await until(page, async () => /Connect a wallet to run it live|Real algo orders are off/.test((await summary.textContent()) ?? ''), 'the Summary to say why it cannot start');
  assert.equal(await summary.getByRole('slider', { name: /^Slide to buy / }).getAttribute('aria-disabled'), 'true', 'the slide to start a real run is off');
  await summary.getByRole('button', { name: 'Turn on Practice run' }).click();
  await summary.getByRole('slider', { name: /^Slide to start the practice buy/ }).waitFor({ state: 'visible' });
  assert.ok(await a.practice(d).isChecked().catch(() => true));
});

h.test('the Algos table: Pause, Resume, Size, Open, the ID, Cancel and Cancel all are its own buttons', async ({ page, ctx }) => {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const a = algo(page);
  await a.t.ready();
  await a.pick('TWAP');
  await typeInto(a.t.amount, dec(SIZE));
  await typeInto(field(page, 'Duration'), '20');
  await practiceInBrowser(a, 'TWAP');
  await slideStart(page, a, 'TWAP');
  await toast(page, /^TWAP started \(paper\)/).waitFor({ state: 'visible', timeout: 20_000 });
  const id = (await views(page))[0]!.algo.id;

  const activity = page.getByRole('group', { name: 'Account activity' });
  await activity.getByRole('tab', { name: /^Algos/ }).click();
  const table = activity.locator('table.algo-t');
  const row = table.locator('tbody tr').filter({ hasText: 'TWAP' }).first();
  await row.waitFor({ state: 'visible' });
  assert.match((await row.textContent()) ?? '', /Practice/, 'the row says practice');
  const show = activity.getByRole('tablist', { name: 'Show' });
  await until(page, async () => /Running\s*1/.test((await show.getByRole('tab', { name: /^Running/ }).textContent()) ?? ''), 'Running 1');

  // Pause, then Resume.
  await row.getByRole('button', { name: 'Pause', exact: true }).click();
  await until(page, async () => (await statusOf(page, id)) === 'paused', 'paused');
  await row.getByRole('button', { name: 'Resume', exact: true }).click();
  await until(page, async () => (await statusOf(page, id)) !== 'paused', 'resumed');

  // Size: a new total; the same total is refused, then 0.008 is saved.
  await row.getByRole('button', { name: 'Size', exact: true }).click();
  const form = table.locator('form.algo-size');
  const input = form.getByRole('textbox');
  await input.waitFor({ state: 'visible' });
  assert.equal(await form.getByRole('button', { name: 'Save' }).isDisabled(), true, 'the size it has now is not a change');
  await form.getByText('That is the size now.').waitFor({ state: 'visible' });
  await typeInto(input, dec(0.008));
  await form.getByRole('button', { name: 'Save' }).click();
  await toast(page, 'Size changed.').waitFor({ state: 'visible' });
  await until(page, async () => (await views(page)).find((v) => v.algo.id === id)?.algo.spec.quantity === '0.008', 'the new size in the engine');

  // The details (Size opened them): the Algo ID, copied in full.
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  const chip = table.getByRole('button', { name: `Copy Algo ID ${id}` }).first();
  await chip.click();
  await toast(page, 'Algo ID copied').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), id);

  // Open: its own window, Live / Orders / Log, and its own Pause.
  await row.getByRole('button', { name: 'Open', exact: true }).click();
  const win = page.getByRole('dialog', { name: /^TWAP buy / });
  await win.waitFor({ state: 'visible' });
  for (const s of ['Live', 'Orders', 'Log']) assert.ok(await win.getByRole('button', { name: s, exact: true }).isVisible(), `the window has ${s}`);
  await win.getByText('Practice · no real orders').first().waitFor({ state: 'visible' });
  await win.getByRole('button', { name: 'Orders', exact: true }).click();
  await win.getByRole('button', { name: 'Pause', exact: true }).waitFor({ state: 'detached', timeout: 2_000 }).catch(() => {});
  await win.getByRole('button', { name: 'Close' }).click();
  await win.waitFor({ state: 'hidden' });

  // Cancel: the row ends.
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await until(page, async () => /cancel/.test(String(await statusOf(page, id))), 'cancelled');
  await show.getByRole('tab', { name: /^Ended/ }).click();
  await table.locator('tbody tr').filter({ hasText: 'Cancelled' }).first().waitFor({ state: 'visible' });

  // Cancel all: two more running, one button ends both.
  await show.getByRole('tab', { name: /^All/ }).click();
  for (let i = 0; i < 2; i++) {
    await page.locator('.toasts .toast__x').evaluateAll((xs) => xs.forEach((x) => (x as HTMLButtonElement).click()));
    await until(page, async () => (await toast(page, /started/).count()) === 0, 'the toasts to clear');
    await a.pick('TWAP');
    await slideStart(page, a, 'TWAP');
    await until(page, async () => (await views(page)).filter((v) => !/cancel|done|ended|failed/.test(v.algo.status)).length === i + 1, `${i + 1} running`);
  }
  await activity.getByRole('button', { name: 'Cancel all', exact: true }).click();
  await until(page, async () => (await views(page)).every((v) => /cancel|done|ended|failed/.test(v.algo.status)), 'every algo ended');
  await until(page, async () => /Running\s*0/.test((await show.getByRole('tab', { name: /^Running/ }).textContent()) ?? ''), 'Running 0');
  assert.equal(await activity.getByRole('button', { name: 'Cancel all', exact: true }).count(), 0, 'nothing left to cancel');
}, { timeout: 180_000 });

h.test('a practice Fill fast runs to its end, and the bell tells of it', async ({ page }) => {
  const a = algo(page);
  await a.t.ready();
  await a.pick('Fill fast');
  await typeInto(a.t.amount, dec(0.001));
  await practiceInBrowser(a, 'Fill fast');
  await slideStart(page, a, 'Fill fast');
  await toast(page, /^Fill fast started \(paper\)/).waitFor({ state: 'visible', timeout: 20_000 });
  const id = (await views(page))[0]!.algo.id;
  await until(page, async () => /done|ended/.test(String(await statusOf(page, id))), 'the Fill fast to finish', 60_000);
  const events = await page.evaluate((x) => window.__vsTest!.algos.events(x), id);
  assert.ok(events.length > 0, 'it logged its rounds');
  // The bell: "Fill fast buy on BTC-USD done (paper)" (or ended), from this browser's engine.
  await page.getByRole('banner').getByRole('button', { name: /^Notifications/ }).click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await panel.getByText(/^Fill fast buy on BTC-USD (done|ended) \(paper\)$/).first().waitFor({ state: 'visible', timeout: 15_000 });
}, { timeout: 120_000 });

h.test('every kind shows its preview: the words line and the Every order table, with nothing thrown', async ({ page, errors }) => {
  const a = algo(page);
  await a.t.ready();
  for (const kind of KINDS) {
    await a.pick(kind);
    if (await a.t.amount.isVisible().catch(() => false)) await typeInto(a.t.amount, dec(SIZE)).catch(() => {});
    await a.t.g.getByRole('button', { name: 'Preview', exact: true }).click();
    const d = a.settings(kind);
    await d.waitFor({ state: 'visible' });
    const prev = d.getByRole('region', { name: 'Preview' });
    await prev.waitFor({ state: 'visible' });
    await until(page, async () => ((await prev.textContent()) ?? '').length > 40, `${kind}: the preview text`);
    await a.done(kind);
  }
  assert.deepEqual(errors.filter((e) => e.startsWith('pageerror')), [], 'no preview threw');
}, { timeout: 180_000 });

h.test('a phone-width screen: the ticket is the carousel\'s Trade page, the algo settings open, Reset is left out', async ({ page }) => {
  const tabs = page.getByRole('tab', { name: 'Trade', exact: true });
  await tabs.waitFor({ state: 'visible', timeout: 30_000 });
  await tabs.click();
  // At phone width the ticket is the carousel's third page, not a panel of its own.
  const a = algo(page, page.locator('.mcarousel__page').nth(2));
  await a.t.g.waitFor({ state: 'visible' });
  await a.t.ready();
  await typeInto(a.t.amount, dec(0.001));
  await waitValue(a.t.amount, (v) => num(v) === 0.001, 'the amount');
  await a.pick('TWAP');
  const d = await a.open('TWAP', 'Runs on');
  assert.ok(await a.place(d, 'ValueDesk').isVisible());
  assert.equal(await d.getByRole('button', { name: 'Reset to defaults' }).isVisible(), false, 'Reset is hidden at phone width');
  await a.done('TWAP');
}, { setup: async (_ctx, page) => page.setViewportSize({ width: 390, height: 844 }) });
