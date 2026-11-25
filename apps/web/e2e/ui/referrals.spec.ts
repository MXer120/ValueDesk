/**
 * Referrals (owner 2026-11-14), in the browser with a wallet that really signs:
 *
 *   a referral link (?ref=CODE, a real SoDEX code): checked, kept, taken off the address; the invited wallet is offered
 *   the two steps - one InviteJoin signature (and nothing else), then the same code on SoDEX - and joins;
 *   the Referrals page under More: without a wallet, and for the wallet that joined (its inviter, its welcome).
 *
 * Needs referral routes behind the dev web: the server, or on production's data (VALUETRADE_DEV_API=prod) the local
 * ones (apps/server tools/invites-dev.ts, launch config "invites-dev"). Without them the join test is skipped.
 * SoDEX's referral reads are real (GET only); nothing binds on SoDEX.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { PHONE, connectWallet, uiSuite, until } from './harness';

const h = uiSuite(import.meta.filename);
/** A real SoDEX referral code (a public leaderboard wallet's): SoDEX names its owner. */
const CODE = 'WNQITYUE';

/** VS_E2E_REF_SHOTS=<dir>: the popup and the page saved, per viewport. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.VS_E2E_REF_SHOTS?.trim();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(dir, `${name}-${PHONE ? 'phone' : 'desktop'}.png`) });
}

async function routesUp(origin: string): Promise<boolean> {
  try {
    const r = await fetch(`${origin}/api/vs/invites/check?code=${CODE}`, { signal: AbortSignal.timeout(15_000) });
    return r.ok && ((await r.json()) as { valid?: boolean }).valid === true;
  } catch {
    return false;
  }
}

h.test('a referral link: kept and taken off the address; the wallet joins with one signature; the same code is offered on SoDEX; the page shows it', async ({ page, wallet, origin, skip }) => {
  if (!(await routesUp(origin))) return skip('no referral routes behind this dev web (start "invites-dev")');
  // The address bar loses the code at once; this browser keeps it.
  await until(page, () => !page.url().includes('ref='), 'the code taken off the address', 15_000);
  await until(page, async () => (await page.evaluate(() => localStorage.getItem('vd.invite'))) !== null, 'the code kept', 15_000);
  const kept = JSON.parse((await page.evaluate(() => localStorage.getItem('vd.invite'))) ?? '{}') as { code?: string; welcome?: boolean };
  assert.equal(kept.code, CODE);
  assert.equal(kept.welcome, true);

  const mark = wallet.mark();
  // Connect (the harness dismisses the first-signup flow and the setup sheet): the referral popup comes next.
  await connectWallet(page);
  const dialog = page.getByRole('dialog', { name: 'You were invited' });
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  assert.ok(await dialog.getByText(CODE, { exact: true }).first().isVisible(), 'the code');
  assert.ok(await dialog.getByText('$0', { exact: true }).isVisible(), 'the welcome');
  assert.equal(await page.getByRole('dialog', { name: /SoDEX code/ }).count(), 0, 'never VALUEDESK over the inviter\'s code');

  await shot(page, 'popup');
  await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
  await dialog.getByText('Joined', { exact: true }).waitFor({ timeout: 30_000 });
  await shot(page, 'popup-joined');
  const signed = wallet.since(mark).filter((r) => r.outcome === 'signed');
  assert.deepEqual(signed.map((r) => r.primaryType), ['InviteJoin'], 'one signature, the join');

  // Step 2: SoDEX says this new wallet has no referrer, so the same code is offered there, on sodex.com.
  const apply = dialog.getByRole('link', { name: 'Apply', exact: true });
  await apply.waitFor({ timeout: 20_000 });
  assert.equal(await apply.getAttribute('href'), `https://sodex.com/join/${CODE}`);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => localStorage.getItem('vd.invite')), null, 'done: the kept code is let go');

  // The Referrals page, from More: whom it joined, and its welcome.
  await page.goto(`${origin}/referrals`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Referrals', exact: true }).waitFor();
  await page.getByText(/Referred by/).first().waitFor({ timeout: 20_000 });
  await page.getByText('Your welcome', { exact: true }).waitFor();
  await page.getByText('$0 ValueDesk fee').first().waitFor();
  // A throwaway wallet has no SoDEX account: no code of its own yet, said so - never an endless "making your link".
  await page.getByText('Your link appears with your SoDEX account').waitFor({ timeout: 20_000 });
  assert.equal(await page.getByText('Could not read your referrals').count(), 0);
  await shot(page, 'page-joined');
  // The link as the Referrals page gives it: on / (the test came by /trade until 2026-11-25, and / lost the code).
}, { path: `/?ref=${CODE.toLowerCase()}`, timeout: 150_000 });

h.test('signing the terms with the code on screen joins by that signature: no popup signature needed', async ({ page, wallet, origin, skip }) => {
  if (!(await routesUp(origin))) return skip('no referral routes behind this dev web (start "invites-dev")');
  const mark = wallet.mark();
  await connectWallet(page, { settle: false });
  // An action that needs the terms (any order): the app's own gate, through the page's own module.
  await page.evaluate(async (owner) => {
    const m = (await import(/* @vite-ignore */ '/src/legal/acceptance.ts' as string)) as { requireTerms(r: { owner: string; reason: string }): Promise<boolean> };
    void m.requireTerms({ owner, reason: 'place this order' });
  }, wallet.address);
  const terms = page.getByRole('dialog', { name: 'Sign the terms to continue' });
  await terms.waitFor({ state: 'visible', timeout: 20_000 });
  assert.ok(await terms.getByText('Referral code', { exact: true }).isVisible(), 'the code is on screen');
  assert.ok(await terms.getByText(`It also joins you with code ${CODE}.`).isVisible(), 'and what the signature does');
  await terms.getByRole('checkbox', { name: /^I confirm that/ }).check();
  await shot(page, 'terms');
  await terms.getByRole('button', { name: /Only necessary|Sign and continue/ }).first().click();
  await terms.waitFor({ state: 'hidden', timeout: 30_000 });
  await until(page, async () => {
    const r = await fetch(`${origin}/api/vs/invites/me?address=${wallet.address}`);
    return ((await r.json()) as { joined?: { code?: string } | null }).joined?.code === CODE;
  }, 'the wallet joined', 30_000);
  assert.ok(!wallet.since(mark).some((r) => r.primaryType === 'InviteJoin'), 'by the terms signature alone');
}, { path: `/?ref=${CODE}`, timeout: 150_000 });

h.test('the Referrals page: under More, and without a wallet a connect state', async ({ page }) => {
  if (!PHONE) {
    await page.getByRole('button', { name: /^More/ }).first().click();
    await page.getByRole('menuitem', { name: 'Referrals' }).click();
  } else {
    await page.goto(page.url().replace(/\/[^/]*$/, '/referrals'), { waitUntil: 'domcontentloaded' });
  }
  await page.getByRole('heading', { name: 'Referrals', exact: true }).waitFor();
  assert.ok(new URL(page.url()).pathname === '/referrals');
  await page.getByText('Connect a wallet', { exact: true }).waitFor();
}, { path: '/trade' });
