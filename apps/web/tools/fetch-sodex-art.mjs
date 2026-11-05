#!/usr/bin/env node
/**
 * Downloads SoDEX's own Blind Box artwork into apps/web/public/sodex-art, so visitors load nothing from
 * SoDEX's hosts (like fetch-logos.mjs). A maintenance tool, not a runtime dependency.
 *
 *   node apps/web/tools/fetch-sodex-art.mjs
 *
 * RUN ONLY ON THE OWNER'S WORD: these are SoDEX's pictures, and whether his OK for its icon set covers them
 * is his to confirm. Until the files exist, the page shows its drawn cubes (components/sodex/BoxArt.tsx).
 *
 * The file names on sodex.com are hashed and change with its builds: a 404 here means reading the new ones
 * off https://sodex.com/blind-box. The 1 MB pfp-unrevealed.gif and the reveal videos are left out on purpose:
 * too heavy for what they add on a view-only page.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sodex-art');
const SITE = 'https://sodex.com/assets/';

/** Published name -> SoDEX's file. About 310 kB in all. */
export const ART = {
  'box-common.webp': 'box-common-closed-TNmYYcrc.webp',
  'box-uncommon.webp': 'box-uncommon-closed-Cu7MnzGi.webp',
  'box-rare.webp': 'box-rare-closed-0T2oH-DJ.webp',
  'box-superrare.webp': 'box-superrare-closed-ZiFwE8gg.webp',
  'cyber-cat.webp': 'cyber-cat-cutout-DPJK59AI.webp',
};

mkdirSync(OUT, { recursive: true });
for (const [name, file] of Object.entries(ART)) {
  const r = await fetch(SITE + file);
  const type = r.headers.get('content-type') ?? '';
  if (!r.ok || !type.startsWith('image/')) throw new Error(`${file}: ${r.status} ${type}`);
  const body = Buffer.from(await r.arrayBuffer());
  writeFileSync(join(OUT, name), body);
  console.log(`${name}  ${Math.round(body.length / 1024)} kB  from ${SITE}${file}`);
}
