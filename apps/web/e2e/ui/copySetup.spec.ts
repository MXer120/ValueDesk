/**
 * Copy setup (components/copy/*, copy/CopySetupSheet.tsx, copy/live.ts): the copy
 * window's two steps - the rules, then where it runs (the ValueDesk executor by
 * default, this browser, self-hosted) - and what each place needs: the executor
 * sign-in, the copy terms (with ValueDesk's own terms in front), the copy fee, the key.
 *
 * Against the dev web the "ValueDesk executor" is the local one (127.0.0.1:8799, via
 * Vite's /api/copy proxy), so a sign-in or terms signature stays on this machine.
 * The throwaway wallet has no SoDEX account: the fee and key steps stop at "deposit
 * first" before the wallet is asked anything. With --live (a funded wallet) the
 * wallet is asked for the key and fee signatures and REJECTS them: nothing is
 * registered on SoDEX.
 */
import assert from 'node:assert/strict';
import type { Locator } from 'playwright-core';
import { connectWallet, uiSuite, until } from './harness';
import { copy } from './copy';

const h = uiSuite(import.meta.filename);


const has = async (l: Locator) => (await l.count()) > 0;

h.test('the copy window: the rules, then where it runs - the ValueDesk executor by default', async ({ page }) => {
  const c = copy(page);
  await c.open();
  assert.equal(await c.modal.getByRole('switch', { name: 'Paper copy' }).isChecked(), false, 'a new copy is live until Paper is picked');
  await c.next();
  assert.ok(await c.place('ValueDesk executor').isChecked(), 'copies run on the ValueDesk executor by default');
  // No wallet: the first thing it needs, and nothing starts.
  assert.ok((await c.titles()).includes('Connect wallet'));
  assert.ok(await c.modal.getByRole('button', { name: 'Start copying', exact: true }).isDisabled());
}, { path: '/copy' });

h.test('three run places, each with its own steps', async ({ page }) => {
  await connectWallet(page);
  const c = copy(page);
  await c.open();
  await c.next();

  const hosted = await c.titles();
  for (const t of ['Connect wallet', 'Sign in to the ValueDesk executor', 'Accept the copy trading terms', 'Approve the copy fee', 'Approve the copy key']) {
    assert.ok(hosted.includes(t), `ValueDesk executor: ${t} (has ${hosted.join(' | ')})`);
  }
  assert.ok(await has(c.step('Approve the copy key').getByText(/held by the ValueDesk executor/)), 'the executor holds the key');

  await c.place('This browser').check();
  await until(page, async () => !(await c.titles()).includes('Sign in to the ValueDesk executor'), 'the browser steps');
  const browser = await c.titles();
  assert.ok(browser.includes('Approve the copy key') && browser.includes('Accept the copy trading terms'), `this browser: ${browser.join(' | ')}`);
  assert.ok(await has(c.modal.getByText('The key stays in this browser.')));

  await c.place('Self-hosted').check();
  await until(page, async () => JSON.stringify(await c.titles()) !== JSON.stringify(browser), 'the self-hosted steps');
  const self = await c.titles();
  assert.ok(self.some((t) => /copier/i.test(t)), `self-hosted names your copier: ${self.join(' | ')}`);

  await c.place('ValueDesk executor').check();
  await until(page, async () => (await c.titles()).includes('Sign in to the ValueDesk executor'), 'the executor steps again');
}, { path: '/copy' });

h.test('signing in to the ValueDesk executor is one signature; a rejection in the wallet changes nothing', async ({ page, wallet }) => {
  await connectWallet(page);
  const c = copy(page);
  await c.open();
  await c.next();
  const signIn = c.step('Sign in to the ValueDesk executor').getByRole('button', { name: 'Sign in', exact: true });

  // Rejected in the wallet: the step stays open, ready to try again. The user's own "no" is not an
  // error (CopySetupSheet run(): isRejection stays silent), so nothing is said.
  wallet.reject.add('copy-sign-in');
  let mark = wallet.mark();
  await signIn.click();
  await until(page, () => wallet.since(mark).some((r) => r.kind === 'copy-sign-in' && r.outcome === 'rejected'), 'the wallet to be asked');
  await until(page, async () => (await signIn.isVisible()) && (await signIn.isEnabled()), 'Sign in, ready again');
  assert.equal(await c.modal.locator('.fx-note--err').count(), 0, 'no error line for a rejection');

  // Signed: one CopyRequest 'session', and the step is done.
  wallet.reject.delete('copy-sign-in');
  mark = wallet.mark();
  await signIn.click();
  await until(page, async () => !(await signIn.isVisible()), 'signed in', 20_000);
  assert.deepEqual(wallet.since(mark).map((r) => [r.kind, r.outcome]), [['copy-sign-in', 'signed']]);
}, { path: '/copy' });

h.test('the copy terms: four statements, then ValueDesk terms and the copy terms, one signature each', async ({ page, wallet }) => {
  await connectWallet(page);
  const c = copy(page);
  await c.open();
  await c.next();
  const before = await c.progress.textContent();
  await c.acceptTerms(wallet);
  await until(page, async () => (await c.progress.textContent()) !== before, 'the step to count as done');
  assert.ok(!(await c.step('Accept the copy trading terms').getByRole('button', { name: 'Review' }).isVisible()), 'no Review left');
}, { path: '/copy' });

h.test('fee and key: a wallet without a SoDEX account is told to deposit first, and the wallet is asked nothing', async ({ page, wallet }) => {
  await connectWallet(page);
  const c = copy(page);
  await c.open();
  await c.next();
  await c.step('Sign in to the ValueDesk executor').getByRole('button', { name: 'Sign in', exact: true }).click();
  await until(page, async () => !(await c.step('Sign in to the ValueDesk executor').getByRole('button', { name: 'Sign in' }).isVisible()), 'signed in', 20_000);
  await c.acceptTerms(wallet);

  const mark = wallet.mark();
  // The fee: a build without a builder charges none (nothing to approve); else its Approve stops at the deposit.
  const fee = c.step('Approve the copy fee');
  const feeApprove = fee.getByRole('button', { name: 'Approve', exact: true });
  if (await feeApprove.isVisible()) {
    await feeApprove.click();
    await c.modal.getByText(/no SoDEX account yet\. Deposit first/).first().waitFor({ state: 'visible' });
  }
  // The key: Approve is open once signed in with the terms accepted, and stops at the deposit.
  const keyApprove = c.step('Approve the copy key').getByRole('button', { name: 'Approve', exact: true });
  await until(page, async () => await keyApprove.isEnabled(), 'the key Approve');
  await keyApprove.click();
  await c.modal.getByText(/no SoDEX account yet\. Deposit first/).first().waitFor({ state: 'visible' });
  assert.deepEqual(wallet.since(mark), [], 'nothing was asked of the wallet');
}, { path: '/copy', throwaway: 'a funded wallet has a SoDEX account' });

h.test('fee and key with a funded wallet: the wallet is asked for exactly the approval and the key, and rejects both', async ({ page, wallet, skip }) => {
  await connectWallet(page);
  const c = copy(page);
  await c.open();
  await c.next();
  await c.place('This browser').check();
  if (await c.step('Accept the copy trading terms').getByRole('button', { name: 'Review' }).isVisible()) await c.acceptTerms(wallet);
  wallet.reject = new Set(['builder', 'trading-key']);
  const feeApprove = c.step('Approve the copy fee').getByRole('button', { name: 'Approve', exact: true });
  if (await feeApprove.isVisible()) {
    const m = wallet.mark();
    await feeApprove.click();
    await until(page, () => wallet.since(m).some((r) => r.kind === 'builder'), 'the builder approval to be asked', 30_000);
    assert.deepEqual(wallet.since(m).map((r) => [r.primaryType, r.outcome]), [['ApproveBuilderFeeAction', 'rejected']]);
  }
  const keyApprove = c.step('Approve the copy key').getByRole('button', { name: 'Approve', exact: true });
  if (!(await keyApprove.isVisible())) return skip('this wallet already has a copy key in this browser');
  const m = wallet.mark();
  await keyApprove.click();
  await until(page, () => wallet.since(m).some((r) => r.kind === 'trading-key'), 'the key registration to be asked', 30_000);
  assert.deepEqual(wallet.since(m).map((r) => [r.primaryType, r.outcome]), [['UserSignedAddAPIKeyAction', 'rejected']]);
  await until(page, async () => await keyApprove.isEnabled(), 'Approve, ready again');
}, { path: '/copy', live: 'the fee and key signatures need a SoDEX account (VS_E2E_KEY); both are rejected in the wallet', timeout: 180_000 });

h.test('a paper copy in this browser needs no fee and no key, and the test bridge sees and stops it', async ({ page, wallet }) => {
  await connectWallet(page);
  const c = copy(page);
  await c.open();
  await c.modal.getByRole('switch', { name: 'Paper copy' }).check();
  await c.next();
  await c.place('This browser').check();
  await c.modal.getByRole('heading', { name: 'Paper copy: what it needs', level: 3 }).waitFor({ state: 'visible' });
  const titles = await c.titles();
  assert.deepEqual(titles, ['Connect wallet', 'Accept the copy trading terms'], 'a paper copy needs no fee and no key');
  assert.ok(await has(c.modal.getByText('none (paper)')), 'no copy fee on paper');
  const start = c.modal.getByRole('button', { name: 'Start paper copy', exact: true });
  assert.ok(await start.isDisabled());
  await c.acceptTerms(wallet);
  await until(page, async () => await start.isEnabled(), 'Start paper copy');
  const mark = wallet.mark();
  await start.click();
  await c.modal.waitFor({ state: 'hidden', timeout: 20_000 });
  assert.deepEqual(wallet.since(mark), [], 'a paper copy signs nothing');

  let views: Awaited<ReturnType<NonNullable<Window['__vsTest']>['copier']['list']>> = [];
  await until(page, async () => {
    views = await page.evaluate(() => window.__vsTest!.copier.list());
    return views.length > 0;
  }, 'the copy in the bridge', 20_000);
  const sub = views[0]!.subscription;
  assert.equal(sub.mode, 'browser');
  assert.equal(sub.settings.paper, true);
  assert.equal(sub.owner, wallet.address);
  // 'standby' until this tab's Web Lock callback has started the runtime, then 'runner'.
  await until(page, async () => (await page.evaluate(() => window.__vsTest!.copier.role())) === 'runner', 'this tab to run the copier');
  assert.equal(await page.evaluate(() => window.__vsTest!.copier.key()), null, 'no copy key for paper');

  await page.evaluate((id) => window.__vsTest!.copier.pause(id), sub.id);
  await until(page, async () => (await page.evaluate((id) => window.__vsTest!.copier.list().then((l) => l.find((v) => v.subscription.id === id)?.subscription.status), sub.id)) === 'paused', 'paused');
  await page.evaluate((id) => window.__vsTest!.copier.stop(id), sub.id);
  await until(page, async () => (await page.evaluate((id) => window.__vsTest!.copier.list().then((l) => l.find((v) => v.subscription.id === id)?.subscription.status), sub.id)) !== 'paused', 'stopped');
  assert.ok(Array.isArray(await page.evaluate((id) => window.__vsTest!.copier.events(id), sub.id)));
}, { path: '/copy', timeout: 120_000 });
