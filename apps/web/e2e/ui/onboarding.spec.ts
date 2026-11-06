/**
 * The first-signup flow (src/onboarding/): a new wallet is walked through all of it once, with no
 * wallet prompt for its first name; it resumes where it stopped; Skip ends it; a returning browser
 * never sees it and gets a green dot on the Settings icon, which leads to Settings > Profile, where a
 * first name needs no signature and a change does. VS_E2E_ONB_SHOTS=<dir> saves every step, per theme.
 *
 * SoDEX's referral reads are real (GET only); the page never binds anything.
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
const profileOf = (page: Page, a: string) => page.evaluate((x) => fetch(`/api/vs/profile?address=${x}`).then((r) => r.json()), a) as Promise<{ username: string | null }>;
/* The wallet on the rail carries the green dot, Settings in its menu; a phone has no rail and keeps the gear. */
const settingsIcon = (page: Page) => page.locator('.side__addr, .settings__btn').first();
const openSettingsRow = async (page: Page) => {
  const rail = await page.locator('.side__addr').first().isVisible();
  await settingsIcon(page).click();
  if (rail) await page.getByRole('menuitem', { name: /^Settings/ }).click();
};

/** The pictures on screen arrived. */
async function picturesLoaded(page: Page): Promise<void> {
  await until(page, () => page.evaluate(() => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>('.onb img')].filter((i) => getComputedStyle(i).display !== 'none');
    return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }), 'the pictures to load');
}

async function walk(page: Page, wallet: { address: string; log: Array<{ kind?: string; method: string; outcome: string }> }, theme: 'dark' | 'light') {
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
  const signsBefore = wallet.log.length;
  await go.click();

  // A new wallet: SoDEX says it has no inviter, so the code is offered, on SoDEX's own page.
  await flow.getByRole('heading', { name: 'Use our SoDEX code' }).waitFor({ timeout: 20_000 });
  assert.equal(wallet.log.length, signsBefore, 'no wallet prompt for a first name');
  assert.equal((await profileOf(page, wallet.address)).username, name, 'the server has the name');
  const apply = flow.getByRole('link', { name: 'Apply on SoDEX' });
  assert.equal(await apply.getAttribute('href'), 'https://sodex.com/join/VALUEDESK');
  assert.equal(await apply.getAttribute('target'), '_blank');
  await shot(page, '2-referral', theme);
  await flow.getByRole('button', { name: 'Not now' }).click();

  // The leaderboard's real rows; Track writes the palette's watchlist.
  await flow.getByRole('heading', { name: 'Track top traders' }).waitFor({ timeout: 20_000 });
  const rows = flow.locator('.onb-tr:not(.onb-tr--head):not(.onb-tr--skeleton)');
  await until(page, async () => (await rows.count()) === 10, 'ten traders');
  await rows.nth(1).getByRole('button', { name: /^Track / }).click();
  await rows.nth(1).getByRole('button', { name: /^Stop tracking / }).waitFor();
  const list = JSON.parse((await stored(page, 'vs.palette.watchlist')) ?? '[]') as unknown[];
  assert.equal(list.length, 1, 'on the watchlist');
  await page.waitForTimeout(SHOTS ? 3500 : 0); // the sparklines
  await shot(page, '3-traders', theme);
  await go.click();

  // The features, on real captures.
  for (const [title, file] of [['Copy the best traders', '4-copy'], ['See where liquidations sit', '5-heatmap'], ['Know who traded every candle', '6-flow']] as const) {
    await flow.getByRole('heading', { name: title }).waitFor();
    await picturesLoaded(page);
    await shot(page, file, theme);
    await go.click();
  }

  // Every major, and what is not open to all says so.
  await flow.getByRole('heading', { name: 'Everything in one terminal' }).waitFor();
  assert.equal(await flow.locator('.onb-tile').count(), 12);
  await flow.locator('.onb-tile', { hasText: 'Bots' }).getByText('Coming soon').waitFor();
  await flow.locator('.onb-tile', { hasText: 'Algo orders' }).getByText('Practice').waitFor();
  await shot(page, '7-overview', theme);
  await go.click();

  // Dark or light, last, and at once.
  await flow.getByRole('heading', { name: 'Dark or light?' }).waitFor();
  await picturesLoaded(page);
  await flow.getByRole('radio', { name: theme === 'light' ? /Dark/ : /Light/ }).click();
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), theme === 'light' ? null : 'light');
  const radio = flow.getByRole('radio', { name: theme === 'light' ? /Light/ : /Dark/ });
  await radio.click();
  assert.equal(await radio.getAttribute('aria-checked'), 'true');
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), theme === 'light' ? 'light' : null);
  await shot(page, '8-theme', theme);
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
    assert.equal(await page.getByRole('menuitem', { name: /username|tour/i }).count(), 0, 'no rows for it in the menu');
    await shot(page, '9-menu', theme);
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
  await flow.getByRole('heading', { name: 'Use our SoDEX code' }).waitFor({ timeout: 20_000 });
  await flow.getByRole('button', { name: 'Not now' }).click();
  await flow.getByRole('heading', { name: 'Track top traders' }).waitFor({ timeout: 20_000 });
  await flow.getByRole('button', { name: 'Continue', exact: true }).click();
  await flow.getByRole('heading', { name: 'Copy the best traders' }).waitFor();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await noDevDock(page);
  await flowOf(page).getByRole('heading', { name: 'Copy the best traders' }).waitFor({ timeout: 20_000 });
  // Back goes on through the steps left; the name is not among them, it is taken.
  await flowOf(page).getByRole('button', { name: 'Back' }).click();
  await flowOf(page).getByRole('heading', { name: 'Track top traders' }).waitFor();
  await flowOf(page).getByRole('button', { name: 'Back' }).click();
  await flowOf(page).getByRole('heading', { name: 'Use our SoDEX code' }).waitFor();
  assert.equal(await flowOf(page).getByRole('button', { name: 'Back' }).count(), 0, 'the first step left has no back');
}, { timeout: 120_000 });

h.test('a skipper gets the green dot; Profile sets a name unsigned and changes it signed; the dot goes', async ({ page, wallet }) => {
  await noDevDock(page);
  await connect(page);
  const flow = flowOf(page);
  await flow.waitFor({ state: 'visible', timeout: 20_000 });
  await flow.getByRole('button', { name: 'Skip' }).click();
  await flow.waitFor({ state: 'hidden' });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await noDevDock(page);
  await page.waitForTimeout(4000);
  assert.equal(await flow.isVisible(), false, 'Skip is for good');
  const dot = page.locator('.settings__dot--go:visible');
  await dot.first().waitFor({ timeout: 15_000 });

  await openSettingsRow(page);
  const stg = page.getByRole('dialog', { name: 'Settings' });
  await stg.getByRole('heading', { name: 'Profile' }).waitFor();
  assert.equal(await stg.getByRole('button', { name: 'Appearance' }).count(), 0, 'Appearance is gone');
  await stg.getByText('No username yet').waitFor();
  await stg.getByRole('button', { name: /^Light/ }).waitFor();
  await stg.getByText('Number format').waitFor();
  await until(page, async () => (await page.locator('.settings__dot--go').count()) === 0, 'the dot to go once Profile is open');
  await shot(page, '10-profile-empty', (await stored(page, 'vs.theme')) ?? 'dark');

  const signed = () => wallet.log.filter((r) => r.kind === 'username').length;
  const first = newName();
  await stg.getByRole('textbox', { name: 'Your username' }).fill(first);
  await stg.getByText('Available').waitFor({ timeout: 10_000 });
  await stg.getByRole('button', { name: 'Save' }).click();
  await stg.getByText(first, { exact: true }).waitFor({ timeout: 15_000 });
  assert.equal(signed(), 0, 'a first name asks the wallet nothing');
  assert.equal((await profileOf(page, wallet.address)).username, first);

  const next = newName();
  await stg.getByRole('textbox', { name: 'New username' }).fill(next);
  await stg.getByText('Available').waitFor({ timeout: 10_000 });
  await shot(page, '11-profile-change', (await stored(page, 'vs.theme')) ?? 'dark');
  await stg.getByRole('button', { name: 'Change' }).click();
  await stg.getByText(next, { exact: true }).waitFor({ timeout: 15_000 });
  assert.equal(signed(), 1, 'a change is signed by the wallet');
  assert.equal(wallet.log.filter((r) => r.kind === 'username')[0]!.outcome, 'signed');
  assert.equal((await profileOf(page, wallet.address)).username, next);
}, { timeout: 120_000 });

h.test('a declined signature changes nothing and says so', async ({ page, wallet }) => {
  await noDevDock(page);
  await connect(page);
  const flow = flowOf(page);
  await flow.waitFor({ state: 'visible', timeout: 20_000 });
  const first = newName();
  await flow.getByRole('textbox', { name: 'Your username' }).fill(first);
  await flow.getByText('Available').waitFor({ timeout: 10_000 });
  await flow.getByRole('button', { name: 'Continue', exact: true }).click();
  await flow.getByRole('heading', { name: 'Use our SoDEX code' }).waitFor({ timeout: 20_000 });
  await flow.getByRole('button', { name: 'Skip' }).click();
  await flow.waitFor({ state: 'hidden' });

  wallet.reject.add('username');
  await openSettingsRow(page);
  const stg = page.getByRole('dialog', { name: 'Settings' });
  await stg.getByRole('heading', { name: 'Profile' }).waitFor();
  await stg.getByRole('textbox', { name: 'New username' }).fill(newName());
  await stg.getByText('Available').waitFor({ timeout: 10_000 });
  await stg.getByRole('button', { name: 'Change' }).click();
  await stg.locator('.onb-hint.is-no').waitFor({ timeout: 15_000 });
  assert.equal((await profileOf(page, wallet.address)).username, first);
}, { timeout: 90_000 });

h.test('a browser used before the flow existed never sees it, and gets the dot instead', async ({ page }) => {
  await noDevDock(page);
  await connect(page);
  await page.waitForTimeout(4000);
  assert.equal(await flowOf(page).isVisible(), false);
  await page.locator('.settings__dot--go:visible').first().waitFor({ timeout: 15_000 });
}, { storage: { 'vs.setup.done': '1' } });
