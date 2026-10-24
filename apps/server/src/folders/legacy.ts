/**
 * The first release's kinds (2026-10-24, live for an evening): a `note` as
 * blocks of styled spans and a `table` as a plain grid. The Knowledge page that
 * followed keeps a doc and a sheet instead; the store turns every note and
 * table it finds into one when it opens (store.ts), with these.
 */
import {
  NOTE_MARKS,
  NOTE_TEXT_BLOCKS,
  TABLE_MAX,
  type DocData,
  type DocMark,
  type DocNode,
  type NoteBlock,
  type NoteData,
  type NoteSpan,
  type SheetCell,
  type SheetData,
  type TableData,
} from './types.js';
import { cleanText, InputError, safeHref } from './validate.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function spans(raw: unknown): NoteSpan[] {
  if (!Array.isArray(raw)) throw new InputError('a note block needs its spans');
  const out: NoteSpan[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.text !== 'string') throw new InputError('a note span needs its text');
    const text = cleanText(r.text);
    if (!text) continue;
    const marks = Array.isArray(r.marks) ? NOTE_MARKS.filter((m) => (r.marks as unknown[]).includes(m)) : [];
    const href = r.href === undefined ? null : safeHref(r.href);
    out.push({ text, ...(marks.length ? { marks } : {}), ...(href ? { href } : {}) });
  }
  return out;
}

export function checkNote(raw: unknown): NoteData {
  if (!isObj(raw) || !Array.isArray(raw.blocks)) throw new InputError('a note is a list of blocks');
  const blocks: NoteBlock[] = [];
  for (const b of raw.blocks) {
    if (!isObj(b) || typeof b.type !== 'string') continue;
    if (b.type === 'hr') blocks.push({ type: 'hr' });
    else if ((b.type === 'ul' || b.type === 'ol') && Array.isArray(b.items)) blocks.push({ type: b.type, items: b.items.map(spans) });
    else if ((NOTE_TEXT_BLOCKS as readonly string[]).includes(b.type)) blocks.push({ type: b.type as (typeof NOTE_TEXT_BLOCKS)[number], spans: spans(b.spans) });
  }
  return { blocks };
}

export function checkTable(raw: unknown): TableData {
  if (!isObj(raw) || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) throw new InputError('a table has columns and rows');
  const cell = (v: unknown): string => (typeof v === 'string' ? cleanText(v).slice(0, TABLE_MAX.cellChars) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  const columns = raw.columns.slice(0, TABLE_MAX.columns).map(cell);
  const rows = raw.rows.slice(0, TABLE_MAX.rows).map((r) => (Array.isArray(r) ? r.slice(0, columns.length).map(cell) : []));
  return { columns, rows };
}

const MARK: Record<string, string> = { b: 'bold', i: 'italic', u: 'underline', s: 'strike', code: 'code' };

/** A span's text as text nodes, a line break inside it as a hard break. */
function inline(ss: NoteSpan[]): DocNode[] {
  const out: DocNode[] = [];
  for (const s of ss) {
    const marks: DocMark[] = (s.marks ?? []).map((m) => ({ type: MARK[m]! }));
    if (s.href) marks.push({ type: 'link', attrs: { href: s.href } });
    s.text.split('\n').forEach((line, i) => {
      if (i > 0) out.push({ type: 'hardBreak' });
      if (line) out.push({ type: 'text', text: line, ...(marks.length ? { marks } : {}) });
    });
  }
  return out;
}

const para = (ss: NoteSpan[]): DocNode => {
  const content = inline(ss);
  return { type: 'paragraph', attrs: { textAlign: null }, ...(content.length ? { content } : {}) };
};

export function noteToDoc(n: NoteData): DocData {
  const content: DocNode[] = [];
  for (const b of n.blocks) {
    if (b.type === 'hr') content.push({ type: 'horizontalRule' });
    else if (b.type === 'ul' || b.type === 'ol') {
      const items = b.items.map((it) => ({ type: 'listItem', content: [para(it)] }));
      if (items.length) content.push(b.type === 'ul' ? { type: 'bulletList', content: items } : { type: 'orderedList', attrs: { start: 1 }, content: items });
    } else if (b.type === 'p') content.push(para(b.spans));
    else if (b.type === 'quote') content.push({ type: 'blockquote', content: [para(b.spans)] });
    else if (b.type === 'pre') {
      const text = b.spans.map((s) => s.text).join('');
      content.push({ type: 'codeBlock', attrs: { language: null }, ...(text ? { content: [{ type: 'text', text }] } : {}) });
    } else {
      const h = b as Extract<NoteBlock, { spans: NoteSpan[] }>;
      const c = inline(h.spans);
      content.push({ type: 'heading', attrs: { level: Number(h.type.slice(1)), textAlign: null }, ...(c.length ? { content: c } : {}) });
    }
  }
  if (!content.length) content.push({ type: 'paragraph', attrs: { textAlign: null } });
  return { v: 1, doc: { type: 'doc', content } };
}

const colName = (c: number): string => (c < 26 ? String.fromCharCode(65 + c) : String.fromCharCode(64 + Math.floor(c / 26)) + String.fromCharCode(65 + (c % 26)));

/** The column names become a bold first row; each cell keeps its text. */
export function tableToSheet(t: TableData): SheetData {
  const cells: Record<string, SheetCell> = {};
  t.columns.forEach((name, c) => {
    if (name) cells[`${colName(c)}1`] = { v: name, s: { b: true } };
  });
  t.rows.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v) cells[`${colName(c)}${r + 2}`] = { v };
    }),
  );
  return { v: 1, sheets: [{ id: 's1', name: 'Sheet1', cells, freeze: { r: 1, c: 0 } }] };
}
