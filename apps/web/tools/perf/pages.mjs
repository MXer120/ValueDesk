// The pages every tool walks, and the public wallets the Scan pages show.
import { evaluate, sleep } from './cdp.mjs';

export const SCAN_VENUES = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];

/**
 * One public wallet per venue for the Scan pages: PERF_ADDR_<VENUE> when set (pin
 * them to compare runs made on different days), else the top of the venue's 30-day
 * board as the served API answers it right now. A venue without an answer is left
 * out, and so is its Scan page.
 */
export async function scanAddresses(origin) {
  const out = {};
  for (const venue of SCAN_VENUES) {
    const pinned = process.env[`PERF_ADDR_${venue.toUpperCase()}`];
    if (pinned) { out[venue] = pinned.toLowerCase(); continue; }
    try {
      const res = await fetch(`${origin}/api/vs/leaderboard?venue=${venue}&window=30d&sort=pnl&limit=1`);
      const address = (await res.json())?.rows?.[0]?.address;
      if (/^0x[0-9a-f]{40}$/i.test(address ?? '')) out[venue] = address.toLowerCase();
    } catch { /* that venue's Scan page is skipped */ }
  }
  return out;
}

export async function pressCtrlK(page) {
  const base = { modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75 };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** metrics.mjs only (it installs window.__perf): the long tasks that opening the palette costs. */
async function paletteAction(page) {
  const before = await evaluate(page, 'window.__perf.lt.length');
  const t = await evaluate(page, 'performance.now()');
  await pressCtrlK(page);
  await sleep(2500);
  const lt = await evaluate(page, 'JSON.stringify(window.__perf.lt)').then(JSON.parse);
  const after = lt.slice(before);
  return { longTasks: after.length, longTaskMs: after.reduce((s, [, d]) => s + d, 0), startedAt: t };
}

/**
 * Every landing page, each Scan venue that has an address, and the command palette
 * opened on the trade page.
 *
 * `ready` is the page's own data on screen: the first element matching the selector
 * (with a digit in its text unless `anyText`), which metrics.mjs times as "data shown".
 * Pages without one show nothing that waits for data (no wallet is connected).
 */
export function pagesFor(addr = {}) {
  const scan = SCAN_VENUES.filter((v) => addr[v]).map((v) => ({
    id: `scan-${v}`,
    path: v === 'sodex' ? `/scan?address=${addr[v]}` : `/scan?address=${addr[v]}&venue=${v}`,
    ready: { selector: '.pf-chart__xlabel' },
  }));
  return [
    { id: 'trade', path: '/trade', ready: { selector: '.mkt-bookrow' } },
    { id: 'explore', path: '/explore', ready: { selector: '.vs-trader' } },
    { id: 'cohorts', path: '/explore?view=cohorts', ready: { selector: '.coh-card__wallets' } },
    { id: 'marketmap', path: '/explore?view=cohorts&section=map', ready: { selector: '.coh-tree__tile', anyText: true } },
    { id: 'leaderboard', path: '/leaderboard', ready: { selector: '.lbp-trader' } },
    { id: 'copy', path: '/copy', ready: { selector: '.copy-addr' } },
    { id: 'portfolio', path: '/portfolio' },
    { id: 'scan', path: '/scan' },
    ...scan,
    { id: 'palette', path: '/trade', ready: { selector: '.mkt-bookrow' }, action: paletteAction, palette: true },
  ];
}

/** `--pages=<regex>` narrows the walk to the page ids it matches. */
export function selectPages(pages, pattern) {
  if (!pattern || pattern === true) return pages;
  const re = new RegExp(pattern);
  return pages.filter((p) => re.test(p.id));
}
