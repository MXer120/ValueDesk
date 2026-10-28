// node --test apps/web/tools/logo-clean.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cleanSvg, minifyPath, sanitizeSvg, slimTracedSvg } from './logo-clean.mjs';
import { recompressPng } from './png-shrink.mjs';

test('sanitise: script, handlers, foreignObject, external and javascript: refs go', () => {
  const evil = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">'
    + '<script>alert(2)</script><script href="https://x/y.js"/>'
    + '<a xlink:href="javascript:alert(3)"><rect onclick=\'alert(4)\' width="1" height="1"/></a>'
    + '<a href="&#x6A;avascript:alert(5)"><rect/></a>'
    + '<image href="https://evil.example/x.png"/><image xlink:href="//evil.example/y.png"/><use href="other.svg#a"/>'
    + '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'
    + '<animate attributeName="href" values="javascript:alert(6)"/><set attributeName="xlink:href" to="javascript:alert(7)"/>'
    + '<style>@import url(https://evil.example/a.css); .a{fill:url(#g)} .b{background:url(https://evil.example/b.png)}</style>'
    + '<rect style="fill:url(#g);filter:url(https://evil.example/f.svg#f)"/></svg>';
  const { svg, removed } = sanitizeSvg(evil);
  for (const bad of ['<script', 'onload', 'onclick', 'javascript:', 'avascript', 'evil.example', 'foreignObject', 'other.svg', '@import', 'attributeName="href"', 'attributeName="xlink:href"']) {
    assert.ok(!svg.includes(bad), `still contains ${bad}: ${svg}`);
  }
  assert.ok(svg.includes('url(#g)'), 'in-document references stay');
  assert.ok(removed.length >= 10);
});

test('sanitise: in-document and image data references are kept, clean files are untouched', () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="g"/></defs>'
    + '<use xlink:href="#g"/><image href="data:image/png;base64,iVBORw0KGgo="/><rect fill="url(#g)"/></svg>';
  const r = sanitizeSvg(ok);
  assert.equal(r.svg, ok);
  assert.deepEqual(r.removed, []);
});

test('minifyPath keeps every coordinate value exactly', () => {
  const nums = (d) => (d.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
  const cases = [
    'M 363.5,-0.5 C 368.167,-0.5 372.833,-0.5 377.5,-0.5C 382.5,0.833333 387.5,0.833333 392.5,-0.5',
    'M0 0L1 2L3 4L-5 .5L0.50 1.50Z',
    'M1.5.5l.5.5.5-.5 H 10 H 20 V 3 V 4 z m 1e-5 2E3',
    'M10,10 L 20,20 M 30,30 L 40,40',
  ];
  for (const d of cases) {
    const m = minifyPath(d);
    assert.deepEqual(nums(m), nums(d), `${d} -> ${m}`);
    assert.ok(m.length <= d.length);
    assert.equal(minifyPath(m), m, 'idempotent');
  }
  assert.equal(minifyPath('M10,10 L 20,20 M 30,30 L 40,40'), 'M10 10L20 20M30 30L40 40', 'a repeated moveto is never merged (it would mean lineto)');
});

test('arcs are left exactly as written (their flags can run together)', () => {
  for (const d of ['M10 10a5 5 0 01 10 0', 'M0 0 A 1 1 0 1 1 2 2']) assert.equal(minifyPath(d), d);
});

test('minify drops only inert bytes; text content keeps its whitespace', () => {
  const src = '<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="http://www.w3.org/2000/svg">\n  <metadata>x</metadata>\n  <path d="M 0,0 L 10,10"/>\n</svg>\n';
  assert.equal(cleanSvg(src).svg, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10"/></svg>\n');
  const text = '<svg xmlns="http://www.w3.org/2000/svg">\n <text x="1" y="2"> a  b </text>\n</svg>';
  assert.ok(cleanSvg(text).svg.includes('<text x="1" y="2"> a  b </text>'));
  const withEntities = '<!DOCTYPE svg [ <!ENTITY ns "http://www.w3.org/2000/svg"> ]><svg xmlns="&ns;"/>';
  assert.ok(cleanSvg(withEntities).svg.includes('<!ENTITY'), 'a DOCTYPE that declares entities is kept');
});

test('recompressPng: same pixels, never bigger, rendering chunks kept', () => {
  const { PNG } = createRequire(import.meta.url)('pngjs');
  const img = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < 64 * 64; i++) {
    img.data[i * 4] = (i * 7) & 255; img.data[i * 4 + 1] = (i * 3) & 255; img.data[i * 4 + 2] = 90; img.data[i * 4 + 3] = i % 5 ? 255 : 128;
  }
  const raw = PNG.sync.write(img, { colorType: 6, filterType: 0, deflateLevel: 1 });
  // add an sRGB chunk the way a design tool would
  const srgb = Buffer.from([0, 0, 0, 1, 0x73, 0x52, 0x47, 0x42, 0, 0xae, 0xce, 0x1c, 0xe9]);
  const withSrgb = Buffer.concat([raw.subarray(0, 33), srgb, raw.subarray(33)]);
  const out = recompressPng(withSrgb);
  assert.ok(out.length <= withSrgb.length);
  assert.ok(PNG.sync.read(out).data.equals(PNG.sync.read(withSrgb).data), 'identical pixels');
  assert.ok(out.includes(Buffer.from('sRGB')), 'sRGB kept');
  assert.equal(recompressPng(Buffer.from('not a png')).toString(), 'not a png');
});

test('slimTracedSvg: coordinates rounded to 1/1000 of the box, default attributes dropped, strokes kept where set', () => {
  const svg = '<svg viewBox="0 0 500 500"><path fill="#BA561B" opacity="1.000000" stroke="none" d="M1 195C1 177.979111 1 160.958206 1.336729 143.386505Z"/></svg>';
  assert.equal(slimTracedSvg(svg), '<svg viewBox="0 0 500 500"><path fill="#BA561B" d="M1 195C1 178 1 161 1.3 143.4Z"/></svg>');
  const stroked = '<svg viewBox="0 0 2000 2000"><path stroke="none" d="M0.4 0.6Z"/><path stroke="#000" d="M1 1Z"/></svg>';
  assert.match(slimTracedSvg(stroked), /stroke="none"/, 'another path sets a stroke: stroke="none" stays');
  assert.match(slimTracedSvg(stroked), /d="M0 1Z"/);
  assert.equal(slimTracedSvg('<svg><path d="M0.123 0Z"/></svg>'), '<svg><path d="M0.123 0Z"/></svg>', 'no viewBox: untouched');
});
