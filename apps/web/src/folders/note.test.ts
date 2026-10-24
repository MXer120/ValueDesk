/**
 * A note's rich text in and out of the editor (note.ts): what is written into
 * the page is escaped and only known tags, and what is read back - from the
 * editor or from a paste - is text and known formatting, nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNote } from '@sign/folders/validate.js';
import { escapeHtml, mergeSpans, noteToHtml, readNote, safeLink, type NodeLike } from './note';

/** A stand-in DOM: el('P', {}, text('x'), el('B', {}, text('y'))). */
const text = (t: string): NodeLike => ({ nodeType: 3, nodeName: '#text', textContent: t, childNodes: [] });
const el = (name: string, attrs: Record<string, string>, ...children: NodeLike[]): NodeLike => ({
  nodeType: 1,
  nodeName: name,
  textContent: children.map((c) => c.textContent ?? '').join(''),
  childNodes: children,
  getAttribute: (k) => attrs[k] ?? null,
});
const root = (...children: NodeLike[]) => el('DIV', {}, ...children);

test('written out: every text escaped, only the known tags, links only to http(s) and mailto', () => {
  const html = noteToHtml({
    blocks: [
      { type: 'h1', spans: [{ text: '<script>alert(1)</script>' }] },
      { type: 'p', spans: [{ text: 'bold & "quoted"', marks: ['b', 'i'] }, { text: 'site', href: 'https://example.com/?a=1&b=2' }, { text: 'bad', href: 'javascript:alert(1)' }] },
      { type: 'ul', items: [[{ text: 'one' }], [{ text: 'two\nlines' }]] },
      { type: 'hr' },
      { type: 'p', spans: [] },
    ],
  });
  assert.equal(
    html,
    '<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>' +
      '<p><em><strong>bold &amp; &quot;quoted&quot;</strong></em><a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">site</a>bad</p>' +
      '<ul><li>one</li><li>two<br>lines</li></ul><hr><p><br></p>',
  );
  assert.equal(escapeHtml(`'<>&"`), '&#39;&lt;&gt;&amp;&quot;');
  assert.equal(safeLink('mailto:me@example.com'), 'mailto:me@example.com');
  assert.equal(safeLink('data:text/html,x'), null);
  assert.equal(safeLink('https://u:p@example.com'), null);
});

test('read back: blocks, marks and links; scripts, images, styles and attributes are not carried', () => {
  const n = readNote(
    root(
      el('H2', {}, text('Levels')),
      el('P', {}, text('Hold '), el('B', {}, text('64k')), text(' or '), el('A', { href: 'https://example.com/x' }, el('EM', {}, text('see'))), el('A', { href: 'javascript:alert(1)' }, text(' this'))),
      el('SCRIPT', {}, text('alert(1)')),
      el('IMG', { src: 'x', onerror: 'alert(1)' }),
      el('UL', {}, el('LI', {}, text('a')), el('LI', {}, text('b'), el('BR', {}), text('c'))),
      el('BLOCKQUOTE', {}, text('quote')),
      el('DIV', {}, el('P', {}, text('nested')), el('H5', {}, text('small head'))),
      el('HR', {}),
      text('loose text'),
      el('P', {}, el('BR', {})),
    ),
  );
  assert.deepEqual(n.blocks, [
    { type: 'h2', spans: [{ text: 'Levels' }] },
    { type: 'p', spans: [{ text: 'Hold ' }, { text: '64k', marks: ['b'] }, { text: ' or ' }, { text: 'see', marks: ['i'], href: 'https://example.com/x' }, { text: ' this' }] },
    { type: 'ul', items: [[{ text: 'a' }], [{ text: 'b\nc' }]] },
    { type: 'quote', spans: [{ text: 'quote' }] },
    { type: 'p', spans: [{ text: 'nested' }] },
    { type: 'h3', spans: [{ text: 'small head' }] },
    { type: 'hr' },
    { type: 'p', spans: [{ text: 'loose text' }] },
  ]);
  // What the editor reads is what the server keeps, unchanged.
  assert.deepEqual(checkNote(n), n);
});

test('round trip: written out and read back is the same note', () => {
  const note = {
    blocks: [
      { type: 'h1' as const, spans: [{ text: 'Thesis' }] },
      { type: 'p' as const, spans: [{ text: 'a ' }, { text: 'b', marks: ['b' as const] }] },
      { type: 'pre' as const, spans: [{ text: 'x = 1' }] },
    ],
  };
  const html = noteToHtml(note);
  assert.match(html, /^<h1>Thesis<\/h1><p>a <strong>b<\/strong><\/p><pre>x = 1<\/pre>$/);
  const back = readNote(root(el('H1', {}, text('Thesis')), el('P', {}, text('a '), el('STRONG', {}, text('b'))), el('PRE', {}, text('x = 1'))));
  assert.deepEqual(back, note);
});

test('spans: neighbours with the same marks become one; trailing line breaks go', () => {
  assert.deepEqual(mergeSpans([{ text: 'a' }, { text: 'b' }, { text: 'c', marks: ['b'] }, { text: '\n' }]), [{ text: 'ab' }, { text: 'c', marks: ['b'] }]);
});
