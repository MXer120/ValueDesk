/**
 * A part of a page from an older build (src/lazyPage.ts lazyChunk / StaleBuild): a
 * release renamed its file while the tab was open, so the old name answers 404.
 * Simulated by answering the part's module with a 404 on the dev server.
 *
 *   - one retry, then the once-a-minute reload; after that reload, the note with a
 *     Reload button in place of the part (not the error boundary);
 *   - a tab that runs an algo is never reloaded: the note at once, and the
 *     "update held" banner saying what the reload would stop.
 */
import assert from 'node:assert/strict';
import type { Page, Route } from 'playwright-core';
import { SIZE, algo, practiceInBrowser, slideStart } from './algo';
import { acceptWelcome, dec, hideDevPanel, typeInto, uiSuite, until } from './harness';
import { toast } from './ticket';

const h = uiSuite(import.meta.filename);

const NOTE = 'A new version of ValueDesk is out: reload the page to open this.';

/** Answer one module of the dev server with a 404 (as a renamed chunk does); returns how often it was asked for. */
async function goneFromBuild(page: Page, file: string): Promise<{ hits: () => number }> {
  let hits = 0;
  await page.route(
    (u) => u.pathname === file,
    (r: Route) => {
      hits++;
      return r.fulfill({ status: 404, contentType: 'text/plain', body: 'gone in the new build' });
    },
  );
  return { hits: () => hits };
}

/** Main-frame navigations from now on (a reload is one). */
function navigations(page: Page): () => number {
  let n = 0;
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) n++;
  });
  return () => n;
}

h.test('a missing part: one retry, one reload, then the note and its Reload button', async ({ page, errors }) => {
  const a = algo(page);
  await a.t.ready();
  const gone = await goneFromBuild(page, '/src/components/algo/AlgoTicket.tsx');
  const navs = navigations(page);

  // First time: retried once, then the tab reloads to fetch the current build.
  await a.tab.click();
  await until(page, () => navs() >= 1, 'the reload', 15_000);
  assert.ok(gone.hits() >= 1, 'the part was asked for');
  await page.waitForLoadState('domcontentloaded');
  await acceptWelcome(page);
  await hideDevPanel(page);

  // Still missing after the reload (within the minute): no reload loop - the note, in place of the algo ticket.
  await a.t.ready();
  const before = navs();
  await a.tab.click();
  const note = a.t.g.getByRole('status').filter({ hasText: NOTE });
  await note.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(navs(), before, 'no second reload inside the minute');
  assert.equal(await page.locator('.error-boundary, [data-error-boundary]').count(), 0, 'not the error boundary');
  assert.equal(errors.filter((e) => e.startsWith('pageerror')).length, 0, 'nothing thrown');

  // Its Reload button reloads.
  await note.getByRole('button', { name: 'Reload', exact: true }).click();
  await until(page, () => navs() > before, 'the Reload button to reload');
});

h.test('a tab running an algo is not reloaded: the note at once, and the banner says what a reload would stop', async ({ page }) => {
  const a = algo(page);
  await a.t.ready();
  await a.pick('TWAP');
  await typeInto(a.t.amount, dec(SIZE));
  await practiceInBrowser(a, 'TWAP');
  await slideStart(page, a, 'TWAP');
  await toast(page, /TWAP started \(paper\)/).waitFor({ state: 'visible', timeout: 20_000 });
  await until(page, async () => (await page.evaluate(() => window.__vsTest!.algos.role())) === 'runner', 'this tab to run it');

  // Then a release renames the Algos table's file.
  await goneFromBuild(page, '/src/components/algo/AlgoTable.tsx');
  const navs = navigations(page);
  const activity = page.getByRole('group', { name: 'Account activity' });
  await activity.getByRole('tab', { name: /^Algos/ }).click();
  await activity.getByRole('status').filter({ hasText: NOTE }).waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .getByRole('status')
    .filter({ hasText: /A new version of ValueDesk is out\. This tab runs 1 live algo, so it was not reloaded/ })
    .waitFor({ state: 'visible' });
  await page.waitForTimeout(1_000);
  assert.equal(navs(), 0, 'the tab that runs the algo was not reloaded');
  await page.evaluate(() => window.__vsTest!.algos.cancelAll());
});
