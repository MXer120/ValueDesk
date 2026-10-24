/**
 * What may be stored in a folder, checked before anything is written.
 *
 * Every kind is rebuilt field by field from what the client sent - a NOTE as
 * blocks of plain-text spans with known marks, a TABLE as strings, a NEWS story
 * with an http(s) link - so what is kept is exactly the shape the web renders,
 * and nothing in it can turn into markup. A CHART snapshot is the chart's own
 * format (apps/web/src/folders/bridge.ts): kept as sent, after its identity
 * (v, engine, symbol, interval) and its size are checked.
 *
 * An UPLOAD is judged by its bytes, never by the name or type the client gives:
 * PDF, PNG, JPEG, WebP, GIF or UTF-8 text. Nothing else - no HTML, no SVG, no
 * archive - is accepted, so nothing a folder serves can run in a browser.
 */
import {
  NOTE_MARKS,
  NOTE_TEXT_BLOCKS,
  TABLE_MAX,
  type FileType,
  type FolderLimits,
  type ItemMeta,
  type JsonKind,
  type NoteBlock,
  type NoteData,
  type NoteSpan,
  type SavedNewsData,
  type TableData,
} from './types.js';

export class InputError extends Error {
  constructor(
    message: string,
    readonly code: 'input' | 'too-large' | 'file-type' = 'input',
  ) {
    super(message);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Control characters other than tab and newlines are dropped from any stored text. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const cleanText = (s: string): string => s.replace(CONTROL, '');

/** A folder's name or an item's title: one line, trimmed, not empty, at most `max` characters. */
export function cleanName(raw: unknown, max: number, what: string): string {
  if (typeof raw !== 'string') throw new InputError(`${what} must be text`);
  const s = cleanText(raw).replace(/\s+/g, ' ').trim();
  if (!s) throw new InputError(`${what} cannot be empty`);
  if ([...s].length > max) throw new InputError(`${what} can be at most ${max} characters`);
  return s;
}

/** A link a stored item may carry: http(s) or mailto, nothing that runs. */
export function safeHref(raw: unknown, allowMailto = true): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol === 'https:' || u.protocol === 'http:') return u.username || u.password ? null : u.href;
  if (allowMailto && u.protocol === 'mailto:') return u.href;
  return null;
}

/* ------------------------------------------------------------------- note ----- */

const MAX_BLOCKS = 4000;
const MAX_SPANS = 2000;

function spans(raw: unknown): NoteSpan[] {
  if (!Array.isArray(raw)) throw new InputError('a note block needs its spans');
  if (raw.length > MAX_SPANS) throw new InputError('a note block has too many pieces');
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
  if (raw.blocks.length > MAX_BLOCKS) throw new InputError('this note has too many paragraphs');
  const blocks: NoteBlock[] = [];
  for (const b of raw.blocks) {
    if (!isObj(b) || typeof b.type !== 'string') throw new InputError('a note block needs its type');
    if (b.type === 'hr') blocks.push({ type: 'hr' });
    else if (b.type === 'ul' || b.type === 'ol') {
      if (!Array.isArray(b.items) || b.items.length > MAX_SPANS) throw new InputError('a list needs its items');
      blocks.push({ type: b.type, items: b.items.map(spans) });
    } else if ((NOTE_TEXT_BLOCKS as readonly string[]).includes(b.type)) {
      blocks.push({ type: b.type as (typeof NOTE_TEXT_BLOCKS)[number], spans: spans(b.spans) });
    } else throw new InputError(`a note cannot hold a "${String(b.type).slice(0, 20)}" block`);
  }
  return { blocks };
}

/** The first words of a note, for the list. */
export function noteExcerpt(n: NoteData, max = 140): string {
  const parts: string[] = [];
  let len = 0;
  for (const b of n.blocks) {
    const text = 'spans' in b ? b.spans.map((s) => s.text).join('') : 'items' in b ? b.items.map((i) => i.map((s) => s.text).join('')).join(' · ') : '';
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    parts.push(t);
    len += t.length;
    if (len >= max) break;
  }
  const all = parts.join(' — ');
  return all.length > max ? `${all.slice(0, max - 1)}…` : all;
}

/* ------------------------------------------------------------------ table ----- */

export function checkTable(raw: unknown): TableData {
  if (!isObj(raw) || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) throw new InputError('a table has columns and rows');
  if (raw.columns.length < 1 || raw.columns.length > TABLE_MAX.columns) throw new InputError(`a table has 1 to ${TABLE_MAX.columns} columns`);
  if (raw.rows.length > TABLE_MAX.rows) throw new InputError(`a table has at most ${TABLE_MAX.rows} rows`);
  const cell = (v: unknown): string => {
    const s = typeof v === 'string' ? cleanText(v) : typeof v === 'number' && Number.isFinite(v) ? String(v) : v == null ? '' : null;
    if (s === null) throw new InputError('a table cell holds text');
    if (s.length > TABLE_MAX.cellChars) throw new InputError(`a table cell holds at most ${TABLE_MAX.cellChars} characters`);
    return s;
  };
  const columns = raw.columns.map(cell);
  const rows = raw.rows.map((r) => {
    if (!Array.isArray(r)) throw new InputError('a table row is a list of cells');
    const row = r.slice(0, columns.length).map(cell);
    while (row.length < columns.length) row.push('');
    return row;
  });
  return { columns, rows };
}

/* ------------------------------------------------------------------- news ----- */

export function checkNews(raw: unknown): SavedNewsData {
  if (!isObj(raw)) throw new InputError('a news story is an object');
  const href = safeHref(raw.href, false);
  if (!href) throw new InputError('a news story needs its http(s) link');
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? cleanText(v).trim().slice(0, max) : '');
  const title = str(raw.title, 600);
  if (!title) throw new InputError('a news story needs its title');
  const time = typeof raw.time === 'number' && Number.isFinite(raw.time) && raw.time >= 0 ? Math.round(raw.time) : 0;
  const symbols = Array.isArray(raw.symbols)
    ? raw.symbols.filter((s): s is string => typeof s === 'string' && /^[A-Za-z0-9.]{1,16}$/.test(s)).slice(0, 8)
    : [];
  const summary = str(raw.summary, 1200);
  return {
    id: str(raw.id, 120),
    title,
    href,
    time,
    author: str(raw.author, 120) || null,
    symbols,
    ...(summary ? { summary } : {}),
    ...(raw.post === true ? { post: true } : {}),
  };
}

/* ------------------------------------------------------------------ chart ----- */

const ENGINES = new Set(['perps', 'spot']);

/** A chart snapshot: its identity checked, the rest kept as the chart wrote it. */
export function checkChart(raw: unknown): Record<string, unknown> {
  if (!isObj(raw)) throw new InputError('a chart snapshot is an object');
  if (raw.v !== 1) throw new InputError('this chart snapshot is of a version this server does not know');
  if (typeof raw.engine !== 'string' || !ENGINES.has(raw.engine)) throw new InputError('a chart snapshot names perps or spot');
  if (typeof raw.symbol !== 'string' || !/^[A-Za-z0-9._:/-]{1,40}$/.test(raw.symbol)) throw new InputError('a chart snapshot names its market');
  if (typeof raw.interval !== 'string' || !/^[0-9]{1,3}[mhdDwWM]$/.test(raw.interval)) throw new InputError('a chart snapshot names its timeframe');
  if (!Array.isArray(raw.drawings) || !Array.isArray(raw.indicators)) throw new InputError('a chart snapshot holds its drawings and studies');
  return raw;
}

/* ------------------------------------------------------------------- data ----- */

/** Check one item's JSON by kind; returns what is stored, its JSON text and the list's view of it. */
export function checkItemData(kind: JsonKind, raw: unknown, limits: FolderLimits): { data: unknown; json: string; meta: ItemMeta } {
  let data: unknown;
  let meta: ItemMeta = {};
  switch (kind) {
    case 'note': {
      const n = checkNote(raw);
      data = n;
      meta = { excerpt: noteExcerpt(n) };
      break;
    }
    case 'table': {
      const t = checkTable(raw);
      data = t;
      meta = { rows: t.rows.length, cols: t.columns.length };
      break;
    }
    case 'news': {
      const n = checkNews(raw);
      data = n;
      meta = { href: n.href, time: n.time, author: n.author };
      break;
    }
    case 'chart': {
      const c = checkChart(raw);
      data = c;
      meta = { engine: c.engine as string, symbol: c.symbol as string, interval: c.interval as string };
      break;
    }
  }
  const json = JSON.stringify(data);
  const max = limits.jsonBytes[kind];
  if (Buffer.byteLength(json) > max) throw new InputError(`this ${kind} is larger than ${Math.round(max / 1024)} KB`, 'too-large');
  return { data, json, meta };
}

/* ------------------------------------------------------------------ files ----- */

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((x, i) => b[at + i] === x);

/** What a file is, from its first bytes; null when it is none of the kinds a folder keeps. */
export function sniffFile(b: Uint8Array): FileType | null {
  if (b.length < 4) return b.length > 0 && isPlainText(b) ? 'text' : null;
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp'; // RIFF....WEBP
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'gif';
  return isPlainText(b) ? 'text' : null;
}

/**
 * UTF-8 without NUL or other control bytes (tabs and newlines aside) - and not
 * markup a browser would render: text that starts like HTML, SVG or XML is
 * refused here even though it is served as an attachment of type text/plain.
 */
export function isPlainText(b: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return false;
  }
  if (HAS_CONTROL.test(text)) return false;
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 256).toLowerCase();
  return !/^<(!doctype|html|svg|\?xml|script|head|body|iframe|object|embed)\b/.test(head);
}

/** A chart thumbnail: a data URL of a PNG or JPEG, decoded and sniffed. */
export function decodeThumb(raw: unknown, max: number): Buffer | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new InputError('a thumbnail is a data URL');
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  if (!m) throw new InputError('a thumbnail is a PNG or JPEG data URL');
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > max) throw new InputError(`a thumbnail can be at most ${Math.round(max / 1024)} KB`, 'too-large');
  const t = sniffFile(bytes);
  if (t !== 'png' && t !== 'jpeg') throw new InputError('a thumbnail is a PNG or JPEG', 'file-type');
  return bytes;
}

/** An upload's name, for showing only: one line, no path, at most 120 characters. */
export function cleanFileName(raw: unknown): string {
  const s = typeof raw === 'string' ? cleanText(raw).replace(/^.*[\\/]/, '').replace(/\s+/g, ' ').trim() : '';
  return [...s].slice(0, 120).join('') || 'file';
}
