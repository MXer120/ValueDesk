/**
 * The windowed account tables under the simulated heavy account (fakeAccount.js): rows in the page, spacers,
 * column heads while scrolling, and a fill card, with screenshots.
 *   npx tsx e2e/perf/windowCheck.ts <dist> <shots dir>
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchEdge } from '../ui/browser';
import { acceptWelcome, connectWallet, dismissOnboarding, dismissSetup, hideDevPanel, newUiContext } from '../ui/harness';
import { createTestWallet } from '../ui/wallet';

const [dist, shots] = process.argv.slice(2);
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname.startsWith('/api')) {
    const r = await fetch(`http://127.0.0.1:8797${url.pathname}${url.search}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    res.writeHead(r?.status ?? 502, { 'content-type': r?.headers.get('content-type') ?? 'application/json' });
    return void res.end(r ? Buffer.from(await r.arrayBuffer()) : undefined);
  }
  let file = join(dist!, decodeURIComponent(url.pathname));
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist!, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const here = dirname(fileURLToPath(import.meta.url));
const browser = await launchEdge({ headed: false });
const wallet = createTestWallet();
const ctx = await newUiContext(browser, wallet);
const px = { 'BTC-USD': 80_000, 'ETH-USD': 2_400, 'SOL-USD': 95, 'SUI-USD': 0.93, 'ZEC-USD': 1_290, 'HYPE-USD': 30 };
await ctx.addInitScript({ content: `window.__VS_FAKE = ${JSON.stringify({ owner: wallet.address, prices: px })};` });
await ctx.addInitScript({ content: readFileSync(join(here, 'fakeAccount.js'), 'utf8') });
const page = await ctx.newPage();
await page.goto(`${origin}/trade`, { waitUntil: 'domcontentloaded' });
await hideDevPanel(page).catch(() => {});
await acceptWelcome(page).catch(() => {});
await connectWallet(page, { settle: true }).catch(() => {});
await dismissOnboarding(page, 3000).catch(() => {});
await dismissSetup(page, 3000).catch(() => {});
await page.evaluate(() => (window as any).__vsLoad.set({ updatesPerSec: 100, fillsPerSec: 12, openOrders: 1000, positions: 8 }));
await page.getByRole('tab', { name: /^Open orders/i }).first().click();
await page.waitForTimeout(12_000);

const look = () => page.evaluate(() => {
  const body = [...document.querySelectorAll<HTMLElement>('table.acct-t tbody')].find((b) => b.offsetParent)!;
  const rows = [...body.children] as HTMLElement[];
  const spacers = rows.filter((r) => r.classList.contains('acct-spacer'));
  let sc: HTMLElement | null = body.parentElement;
  while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
  const heads = [...body.closest('table')!.tHead!.rows[0]!.cells].map((h) => h.offsetWidth);
  const box = sc!.getBoundingClientRect();
  const under = document.elementFromPoint(box.left + 80, box.top + 60)?.closest('tr');
  return {
    rows: rows.length - spacers.length, spacers: spacers.map((s) => s.offsetHeight), totalHeight: body.offsetHeight,
    scrollHeight: sc!.scrollHeight, scrollTop: sc!.scrollTop, clientHeight: sc!.clientHeight, heads, seen: under?.textContent?.slice(0, 40) ?? null,
  };
});
const scrollTo = (y: number) => page.evaluate((to) => {
  const body = [...document.querySelectorAll<HTMLElement>('table.acct-t tbody')].find((b) => b.offsetParent)!;
  let sc: HTMLElement | null = body.parentElement;
  while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
  sc!.scrollTop = to;
}, y);
console.log('top', JSON.stringify(await look()));
await page.screenshot({ path: join(shots!, 'win-top.png') });
const fills = await page.getByText(/^[\d,]+ fills$/).count();
console.log('fill summary cards', fills);
for (const y of [1000, 3000, 6000, 100_000]) {
  await scrollTo(y);
  await page.waitForTimeout(400);
  console.log('at', y, JSON.stringify(await look()));
}
await page.screenshot({ path: join(shots!, 'win-bottom.png') });
await scrollTo(3000);
await page.waitForTimeout(400);
await page.screenshot({ path: join(shots!, 'win-mid.png') });

await page.getByRole('tab', { name: /^Trade history/i }).first().click();
await page.waitForTimeout(3000);
for (let i = 0; i < 6; i++) {
  await scrollTo(10_000_000);
  await page.waitForTimeout(300);
  const more = page.getByRole('button', { name: /load more/i }).first();
  if (await more.count()) await more.click().catch(() => {});
  await page.waitForTimeout(800);
}
console.log('trades', JSON.stringify(await look()));
await page.screenshot({ path: join(shots!, 'win-trades.png') });
await browser.close();
server.close();
process.exit(0);
