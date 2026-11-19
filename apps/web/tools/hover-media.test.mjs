// node --test tools/hover-media.test.mjs (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { hoverMedia, hoverOnly } from './hover-media.mjs';

const norm = (css) => css.replace(/\s+/g, ' ').replace(/\s*([{}])\s*/g, '$1').trim();
const run = async (css) => {
  const stats = { wrapped: 0, kept: 0 };
  const out = await postcss([hoverMedia({ stats })]).process(css, { from: undefined });
  return { css: norm(out.css), stats };
};

test('a hover style goes behind (hover: hover), in place', async () => {
  const { css, stats } = await run('.a { color: red } .a:hover { transform: translateY(-3px) } .b { color: blue }');
  assert.equal(css, norm('.a { color: red } @media (hover: hover) { .a:hover { transform: translateY(-3px) } } .b { color: blue }'));
  assert.deepEqual(stats, { wrapped: 1, kept: 0 });
});

test('a selector list is split: the focus half stays', async () => {
  const { css } = await run('.a:hover, .a:focus-visible { background: #111 }');
  assert.equal(css, norm('.a:focus-visible { background: #111 } @media (hover: hover) { .a:hover { background: #111 } }'));
});

test(':not(:hover) applies on a touch screen, so it stays', async () => {
  assert.equal(hoverOnly('.a:not(:hover)'), false);
  assert.equal(hoverOnly('.a:not(.b:hover) .c'), false);
  assert.equal(hoverOnly('.a:hover:not(:disabled)'), true);
  assert.equal(hoverOnly('.row:has(.btn:hover)'), true);
  const { css } = await run('.a:not(:hover) { opacity: .5 }');
  assert.equal(css, norm('.a:not(:hover) { opacity: .5 }'));
});

test('a reveal on hover is kept (a phone reaches it by the tap)', async () => {
  const { css, stats } = await run('.row:hover .row__x { opacity: 1 }');
  assert.equal(css, norm('.row:hover .row__x { opacity: 1 }'));
  assert.deepEqual(stats, { wrapped: 0, kept: 1 });
});

test('inside another media query it nests; inside a hover query it is left', async () => {
  const { css } = await run('@media (max-width: 760px) { .a:hover { color: red } } @media (hover: hover) { .b:hover { color: red } }');
  assert.equal(css, norm('@media (max-width: 760px) { @media (hover: hover) { .a:hover { color: red } } } @media (hover: hover) { .b:hover { color: red } }'));
});
