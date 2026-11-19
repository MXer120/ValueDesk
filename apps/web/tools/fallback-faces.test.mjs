import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARIAL, FIGURE_SAMPLE, TEXT_SAMPLE, avgWidth, fallbackCss, inRange, rangesOf, readFont } from './fallback-faces.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const styles = readFileSync(join(WEB, 'src', 'styles.css'), 'utf8');

test('styles.css holds exactly the faces the font files give (run tools/fallback-faces.mjs after a font update)', () => {
  const block = /\/\* fallback faces: begin \*\/\n([\s\S]*?)\n\/\* fallback faces: end \*\//.exec(styles)?.[1];
  assert.ok(block, 'the marked block in styles.css');
  assert.equal(block, fallbackCss());
});

test('each family names its fallback face right after itself', () => {
  assert.match(styles, /--font-text: "IBM Plex Sans", "IBM Plex Sans Fallback",/);
  assert.match(styles, /--font-num: "Asap", "Asap Fallback", "IBM Plex Sans",/);
  assert.match(styles, /--font-display: "Space Grotesk", "Space Grotesk Fallback", "IBM Plex Sans",/);
});

test("the static shell's wordmark face is styles.css's IBM Plex Sans 500 face", () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  const metrics = (css) => /font-weight: 500; (size-adjust: [^;]+; ascent-override: [^;]+; descent-override: [^;]+; line-gap-override: [^;]+;)/.exec(css)?.[1];
  const plex500 = fallbackCss().split('\n').find((r) => r.includes('"IBM Plex Sans Fallback"') && r.includes('font-weight: 500'));
  assert.ok(metrics(html));
  assert.equal(metrics(html), metrics(plex500));
});

test('the sizes follow from the measured widths and heights', () => {
  const plexDir = dirname(createRequire(join(WEB, 'package.json')).resolve('@fontsource/ibm-plex-sans/package.json'));
  const plex = readFont(readFileSync(join(plexDir, 'files', 'ibm-plex-sans-latin-400-normal.woff')));
  assert.equal(plex.upm, 1000);
  const size = avgWidth(plex, TEXT_SAMPLE) / ARIAL.text;
  const rule = fallbackCss().split('\n')[0];
  assert.match(rule, new RegExp(`size-adjust: ${(Math.round(size * 1e4) / 1e2).toFixed(2)}%`));
  assert.match(rule, new RegExp(`ascent-override: ${(Math.round((plex.ascent / plex.upm / size) * 1e4) / 1e2).toFixed(2)}%`));
  assert.ok(FIGURE_SAMPLE.every(([c]) => /[0-9.,%$+-]/.test(c)));
});

test('a face only covers what the real face draws', () => {
  assert.equal(rangesOf([0x41, 0x42, 0x43, 0x45, 0x20]), 'U+0020,U+0041-0043,U+0045');
  const has = inRange('U+0000-00FF,U+0131');
  assert.ok(has(0x41) && has(0x131) && !has(0x130) && !has(0x2192));
  const asapRange = /"Asap Fallback"[^\n]*unicode-range: ([^;]+);/.exec(fallbackCss())?.[1] ?? '';
  assert.ok(!inRange(asapRange)(0x2605), 'a star Asap lacks still falls through to the system face');
});
