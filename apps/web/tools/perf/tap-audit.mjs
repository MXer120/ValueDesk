// Lists the visible tap targets smaller than 44x44 px at 375x812 (Android Chrome, touch), per page.
//   node tap-audit.mjs <origin> [--pages=/trade,/points,/bots,/portfolio] [--port=9371]
import { launchChrome, newPage, evaluate, sleep, parseArgs } from "./cdp.mjs";
const { flags, positional } = parseArgs(process.argv.slice(2));
const origin = positional[0];
const PAGES = String(flags.pages ?? '/trade,/points,/bots,/portfolio').split(',');
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A346B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const chrome = await launchChrome({ port: Number(flags.port ?? 9371), width: 375, height: 812 });
const probe = `(() => {
  const out = [];
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=radio], [role=switch], [role=menuitem], [role=checkbox]';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight * 3) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    if (r.height >= 44 && r.width >= 44) continue;
    if (el.matches('input[type=checkbox], input[type=radio]') && el.closest('label')) continue;
    const cls = (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean)[0] || el.tagName.toLowerCase();
    out.push({ cls, w: Math.round(r.width), h: Math.round(r.height), text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24) });
  }
  return JSON.stringify(out);
})()`;
try {
  for (const path of PAGES) {
    const page = await newPage(chrome.cdp, { width: 375, height: 812, dpr: 2 });
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    await page.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('vd.site.terms.look', JSON.stringify('2026-11-14'))}catch{}` });
    await page.send('Page.navigate', { url: origin + path });
    await sleep(9000);
    const list = JSON.parse(await evaluate(page, probe));
    const by = new Map();
    for (const x of list) { const k = x.cls; const e = by.get(k) ?? { n: 0, w: x.w, h: x.h, text: x.text }; e.n++; by.set(k, e); }
    console.log(`\n${path}: ${list.length} targets under 44 px`);
    for (const [k, e] of [...by].sort((a, b) => b[1].n - a[1].n).slice(0, 25)) console.log(`  ${String(e.n).padStart(3)}  ${k.padEnd(28)} ${e.w}x${e.h}  "${e.text}"`);
    await page.close();
  }
} finally {
  await chrome.close();
}
