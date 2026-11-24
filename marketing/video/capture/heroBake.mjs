/**
 * The home page hero's layers (components/landing/site/AppDesk.tsx): each captured page (heroPages.mts) tilted in 3D and
 * drawn as three transparent pictures - the page with its tiles cut out, the tiles, the front tiles - so the browser
 * only moves pictures. From the repo root:
 *   IN=<dir of trade.png copy.png new.png> OUT=<dir> node marketing/video/capture/heroBake.mjs
 * then make <page>-<0..2>.webp 2160 wide and -s 1200 wide from the PNGs.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const K = 1240 / 1920;
/** x, y, width, height, how far above the page, corner, the height it is cut out at, layer. */
const cards = [0, 1].flatMap((row) => [0, 1, 2, 3, 4].map((i) => { const z = [44, 30, 58, 36, 50][(i + row * 2) % 5]; return [150 + [0, 340, 681, 1021, 1362][i], 517 + row * 242, 326, 228, z, 14, 0, z > 40 ? 2 : 1]; }));
const PAGES = {
  trade: ['trade', [[72, 6, 1844, 48, 34, 12, 0, 1], [72, 60, 1074, 63, 34, 12, 0, 1], [72, 127, 1074, 604, 34, 14, 0, 1], [72, 735, 1459, 333, 44, 14, 0, 1], [1150, 60, 381, 671, 54, 14, 0, 2], [1535, 735, 381, 333, 64, 14, 0, 2], [1535, 60, 381, 671, 78, 14, 0, 2]]],
  copy: ['copy', cards],
  bots: ['new', [[374, 228, 848, 787, 18, 18, 0, 1], ...[291, 397, 681, 787, 892].map((y) => [397, y, 802, 100, 32, 12, 18.5, 2]), [397, 502, 802, 173, 50, 12, 18.5, 2], [1234, 228, 380, 837, 78, 18, 0, 2]]],
};
const b = await chromium.launch({ executablePath: process.env.VS_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const pg = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
for (const [name, [src, panels]] of Object.entries(PAGES)) {
  const img = `url(data:image/png;base64,${readFileSync(`${process.env.IN}/${src}.png`).toString('base64')})`;
  const box = ([x, y, w, h, , r]) => `left:${x * K}px;top:${y * K}px;width:${w * K}px;height:${h * K}px;border-radius:${r * K}px;`;
  const hole = (p) => `<span class="hole l${p[6] ? 1 : 0}" style="${box(p)}${p[6] ? `transform:translateZ(${p[6]}px)` : ''}"></span>`;
  const pane = (p) => `<span class="pane l${p[7]}" style="${box(p)}background-position:${-p[0] * K}px ${-p[1] * K}px;transform:translateZ(${p[4]}px)"></span>`;
  for (const layer of [0, 1, 2]) {
    await pg.setContent(`<style>html,body{margin:0;background:transparent}
.rig{position:absolute;left:100px;top:40px;width:1320px;height:780px;perspective:2600px;perspective-origin:50% 6%}
.tilt{position:absolute;left:40px;top:34px;width:1240px;height:697.5px;transform-style:preserve-3d;transform:rotateX(29deg) rotateZ(-3deg)}
.page{position:absolute;inset:0;border-radius:22px;transform-style:preserve-3d}
.bg{position:absolute;inset:0;border-radius:22px;background:#0e0f10 ${img} 0 0/1240px 697.5px no-repeat;box-shadow:0 60px 60px -30px rgba(0,0,0,.75),0 0 0 1px rgba(190,180,255,.34),inset 0 1px 0 rgba(255,255,255,.25)}
span{position:absolute}.hole{background:#0a0b0c;box-shadow:inset 0 0 24px rgba(0,0,0,.7)}
.pane{background:#17181a ${img} 0 0/1240px 697.5px no-repeat;box-shadow:0 30px 44px -20px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.1),inset 0 1px 0 rgba(255,255,255,.12)}
.l0,.l1,.l2{visibility:hidden}.l${layer}{visibility:visible}</style>
<div class="rig"><div class="tilt"><div class="page"><div class="bg l0"></div>${panels.map(hole).join('')}${panels.map(pane).join('')}</div></div></div>`);
    await pg.waitForTimeout(700);
    await pg.screenshot({ path: `${process.env.OUT}/${name}-${layer}.png`, omitBackground: true, clip: { x: 40, y: 60, width: 1440, height: 860 } });
  }
  console.log(name);
}
await b.close();
