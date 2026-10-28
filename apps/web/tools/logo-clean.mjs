#!/usr/bin/env node
/**
 * Logo hygiene for the logo tools: sanitise SVGs, then shrink SVGs and PNGs
 * without changing a pixel.
 *
 *   node apps/web/tools/logo-clean.mjs            clean public/logos in place, report
 *   node apps/web/tools/logo-clean.mjs --check    report only; exit 1 if anything would change
 *
 * fetch-logos.mjs and fetch-venue-logos.mjs run every downloaded SVG through
 * `cleanSvg`, and every PNG through png-shrink.mjs (which recompresses), before
 * writing it.
 *
 * SANITISE (security audit W-09). These are third-party files served from our
 * own origin. Rendered through <img> an SVG can run nothing, but opened
 * directly (a link, a new tab) it is a document of this origin and its script
 * runs with the app's storage. Removed: <script>, <foreignObject>, <handler>,
 * every on* event attribute, any href / xlink:href / src that is not an
 * in-document #fragment or an image data: URI (javascript:, http(s):, //,
 * relative files), animations that target an href, and @import / external
 * url() in CSS. Nothing removed here can affect how the file renders as an
 * image: an <img> never runs script, never renders foreignObject content from
 * another origin, and never fetches external resources.
 *
 * MINIFY, LOSSLESSLY. Only bytes that cannot change the rendering go:
 *   - CR before LF (an XML parser normalises line ends itself);
 *   - the XML declaration, comments (not one carrying rights information), the DOCTYPE, <metadata>, and editor
 *     namespaces (inkscape:, sodipodi:, sketch:);
 *   - whitespace between tags, when the file has no text content;
 *   - redundant separators and zeros in path data and point lists ("0.50" ->
 *     ".5", "1, -2" -> "1-2") and repeated command letters;
 *   - embedded PNGs are re-deflated losslessly (png-shrink.mjs recompressPng,
 *     which proves the decoded pixels are identical before using the result).
 * Every coordinate keeps its exact value - no rounding, no relative/absolute
 * conversion - so the rasteriser sees the same geometry. Rounding coordinates
 * (what SVGO does by default) was measured and rejected: at 2-3 decimals it
 * changed anti-aliased edge pixels in most of the large logos.
 */
import { readFileSync, writeFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recompressPng } from './png-shrink.mjs';

/* ------------------------------------------------------------------ sanitise */

const IMAGE_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i;

/** A reference that is safe to keep: in-document, or an image data URI. */
function safeRef(value) {
  const v = value.trim().replace(/&#(?:x0*9|0*9|x0*a|0*10|x0*d|0*13);|[\t\n\r]/gi, '');
  return v.startsWith('#') || IMAGE_DATA_URI.test(v);
}

const ATTR = (name) => new RegExp(`\\s(${name})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');

/** @returns {{ svg: string, removed: string[] }} */
export function sanitizeSvg(input) {
  let svg = input;
  const removed = [];
  const drop = (re, what) => {
    svg = svg.replace(re, (m) => {
      removed.push(what);
      return '';
    });
  };
  // Elements that can run script or embed a document, content and all.
  for (const tag of ['script', 'foreignObject', 'handler', 'iframe', 'embed', 'object']) {
    drop(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*?/>`, 'gi'), `<${tag}/>`);
    drop(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[\\s\\S]*?</(?:[\\w-]+:)?${tag}\\s*>`, 'gi'), `<${tag}>`);
  }
  // Animations that rewrite a link target (<animate attributeName="href" values="javascript:...">).
  drop(/<(?:animate|set)\b[^>]*attributeName\s*=\s*["']?(?:xlink:)?href\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:animate|set)\s*>)/gi, '<animate href>');
  // Event handlers.
  drop(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, 'on* attribute');
  // Links and sources that leave the document (external files, javascript:).
  svg = svg.replace(ATTR('(?:xlink:)?href|src'), (m, name, d, s, u) => {
    const value = d ?? s ?? u ?? '';
    if (safeRef(value)) return m;
    removed.push(`${name}="${value.slice(0, 40)}"`);
    return '';
  });
  // CSS: no imports, no external url(), no legacy expression().
  const cleanCss = (css) =>
    css
      .replace(/@import\b[^;]*;?/gi, () => (removed.push('@import'), ''))
      .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, ref) => (safeRef(ref) ? m : (removed.push('external url()'), 'none')))
      .replace(/expression\s*\(/gi, () => (removed.push('expression()'), 'invalid('));
  svg = svg.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, open, css, close) => open + cleanCss(css) + close);
  svg = svg.replace(/(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, pre, d, s) => {
    const css = d ?? s;
    const out = cleanCss(css);
    return out === css ? m : `${pre}"${out.replace(/"/g, '&quot;')}"`;
  });
  return { svg, removed };
}

/* ------------------------------------------------------------------ minify */

/** A number literal, shortest spelling of the SAME value: 0.50 -> .5, -0.5 -> -.5, 10.0 -> 10. */
function shortNum(t) {
  if (/e/i.test(t)) return t; // exponent forms stay as written
  let sign = '';
  if (t[0] === '-' || t[0] === '+') {
    sign = t[0] === '-' ? '-' : '';
    t = t.slice(1);
  }
  let [int, frac = ''] = t.split('.');
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  let out = frac ? `${int === '0' ? '' : int}.${frac}` : int || '0';
  if (out === '') out = '0';
  return sign + out;
}

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

/** Tokenise path data into commands and number literals; null if it is not plain path grammar. */
function tokenisePath(d) {
  const out = [];
  let i = 0;
  while (i < d.length) {
    const c = d[i];
    if (/[\s,]/.test(c)) { i++; continue; }
    if (/[MmZzLlHhVvCcSsQqTtAa]/.test(c)) { out.push({ cmd: c }); i++; continue; }
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) return null;
    out.push({ num: m[0] });
    i = NUM.lastIndex;
  }
  return out;
}

/** Join number literals with the fewest separators a parser still reads the same. */
function joinNums(nums) {
  let s = '';
  let prev = '';
  for (const raw of nums) {
    const n = shortNum(raw);
    if (!prev) s += n;
    else if (n[0] === '-' || (n[0] === '.' && /[.eE]/.test(prev))) s += n; // sign, or a second '.', starts a new number
    else s += ` ${n}`;
    prev = n;
  }
  return s;
}

export function minifyPath(d) {
  // Arcs may run their two flags together ("a1 1 0 01 2 3"), which a plain
  // number tokeniser misreads: leave any path with an arc exactly as written.
  if (/[Aa]/.test(d)) return d;
  const toks = tokenisePath(d);
  if (!toks) return d;
  const segs = [];
  for (const t of toks) {
    if (t.cmd) segs.push({ cmd: t.cmd, nums: [] });
    else if (segs.length) segs.at(-1).nums.push(t.num);
    else return d;
  }
  // A repeated command letter is implied, so runs of the same command merge -
  // never moveto (a repeat after M means lineto) or closepath (no arguments).
  const groups = [];
  for (const seg of segs) {
    const prev = groups.at(-1);
    if (prev && prev.cmd === seg.cmd && !/[MmZz]/.test(seg.cmd) && prev.nums.length && seg.nums.length) prev.nums.push(...seg.nums);
    else groups.push({ cmd: seg.cmd, nums: [...seg.nums] });
  }
  return groups.map(({ cmd, nums }) => cmd + joinNums(nums)).join('');
}

function hasText(svg) {
  return /<(?:[\w-]+:)?(?:text|tspan|textPath)\b/i.test(svg);
}

export function minifySvg(input) {
  let svg = input;
  svg = svg.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); // XML reads CRLF as LF anyway (XML 1.0 s2.11)
  svg = svg.replace(/<\?(?!xml-stylesheet)[\s\S]*?\?>/g, ''); // XML declaration, processing instructions
  // Comments go, except rights information (a copyright, licence or "by <author>" note): removing
  // that may touch § 95c UrhG, and the licence review (2026-10-28) asks to keep it.
  svg = svg.replace(/<!--[\s\S]*?-->/g, (c) => (/©|\(c\)|copyright|licen[cs]e|trademark|all rights|\bby\s+\S/i.test(c) ? c : ''));
  // A DOCTYPE with an internal subset may declare entities the document uses (&ns_svg;): kept.
  svg = svg.replace(/<!DOCTYPE[^[>]*>/gi, '');
  svg = svg.replace(/<metadata\b[\s\S]*?<\/metadata\s*>/gi, '').replace(/<metadata\b[^>]*\/>/gi, '');
  svg = svg.replace(/<(inkscape|sodipodi|sketch):[\w-]+\b[^>]*\/>/g, '');
  svg = svg.replace(/<(inkscape|sodipodi|sketch):([\w-]+)\b[\s\S]*?<\/\1:\2\s*>/g, '');
  svg = svg.replace(/\s(?:inkscape|sodipodi|sketch):[\w-]+\s*=\s*(?:"[^"]*"|'[^']*')/g, '');
  svg = svg.replace(/\sxmlns:(?:inkscape|sodipodi|sketch)\s*=\s*(?:"[^"]*"|'[^']*')/g, '');
  if (!hasText(svg)) svg = svg.replace(/>\s+</g, '><');
  svg = svg.replace(/(\sd\s*=\s*)(["'])([^"']*)\2/g, (m, pre, q, d) => `${pre}${q}${minifyPath(d)}${q}`);
  svg = svg.replace(/(\spoints\s*=\s*)(["'])([^"']*)\2/g, (m, pre, q, p) => {
    const nums = p.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
    const rest = p.replace(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g, '').replace(/[\s,]/g, '');
    return nums && !rest ? `${pre}${q}${joinNums(nums)}${q}` : m;
  });
  return svg.trim() + '\n';
}

/** Embedded PNGs, recompressed losslessly (same pixels, fewer bytes). */
export function recompressEmbedded(svg) {
  return svg.replace(/(data:image\/png;base64,)([A-Za-z0-9+/=\s]+)/g, (m, head, b64) => {
    const png = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
    const out = recompressPng(png);
    return out === png ? m : head + out.toString('base64');
  });
}

/** Sanitise, minify, recompress embedded PNGs. Accepts a Buffer or a string. */
export function cleanSvg(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const { svg, removed } = sanitizeSvg(text);
  return { svg: recompressEmbedded(minifySvg(svg)), removed };
}

/**
 * A traced (vectorised-photo) SVG slimmed for icon use: path coordinates
 * rounded to 1/1000 of the viewBox (invisible at the 14-128 px an icon is shown
 * at - an error of at most 0.05 % of its width), and the attributes a tracer
 * writes on every one of thousands of paths that only repeat the default
 * (opacity="1.000000"; stroke="none" where nothing sets a stroke). Used by
 * fetch-venue-logos.mjs on SVGs over SLIM_OVER bytes (some Hyperliquid memecoin
 * icons are 0.5-1 MB): the drawing stays the same, the file shrinks severalfold.
 */
export const SLIM_OVER = 100_000;
export function slimTracedSvg(input) {
  let svg = String(input);
  const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
  const span = vb ? Math.max(Number(vb[1]), Number(vb[2])) : 0;
  if (!(span > 0)) return svg;
  const dec = Math.max(0, Math.ceil(Math.log10(1000 / span)));
  const round = (x) => {
    const r = Number(Number(x).toFixed(dec));
    return String(Object.is(r, -0) ? 0 : r);
  };
  svg = svg.replace(/(\sd\s*=\s*)(["'])([^"']*)\2/g, (m, pre, q, d) => {
    if (/[eE]/.test(d)) return m;
    const out = d.replace(/-?\d*\.\d+/g, round);
    return `${pre}${q}${minifyPath(out)}${q}`;
  });
  svg = svg.replace(/\sopacity\s*=\s*["']1(?:\.0*)?["']/g, '');
  const otherStroke = /\sstroke\s*=\s*["'](?!none["'])|stroke\s*:/i.test(svg);
  if (!otherStroke) svg = svg.replace(/\sstroke\s*=\s*["']none["']/g, '');
  return svg;
}

/* ------------------------------------------------------------------ CLI */

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(svg|png)$/i.test(f)) out.push(p);
  }
  return out;
}

/**
 * Replace, don't rewrite in place: a dev server may be serving the file right
 * now. A synced folder (OneDrive) or a scanner can hold the target for a
 * moment, so the rename is retried, and written directly as a last resort.
 */
function replaceFile(file, bytes) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, bytes);
  for (let i = 0; i < 20; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  writeFileSync(file, bytes);
  try {
    rmSync(tmp, { force: true });
  } catch {
    /* left for the next run */
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const web = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const roots = dirs.length ? dirs : [join(web, 'public', 'logos')];
  let before = 0, after = 0, changed = 0;
  const sanitised = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const buf = readFileSync(file);
      let out;
      if (/\.png$/i.test(file)) {
        out = recompressPng(buf);
      } else {
        const { svg, removed } = cleanSvg(buf);
        if (removed.length) sanitised.push(`${relative(web, file)}: ${[...new Set(removed)].join(', ')}`);
        out = Buffer.from(svg, 'utf8');
      }
      before += buf.length;
      after += out.length;
      if (!out.equals(buf)) {
        changed++;
        if (!check) replaceFile(file, out);
      }
    }
  }
  console.log(`${changed} file(s) ${check ? 'would change' : 'rewritten'}: ${(before / 1024).toFixed(0)} kB -> ${(after / 1024).toFixed(0)} kB`);
  if (sanitised.length) console.log(`sanitised:\n  ${sanitised.join('\n  ')}`);
  else console.log('sanitised: nothing to remove');
  if (check && changed) process.exit(1);
}
