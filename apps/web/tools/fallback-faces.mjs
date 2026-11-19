/**
 * METRIC-MATCHED FALLBACK FACES for the three self-hosted families (phone pass, 2026-11-18).
 *
 * Every face is `font-display: swap`: until IBM Plex Sans, Asap and Space Grotesk have arrived (~1.3 s after the
 * first paint on /trade over "Slow 4G"), text is drawn in the next family of the stack, a system face of other
 * widths and heights - and every line, column and button re-lays out when the real face swaps in. A fallback face is
 * a local font (no download) told to take the real face's size: `size-adjust` from the two faces' average advance
 * width, `ascent-override` / `descent-override` / `line-gap-override` from the real face's vertical metrics (hhea), so
 * the swap changes the letter shapes but moves almost nothing.
 *
 * MEASURED, NOT ASSUMED: the real faces' numbers are read from the @fontsource files in node_modules (WOFF 1.0:
 * zlib tables), the local font's from its own file (`ARIAL` below, read from Windows' arial.ttf 7.07 and kept here,
 * since a build machine has no Arial). Widths are averaged over a sample weighted like what the face draws: running
 * text (English letter frequencies, a tenth as many capitals, spaces) for Plex and Space Grotesk, figures and their
 * separators for Asap (--font-num: prices, sizes, percentages).
 *
 * ONLY WHERE THE REAL FACE DRAWS: each fallback face's unicode-range is the code points the real face's latin and
 * latin-ext files actually hold. A character the real face does not have falls through to the system face as
 * before, so once the fonts are in, nothing on screen differs from before this existed.
 *
 * WHERE IT APPLIES: local('Arial') is on Windows, macOS and iOS; local('Liberation Sans') (Arial's metrics) on most
 * Linux. NOT ON ANDROID: its system face is Roboto, whose metrics need Roboto's own file, which is not on the machine
 * this was measured on - adding a Roboto face is the same table with Roboto's numbers (tools/fallback-faces.mjs).
 *
 *   node tools/fallback-faces.mjs [path/to/arial.ttf]   prints the CSS (styles.css "fallback faces" holds it);
 *                                                        with a path, also the local font's numbers measured afresh
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ font files ----- */

/** The tables of a TrueType/OpenType file or a WOFF 1.0 file, by tag. */
export function tablesOf(buf) {
  const sig = buf.readUInt32BE(0);
  const out = new Map();
  if (sig === 0x774f4646) {
    // 'wOFF': 44-byte header, then 20-byte entries (tag, offset, compLength, origLength, checksum).
    const n = buf.readUInt16BE(12);
    for (let i = 0; i < n; i++) {
      const e = 44 + i * 20;
      const tag = buf.toString('latin1', e, e + 4);
      const off = buf.readUInt32BE(e + 4);
      const comp = buf.readUInt32BE(e + 8);
      const orig = buf.readUInt32BE(e + 12);
      const raw = buf.subarray(off, off + comp);
      out.set(tag, comp < orig ? inflateSync(raw) : raw);
    }
    return out;
  }
  if (sig === 0x00010000 || sig === 0x4f54544f || sig === 0x74727565) {
    const n = buf.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      const e = 12 + i * 16;
      const tag = buf.toString('latin1', e, e + 4);
      const off = buf.readUInt32BE(e + 8);
      const len = buf.readUInt32BE(e + 12);
      out.set(tag, buf.subarray(off, off + len));
    }
    return out;
  }
  throw new Error('fallback-faces: not a TTF/OTF or WOFF 1.0 file');
}

/** Code point -> glyph id, from cmap format 4 (BMP) or 12 (full). */
function cmapOf(t) {
  const n = t.readUInt16BE(2);
  let best = null;
  for (let i = 0; i < n; i++) {
    const pid = t.readUInt16BE(4 + i * 8);
    const eid = t.readUInt16BE(6 + i * 8);
    const off = t.readUInt32BE(8 + i * 8);
    const fmt = t.readUInt16BE(off);
    if (pid === 3 && eid === 10 && fmt === 12) { best = off; break; }
    if (((pid === 3 && eid === 1) || pid === 0) && fmt === 4 && best === null) best = off;
    if (pid === 0 && fmt === 12) best = off;
  }
  if (best === null) throw new Error('fallback-faces: no usable cmap');
  const map = new Map();
  const fmt = t.readUInt16BE(best);
  if (fmt === 12) {
    const groups = t.readUInt32BE(best + 12);
    for (let g = 0; g < groups; g++) {
      const p = best + 16 + g * 12;
      const start = t.readUInt32BE(p);
      const end = t.readUInt32BE(p + 4);
      const gid = t.readUInt32BE(p + 8);
      for (let c = start; c <= end; c++) map.set(c, gid + (c - start));
    }
    return map;
  }
  const segX2 = t.readUInt16BE(best + 6);
  const ends = best + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const offsets = deltas + segX2;
  for (let s = 0; s < segX2 / 2; s++) {
    const end = t.readUInt16BE(ends + s * 2);
    const start = t.readUInt16BE(starts + s * 2);
    const delta = t.readInt16BE(deltas + s * 2);
    const ro = t.readUInt16BE(offsets + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let gid;
      if (ro === 0) gid = (c + delta) & 0xffff;
      else {
        const at = offsets + s * 2 + ro + (c - start) * 2;
        gid = t.readUInt16BE(at);
        if (gid !== 0) gid = (gid + delta) & 0xffff;
      }
      if (gid !== 0) map.set(c, gid);
    }
  }
  return map;
}

/** What a face's metrics come to: units per em, hhea's vertical metrics, a glyph's advance, its code points. */
export function readFont(buf) {
  const t = tablesOf(buf);
  const head = t.get('head');
  const hhea = t.get('hhea');
  const hmtx = t.get('hmtx');
  const upm = head.readUInt16BE(18);
  const ascent = hhea.readInt16BE(4);
  const descent = hhea.readInt16BE(6);
  const lineGap = hhea.readInt16BE(8);
  const nh = hhea.readUInt16BE(34);
  const cmap = cmapOf(t.get('cmap'));
  const advance = (gid) => hmtx.readUInt16BE(Math.min(gid, nh - 1) * 4);
  return { upm, ascent, descent, lineGap, cmap, advance };
}

/* ---------------------------------------------------------------------- samples ----- */

/** English letter frequencies (%, Lewand), the share the averages are weighted by. */
const LETTERS = { a: 8.2, b: 1.5, c: 2.8, d: 4.3, e: 12.7, f: 2.2, g: 2.0, h: 6.1, i: 7.0, j: 0.15, k: 0.77, l: 4.0, m: 2.4, n: 6.7, o: 7.5, p: 1.9, q: 0.095, r: 6.0, s: 6.3, t: 9.1, u: 2.8, v: 0.98, w: 2.4, x: 0.15, y: 2.0, z: 0.074 };
/** Running text: the letters, a tenth as many capitals, and a space for every ~5 letters. */
export const TEXT_SAMPLE = [...Object.entries(LETTERS), ...Object.entries(LETTERS).map(([c, f]) => [c.toUpperCase(), f / 10]), [' ', 20]];
/** --font-num: figures, and the separators between them. */
export const FIGURE_SAMPLE = [...'0123456789'].map((c) => [c, 10]).concat([['.', 6], [',', 4], ['%', 1.5], ['$', 1.5], ['-', 1.5], ['+', 1]]);

/** The average advance of a sample, in em. */
export function avgWidth(font, sample) {
  let sum = 0;
  let weight = 0;
  for (const [ch, w] of sample) {
    const gid = font.cmap.get(ch.codePointAt(0));
    if (gid === undefined) throw new Error(`fallback-faces: the face has no ${JSON.stringify(ch)}`);
    sum += (font.advance(gid) / font.upm) * w;
    weight += w;
  }
  return sum / weight;
}

/* -------------------------------------------------------------------- the faces ----- */

/**
 * Arial Regular, measured from Windows 11's arial.ttf (name table: "Version 7.07"): units per em, hhea
 * ascent/descent/line gap, and the two sample averages in em (2026-11-18).
 * `node tools/fallback-faces.mjs C:/Windows/Fonts/arial.ttf` measures them again.
 */
export const ARIAL = { upm: 2048, ascent: 1854, descent: -434, lineGap: 67, text: 0.46126, figures: 0.53372 };

/** The CSS code points a face draws (cmap within the subset's own unicode-range), as compact ranges. */
export function rangesOf(cps) {
  const list = [...new Set(cps)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    const h = (n) => n.toString(16).toUpperCase().padStart(4, '0');
    out.push(i === j ? `U+${h(list[i])}` : `U+${h(list[i])}-${h(list[j])}`);
    i = j;
  }
  return out.join(',');
}

/** Code points of a unicode-range string. */
export function inRange(range) {
  const parts = range.split(',').map((p) => p.trim().replace(/^U\+/i, '')).map((p) => {
    const [a, b] = p.split('-');
    return [parseInt(a, 16), parseInt(b ?? a, 16)];
  });
  return (cp) => parts.some(([a, b]) => cp >= a && cp <= b);
}

const pct = (n) => `${(Math.round(n * 1e4) / 1e2).toFixed(2)}%`;

/** One fallback @font-face: the local font sized to the real face. */
export function faceRule({ family, weight, real, local = ARIAL, sample, range }) {
  const realW = avgWidth(real, sample);
  const localW = sample === FIGURE_SAMPLE ? local.figures : local.text;
  const size = realW / localW;
  return `@font-face { font-family: "${family} Fallback"; src: local("Arial"), local("ArialMT"), local("Liberation Sans"); font-weight: ${weight}; ` +
    `size-adjust: ${pct(size)}; ascent-override: ${pct(real.ascent / real.upm / size)}; descent-override: ${pct(-real.descent / real.upm / size)}; line-gap-override: ${pct(real.lineGap / real.upm / size)}; ` +
    `unicode-range: ${range}; }`;
}

const require = createRequire(import.meta.url);
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
/** A @fontsource package's folder, from apps/web. */
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`, { paths: [WEB] }));

/** The faces main.tsx loads: family, package, file stem, weights, the sample its text is. */
export const FACES = [
  { family: 'IBM Plex Sans', pkg: '@fontsource/ibm-plex-sans', stem: 'ibm-plex-sans', weights: [400, 500], sample: TEXT_SAMPLE },
  { family: 'Asap', pkg: '@fontsource/asap', stem: 'asap', weights: [400, 500], sample: FIGURE_SAMPLE },
  { family: 'Space Grotesk', pkg: '@fontsource/space-grotesk', stem: 'space-grotesk', weights: [600], sample: TEXT_SAMPLE },
];

/** The unicode-range a subset's CSS declares for that weight. */
function declaredRange(dir, stem, subset, weight) {
  const css = readFileSync(join(dir, `${weight}.css`), 'utf8');
  const m = new RegExp(`/\\* ${stem}-${subset}-${weight}-normal \\*/[^}]*unicode-range:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`fallback-faces: no ${subset} range in ${stem}/${weight}.css`);
  return m[1];
}

/** Every fallback face, as the CSS styles.css holds. */
export function fallbackCss() {
  const rules = [];
  for (const f of FACES) {
    const dir = pkgDir(f.pkg);
    for (const weight of f.weights) {
      const fonts = ['latin', 'latin-ext'].map((subset) => ({
        font: readFont(readFileSync(join(dir, 'files', `${f.stem}-${subset}-${weight}-normal.woff`))),
        has: inRange(declaredRange(dir, f.stem, subset, weight)),
      }));
      const cps = fonts.flatMap(({ font, has }) => [...font.cmap.keys()].filter((cp) => cp >= 0x20 && has(cp)));
      rules.push(faceRule({ family: f.family, weight, real: fonts[0].font, sample: f.sample, range: rangesOf(cps) }));
    }
  }
  return rules.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arial = process.argv[2];
  if (arial) {
    const a = readFont(readFileSync(arial));
    console.log(`/* local font: upm ${a.upm}, ascent ${a.ascent}, descent ${a.descent}, lineGap ${a.lineGap}, text ${avgWidth(a, TEXT_SAMPLE).toFixed(5)}, figures ${avgWidth(a, FIGURE_SAMPLE).toFixed(5)} */`);
  }
  console.log(fallbackCss());
}
