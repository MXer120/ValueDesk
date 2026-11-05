/**
 * The light theme is a real one (theme-light.css): readable by numbers, and no sheet slips back to
 * a literal white hairline that would vanish on a white panel. The canvas palette follows the CSS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const light = readFileSync(join(SRC, 'theme-light.css'), 'utf8');

const token = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(light);
  assert.ok(m, `--${name} in theme-light.css`);
  return m![1]!;
};

const luminance = (hex: string): number => {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

test('text meets 4.5:1 on the light panel, and the steps stay in order', () => {
  const panel = token('bg-panel');
  for (const t of ['text', 'muted', 'dim', 'pos', 'neg', 'warn']) {
    const r = contrast(token(t), panel);
    assert.ok(r >= 4.5, `--${t} ${token(t)} on ${panel}: ${r.toFixed(2)}:1`);
  }
  assert.ok(contrast(token('text'), panel) > contrast(token('muted'), panel));
  assert.ok(contrast(token('muted'), panel) > contrast(token('dim'), panel));
});

test('text stays readable on the light page itself', () => {
  const page = token('bg');
  for (const t of ['text', 'muted']) assert.ok(contrast(token(t), page) >= 4.5, `--${t} on the page`);
  assert.ok(contrast(token('dim'), page) >= 3.8, '--dim on the page');
});

test('the sheets make hairlines of the ink, never of literal white', () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  // The admin suite is dark only (admin/), and TradingView's sheet goes into its own frame.
  const bad = walk(SRC)
    .filter((f) => f.endsWith('.css') && !/[\\/]admin[\\/]|tv-theme\.css$/.test(f))
    .flatMap((f) => {
      const lines = readFileSync(f, 'utf8').split('\n');
      return lines.flatMap((l, i) => (/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/.test(l) && !/--sheen/.test(l) && !f.endsWith('theme-light.css') ? [`${relative(SRC, f)}:${i + 1}`] : []));
    });
  assert.deepEqual(bad, [], 'use rgb(var(--ink) / a): the ink turns black on the light theme');
});

test('ink: white on dark, black on light', () => {
  const styles = readFileSync(join(SRC, 'styles.css'), 'utf8');
  assert.match(styles, /--ink: 255 255 255;/);
  assert.match(light, /--ink: 0 0 0;/);
});

test('the chart palette says the same colours as the light sheet', () => {
  const chart = readFileSync(join(SRC, 'chart', 'theme.ts'), 'utf8');
  const lightPalette = chart.slice(chart.indexOf('const LIGHT: Palette'));
  for (const [key, t] of [['text', 'text'], ['muted', 'muted'], ['dim', 'dim'], ['pos', 'pos'], ['neg', 'neg']] as const) {
    assert.match(lightPalette, new RegExp(`\\b${key}: '${token(t)}'`), `T.${key} on light is --${t}`);
  }
});

test('the theme is applied before first paint, from a file the CSP allows', () => {
  const html = readFileSync(join(SRC, '..', 'index.html'), 'utf8');
  assert.match(html, /<script src="\/theme-boot\.js"><\/script>/);
  const boot = readFileSync(join(SRC, '..', 'public', 'theme-boot.js'), 'utf8');
  assert.match(boot, /localStorage\.getItem\('vs\.theme'\) === 'light'/);
  assert.match(readFileSync(join(SRC, 'theme.ts'), 'utf8'), /const KEY = 'vs\.theme'/);
});
