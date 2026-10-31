/**
 * The notifications bell (components/Notices.tsx): the unread mark, and the View
 * pop-up's filters - Grade (all / warnings + errors / errors) and About (algos +
 * copies / account / other) - which are kept across a reload and reset together.
 *
 * The rows are seeded into the bell's own store (localStorage vs.notices.v1,
 * notices.ts) before the app starts, one of each kind and grade.
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { connectWallet, uiSuite, until } from './harness';

const h = uiSuite(import.meta.filename);

const now = Date.now();
type Row = { id: string; kind: string; title: string; grade?: 'info' | 'warn' | 'error'; important?: boolean; read?: boolean };
const ROWS: Row[] = [
  { id: 'e2e-dep', kind: 'deposit', title: 'E2E deposit arrived' },
  { id: 'e2e-wd', kind: 'withdraw', title: 'E2E withdrawal sent' },
  { id: 'e2e-err', kind: 'error', title: 'E2E order failed', important: true, read: false },
  { id: 'e2e-sys', kind: 'system', title: 'E2E system warning' },
  { id: 'e2e-info', kind: 'info', title: 'E2E info' },
  { id: 'e2e-algo-warn', kind: 'algo', title: 'E2E algo held', grade: 'warn' },
  { id: 'e2e-algo-info', kind: 'algo', title: 'E2E algo finished', grade: 'info' },
  { id: 'e2e-copy-err', kind: 'copy', title: 'E2E copy stopped', grade: 'error' },
];
const NOTICES = JSON.stringify(
  ROWS.map((r, i) => ({ body: `${r.title}.`, important: false, read: true, time: now - i * 60_000, ...r })),
);
const t = (...ids: string[]) => ROWS.filter((r) => ids.includes(r.id)).map((r) => r.title);
const ALL = ROWS.map((r) => r.title);

function bell(page: Page) {
  const button = page.getByRole('banner').getByRole('button', { name: /^Notifications/ });
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  const view = page.getByRole('dialog', { name: 'View' });
  const b = {
    button,
    panel,
    view,
    async open() {
      if (!(await panel.isVisible())) await button.click();
      await panel.waitFor({ state: 'visible' });
    },
    /** The seeded rows the panel shows now, top to bottom (the app's own system rows are left out). */
    async titles(): Promise<string[]> {
      const all = await panel.locator('.navnotes__k').allTextContents();
      return all.map((s) => s.trim()).filter((s) => s.startsWith('E2E '));
    },
    async pick(section: 'Grade' | 'About', option: string) {
      if (!(await view.isVisible())) await panel.getByRole('button', { name: 'View', exact: true }).click();
      await view.waitFor({ state: 'visible' });
      const radio = view.getByRole('group', { name: section }).getByRole('radio', { name: option, exact: true });
      await radio.click();
      await until(page, async () => (await radio.getAttribute('aria-checked')) === 'true', `${section}: ${option}`);
    },
    async expect(want: string[], what: string) {
      let got: string[] = [];
      await until(page, async () => {
        got = await b.titles();
        return JSON.stringify(got) === JSON.stringify(want);
      }, `${what}: ${JSON.stringify(want)} (shown: ${JSON.stringify(got)})`);
    },
  };
  return b;
}

h.test('an unread error marks the bell, and opening it reads it', async ({ page }) => {
  const b = bell(page);
  await until(page, async () => /^Notifications, \d+ unread$/.test((await b.button.getAttribute('aria-label')) ?? ''), 'the unread mark');
  await b.open();
  await b.expect(ALL, 'every row, newest first');
  // The list opens on the screen, whole: on a phone it ran off the left edge (the bell sits mid-bar there).
  const box = (await b.panel.boundingBox())!;
  const screen = page.viewportSize()!;
  assert.ok(box.x >= 0 && box.x + box.width <= screen.width, `the list lies within the ${screen.width}px screen (x ${Math.round(box.x)} to ${Math.round(box.x + box.width)})`);
  // Open, the panel's scrim covers the page (and the bell): it is what closes it - tapped beside the list.
  const below = box.y + box.height + 4 < screen.height - 4;
  await page.getByRole('button', { name: 'Close notifications' }).click({ position: below ? { x: screen.width / 2, y: screen.height - 4 } : { x: 4, y: screen.height - 4 } });
  await b.panel.waitFor({ state: 'hidden' });
  await until(page, async () => (await b.button.getAttribute('aria-label')) === 'Notifications', 'the mark to clear');
}, { storage: { 'vs.notices.v1': NOTICES } });

h.test('toasts never lie over the bar: docked in its lane, or (a phone) under it - its links and wallet button take taps', async ({ page }) => {
  await connectWallet(page);
  // Connecting starts the indexing card, which stays for minutes: the toast that sat over a phone's header.
  const card = page.locator('.toasts .toast').first();
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  const docked = await page.locator('.toasts').first().evaluate((el) => el.classList.contains('is-docked'));
  if (!docked) {
    const bar = (await page.getByRole('banner').boundingBox())!;
    const box = (await card.boundingBox())!;
    assert.ok(box.y >= bar.y + bar.height - 1, `the toast (top ${Math.round(box.y)}) starts under the bar (bottom ${Math.round(bar.y + bar.height)})`);
  }
  // A tap on a page link reaches it (trial: every actionability check, nothing clicked).
  await page.getByRole('link', { name: 'Portfolio', exact: true }).first().click({ trial: true, timeout: 5_000 });
  // An open dialog is above the toasts: on a phone the indexing card lay over the terms' "I confirm" box.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
  const c = (await card.boundingBox())!;
  const top = await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.toasts'), [c.x + c.width / 2, c.y + c.height / 2]);
  assert.equal(top, false, 'the toast is not the topmost thing under the open dialog');
}, { storage: { 'vs.notices.v1': NOTICES } });

h.test('View > Grade: all, warnings + errors, errors', async ({ page }) => {
  const b = bell(page);
  await b.open();
  await b.expect(ALL, 'All');
  await b.pick('Grade', 'Warnings + errors');
  await b.expect(t('e2e-err', 'e2e-sys', 'e2e-algo-warn', 'e2e-copy-err'), 'warnings and errors');
  await b.pick('Grade', 'Errors');
  await b.expect(t('e2e-err', 'e2e-copy-err'), 'errors');
  await b.pick('Grade', 'All');
  await b.expect(ALL, 'All again');
}, { storage: { 'vs.notices.v1': NOTICES } });

h.test('View > About: algos + copies, account, other - and with a grade', async ({ page }) => {
  const b = bell(page);
  await b.open();
  await b.pick('About', 'Algos + copies');
  await b.expect(t('e2e-algo-warn', 'e2e-algo-info', 'e2e-copy-err'), 'algos and copies');
  await b.pick('About', 'Account');
  await b.expect(t('e2e-dep', 'e2e-wd'), 'account');
  await b.pick('About', 'Other');
  await b.expect(t('e2e-err', 'e2e-sys', 'e2e-info'), 'other');
  // Both at once: errors about algos and copies.
  await b.pick('About', 'Algos + copies');
  await b.pick('Grade', 'Errors');
  await b.expect(t('e2e-copy-err'), 'errors about algos and copies');
  // Nothing passes: said, not an empty box.
  await b.pick('About', 'Account');
  await b.expect([], 'errors about the account');
  await b.panel.getByText('Nothing for this view.').waitFor({ state: 'visible' });
}, { storage: { 'vs.notices.v1': NOTICES } });

h.test('the View is kept across a reload, and Reset clears both filters', async ({ page }) => {
  const b = bell(page);
  await b.open();
  await b.pick('Grade', 'Errors');
  await b.pick('About', 'Algos + copies');
  await b.expect(t('e2e-copy-err'), 'filtered');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await b.open();
  await b.expect(t('e2e-copy-err'), 'still filtered after a reload');
  assert.ok(await b.panel.getByRole('button', { name: 'View', exact: true }).evaluate((el) => el.classList.contains('is-on')), 'the View button shows a filter is on');
  await b.panel.getByRole('button', { name: 'View', exact: true }).click();
  await b.view.getByRole('button', { name: 'Reset', exact: true }).click();
  await b.expect(ALL, 'everything after Reset');
  assert.ok(await b.view.getByRole('button', { name: 'Reset', exact: true }).isDisabled(), 'nothing left to reset');
}, { storage: { 'vs.notices.v1': NOTICES } });
