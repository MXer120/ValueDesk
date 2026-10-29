/**
 * The algo ticket (components/algo/AlgoTicket.tsx, draft.ts) inside the order ticket:
 * every kind, where it runs (ValueDesk by default, this browser, self-hosted),
 * practice against real, the exits - and a practice run started from the ticket,
 * which the test bridge (window.__vsTest) then sees, pauses and cancels.
 *
 * Practice only. A practice run sends nothing; no test here turns practice off and starts.
 */
import assert from 'node:assert/strict';
import { KINDS, SIZE, algo, practiceInBrowser, slideStart } from './algo';
import { dec, typeInto, uiSuite, until, waitValue } from './harness';
import { toast } from './ticket';

const h = uiSuite(import.meta.filename);

h.test('the Algo menu offers every kind, and each opens its own settings', async ({ page, errors }) => {
  const a = algo(page);
  await a.t.ready();
  await a.tab.click();
  await a.menu.waitFor({ state: 'visible' });
  const offered = (await a.menu.getByRole('option').allTextContents()).map((s) => s.trim());
  assert.deepEqual(offered, KINDS);
  await page.keyboard.press('Escape');
  for (const kind of KINDS) {
    await a.pick(kind);
    const d = await a.open(kind);
    await d.getByRole('heading', { name: `${kind} settings`, level: 2 }).waitFor({ state: 'visible' });
    const sections = (await d.getByRole('navigation', { name: `${kind} settings sections` }).getByRole('button').allTextContents()).map((s) => s.trim());
    for (const s of ['Order', 'Runs on', 'Summary']) assert.ok(sections.includes(s), `${kind} has a ${s} section (has: ${sections.join(', ')})`);
    await a.done(kind);
  }
  assert.deepEqual(errors.filter((e) => e.startsWith('pageerror')), [], 'no kind threw');
});

h.test('runs on the ValueDesk executor by default; this browser and self-hosted can be picked', async ({ page }) => {
  const a = algo(page);
  await a.t.ready();
  await a.pick('TWAP');
  // Not set up (no wallet, no executor sign-in): the button says so instead of starting.
  await waitValue(a.button, /ValueDesk executor not set up/, 'the hosted executor note');
  assert.ok(await a.button.isDisabled());

  const d = await a.open('TWAP', 'Runs on');
  assert.ok(await a.place(d, 'ValueDesk').isChecked(), 'ValueDesk is the default');
  assert.ok(!(await a.practice(d).isChecked()), 'practice is a choice, off until picked');
  await a.place(d, 'Self-hosted').check();
  assert.ok(await a.place(d, 'Self-hosted').isChecked());
  await a.place(d, 'This browser').check();
  assert.ok(await a.place(d, 'This browser').isChecked());
  await a.done('TWAP');
  // This browser, real orders: a wallet is needed before anything can be signed.
  await waitValue(a.button, (v) => !/ValueDesk executor/.test(v), 'the button to stop naming the executor');
  assert.match(await a.t.value(a.button), /Connect wallet|Enable trading|trading key|practice/i);
});

h.test('practice vs real: a practice run in this browser needs no wallet', async ({ page }) => {
  const a = algo(page);
  await a.t.ready();
  await a.pick('TWAP');
  await typeInto(a.t.amount, dec(SIZE));
  await practiceInBrowser(a, 'TWAP');
  // The button says practice ("paper") and can start without a wallet.
  await waitValue(a.button, /^Start TWAP \(paper\) · Long$/, 'Start TWAP (paper)');
  await until(page, async () => await a.button.isEnabled(), 'the Start button');

  // Practice off again: real orders, so the wallet is asked for again.
  const d = await a.open('TWAP', 'Runs on');
  await a.practice(d).uncheck();
  await a.done('TWAP');
  await waitValue(a.button, (v) => !v.includes('(paper)'), 'the button to drop (paper)');
  assert.match(await a.t.value(a.button), /Connect wallet|Enable trading|trading key/i);
});

h.test('exits: the take-profit / stop-loss switch opens its fields', async ({ page }) => {
  const a = algo(page);
  await a.t.ready();
  await a.pick('TWAP');
  await typeInto(a.t.amount, dec(SIZE));
  const d = await a.open('TWAP', 'Exits');
  const exits = d.getByRole('switch', { name: 'Take-profit / stop-loss' });
  assert.ok(!(await exits.isChecked()));
  const region = d.getByRole('region', { name: 'Exits' });
  const before = await region.getByRole('textbox').count();
  await exits.check();
  await until(page, async () => (await region.getByRole('textbox').count()) > before, 'the TP/SL fields');
  await exits.uncheck();
  await until(page, async () => (await region.getByRole('textbox').count()) === before, 'the TP/SL fields to go');
  await a.done('TWAP');
});

h.test('a practice TWAP starts from the ticket, shows in the Algos tab, and the test bridge pauses and cancels it', async ({ page }) => {
  const a = algo(page);
  await a.t.ready();
  await a.pick('TWAP');
  await typeInto(a.t.amount, dec(SIZE));
  await practiceInBrowser(a, 'TWAP');
  await slideStart(page, a, 'TWAP');
  await toast(page, /TWAP started \(paper\)\. Follow it in the Algos tab\./).waitFor({ state: 'visible', timeout: 20_000 });

  // The bridge sees the run this tab works: paper, in this browser, for the paper book (no wallet).
  const views = await page.evaluate(() => window.__vsTest!.algos.list());
  const mine = views.filter((v) => v.algo.spec.paper === true && v.algo.mode === 'browser');
  assert.equal(mine.length, 1, `one practice algo (got ${views.length})`);
  const id = mine[0]!.algo.id;
  assert.equal(await page.evaluate(() => window.__vsTest!.algos.owner()), 'paper');
  assert.equal(await page.evaluate(() => window.__vsTest!.algos.role()), 'runner');

  // The Algos tab lists it.
  const activity = page.getByRole('group', { name: 'Account activity' });
  await activity.getByRole('tab', { name: /^Algos/ }).click();
  await activity.getByText('TWAP').first().waitFor({ state: 'visible' });

  const status = () => page.evaluate((x) => window.__vsTest!.algos.list().then((l) => l.find((v) => v.algo.id === x)?.algo.status), id);
  await page.evaluate((x) => window.__vsTest!.algos.pause(x), id);
  await until(page, async () => (await status()) === 'paused', 'paused');
  await page.evaluate((x) => window.__vsTest!.algos.resume(x), id);
  await until(page, async () => (await status()) !== 'paused', 'resumed');
  await page.evaluate((x) => window.__vsTest!.algos.cancel(x), id);
  await until(page, async () => /cancel/.test(String(await status())), 'cancelled');
  const events = await page.evaluate((x) => window.__vsTest!.algos.events(x), id);
  assert.ok(events.length > 0, 'the run left events');
});

h.test('the test bridge starts, lists and cancels a practice algo on its own (the live suite browser target)', async ({ page }) => {
  const a = algo(page);
  await a.t.ready();
  await a.pick('TWAP');
  await typeInto(a.t.amount, dec(SIZE));
  await practiceInBrowser(a, 'TWAP');
  await slideStart(page, a, 'TWAP');
  await toast(page, /TWAP started \(paper\)/).waitFor({ state: 'visible', timeout: 20_000 });
  // The spec the ticket built, as the engine parsed it, started again through the bridge alone.
  const first = (await page.evaluate(() => window.__vsTest!.algos.list()))[0]!;
  await page.evaluate((x) => window.__vsTest!.algos.cancel(x), first.algo.id);
  const checked = await page.evaluate((s) => window.__vsTest!.algos.check(s), first.algo.spec);
  assert.deepEqual(checked.errors, {}, 'the saved spec still parses');
  const id = await page.evaluate((s) => window.__vsTest!.algos.start(s), checked.spec);
  assert.ok(id && id !== first.algo.id);
  const list = await page.evaluate(() => window.__vsTest!.algos.list());
  assert.ok(list.some((v) => v.algo.id === id && v.algo.spec.paper === true));
  // A live spec is refused by the same gate as the ticket's (liveAlgos.ts): the bridge adds no way around it.
  const live = { ...(checked.spec as Record<string, unknown>), paper: false };
  const refused = await page.evaluate((s) => window.__vsTest!.algos.start(s).then(() => 'started', (e: Error) => e.message), live);
  assert.notEqual(refused, 'started', 'a live algo without a wallet is refused');
  await page.evaluate(() => window.__vsTest!.algos.cancelAll());
});
