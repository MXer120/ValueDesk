/**
 * The wallet menu (NavBar.tsx AddressMenu, opened from the rail's wallet button): it opens at its
 * width and keeps it while the balances come in (it opened with "—" and widened a moment later,
 * owner 2026-10-31), and its Portfolio and Send feedback rows go where they say.
 */
import assert from 'node:assert/strict';
import { connectWallet, uiSuite, until } from './harness';

const h = uiSuite(import.meta.filename);

h.test('the wallet menu keeps its width while it fills; Portfolio and Send feedback work from it', async ({ page }) => {
  await connectWallet(page);
  const rail = page.getByRole('complementary', { name: 'Tools' });
  const button = rail.getByRole('button', { name: /^Wallet / });
  await button.click();
  const menu = page.locator('.navaddr__menu.acct-menu');
  await menu.waitFor({ state: 'visible' });
  // offsetWidth: the layout width, which the pop-in's scale does not change.
  const widths: number[] = [];
  for (let i = 0; i < 20; i++) {
    widths.push(await menu.evaluate((el) => (el as HTMLElement).offsetWidth));
    await page.waitForTimeout(100);
  }
  assert.equal(new Set(widths).size, 1, `one width over 2 s (${[...new Set(widths)].join(', ')} px)`);

  await menu.getByRole('menuitem', { name: 'Send feedback' }).click();
  await until(page, async () => (await page.locator('.fb-dialog').count()) > 0, 'the feedback chat to open');
  await page.keyboard.press('Escape');
  await page.locator('.fb-dialog').waitFor({ state: 'hidden', timeout: 10_000 });

  await button.click();
  await menu.waitFor({ state: 'visible' });
  await menu.getByRole('menuitem', { name: 'Portfolio' }).click();
  await until(page, async () => new URL(page.url()).pathname === '/portfolio', 'the Portfolio page');
  await menu.waitFor({ state: 'hidden', timeout: 5_000 });
});
