/**
 * The Bots section (components/bots/*, bots/routes.ts): the sidebar's Bots group, what Overview shows before a
 * wallet, the executor setup (sign-in, the copy terms with ValueDesk's own first), and a practice market maker
 * from New bot to its own page - start, change settings, the market gate, pause, resume, stop, delete - each one
 * wallet signature ('algo'), nothing else signed; then Explore (every market's estimate, a market's detail, Start
 * bot there) and Savings.
 *
 * Against the dev web the ValueDesk executor is the local one (127.0.0.1:8799): every bot here is a practice
 * run against SoDEX's live book, and nothing reaches SoDEX. Screenshots of each state land in
 * e2e/ui/.out/bots-*.png (with @phone on a phone) for the design review.
 *
 * The section is in dev builds, the beta channel and VITE_BOTS=1 builds (BOTS_ON): run this against the bots dev
 * web (--web http://localhost:5186, the bots worktree, launch config bots-wt-web). Against a build without it the
 * tab is "coming soon", which the first test checks; the others have nothing to do.
 */
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { PHONE, connectWallet, uiSuite, until } from './harness';
import { toast } from './ticket';
import type { TestWallet } from './wallet';

const h = uiSuite(import.meta.filename);
const OUT = join(dirname(fileURLToPath(import.meta.url)), '.out');
const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `bots-${name}${PHONE ? '@phone' : ''}.png`), fullPage: true });

/**
 * Bots > Set up: the bot setup sheet (no executor to pick, no sign-in step of its own) - the terms, worded for
 * bots, whose "Sign and accept" signs in to the executor as well; nothing of the copy setup shows.
 */
async function setUp(page: Page, wallet: TestWallet): Promise<void> {
  await page.getByRole('button', { name: 'Set up', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Bot setup' });
  await sheet.waitFor({ state: 'visible' });
  await page.waitForTimeout(400);
  await shot(page, 'setup-sheet');
  for (const copyWords of [/Sign in to the ValueDesk executor/, /copy trading terms/, /One signature shows it/, /Pick where the copier runs/]) {
    assert.equal(await sheet.getByText(copyWords).count(), 0, `no copy setup wording: ${copyWords}`);
  }
  const step = (t: string) => sheet.getByRole('listitem').filter({ hasText: t });
  const mark = wallet.mark();
  // Sign in first; with no acceptance on record for this wallet, the terms form opens.
  await step('Accept the terms').getByRole('button', { name: 'Continue', exact: true }).click();
  await sheet.getByRole('checkbox', { name: /^I am at least 18/ }).waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await sheet.getByText(/EU and EEA/).count(), 0, 'no copy leverage note in the bot setup');
  for (const s of [/^I am at least 18/, /^I am not a US person/, /^I chose every bot/, /^I have read the terms and risk disclosure/]) await sheet.getByRole('checkbox', { name: s }).check();
  await sheet.getByRole('button', { name: 'Sign and accept', exact: true }).click();
  const site = page.getByRole('dialog', { name: 'Sign the terms to continue' });
  await site.waitFor({ state: 'visible' });
  await site.getByRole('checkbox', { name: /^I confirm that/ }).check();
  await site.getByRole('button', { name: 'Only necessary', exact: true }).click();
  await toast(page, 'Terms accepted.').waitFor({ state: 'visible', timeout: 30_000 });
  await sheet.getByText('Ready to run bots').waitFor({ state: 'visible', timeout: 20_000 });
  assert.deepEqual(wallet.since(mark).filter((r) => r.outcome === 'signed').map((r) => r.kind), ['copy-sign-in', 'site-terms', 'copy-terms']);
  await sheet.locator('.cs-actions').getByRole('button', { name: 'Close', exact: true }).click();
  await sheet.waitFor({ state: 'hidden' });
}

// A build without the section: Bots is a "coming soon" name in the nav and no page (router.ts SOON_TABS).
/** Demo data is on by default in local builds: these tests use the real executor's bots. */
const realData = async (page: Page) => {
  if (await page.evaluate(() => localStorage.getItem('vd.bots.demo') !== '0')) {
    await page.evaluate(() => localStorage.setItem('vd.bots.demo', '0'));
    await page.reload();
  }
};
const comingSoon = async (page: Page) => {
  await realData(page);
  await page.locator('.navlinks').first().waitFor();
  // Bots is coming soon only when the nav has no link to it (a beta pill on the link is not that).
  return (await page.locator('.navlinks a[href="/bots"]').count()) === 0;
};
const pages = (page: Page) => page.getByRole('navigation', { name: 'Bots pages' });
const go = async (page: Page, name: 'Overview' | 'New bot' | 'Explore' | 'Savings', heading: string) => {
  await pages(page).getByRole('button', { name, exact: true }).click();
  await page.getByRole('heading', { name: heading, exact: true }).waitFor();
};
const signedKinds = (wallet: TestWallet, mark: number) => wallet.since(mark).filter((r) => r.outcome === 'signed').map((r) => r.kind);
const headState = async (page: Page) => (await page.locator('.bots-head .bots-state').first().textContent()) ?? '';

h.test('before a wallet: the sidebar Bots group, Overview, latency, Explore and New bot read without one', async ({ page }) => {
  if (await comingSoon(page)) {
    assert.equal(await page.locator('.navlinks a[href="/bots"]').count(), 0, 'no link to a page that is not there');
    await shot(page, 'soon');
    return;
  }
  await page.getByRole('heading', { name: 'Bots', exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Connect wallet' }).first().isVisible());
  for (const name of ['Market maker', 'Grid']) assert.ok(await page.locator('.bots-strat__name', { hasText: name }).first().isVisible(), name);
  assert.equal(await page.getByText('Volume maker', { exact: true }).count(), 0, 'the volume maker is no longer offered');
  // The latency card: the chart or its empty state, never an error.
  await page.locator('.bots-latcard').waitFor();
  await until(page, async () => (await page.locator('.bots-lat__chart svg, .bots-lat__well').count()) > 0, 'latency drawn or empty', 20_000);
  // Before a wallet: no figures at all, only the wallet's own once it is set up.
  assert.ok(await page.locator('.bots-latcard').getByText(/see how fast your orders reach SoDEX/).isVisible(), 'own bots only');
  assert.equal(await page.locator('.bots-lat__chart svg').count(), 0, 'nobody else\u2019s latency before a wallet');
  await shot(page, 'no-wallet');
  if (!PHONE) {
    // The rail's foot: Bots, New bot, Explore, Savings.
    const rail = page.getByRole('group', { name: 'Bots' });
    for (const name of ['Bots', 'New bot', 'Explore bot markets', 'Bot savings']) assert.ok(await rail.getByRole('button', { name, exact: true }).isVisible(), name);
    await rail.getByRole('button', { name: 'Explore bot markets', exact: true }).click();
    await page.getByRole('heading', { name: 'Explore', exact: true }).waitFor();
    await page.waitForURL((u) => u.pathname === '/bots/explore');
  } else await go(page, 'Explore', 'Explore');
  await page.locator('.bots-xtable tbody tr').first().waitFor({ timeout: 20_000 });
  await shot(page, 'explore');
  await page.getByRole('radio', { name: 'Any activity', exact: true }).click();
  const rows = await page.locator('.bots-xtable tbody tr.bots-row').count();
  assert.ok(rows >= 5, `markets listed: ${rows}`);
  await page.getByRole('searchbox', { name: 'Search markets' }).fill('ETH');
  const eth = page.locator('.bots-xtable tbody tr.bots-row', { hasText: 'ETH' }).first();
  await eth.click();
  await page.locator('.bots-xd').getByText('Weekdays', { exact: true }).waitFor();
  await shot(page, 'explore-eth');
  await eth.getByRole('button', { name: 'Configure bot', exact: true }).click();
  await page.getByRole('heading', { name: 'New bot', exact: true }).waitFor();
  await page.waitForURL((u) => u.pathname === '/bots/new' && u.searchParams.get('market') === 'ETH-USD');
  await until(page, async () => /\$\d/.test((await page.locator('.bots-rc__v').first().textContent()) ?? ''), 'the estimate per $1M', 20_000);
  // From the preset (Explore picked the market): Settings in its three parts, then Review.
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByText('Connect your wallet to start a bot.').waitFor();
  await shot(page, 'new-no-wallet');
  await go(page, 'Savings', 'Savings');
  assert.ok(await page.getByText('No wallet connected').isVisible());
}, { path: '/bots', timeout: 120_000 });

h.test('a practice market maker: set up, New bot with the gate, its page, settings, pause, stop, delete - one signature each', async ({ page, wallet }) => {
  if (await comingSoon(page)) return;
  await connectWallet(page);
  await page.getByRole('heading', { name: 'Bots', exact: true }).waitFor();
  await shot(page, 'setup-needed');
  await setUp(page, wallet);

  // New bot, five steps: bot type (market maker), markets (BTC), preset (the oracle maker, costs on BTC), Settings in
  // three parts (size, quoting, the volatility gate on in Safeguards), then Review and Start.
  await go(page, 'New bot', 'New bot');
  assert.equal(await page.getByRole('radio', { name: 'Market maker', exact: true }).getAttribute('aria-checked'), 'true');
  await shot(page, 'new-0');
  const next = page.getByRole('button', { name: /^Next/ });
  await next.click();
  await page.getByRole('table', { name: 'Markets' }).waitFor({ timeout: 20_000 });
  await page.getByRole('searchbox', { name: 'Search a market' }).fill('BTC');
  // BTC is picked already (the default market): it stays the one market.
  assert.equal(await page.getByRole('checkbox', { name: 'BTC-USD', exact: true }).first().getAttribute('aria-checked'), 'true');
  await shot(page, 'new-2');
  await next.click();
  assert.equal(await page.getByRole('radio', { name: 'Oracle maker', exact: true }).getAttribute('aria-checked'), 'true');
  assert.ok((await page.locator('.bots-rrow').count()) >= 5, 'several market makers to pick from');
  assert.ok((await page.locator('.bots-rrow').first().textContent())?.includes('on BTC'), 'the presets cost the picked market');
  // For someone who reads only the cost: the best bot is on top and no bot below it shows a lower cost.
  const costs = await page.locator('.bots-rrow').evaluateAll((els) => els.map((e) => ({ best: e.classList.contains('is-best'), v: ((t) => (t.startsWith('+') ? -1 : 1) * Number(t.replace(/[^0-9.]/g, '')))(e.querySelector('.bots-strow__n b')?.textContent ?? '') })));
  if (costs.some((c) => c.best)) {
    assert.ok(costs[0]!.best, 'the best bot comes first');
    assert.ok(costs.every((c) => Number.isNaN(c.v) || c.v >= costs[0]!.v), `no cheaper bot below the best: ${JSON.stringify(costs)}`);
  }
  await shot(page, 'new-1');
  await next.click();
  await page.getByText('Order size', { exact: true }).first().waitFor();
  assert.ok(await page.getByRole('switch', { name: 'Practice' }).isDisabled(), 'real orders are off for this wallet: practice only');
  await next.click();
  await page.getByRole('button', { name: /Advanced settings/ }).waitFor();
  assert.ok(await page.getByText('Follow the oracle', { exact: true }).isVisible(), 'quoting reads the oracle');
  await next.click();
  const before = (await page.locator('.bots-rc__v').textContent()) ?? '';
  const gate = page.getByRole('switch', { name: 'Volatility gate' });
  await gate.click();
  await until(page, async () => (await gate.getAttribute('aria-checked')) === 'true', 'gate on');
  // The gate is a line of the estimate now (read on this market's calm minutes).
  await until(page, async () => (await page.locator('.bots-rc__line', { hasText: 'Volatility gate' }).count()) === 1, 'the gate in the estimate');
  assert.ok(before.length > 0);
  // Trading hours: the hourly-move chart, a session preset, and the mode said plainly.
  await page.getByRole('switch', { name: 'Trading hours' }).click();
  await page.getByRole('img', { name: /How much the price moves at each hour/ }).waitFor();
  assert.ok(await page.getByText('Skip set hours', { exact: true }).isVisible());
  await until(page, async () => (await page.locator('.bots-rc__line', { hasText: 'Pause hours' }).count()) === 1, 'the hours in the estimate');
  await shot(page, 'new-3');
  await page.getByRole('switch', { name: 'Trading hours' }).click();
  await next.click();
  await until(page, async () => (await page.locator('.bots-rc__guard.is-on', { hasText: 'Volatility gate' }).count()) === 1, 'the receipt shows the gate on');
  await shot(page, 'new');
  let mark = wallet.mark();
  await page.getByRole('button', { name: 'Start practice bot', exact: true }).click();
  // Start asks first, with what starts.
  await page.getByRole('dialog', { name: /^Start / }).getByRole('button', { name: 'Start practice bot', exact: true }).click();
  await page.waitForURL((u) => /^\/bots\/[^/]+$/.test(u.pathname) && !['/bots/new', '/bots/explore', '/bots/savings'].includes(u.pathname), { timeout: 30_000 });
  assert.deepEqual(signedKinds(wallet, mark), ['algo'], 'one signature to start');
  const first = new URL(page.url()).pathname.split('/')[2]!;

  // Its page: running, the gate in its line, its own latency card.
  await until(page, async () => (await headState(page)).includes('Running'), 'it runs', 30_000);
  assert.ok(await page.locator('.bots-head').getByText('Gate on', { exact: true }).first().isVisible());
  assert.ok(await page.locator('.bots-latcard').first().isVisible(), 'the bot has its latency card');
  await page.waitForTimeout(6_000);
  await shot(page, 'bot');

  // Settings: the Settings tab is the form itself; a change is applied by Clean restart (the recommended button), one signature.
  await page.locator('.bots-head').getByRole('button', { name: 'Edit settings', exact: true }).click();
  const sp = page.locator('.bots-settingspage');
  await sp.waitFor();
  await sp.getByRole('textbox', { name: 'Order size', exact: true }).fill('15');
  await sp.getByRole('tab', { name: /Safeguards/ }).click();
  assert.equal(await sp.getByRole('switch', { name: 'Volatility gate' }).getAttribute('aria-checked'), 'true', 'it shows what runs: the gate on');
  await sp.getByRole('switch', { name: 'Volatility gate' }).click();
  // The size, the holding that follows it, and the gate.
  await until(page, async () => /[2-9] changes/.test((await page.locator('.bots-restartbar').textContent()) ?? ''), 'the changes counted');
  await page.waitForTimeout(400);
  await shot(page, 'restart');
  mark = wallet.mark();
  await page.locator('.bots-restartbar').getByRole('button', { name: /Clean restart/ }).click();
  await page.waitForURL((u) => /^\/bots\/[^/]+$/.test(u.pathname) && u.pathname !== `/bots/${first}`, { timeout: 30_000 });
  assert.deepEqual(signedKinds(wallet, mark), ['algo'], 'one signature to restart');
  const id = new URL(page.url()).pathname.split('/')[2]!;
  await until(page, async () => (await headState(page)).includes('Running'), 'the new one runs', 40_000);
  assert.equal(await page.locator('.bots-head').getByText('Gate on', { exact: true }).count(), 0, 'the gate is off');

  // Pause and resume.
  const head = page.locator('.bots-head');
  mark = wallet.mark();
  await head.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('dialog', { name: /^Pause / }).getByRole('button', { name: 'Pause bot', exact: true }).click();
  await head.getByRole('button', { name: 'Resume', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  await head.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('dialog', { name: /^Resume / }).getByRole('button', { name: 'Resume bot', exact: true }).click();
  await head.getByRole('button', { name: 'Pause', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  assert.deepEqual(signedKinds(wallet, mark), ['algo', 'algo']);
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await page.locator('.bots-log li').first().waitFor({ state: 'visible', timeout: 20_000 });
  await shot(page, 'activity');

  // The overview lists it; search finds it and misses well.
  await go(page, 'Overview', 'Bots');
  const row = page.locator('.bots-row.is-running').filter({ hasText: 'BTC' }).first();
  await row.waitFor({ state: 'visible' });
  await page.getByRole('searchbox', { name: 'Search bots' }).fill('zzz');
  await page.getByText('No bot matches').waitFor();
  await page.getByRole('searchbox', { name: 'Search bots' }).fill('BTC');
  await row.waitFor({ state: 'visible' });
  await shot(page, 'overview');

  // Stop from its page (what it holds is closed: a second stop ends it at once), then delete.
  await row.click();
  await page.waitForURL((u) => u.pathname === `/bots/${id}`);
  await head.getByRole('button', { name: /^Stop( and close)?$/ }).click();
  const confirmStop = page.getByRole('dialog', { name: /^Stop / });
  if (await confirmStop.isVisible({ timeout: 3_000 }).catch(() => false)) await confirmStop.getByRole('button', { name: 'Stop bot', exact: true }).click();
  await until(page, async () => /Stopped|Closing/.test(await headState(page)), 'stopped or closing', 30_000);
  if (/Closing/.test(await headState(page))) {
    await head.getByRole('button', { name: 'Stop now', exact: true }).click();
    await page.getByRole('dialog', { name: /^Stop / }).getByRole('button', { name: 'Stop bot', exact: true }).click();
    await until(page, async () => /Stopped/.test(await headState(page)), 'stopped at once', 30_000);
  }
  await shot(page, 'stopped');
  await head.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog', { name: /^Delete / }).getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForURL((u) => u.pathname === '/bots', { timeout: 20_000 });
  await page.getByRole('heading', { name: 'Bots', exact: true }).waitFor();

  // Savings, with a wallet: the fee tier, staking and the bots' cards.
  await go(page, 'Savings', 'Savings');
  for (const t of ['Fee tier', 'Staking', 'Your bots']) await page.getByText(t, { exact: true }).first().waitFor();
  await shot(page, 'savings');

  // A new browser for the same wallet (nothing kept here): one sign-in signature, the terms are not asked again.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('vd.copy.terms:')) localStorage.removeItem(k);
    sessionStorage.clear();
  });
  await page.reload();
  await go(page, 'Overview', 'Bots');
  await page.getByRole('button', { name: 'Set up', exact: true }).first().click();
  const again = page.getByRole('dialog', { name: 'Bot setup' });
  await again.waitFor({ state: 'visible' });
  mark = wallet.mark();
  await again.getByRole('listitem').filter({ hasText: 'Accept the terms' }).getByRole('button', { name: 'Continue', exact: true }).click();
  await again.getByText('Ready to run bots').waitFor({ state: 'visible', timeout: 30_000 });
  assert.deepEqual(signedKinds(wallet, mark), ['copy-sign-in'], 'returning wallet: sign in only, no second terms signature');
  assert.equal(await again.getByRole('checkbox', { name: /^I am at least 18/ }).count(), 0, 'no terms form');
}, { path: '/bots', timeout: 300_000 });
