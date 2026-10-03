/**
 * public/favicon.ico is drawn from public/favicon.svg by tools/favicon.mjs.
 * This keeps the two together: change the SVG, run `node tools/favicon.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ICO_PATH, ICO_SIZES, SVG_PATH, icoFromSvg, rasterise, shapesOf } from '../tools/favicon.mjs';

const svg = readFileSync(SVG_PATH, 'utf8');
const ico = readFileSync(ICO_PATH);

test('favicon.ico is exactly what tools/favicon.mjs draws from favicon.svg', () => {
  assert.ok(icoFromSvg(svg).equals(ico), 'favicon.svg changed: run `node tools/favicon.mjs` in apps/web');
});

test('favicon.ico: an icon file with a 32-bit image for each size', () => {
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 = icon');
  assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
  ICO_SIZES.forEach((size, k) => {
    const e = 6 + 16 * k;
    assert.equal(ico[e], size);
    assert.equal(ico[e + 1], size);
    assert.equal(ico.readUInt16LE(e + 6), 32);
    const at = ico.readUInt32LE(e + 12);
    const len = ico.readUInt32LE(e + 8);
    assert.ok(at + len <= ico.length, 'the image lies inside the file');
    assert.equal(ico.readUInt32LE(at), 40, 'a BITMAPINFOHEADER');
    assert.equal(ico.readInt32LE(at + 4), size);
    assert.equal(ico.readInt32LE(at + 8), size * 2, 'colour rows + mask rows');
  });
});

test('the drawing is the SVG: surface in the middle, transparent corners, the two candle colours on the desk', () => {
  const shapes = shapesOf(svg);
  assert.equal(shapes.rects.length, 10);
  const px = rasterise(shapes, 32);
  const at = (x: number, y: number) => Array.from(px.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4));
  assert.deepEqual(at(16, 2), [0x1b, 0x1a, 0x14, 255], 'the surface colour');
  assert.equal(at(0, 0)[3], 0, 'a rounded corner is transparent');
  assert.deepEqual(at(10, 15), [0x00, 0xb4, 0x81, 255], 'the green candle');
  assert.deepEqual(at(20, 18), [0xef, 0x4a, 0x3c, 255], 'the red candle');
  assert.deepEqual(at(16, 23), [0xe6, 0xe6, 0xe6, 255], 'the desk');
});

test('shapesOf refuses an SVG it cannot draw exactly', () => {
  assert.throws(() => shapesOf('<svg viewBox="0 0 32 32"><path d="M0 0"/></svg>'), /only <rect>/);
  assert.throws(() => shapesOf('<svg viewBox="0 0 32 32"><rect width="4" height="4" fill="red"/></svg>'), /#rrggbb/);
});
