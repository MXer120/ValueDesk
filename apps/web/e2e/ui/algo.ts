/**
 * The algo ticket (components/algo/AlgoTicket.tsx) inside the order ticket, as the specs drive it.
 */
import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright-core';
import { until } from './harness';
import { ticket, toast } from './ticket';

/** 0.005 BTC: about $400, so each of a TWAP's 30 default slices clears SoDEX's $10 minimum. */
export const SIZE = 0.005;

/** Every kind the Algo menu offers (components/algo/menu.ts ALGO_MENU), in its order. */
export const KINDS = ['TWAP', 'Chase TWAP', 'VWAP', 'POV', 'Iceberg', 'Chase', 'Scale', 'DCA', 'Swarm', 'Conditional', 'Trailing stop', 'Fill fast', 'Bracket', 'Basket'];

export function algo(page: Page, root?: Locator) {
  const t = ticket(page, root);
  const tabs = t.g.getByRole('tablist', { name: 'Order type' });
  const menu = page.getByRole('listbox', { name: 'Algo order type' });
  const a = {
    t,
    menu,
    /** The fourth tab: "Algo" until a kind is picked, then that kind's name. */
    tab: tabs.getByRole('tab').nth(3),
    button: t.g.locator('.oe-side__btn'),
    async pick(kind: string): Promise<void> {
      if (!(await menu.isVisible())) await a.tab.click();
      await menu.getByRole('option', { name: kind, exact: true }).click();
      await until(page, async () => ((await a.tab.textContent()) ?? '').trim().startsWith(kind), `the ${kind} tab`);
      if (await menu.isVisible()) await page.keyboard.press('Escape');
    },
    settings: (kind: string) => page.getByRole('dialog', { name: `${kind} settings` }),
    async open(kind: string, section?: string) {
      const d = a.settings(kind);
      // Its name carries a count once a setting differs from the defaults ("Advanced 1 changed").
      if (!(await d.isVisible())) await t.g.getByRole('button', { name: /^Advanced/ }).click();
      await d.waitFor({ state: 'visible' });
      if (section) {
        await d.getByRole('navigation', { name: `${kind} settings sections` }).getByRole('button', { name: section, exact: true }).click();
        await d.getByRole('heading', { name: section, level: 3 }).waitFor({ state: 'visible' });
      }
      return d;
    },
    async done(kind: string) {
      const d = a.settings(kind);
      await d.getByRole('button', { name: 'Done', exact: true }).click();
      await d.waitFor({ state: 'hidden' });
    },
    place: (d: Locator, name: 'ValueDesk' | 'This browser' | 'Self-hosted') =>
      d.getByRole('radiogroup', { name: 'Runs on' }).getByRole('radio', { name: new RegExp(`^${name} `) }),
    practice: (d: Locator) => d.getByRole('switch', { name: 'Practice run · no real orders' }),
  };
  return a;
}

/**
 * Start from the ticket: its button opens the Summary (every order at a glance), and the
 * slide there starts it - by keyboard here (End lets go at the end), as SlideConfirm allows.
 */
export async function slideStart(page: Page, a: ReturnType<typeof algo>, kind: string) {
  await until(page, async () => await a.button.isEnabled(), 'the Start button');
  await a.button.click();
  const d = a.settings(kind);
  await d.getByRole('heading', { name: 'Summary', level: 3 }).waitFor({ state: 'visible' });
  const slide = d.getByRole('slider', { name: /^Slide to start the practice .*: drag to the end and let go$/ });
  await slide.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await slide.getAttribute('aria-valuenow'), '20', 'part of the way');
  assert.equal(await toast(page, /started/).count(), 0, 'a slide short of the end starts nothing');
  await page.keyboard.press('End');
}

/** A practice run in this browser: Runs on > This browser, Practice on. */
export async function practiceInBrowser(a: ReturnType<typeof algo>, kind: string) {
  const d = await a.open(kind, 'Runs on');
  await a.place(d, 'This browser').check();
  await a.practice(d).check();
  assert.ok(await a.practice(d).isChecked());
  await a.done(kind);
}
