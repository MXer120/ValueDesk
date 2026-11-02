/**
 * The Bots page (components/bots/*): what it shows before a wallet, the executor setup it walks through
 * (sign-in, the copy terms with ValueDesk's own first), and a practice volume maker from preset to stop and
 * delete - each start, pause, edit and stop one wallet signature ('algo'), nothing else signed.
 *
 * Against the dev web the ValueDesk executor is the local one (127.0.0.1:8799): every bot here is a practice
 * run against SoDEX's live book, and nothing reaches SoDEX. Screenshots of each state land in
 * e2e/ui/.out/bots-*.png (with @phone on a phone) for the design review.
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

/** Bots > Set up: the copy setup sheet, ValueDesk executor - sign in, then the copy terms. */
async function setUp(page: Page, wallet: TestWallet): Promise<void> {
  await page.getByRole('button', { name: 'Set up', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Copy setup' });
  await sheet.waitFor({ state: 'visible' });
  const step = (t: string) => sheet.getByRole('listitem').filter({ hasText: t });
  await step('Sign in to the ValueDesk executor').getByRole('button', { name: 'Sign in', exact: true }).click();
  await until(page, async () => !(await step('Sign in to the ValueDesk executor').getByRole('button', { name: 'Sign in' }).isVisible()), 'signed in', 20_000);
  const mark = wallet.mark();
  await step('Accept the copy trading terms').getByRole('button', { name: 'Review', exact: true }).click();
  for (const s of [/^I am at least 18/, /^I am not a US person/, /^I chose the trader/, /^I have read the copy trading terms/]) await sheet.getByRole('checkbox', { name: s }).check();
  await sheet.getByRole('button', { name: 'Sign and accept', exact: true }).click();
  const site = page.getByRole('dialog', { name: 'Sign the terms to continue' });
  await site.waitFor({ state: 'visible' });
  await site.getByRole('checkbox', { name: /^I confirm that/ }).check();
  await site.getByRole('button', { name: 'Only necessary', exact: true }).click();
  await toast(page, 'Copy trading terms accepted.').waitFor({ state: 'visible', timeout: 30_000 });
  assert.deepEqual(wallet.since(mark).filter((r) => r.outcome === 'signed').map((r) => r.kind), ['site-terms', 'copy-terms']);
  await sheet.locator('.cs-actions').getByRole('button', { name: 'Close', exact: true }).click();
  await sheet.waitFor({ state: 'hidden' });
}

h.test('before a wallet: the three strategies, what each costs, and Connect', async ({ page }) => {
  await page.getByRole('heading', { name: 'Bots', level: 1 }).waitFor();
  for (const name of ['Volume maker', 'Grid', 'DCA bot']) assert.ok(await page.getByRole('button', { name: new RegExp(name) }).first().isVisible(), name);
  assert.ok(await page.getByText('$170').first().isVisible(), 'fees per $1M: 1.2 bp maker + 0.5 bp');
  assert.ok(await page.getByRole('button', { name: 'Connect wallet' }).first().isVisible());
  await shot(page, 'no-wallet');
}, { path: '/bots' });

h.test('a practice volume maker: set up, preset, start, its window, pause, edit, stop, delete - one signature each', async ({ page, wallet }) => {
  await connectWallet(page);
  await page.getByRole('heading', { name: 'Bots', level: 1 }).waitFor();
  await shot(page, 'setup-needed');
  await setUp(page, wallet);

  // Empty: the strategies; pick the volume maker.
  await page.getByText('Start your first bot').waitFor({ state: 'visible', timeout: 20_000 });
  await shot(page, 'empty');
  await page.getByRole('button', { name: /Volume maker/ }).first().click();
  const form = page.getByRole('dialog', { name: 'New volume maker' });
  await form.waitFor({ state: 'visible' });
  assert.ok(await form.getByRole('button', { name: 'Balanced', exact: true }).getAttribute('aria-pressed').then((x) => x === 'true'), 'Balanced by default');
  await form.getByRole('button', { name: 'Steady', exact: true }).click();
  assert.ok(await form.getByRole('switch', { name: 'Practice' }).isDisabled(), 'live bots are off for this wallet: practice only');
  await until(page, async () => /\$170/.test((await form.locator('.bots-cost').textContent()) ?? ''), 'the cost per $1M');
  await shot(page, 'form');
  let mark = wallet.mark();
  await form.getByRole('button', { name: 'Start practice bot', exact: true }).click();
  await form.waitFor({ state: 'hidden', timeout: 30_000 });
  assert.deepEqual(wallet.since(mark).filter((r) => r.outcome === 'signed').map((r) => r.kind), ['algo'], 'one signature to start');

  // Its window opens on the overview.
  const sheet = page.getByRole('dialog', { name: /^Volume maker BTC$/ });
  await sheet.waitFor({ state: 'visible' });
  await until(page, async () => (await sheet.locator('.bots-state, .algo-st__status').first().textContent())?.includes('Running') ?? false, 'it runs', 30_000);
  await page.waitForTimeout(8_000);
  await shot(page, 'sheet');
  await sheet.getByRole('button', { name: 'Activity', exact: true }).click();
  await sheet.locator('.bots-log li').first().waitFor({ state: 'visible', timeout: 20_000 });
  await shot(page, 'activity');
  await sheet.getByRole('button', { name: 'Overview', exact: true }).click();

  mark = wallet.mark();
  await sheet.getByRole('button', { name: 'Pause', exact: true }).click();
  await sheet.getByRole('button', { name: 'Resume', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  await sheet.getByRole('button', { name: 'Resume', exact: true }).click();
  await sheet.getByRole('button', { name: 'Pause', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  assert.deepEqual(wallet.since(mark).filter((r) => r.outcome === 'signed').map((r) => r.kind), ['algo', 'algo']);
  await sheet.getByRole('button', { name: 'Close', exact: true }).first().click();
  await sheet.waitFor({ state: 'hidden' });

  // The list.
  const row = page.getByRole('row', { name: /Volume maker BTC/ });
  await row.waitFor({ state: 'visible' });
  await shot(page, 'list');

  // A row's controls: in the row on a wide screen; on a phone the row opens its window, which has them.
  const win = page.getByRole('dialog', { name: /^Volume maker BTC$/ });
  const control = async (name: string) => {
    if (!PHONE) return row.getByRole('button', { name, exact: true }).click();
    if (!(await win.isVisible())) {
      await row.click();
      await win.waitFor({ state: 'visible' });
    }
    await win.getByRole('button', { name, exact: true }).click();
  };
  const closeWin = async () => {
    if (await win.isVisible()) {
      await win.getByRole('button', { name: 'Close', exact: true }).first().click();
      await win.waitFor({ state: 'hidden' });
    }
  };
  const state = async () => (await row.locator('.bots-state').textContent()) ?? '';

  // Edit: a new order size, saved as one signature.
  await control('Edit');
  const edit = page.getByRole('dialog', { name: 'Edit volume maker' });
  await edit.waitFor({ state: 'visible' });
  await shot(page, 'edit');
  const each = edit.getByRole('textbox', { name: 'Each side' });
  await each.fill('25');
  mark = wallet.mark();
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
  await edit.waitFor({ state: 'hidden', timeout: 30_000 });
  assert.deepEqual(wallet.since(mark).filter((r) => r.outcome === 'signed').map((r) => r.kind), ['algo']);
  await closeWin();

  // Stop (what it holds is closed first: a second stop ends it at once), then delete.
  await control('Stop');
  await page.getByRole('dialog', { name: /^Stop Volume maker BTC\?/ }).getByRole('button', { name: 'Stop bot', exact: true }).click();
  await closeWin();
  await until(page, async () => ['Stopped', 'Closing'].includes(await state()), 'stopped or closing', 30_000);
  if ((await state()) === 'Closing') {
    await control('Stop now');
    await page.getByRole('dialog', { name: /^Stop / }).getByRole('button', { name: 'Stop bot', exact: true }).click();
    await closeWin();
    await until(page, async () => (await state()) === 'Stopped', 'stopped at once', 30_000);
  }
  await shot(page, 'stopped');
  await control('Delete');
  await page.getByRole('dialog', { name: /^Delete / }).getByRole('button', { name: 'Delete', exact: true }).click();
  await row.waitFor({ state: 'hidden', timeout: 20_000 });
}, { path: '/bots', timeout: 240_000 });
