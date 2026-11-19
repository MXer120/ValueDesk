// Does the trade chart pan with one finger and zoom with two? Real touch events over CDP at 375x812.
//   node touch-chart.mjs <origin> [--port=9391]
import { writeFileSync } from 'node:fs';
import { launchChrome, newPage, evaluate, sleep, parseArgs } from "./cdp.mjs";
const { flags, positional } = parseArgs(process.argv.slice(2));
const origin = positional[0];
const out = String(flags.out ?? '.');
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A346B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const chrome = await launchChrome({ port: Number(flags.port ?? 9391), width: 375, height: 812 });
try {
  const page = await newPage(chrome.cdp, { width: 375, height: 812, dpr: 2 });
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await page.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('vd.site.terms.look', JSON.stringify('2026-11-14'))}catch{}` });
  await page.send('Page.navigate', { url: `${origin}/trade` });
  await sleep(10000);
  // The chart's canvas area: the biggest canvas on the page.
  const box = JSON.parse(await evaluate(page, `(() => { const c = [...document.querySelectorAll('canvas')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 100 && r.height > 100).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return JSON.stringify(c ? { x: c.x, y: c.y, w: c.width, h: c.height } : null); })()`));
  if (!box) throw new Error('no chart canvas');
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  // What the chart shows: the x-axis labels' text (klinecharts draws them; read through the app's own read-out is not
  // available), so compare screenshots of the chart area instead.
  const shot = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } }); writeFileSync(`${out}/touch-${name}.png`, Buffer.from(data, 'base64')); return data; };
  const scroll0 = await evaluate(page, 'window.scrollY');
  const a = await shot('0-before');
  const touch = async (type, points) => page.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  // One finger, right to left: pan.
  await touch('touchStart', [[cx + 80, cy]]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [[cx + 80 - i * 16, cy]]); await sleep(16); }
  await touch('touchEnd', []);
  await sleep(600);
  const b = await shot('1-panned');
  // Two fingers apart: zoom in.
  await touch('touchStart', [[cx - 20, cy], [cx + 20, cy]]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [[cx - 20 - i * 8, cy], [cx + 20 + i * 8, cy]]); await sleep(16); }
  await touch('touchEnd', []);
  await sleep(600);
  const c = await shot('2-pinched');
  const scroll1 = await evaluate(page, 'window.scrollY');
  console.log(JSON.stringify({ box, panChanged: a !== b, pinchChanged: b !== c, pageScrolled: scroll1 !== scroll0 }));
} finally {
  await chrome.close();
}
