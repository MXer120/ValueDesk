// A cold phone load as pictures: screenshots at fixed seconds after navigation, Slow 4G (DevTools preset values) + 4x CPU,
// 375x812 Android Chrome. For before/after comparisons of what a visitor sees while a page loads.
//   node tools/perf/filmstrip.mjs <origin><path> <outDir> <name> [--at=1,2,3,4,6,8,10] [--profile=slow4g|fast4g] [--theme=dark|light] [--port=9411]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, newPage, sleep, parseArgs } from './cdp.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const [url, outDir, name] = positional;
const AT = String(flags.at ?? '1,2,3,4,6,8,10').split(',').map(Number);
const NET = flags.profile === 'fast4g'
  ? { offline: false, latency: 60 * 2.75, downloadThroughput: (9 * 1000 * 1000) / 8 * 0.9, uploadThroughput: (1.5 * 1000 * 1000) / 8 * 0.9 }
  : { offline: false, latency: 150 * 3.75, downloadThroughput: (1.6 * 1000 * 1000) / 8 * 0.9, uploadThroughput: (750 * 1000) / 8 * 0.9 };
const theme = flags.theme === 'light' ? 'light' : 'dark';
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A346B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
mkdirSync(outDir, { recursive: true });
const chrome = await launchChrome({ port: Number(flags.port ?? 9411), width: 375, height: 812, extraArgs: ['--ignore-certificate-errors'] }); // the local HTTP/2 server's self-signed certificate
try {
  const page = await newPage(chrome.cdp, { width: 375, height: 812, dpr: 1 });
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await page.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await page.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.send('Network.enable');
  await page.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.send('Network.emulateNetworkConditions', NET);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('vd.site.terms.look', JSON.stringify('2026-11-14'));localStorage.setItem('vs.theme', ${JSON.stringify(theme)})}catch{}` });
  const t0 = Date.now();
  await page.send('Page.navigate', { url });
  for (const s of AT) {
    const wait = s * 1000 - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    const file = join(outDir, `${name}-${String(s).padStart(2, '0')}s.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(file);
  }
} finally {
  await chrome.close();
}
