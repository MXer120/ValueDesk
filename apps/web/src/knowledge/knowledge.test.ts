/**
 * The Knowledge page's pure parts: a board's geometry (arrows on their shapes'
 * edges, moving with a frame, resizing, snapping, fitting, what is saved), a
 * text or a link made into a doc, a doc as Markdown - and that each of them is
 * exactly what the server keeps (its own checks, through the `@sign` alias).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBoard, checkDoc } from '@sign/folders/validate.js';
import { findTweetUrl } from '@sign/folders/tweetUrl.js';
import type { DocNode } from '@sign/folders/types.js';
import {
  duplicate,
  edgePoint,
  fitView,
  forSaving,
  lineEnds,
  lineThrough,
  moveBy,
  movedWith,
  penFrom,
  resizeBox,
  scaleGroup,
  settleLines,
  snap,
  thin,
  zoomAt,
  type El,
} from './board/model';
import { docFromText, emptyBoard, emptyDoc, emptySheet, titleOf } from '../folders/quick';
import { docToMarkdown } from './doc/markdown';
import { checkSheet } from '@sign/folders/validate.js';

const rect = (id: string, x: number, y: number, w = 100, h = 60, type: El['type'] = 'rect'): El => ({ id, type, x, y, w, h });

test('board: an attached arrow meets its shapes at their edges, and follows them when they move', () => {
  const a = rect('a', 0, 0);
  const b = rect('b', 300, 0);
  const arrow = lineThrough({ id: 'l', type: 'arrow', x: 0, y: 0, w: 0, h: 0, from: 'a', to: 'b' }, { x: 50, y: 30 }, { x: 350, y: 30 });
  const els = settleLines([a, b, arrow]);
  const ends = lineEnds(els[2]!, new Map(els.map((e) => [e.id, e])));
  assert.deepEqual([Math.round(ends.a.x), Math.round(ends.a.y)], [106, 30], 'leaves a at its right edge, 6 out');
  assert.deepEqual([Math.round(ends.b.x), Math.round(ends.b.y)], [294, 30], 'meets b at its left edge');
  const moved = moveBy(els, new Set(['b']), 0, 200);
  const l = moved.find((e) => e.id === 'l')!;
  assert.equal(Math.round(l.h), 128, 'the arrow went down with b (edge to edge: from y 66 to y 194)');
  // An ellipse's and a diamond's edges are their own.
  assert.equal(Math.round(edgePoint({ x: 0, y: 0, w: 100, h: 100 }, 'ellipse', { x: 50, y: 500 }, 0).y), 100);
  const d = edgePoint({ x: 0, y: 0, w: 100, h: 100 }, 'diamond', { x: 500, y: 500 }, 0);
  assert.deepEqual([Math.round(d.x), Math.round(d.y)], [75, 75]);
  // A deleted end lets go.
  const gone = settleLines(els.filter((e) => e.id !== 'b'));
  assert.equal(gone.find((e) => e.id === 'l')!.to, undefined);
});

test('board: a frame takes what lies inside it along; a locked thing stays', () => {
  const frame: El = { id: 'f', type: 'frame', x: 0, y: 0, w: 500, h: 400 };
  const inside = rect('in', 50, 50);
  const outside = rect('out', 600, 50);
  const locked: El = { ...rect('lk', 100, 100), lock: true };
  const ids = movedWith([frame, inside, outside, locked], new Set(['f']));
  assert.deepEqual([...ids].sort(), ['f', 'in']);
  const after = moveBy([frame, inside, outside, locked], ids, 10, 20);
  assert.deepEqual(after.map((e) => [e.x, e.y]), [[10, 20], [60, 70], [600, 50], [100, 100]]);
});

test('board: resizing by a handle, keeping proportions with Shift, a group scaled together', () => {
  const start = { x: 0, y: 0, w: 200, h: 100 };
  assert.deepEqual(resizeBox(start, 'se', { x: 300, y: 300 }, false), { x: 0, y: 0, w: 300, h: 300 });
  assert.deepEqual(resizeBox(start, 'se', { x: 400, y: 120 }, true), { x: 0, y: 0, w: 400, h: 200 });
  assert.deepEqual(resizeBox(start, 'nw', { x: 300, y: 300 }, false), { x: 192, y: 92, w: 8, h: 8 }, 'never inside out');
  const group = scaleGroup([rect('a', 0, 0, 100, 100), rect('b', 100, 0, 100, 100)], new Set(['a', 'b']), { x: 0, y: 0, w: 200, h: 100 }, { x: 0, y: 0, w: 400, h: 200 });
  assert.deepEqual(group.map((e) => [e.x, e.y, e.w, e.h]), [[0, 0, 200, 200], [200, 0, 200, 200]]);
});

test('board: a moving box snaps to the edges and centers of the others, within the tolerance', () => {
  const s = snap({ x: 103, y: 500, w: 50, h: 50 }, [{ x: 0, y: 0, w: 100, h: 100 }], 6);
  assert.equal(s.dx, -3, 'its left edge onto the other\'s right edge');
  assert.equal(s.dy, 0, 'nothing near vertically');
  assert.equal(s.guides.length, 1);
  assert.equal(snap({ x: 120, y: 500, w: 50, h: 50 }, [{ x: 0, y: 0, w: 100, h: 100 }], 6).dx, 0);
});

test('board: the view fits what is there, zooms at the pointer, and what is saved passes the server unchanged', () => {
  const v = fitView([{ x: 0, y: 0, w: 1000, h: 500 }], 1200, 800);
  assert.ok(v.z > 1 && v.z <= 1.5);
  const z = zoomAt({ x: 0, y: 0, z: 1 }, 2, 100, 100);
  assert.deepEqual(z, { x: -100, y: -100, z: 2 }, 'the point under the pointer stays put');

  const pts = Array.from({ length: 200 }, (_, i) => ({ x: i * 0.5, y: Math.sin(i / 10) * 20 }));
  const pen = penFrom({ id: 'p', type: 'pen', x: 0, y: 0, w: 0, h: 0, stroke: '#f2f2f2', sw: 3 }, thin(pts, 2));
  assert.ok(pen.points!.length < 200 * 2, 'a stroke is thinned');
  const els: El[] = [
    { id: 's', type: 'sticky', x: 0.123456, y: 1e12, w: -5, h: 200, text: 'Idea', fill: '#ffe58f', fs: 20 },
    pen,
    { id: 'l', type: 'arrow', x: 0, y: 0, w: 10, h: 0, points: [0, 0, 10, 0], from: 's', to: 'missing', head: 'arrow' },
    { id: 'i', type: 'item', x: 0, y: 0, w: 280, h: 128, ref: 'AAAAAAAAAAAAAAAA' },
  ];
  const saved = forSaving(els);
  assert.equal(saved[0]!.x, 0.1);
  assert.equal(saved[0]!.y, 10_000_000);
  assert.equal(saved[0]!.w, 0);
  assert.equal(saved[2]!.to, undefined, 'an end attached to nothing is dropped');
  const data = { v: 1 as const, elements: saved, bg: 'dots' as const };
  assert.deepEqual(checkBoard(data), data, 'the server keeps exactly this');
  const copy = duplicate([els[0]!, els[2]!], 24, 24);
  assert.notEqual(copy[0]!.id, 's');
  assert.equal(copy[1]!.from, copy[0]!.id, 'a copied arrow holds on to the copied note');
});

test('quick save: text becomes a doc (a paragraph per block, links kept), titled by its first line', () => {
  const d = docFromText('BTC thesis\nweekly close above 64k\n\nsee https://example.com/chart.\n\n\n');
  assert.deepEqual(d.doc.content![0], {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [{ type: 'text', text: 'BTC thesis' }, { type: 'hardBreak' }, { type: 'text', text: 'weekly close above 64k' }],
  });
  assert.deepEqual(d.doc.content![1]!.content, [
    { type: 'text', text: 'see ' },
    { type: 'text', text: 'https://example.com/chart', marks: [{ type: 'link', attrs: { href: 'https://example.com/chart' } }] },
    { type: 'text', text: '.' },
  ]);
  assert.deepEqual(checkDoc(d), d, 'the server keeps exactly this');
  assert.equal(titleOf('  BTC thesis \nmore'), 'BTC thesis');
  assert.equal(titleOf('https://www.example.com/a/b?c=1'), 'example.com/a/b');
  assert.equal(titleOf('x'.repeat(100)).length, 80);
  assert.equal(titleOf('   '), 'Quick note');
  assert.equal(findTweetUrl('look https://twitter.com/jack/status/20?s=1')?.url, 'https://x.com/jack/status/20');
  // The empty items the page makes are what the server keeps.
  assert.deepEqual(checkDoc(emptyDoc()), emptyDoc());
  assert.deepEqual(checkSheet(emptySheet()), emptySheet());
  assert.deepEqual(checkBoard(emptyBoard()), emptyBoard());
});

test('markdown: headings, marks, nested and to-do lists, quotes, code, tables, images and cards', () => {
  const t = (text: string, marks?: string[]): DocNode => ({ type: 'text', text, ...(marks ? { marks: marks.map((m) => (m.startsWith('http') ? { type: 'link', attrs: { href: m } } : { type: m })) } : {}) });
  const p = (...c: DocNode[]): DocNode => ({ type: 'paragraph', content: c });
  const doc: DocNode = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [t('Levels')] },
      p(t('BTC ', ['bold']), t('64k', ['italic']), t(' and '), t('a link', ['https://x.com/a b']), t(' *raw*')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one')), { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p(t('three'))] }] }] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('done'))] }, { type: 'taskItem', attrs: { checked: false }, content: [p(t('todo'))] }] },
      { type: 'blockquote', content: [p(t('quoted'))] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;')] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('A'))] }, { type: 'tableHeader', content: [p(t('B|C'))] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('1'))] }, { type: 'tableCell', content: [p(t('2'))] }] }] },
      { type: 'image', attrs: { file: 'AAAAAAAAAAAAAAAA', alt: 'chart' } },
      { type: 'itemRef', attrs: { id: 'BBBBBBBBBBBBBBBB' } },
      { type: 'horizontalRule' },
    ],
  };
  const md = docToMarkdown(doc, (id) => (id === 'BBBBBBBBBBBBBBBB' ? 'ETH plan' : null));
  assert.equal(
    md,
    [
      '## Levels',
      '**BTC ***64k* and [a link](https://x.com/a%20b) \\*raw\\*',
      '- one\n  3. three',
      '- [x] done\n- [ ] todo',
      '> quoted',
      '```ts\nconst a = 1;\n```',
      '| A | B\\\\|C |\n| --- | --- |\n| 1 | 2 |',
      '*[image: chart]*',
      '*[ETH plan]*',
      '---',
    ].join('\n\n') + '\n',
  );
});

test('access: Knowledge is the owner wallet\'s only (any case), never for no wallet', async () => {
  const { isKnowledgeOwner, KNOWLEDGE_OWNER } = await import('../folders/access');
  assert.equal(isKnowledgeOwner('0x04Fb8f9d0D8cd5495aa47e81Ca9804cdf32a277d'), true);
  assert.equal(isKnowledgeOwner(KNOWLEDGE_OWNER), true);
  assert.equal(isKnowledgeOwner('0x' + '11'.repeat(20)), false);
  assert.equal(isKnowledgeOwner(null), false);
});
