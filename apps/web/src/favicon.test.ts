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

test('the drawing is the SVG: the dark tile, transparent corners, the white arms of the V and its green point', () => {
  const shapes = shapesOf(svg);
  assert.equal(shapes.rects.length, 6);
  const px = rasterise(shapes, 32);
  const at = (x: number, y: number) => Array.from(px.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4));
  assert.deepEqual(at(16, 2), [0x12, 0x12, 0x12, 255], 'the tile colour');
  assert.equal(at(0, 0)[3], 0, 'a rounded corner is transparent');
  assert.deepEqual(at(6, 10), [0xf4, 0xf4, 0xf4, 255], 'the left arm');
  assert.deepEqual(at(25, 10), [0xf4, 0xf4, 0xf4, 255], 'the right arm');
  assert.deepEqual(at(16, 22), [0x00, 0xb4, 0x81, 255], 'the green point');
  assert.deepEqual(at(16, 10), [0x12, 0x12, 0x12, 255], 'the open middle of the V');
});

test('shapesOf refuses an SVG it cannot draw exactly', () => {
  assert.throws(() => shapesOf('<svg viewBox="0 0 32 32"><path d="M0 0"/></svg>'), /only <rect>/);
  assert.throws(() => shapesOf('<svg viewBox="0 0 32 32"><rect width="4" height="4" fill="red"/></svg>'), /#rrggbb/);
});
