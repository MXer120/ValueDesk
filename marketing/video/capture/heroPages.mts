/**
 * The landing hero's pages (components/landing/v3/Terminal.tsx): Trade with the demo account, Copy and Bots, each one
 * picture plus the boxes of its panels. From apps/web:
 *   VD_WEB=http://localhost:5180 OUT=<dir> npx tsx ../../marketing/video/capture/heroPages.mts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { openDemo, setView } from './demoKit.mts';
import { connectWallet } from '../../../apps/web/e2e/ui/harness';
import { fakeSodexAccount } from '../../../apps/web/e2e/ui/sodexFake';
import { createTestWallet } from '../../../apps/web/e2e/ui/wallet';

const LOOK = { 'vd.site.terms.look': '"2026-11-23"' };
/** Near the market on the capture day; a mixed, modest account. */
const ACCOUNT = { balance: 25_000, stateful: true, positions: [{ symbol: 'BTC-USD', size: '0.12', entry: '61020', leverage: 10 }, { symbol: 'ETH-USD', size: '-1.8', entry: '1709', leverage: 5 }, { symbol: 'SOL-USD', size: '24', entry: '71.2', leverage: 5 }] };

const OUT = process.env.OUT!;
setView(1080);
const boxes: Record<string, Array<[string, number, number, number, number]>> = {};
const HIDE = '.toast, .toasts, .notices, [class*="idxprompt"], [class*="index-prompt"], [class*="navalert"], [class*="NavAlert"], .nav-alert { visibility: hidden !important } #__film_cursor { display: none }';
async function take(p: Page, name: string, sels: Array<[string, string]>) {
  await p.addStyleTag({ content: HIDE });
  await p.mouse.move(2, 2);
  await p.waitForTimeout(700);
  await p.screenshot({ path: join(OUT, `${name}.png`) });
  boxes[name] = [];
  for (const [k, s] of sels) for (const el of await p.locator(s).all()) {
    const b = await el.boundingBox();
    if (b && b.width > 40 && b.y < 1080) boxes[name]!.push([k, Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]);
  }
  console.log(name, JSON.stringify(boxes[name]).slice(0, 900));
}
const only = process.env.ONLY?.split(',');
if (!only || only.includes('trade')) {
  const w = createTestWallet();
  const d = await openDemo('/trade', { trading: false, storage: LOOK, before: async (ctx) => { await w.install(ctx); await fakeSodexAccount(ctx, w.address, ACCOUNT as never); } });
  await d.page.getByRole('complementary', { name: 'Tools' }).getByRole('button', { name: /^Connect/ }).first().waitFor({ state: 'visible', timeout: 60_000 });
  await connectWallet(d.page);
  await d.page.waitForTimeout(14000);
  await take(d.page, 'trade', [['cell', '.dash-cell, .panel, [class*="dash-panel"]'], ['tabs', '.mkt-tabs, [class*="markettabs"]'], ['nav', 'header, .navbar'], ['rail', '.sidebar, [class*="rail"]']]);
  console.log(await d.page.evaluate(() => [...document.querySelectorAll('main *, .app *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 180 && r.height > 120 && parseFloat(getComputedStyle(e).borderTopLeftRadius) > 5; }).map((e) => { const r = e.getBoundingClientRect(); return `${(e as HTMLElement).className}`.slice(0, 50) + ' ' + [r.x, r.y, r.width, r.height].map(Math.round).join(','); }).join('\n')));
  await d.close();
}
for (const [n, path] of [['copy', '/copy'], ['new', '/bots/new'], ['explore', '/bots/explore']] as const) {
  if (only && !only.includes(n)) continue;
  const d = await openDemo(path, { trading: false, storage: LOOK });
  await d.page.waitForTimeout(13000);
  if (n === 'new') for (let i = 0; i < 2; i++) { await d.page.getByRole('button', { name: /^Next/ }).first().click({ timeout: 8000 }).catch(() => console.log('no next')); await d.page.waitForTimeout(5000); }
  await take(d.page, n, [['card', '.card, [class*="tcard"], [class*="copy-card"], [class*="shellcard"]']]);
  console.log(await d.page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 180 && r.height > 90 && r.y < 1080 && parseFloat(getComputedStyle(e).borderTopLeftRadius) > 5; }).slice(0, 40).map((e) => { const r = e.getBoundingClientRect(); return `${(e as HTMLElement).className}`.slice(0, 50) + ' ' + [r.x, r.y, r.width, r.height].map(Math.round).join(','); }).join('\n')));
  await d.close();
}
writeFileSync(join(OUT, 'boxes.json'), JSON.stringify(boxes));
