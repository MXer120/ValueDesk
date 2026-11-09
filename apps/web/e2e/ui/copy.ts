/**
 * The copy window (components/copy/CopyModal.tsx, copy/CopySetupSheet.tsx) as the specs
 * drive it: its two steps, the run places, the setup steps and the copy terms.
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { toast } from './ticket';
import type { TestWallet } from './wallet';
export function copy(page: Page) {
  const modal = page.getByRole('dialog', { name: /^Copy 0x/ });
  const places = modal.getByRole('radiogroup', { name: 'Where the copier runs' });
  const c = {
    modal,
    place: (name: 'ValueDesk executor' | 'This browser' | 'Self-hosted') => places.getByRole('radio', { name: new RegExp(`^${name} `) }),
    step: (title: string | RegExp) => modal.getByRole('listitem').filter({ hasText: title }),
    progress: modal.getByText(/^(\d+ of \d+ steps done|Ready to copy)$/),
    /** Discover's first trader with a Copy button (a losing trader offers Counter instead). */
    async open(): Promise<void> {
      const card = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Copy', exact: true }) }).first();
      await card.waitFor({ state: 'visible', timeout: 30_000 });
      await card.getByRole('button', { name: 'Copy', exact: true }).click();
      await modal.waitFor({ state: 'visible' });
    },
    async next(): Promise<void> {
      await modal.getByRole('button', { name: 'Next', exact: true }).click();
      await places.waitFor({ state: 'visible' });
    },
    async titles(): Promise<string[]> {
      return (await modal.locator('.cs-step__t').allTextContents()).map((s) => s.trim());
    },
    /** Review > the four copy statements > the bottom button "Sign and accept the terms"; then ValueDesk's own terms in front of them. */
    async acceptTerms(wallet: TestWallet): Promise<void> {
      const mark = wallet.mark();
      await c.step('Accept the copy trading terms').getByRole('button', { name: 'Review', exact: true }).click();
      // The terms are accepted with the dialog's bottom button, never with one in the step (owner 2026-11-09).
      assert.equal(await c.step('Accept the copy trading terms').getByRole('button', { name: /Sign and accept/ }).count(), 0, 'no accept button in the step');
      const sign = modal.getByRole('button', { name: 'Sign and accept the terms', exact: true });
      for (const s of [/^I am at least 18/, /^I am not a US person/, /^I chose the trader/, /^I have read the copy trading terms/]) {
        assert.ok(await sign.isDisabled(), 'the bottom button waits for every statement');
        await modal.getByRole('checkbox', { name: s }).check();
      }
      await sign.click();
      // ValueDesk's own terms come first (legal/LegalGate.tsx): signed once per wallet.
      const site = page.getByRole('dialog', { name: 'Sign the terms to continue' });
      await site.waitFor({ state: 'visible' });
      await site.getByRole('checkbox', { name: /^I confirm that/ }).check();
      await site.getByRole('button', { name: 'Only necessary', exact: true }).click();
      await toast(page, 'Copy trading terms accepted.').waitFor({ state: 'visible', timeout: 30_000 });
      const signed = wallet.since(mark).filter((r) => r.outcome === 'signed').map((r) => r.kind);
      assert.deepEqual(signed, ['site-terms', 'copy-terms'], 'ValueDesk terms, then the copy terms: one signature each');
    },
  };
  return c;
}
