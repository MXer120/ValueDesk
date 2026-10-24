/**
 * A note's rich text, between what is stored (NoteData: blocks of plain-text
 * spans with known marks - apps/server/src/folders/types.ts) and the editor
 * (a contentEditable element).
 *
 *   noteToHtml   stored -> the editor's markup. Every text is escaped and only
 *                the tags below are written, so loading a note can never put
 *                anything else into the page.
 *   readNote     the editor's DOM (or a pasted fragment, parsed inert) -> stored.
 *                Reads only text and the formatting it knows; anything else in
 *                the DOM - an image, a script, an attribute - is not carried.
 *
 * Paste goes through both (NoteEditor.tsx): the clipboard's HTML is parsed in a
 * document that runs and loads nothing, read into spans, written back out with
 * noteToHtml and only then inserted.
 */
import type { NoteBlock, NoteData, NoteMark, NoteSpan, NoteTextBlock } from '@sign/folders/types.js';

const MARK_TAG: Record<NoteMark, string> = { b: 'strong', i: 'em', u: 'u', s: 's', code: 'code' };
const BLOCK_TAG = { p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote', pre: 'pre' } as const;

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A link a note may carry: http(s) or mailto. */
export function safeLink(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const u = new URL(raw.trim());
    if ((u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password) return u.href;
    if (u.protocol === 'mailto:') return u.href;
  } catch {
    /* not a URL */
  }
  return null;
}

function spansToHtml(spans: readonly NoteSpan[]): string {
  if (spans.length === 0) return '<br>';
  return spans
    .map((s) => {
      let h = escapeHtml(s.text).replace(/\n/g, '<br>');
      for (const m of s.marks ?? []) h = `<${MARK_TAG[m]}>${h}</${MARK_TAG[m]}>`;
      const href = safeLink(s.href);
      if (href) h = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${h}</a>`;
      return h;
    })
    .join('');
}

export function noteToHtml(n: NoteData): string {
  if (n.blocks.length === 0) return '<p><br></p>';
  return n.blocks
    .map((b) => {
      if (b.type === 'hr') return '<hr>';
      if ('items' in b) return `<${b.type}>${b.items.map((i) => `<li>${spansToHtml(i)}</li>`).join('')}</${b.type}>`;
      const tag = BLOCK_TAG[b.type];
      return `<${tag}>${spansToHtml(b.spans)}</${tag}>`;
    })
    .join('');
}

/* ------------------------------------------------------------ reading ----- */

/** What readNote needs of a DOM node (a real one in the browser, a stand-in in tests). */
export interface NodeLike {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<NodeLike>;
  getAttribute?(name: string): string | null;
}

const TEXT = 3;
const ELEMENT = 1;
const INLINE_MARK: Record<string, NoteMark> = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', INS: 'u', S: 's', STRIKE: 's', DEL: 's', CODE: 'code', KBD: 'code', SAMP: 'code' };
const HEADING: Record<string, NoteBlock['type']> = { H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h3', H5: 'h3', H6: 'h3' };
const BLOCKISH = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TR', 'FIGURE']);
/** Never read: their text is not the note's. */
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'HEAD', 'TITLE', 'META', 'LINK', 'BUTTON', 'SELECT', 'INPUT', 'TEXTAREA']);

const kids = (n: NodeLike): NodeLike[] => Array.from(n.childNodes);

/** Inline content into spans, carrying the marks and the link it sits under. */
function inline(n: NodeLike, marks: NoteMark[], href: string | null, out: NoteSpan[]): void {
  if (n.nodeType === TEXT) {
    const text = (n.textContent ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (text) out.push({ text, ...(marks.length ? { marks: [...new Set(marks)] } : {}), ...(href ? { href } : {}) });
    return;
  }
  if (n.nodeType !== ELEMENT || SKIP.has(n.nodeName)) return;
  if (n.nodeName === 'BR') {
    out.push({ text: '\n', ...(marks.length ? { marks: [...new Set(marks)] } : {}) });
    return;
  }
  const m = INLINE_MARK[n.nodeName];
  const nextMarks = m ? [...marks, m] : marks;
  const nextHref = n.nodeName === 'A' ? safeLink(n.getAttribute?.('href')) ?? href : href;
  for (const c of kids(n)) inline(c, nextMarks, nextHref, out);
}

/** Adjacent spans with the same marks and link become one; a trailing line break goes. */
export function mergeSpans(spans: NoteSpan[]): NoteSpan[] {
  const out: NoteSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && (last.marks ?? []).join() === (s.marks ?? []).join() && last.href === s.href) last.text += s.text;
    else out.push({ ...s });
  }
  while (out.length && /^\n+$/.test(out[out.length - 1]!.text)) out.pop();
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\n+$/, '');
  return out.filter((s) => s.text.length > 0);
}

/** A DOM subtree (the editor, or a pasted fragment) as stored blocks. */
export function readNote(root: NodeLike): NoteData {
  const blocks: NoteBlock[] = [];
  let loose: NoteSpan[] = [];
  const flush = () => {
    const spans = mergeSpans(loose);
    loose = [];
    if (spans.length) blocks.push({ type: 'p', spans });
  };
  const walk = (n: NodeLike) => {
    if (n.nodeType === ELEMENT && SKIP.has(n.nodeName)) return;
    if (n.nodeType !== ELEMENT || !BLOCKISH.has(n.nodeName)) {
      inline(n, [], null, loose);
      return;
    }
    flush();
    const name = n.nodeName;
    if (name === 'HR') {
      blocks.push({ type: 'hr' });
      return;
    }
    if (name === 'UL' || name === 'OL') {
      const items: NoteSpan[][] = [];
      for (const li of kids(n)) {
        const spans: NoteSpan[] = [];
        inline(li, [], null, spans);
        const merged = mergeSpans(spans);
        if (merged.length) items.push(merged);
      }
      if (items.length) blocks.push({ type: name === 'UL' ? 'ul' : 'ol', items });
      return;
    }
    const type: NoteBlock['type'] | null = HEADING[name] ?? (name === 'BLOCKQUOTE' ? 'quote' : name === 'PRE' ? 'pre' : name === 'P' || name === 'LI' ? 'p' : null);
    // A container (a div, a section, a pasted table) whose children are blocks: read them as blocks.
    if (!type && kids(n).some((c) => c.nodeType === ELEMENT && BLOCKISH.has(c.nodeName))) {
      for (const c of kids(n)) walk(c);
      flush();
      return;
    }
    const spans: NoteSpan[] = [];
    inline(n, [], null, spans);
    const merged = mergeSpans(spans);
    if (merged.length || type === 'p' || !type) blocks.push({ type: (type ?? 'p') as NoteTextBlock['type'], spans: merged });
  };
  for (const c of kids(root)) walk(c);
  flush();
  // Empty paragraphs at the end are the editor's caret line, not content.
  while (blocks.length && blocks[blocks.length - 1]!.type === 'p' && (blocks[blocks.length - 1] as { spans: NoteSpan[] }).spans.length === 0) blocks.pop();
  return { blocks };
}

/** A note with nothing in it. */
export const EMPTY_NOTE: NoteData = { blocks: [] };

/** The plain text of a note (search, the item's first line). */
export const noteText = (n: NoteData): string =>
  n.blocks.map((b) => ('spans' in b ? b.spans.map((s) => s.text).join('') : 'items' in b ? b.items.map((i) => i.map((s) => s.text).join('')).join('\n') : '')).join('\n');
