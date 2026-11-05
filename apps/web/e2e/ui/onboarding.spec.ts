/**
 * The first-signup flow (src/onboarding/): a new wallet is walked through all of it once; a
 * username is signed and on the server; it resumes where it stopped; Skip ends it; a returning
 * browser never sees it. VS_E2E_ONB_SHOTS=<dir> saves a screenshot of every step, per theme.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { PHONE, uiSuite, until } from './harness';

const h = uiSuite(import.meta.filename);

const SHOTS = process.env.VS_E2E_ONB_SHOTS?.trim();
const flowOf = (page: Page) => page.getByRole('dialog', { name: 'Getting started' });
const newName = () => `e2e_${Math.random().toString(36).slice(2, 10)}`;

async function shot(page: Page, name: string, theme: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(SHOTS, `${name}-${theme}-${PHONE ? 'phone' : 'desktop'}.png`) });
}

/** The dev build's dock comes back open after a reload and floats over everything: gone for good here. */
const noDevDock = (page: Page) => page.addStyleTag({ content: '.devp { display: none !important; }' });

/** Connect through the app's dialog, leaving whatever the wallet's first connect opens on screen. */
async function connect(page: Page): Promise<void> {
  const rail = page.getByRole('complementary', { name: 'Tools' });
  const wide = await rail.getByRole('button', { name: 'Connect wallet' }).isVisible().catch(() => false);
  await (wide ? rail : page.getByRole('banner')).getByRole('button', { name: 'Connect wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: 'MetaMask Installed' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 });
}

const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

/** The pictures on screen arrived. */
async function picturesLoaded(page: Page): Promise<void> {
  await until(page, () => page.evaluate(() => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>('.onb img')].filter((i) => getComputedStyle(i).display !== 'none');
    return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }), 'the pictures to load');
}

async function walk(page: Page, wallet: { address: string; log: Array<{ kind?: string; outcome: string }> }, theme: 'dark' | 'light') {
  const flow = flowOf(page);
  await flow.waitFor({ state: 'visible', timeout: 20_000 });
  await flow.getByRole('heading', { name: 'Set your username' }).waitFor();
  const go = flow.getByRole('button', { name: 'Continue', exact: true });
  const input = flow.getByRole('textbox', { name: 'Your username' });
  assert.equal(await go.isDisabled(), true, 'Continue is dim until a name is valid');
  await shot(page, '1-username', theme);

  await input.fill('sodex_official');
  await flow.getByText('This name is reserved.').waitFor();
  assert.equal(await go.isDisabled(), true);
  await input.fill('ab');
  await flow.getByText('At least 3 characters.').waitFor();
  const name = newName();
  await input.fill(name);
  await flow.getByText('Available').waitFor({ timeout: 10_000 });
  await shot(page, '1-username-valid', theme);
  await go.click();

  // 2: the leaderboard's real rows; Track writes the palette's watchlist.
  await flow.getByRole('heading', { name: 'Track top traders' }).waitFor({ timeout: 20_000 });
  const claim = wallet.log.filter((r) => r.kind === 'username');
  assert.equal(claim.length, 1, 'one signature for the name');
  assert.equal(claim[0]!.outcome, 'signed');
  const answer = await page.evaluate((a) => fetch(`/api/vs/profile?address=${a}`).then((r) => r.json()), wallet.address) as { username: string };
  assert.equal(answer.username, name, 'the server has the name');
  const rows = flow.locator('.onb-tr:not(.onb-tr--head):not(.onb-tr--skeleton)');
  await until(page, async () => (await rows.count()) === 10, 'ten traders');
  const track = rows.nth(1).getByRole('button', { name: /^Track / });
  await track.click();
  await rows.nth(1).getByRole('button', { name: /^Stop tracking / }).waitFor();
  const list = JSON.parse((await stored(page, 'vs.palette.watchlist')) ?? '[]') as unknown[];
  assert.equal(list.length, 1, 'on the watchlist');
  await page.waitForTimeout(SHOTS ? 3500 : 0); // the sparklines
  await shot(page, '2-traders', theme);
  await go.click();

  // 3: the features, on real captures.
  for (const [title, file] of [['Copy the best traders', '3-copy'], ['See where liquidations sit', '4-heatmap'], ['Know who traded every candle', '5-flow']] as const) {
    await flow.getByRole('heading', { name: title }).waitFor();
    await picturesLoaded(page);
    await shot(page, file, theme);
    await go.click();
  }

  // 4: every major, and what is not open to all says so.
  await flow.getByRole('heading', { name: 'Everything in one terminal' }).waitFor();
  assert.equal(await flow.locator('.onb-tile').count(), 12);
  await flow.locator('.onb-tile', { hasText: 'Bots' }).getByText('Coming soon').waitFor();
  await flow.locator('.onb-tile', { hasText: 'Algo orders' }).getByText('Practice').waitFor();
  await shot(page, '6-overview', theme);
  await go.click();

  // 5: dark or light, last, and at once.
  await flow.getByRole('heading', { name: 'Dark or light?' }).waitFor();
  await picturesLoaded(page);
  // The other one first: it flips at once, and back.
  await flow.getByRole('radio', { name: theme === 'light' ? /Dark/ : /Light/ }).click();
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), theme === 'light' ? null : 'light');
  const radio = flow.getByRole('radio', { name: theme === 'light' ? /Light/ : /Dark/ });
  await radio.click();
  assert.equal(await radio.getAttribute('aria-checked'), 'true');
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), theme === 'light' ? 'light' : null);
  await shot(page, '7-theme', theme);
  await flow.getByRole('button', { name: 'Start trading' }).click();
  await flow.waitFor({ state: 'hidden' });
  return name;
}

for (const theme of ['dark', 'light'] as const) {
  h.test(`a new wallet: all of it once, then never again (${theme})`, async ({ page, wallet }) => {
    await noDevDock(page);
    await connect(page);
    const name = await walk(page, wallet, theme);

    assert.match(new URL(page.url()).pathname, /^\/trade/);
    assert.equal(await page.getByRole('dialog', { name: 'Setting up your account' }).isVisible(), false, 'no second wizard');
    assert.equal(await stored(page, 'vs.setup.indexOn'), '1', 'the history is read, as the setup sheets started it');
    assert.equal((await stored(page, 'vs.theme')) ?? 'dark', theme);

    await page.reload({ waitUntil: 'domcontentloaded' });
  await noDevDock(page);
    await page.waitForTimeout(4000);
    assert.equal(await flowOf(page).isVisible(), false, 'it does not come back');
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), theme === 'light' ? 'light' : null, 'the theme stays over a reload');

    // The name, in the address menu.
    if (!PHONE) await page.getByRole('complementary', { name: 'Tools' }).getByRole('button', { name: /^Wallet / }).first().click();
    else await page.getByRole('banner').getByRole('button', { name: /0x[0-9a-f]/i }).first().click();
    await page.locator('.acct-menu__who', { hasText: name }).waitFor({ timeout: 15_000 });
    assert.equal(await page.getByRole('menuitem', { name: 'Set your username' }).count(), 0);
    await shot(page, '8-menu', theme);
  }, { timeout: 180_000, storage: theme === 'light' ? { 'vs.theme': 'light' } : {} });
}

h.test('it resumes at the step it stopped on', async ({ page }) => {
  await noDevDock(page);
  await connect(page);
  const flow = flowOf(page);
  await flow.waitFor({ state: 'visible', timeout: 20_000 });
  await flow.getByRole('textbox', { name: 'Your username' }).fill(newName());
  await flow.getByText('Available').waitFor({ timeout: 10_000 });
  await flow.getByRole('button', { name: 'Continue', exact: true }).click();
  await flow.getByRole('heading', { name: 'Track top traders' }).waitFor({ timeout: 20_000 });
  await flow.getByRole('button', { name: 'Continue', exact: true }).click();
  await flow.getByRole('heading', { name: 'Copy the best traders' }).waitFor();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await noDevDock(page);
  await flowOf(page).getByRole('heading', { name: 'Copy the best traders' }).waitFor({ timeout: 20_000 });
  // Back goes to the traders, not to a name that cannot be taken twice.
  await flowOf(page).getByRole('button', { name: 'Back' }).click();
  await flowOf(page).getByRole('heading', { name: 'Track top traders' }).waitFor();
  assert.equal(await flowOf(page).getByRole('button', { name: 'Back' }).count(), 0, 'the first step left has no back');
}, { timeout: 120_000 });

h.test('Skip ends it for good; the name can still be taken from the address menu', async ({ page, wallet }) => {
  await noDevDock(page);
  await connect(page);
  const flow = flowOf(page);
  await flow.waitFor({ state: 'visible', timeout: 20_000 });
  await flow.getByRole('button', { name: 'Skip' }).click();
  await flow.waitFor({ state: 'hidden' });
  assert.equal(wallet.log.filter((r) => r.kind === 'username').length, 0, 'nothing signed');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await noDevDock(page);
  await page.waitForTimeout(4000);
  assert.equal(await flow.isVisible(), false);

  if (!PHONE) await page.getByRole('complementary', { name: 'Tools' }).getByRole('button', { name: /^Wallet / }).first().click();
  else await page.getByRole('banner').getByRole('button', { name: /0x[0-9a-f]/i }).first().click();
  await page.getByRole('menuitem', { name: 'Set your username' }).dispatchEvent('click');
  await flow.getByRole('heading', { name: 'Set your username' }).waitFor();
  assert.equal(await flow.locator('.onb__steps').count(), 0, 'the username alone: no steps');
  const name = newName();
  await flow.getByRole('textbox', { name: 'Your username' }).fill(name);
  await flow.getByText('Available').waitFor({ timeout: 10_000 });
  await flow.getByRole('button', { name: 'Continue', exact: true }).click();
  await flow.waitFor({ state: 'hidden', timeout: 20_000 });
  const answer = await page.evaluate((a) => fetch(`/api/vs/profile?address=${a}`).then((r) => r.json()), wallet.address) as { username: string };
  assert.equal(answer.username, name);
}, { timeout: 120_000 });

h.test('a browser used before the flow existed never sees it', async ({ page }) => {
  await noDevDock(page);
  await connect(page);
  await page.waitForTimeout(4000);
  assert.equal(await flowOf(page).isVisible(), false);
}, { storage: { 'vs.setup.done': '1' } });

h.test('a declined signature keeps the step, says so, and takes nothing', async ({ page, wallet }) => {
  await noDevDock(page);
  await connect(page);
  const flow = flowOf(page);
  await flow.waitFor({ state: 'visible', timeout: 20_000 });
  wallet.reject.add('username');
  await flow.getByRole('textbox', { name: 'Your username' }).fill(newName());
  await flow.getByText('Available').waitFor({ timeout: 10_000 });
  await flow.getByRole('button', { name: 'Continue', exact: true }).click();
  await flow.locator('.onb-hint.is-no').waitFor({ timeout: 15_000 });
  await flow.getByRole('heading', { name: 'Set your username' }).waitFor();
  const answer = await page.evaluate((a) => fetch(`/api/vs/profile?address=${a}`).then((r) => r.json()), wallet.address) as { username: string | null };
  assert.equal(answer.username, null);
}, { timeout: 90_000 });
