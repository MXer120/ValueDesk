/**
 * What may be stored in a folder, checked before anything is written.
 *
 * Every kind is rebuilt field by field from what the client sent, keeping only
 * what is listed here - a DOC as nodes and marks of known types with known
 * attributes (text as text, links http(s) or mailto), a SHEET as text cells and
 * known styles, a BOARD as elements of known types with numbers in range, a
 * TWEET and a NEWS story with their http(s) links - so what is kept is exactly
 * the shape the web renders, and nothing in it can turn into markup. A CHART
 * snapshot is the chart's own format (apps/web/src/folders/bridge.ts): kept as
 * sent, after its identity (v, engine, symbol, interval) and its size are
 * checked.
 *
 * An UPLOAD is judged by its bytes, never by the name or type the client gives:
 * PDF, PNG, JPEG, WebP, GIF or UTF-8 text. Nothing else - no HTML, no SVG, no
 * archive - is accepted, so nothing a folder serves can run in a browser.
 */
import {
  BOARD_ENDS,
  BOARD_MAX,
  BOARD_TYPES,
  COLOR_RE,
  DOC_MAX,
  ITEM_ID_RE,
  SHEET_MAX,
  TWEET_MAX,
  type BoardData,
  type BoardElement,
  type DocData,
  type DocMark,
  type DocNode,
  type FileType,
  type FolderLimits,
  type ItemMeta,
  type JsonKind,
  type SavedNewsData,
  type SheetCell,
  type SheetCellStyle,
  type SheetData,
  type SheetTab,
  type TweetData,
} from './types.js';
import { parseTweetUrl } from './tweetUrl.js';

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

const color = (v: unknown): string | undefined => (typeof v === 'string' && COLOR_RE.test(v) ? v.toLowerCase() : undefined);
const int = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? cleanText(v).slice(0, max) : '');
/** Only the keys whose value is not undefined. */
const defined = <T extends Record<string, unknown>>(o: T): T => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

/* -------------------------------------------------------------------- doc ----- */

const ALIGN = ['left', 'center', 'right', 'justify'] as const;
const textAlign = (a: Record<string, unknown>) => ({ textAlign: oneOf(a.textAlign, ALIGN) ?? null });
const cellAttrs = (a: Record<string, unknown>) => ({
  colspan: int(a.colspan, 1, 50) ?? 1,
  rowspan: int(a.rowspan, 1, 50) ?? 1,
  colwidth: Array.isArray(a.colwidth) && a.colwidth.length <= 50 && a.colwidth.every((w) => int(w, 10, 4000) !== undefined) ? (a.colwidth as number[]) : null,
});

/** The node types a doc keeps, each with the attributes it keeps (rebuilt; anything else is dropped). */
const DOC_NODES: Record<string, ((a: Record<string, unknown>) => Record<string, unknown> | null) | null> = {
  doc: null,
  paragraph: textAlign,
  heading: (a) => ({ level: int(a.level, 1, 3) ?? 1, ...textAlign(a) }),
  blockquote: null,
  bulletList: null,
  orderedList: (a) => ({ start: int(a.start, 0, 1_000_000) ?? 1 }),
  listItem: null,
  taskList: null,
  taskItem: (a) => ({ checked: a.checked === true }),
  codeBlock: (a) => ({ language: typeof a.language === 'string' && /^[A-Za-z0-9_+#.-]{1,24}$/.test(a.language) ? a.language : null }),
  horizontalRule: null,
  hardBreak: null,
  table: null,
  tableRow: null,
  tableHeader: cellAttrs,
  tableCell: cellAttrs,
  // An image is an attachment of the doc, by id; its bytes are fetched with the token, never from a URL.
  image: (a) => (typeof a.file === 'string' && ITEM_ID_RE.test(a.file) ? { file: a.file, alt: str(a.alt, 300), width: int(a.width, 10, 4000) ?? null } : null),
  // A card of another item in the wallet's folders.
  itemRef: (a) => (typeof a.id === 'string' && ITEM_ID_RE.test(a.id) ? { id: a.id } : null),
};

const DOC_MARKS: Record<string, ((a: Record<string, unknown>) => Record<string, unknown> | null) | null> = {
  bold: null,
  italic: null,
  underline: null,
  strike: null,
  code: null,
  link: (a) => {
    const href = safeHref(a.href);
    return href ? { href } : null;
  },
  highlight: (a) => ({ color: color(a.color) ?? null }),
  textStyle: (a) => {
    const c = color(a.color);
    return c ? { color: c } : null;
  },
};

function docMarks(raw: unknown): DocMark[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DocMark[] = [];
  const seen = new Set<string>();
  for (const m of raw.slice(0, 16)) {
    if (!isObj(m) || typeof m.type !== 'string' || !(m.type in DOC_MARKS) || seen.has(m.type)) continue;
    const spec = DOC_MARKS[m.type];
    if (spec === null) out.push({ type: m.type });
    else {
      const attrs = spec!(isObj(m.attrs) ? m.attrs : {});
      if (!attrs) continue;
      out.push({ type: m.type, attrs });
    }
    seen.add(m.type);
  }
  return out.length ? out : undefined;
}

export function checkDoc(raw: unknown): DocData {
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.doc) || raw.doc.type !== 'doc') throw new InputError('a doc is the editor\'s document (v 1)');
  let nodes = 0;
  const walk = (n: Record<string, unknown>, depth: number): DocNode | null => {
    if (++nodes > DOC_MAX.nodes) throw new InputError('this doc is too long', 'too-large');
    if (depth > DOC_MAX.depth) throw new InputError('this doc nests too deeply');
    if (typeof n.type !== 'string' || !(n.type in DOC_NODES)) return null;
    if (n.type === 'doc' && depth > 0) return null;
    const spec = DOC_NODES[n.type];
    const out: DocNode = { type: n.type };
    if (spec) {
      const attrs = spec(isObj(n.attrs) ? n.attrs : {});
      if (!attrs) return null;
      out.attrs = attrs;
    }
    if (Array.isArray(n.content)) {
      const kids: DocNode[] = [];
      for (const c of n.content) {
        if (!isObj(c)) continue;
        if (c.type === 'text') {
          if (++nodes > DOC_MAX.nodes) throw new InputError('this doc is too long', 'too-large');
          const text = typeof c.text === 'string' ? cleanText(c.text) : '';
          if (!text) continue;
          const marks = docMarks(c.marks);
          kids.push({ type: 'text', text, ...(marks ? { marks } : {}) });
        } else {
          const k = walk(c, depth + 1);
          if (k) kids.push(k);
        }
      }
      if (kids.length) out.content = kids;
    }
    return out;
  };
  const doc = walk(raw.doc, 0)!;
  return { v: 1, doc };
}

/** All of a doc's text, blocks apart (search, the excerpt). */
export function docText(d: DocData, max = Infinity): string {
  const parts: string[] = [];
  let len = 0;
  const walk = (n: DocNode): void => {
    if (len >= max) return;
    if (n.type === 'text' && n.text) {
      parts.push(n.text);
      len += n.text.length;
      return;
    }
    if (n.type === 'hardBreak') parts.push(' ');
    for (const c of n.content ?? []) walk(c);
    if (n.type !== 'text' && n.type !== 'doc' && n.type !== 'hardBreak') parts.push('\n');
  };
  walk(d.doc);
  return parts.join('');
}

const excerptOf = (text: string, max = 140): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/* ------------------------------------------------------------------ sheet ----- */

const CELL_KEY = /^([A-Z]{1,2})([1-9][0-9]{0,3})$/;
const colOf = (letters: string): number => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
const SHEET_ID = /^[A-Za-z0-9_-]{1,24}$/;
const FMTS = ['num', 'pct', 'usd', 'date', 'text'] as const;

function cellStyle(raw: unknown): SheetCellStyle | undefined {
  if (!isObj(raw)) return undefined;
  const s: SheetCellStyle = defined({
    b: raw.b === true ? (true as const) : undefined,
    i: raw.i === true ? (true as const) : undefined,
    u: raw.u === true ? (true as const) : undefined,
    s: raw.s === true ? (true as const) : undefined,
    al: oneOf(raw.al, ['l', 'c', 'r'] as const),
    fg: color(raw.fg),
    bg: color(raw.bg),
    fmt: oneOf(raw.fmt, FMTS),
    dp: int(raw.dp, 0, 10),
    wrap: raw.wrap === true ? (true as const) : undefined,
  });
  return Object.keys(s).length ? s : undefined;
}

function sizes(raw: unknown, maxIndex: number, min: number, max: number): Record<string, number> | undefined {
  if (!isObj(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!/^\d{1,4}$/.test(k) || Number(k) >= maxIndex) continue;
    const n = num(v, min, max);
    if (n !== undefined) out[String(Number(k))] = Math.round(n);
  }
  return Object.keys(out).length ? out : undefined;
}

export function checkSheet(raw: unknown): SheetData {
  if (!isObj(raw) || raw.v !== 1 || !Array.isArray(raw.sheets)) throw new InputError('a sheet is a list of tabs (v 1)');
  if (raw.sheets.length < 1 || raw.sheets.length > SHEET_MAX.sheets) throw new InputError(`a sheet has 1 to ${SHEET_MAX.sheets} tabs`);
  let cells = 0;
  const names = new Set<string>();
  const ids = new Set<string>();
  const sheets: SheetTab[] = raw.sheets.map((t, i) => {
    if (!isObj(t)) throw new InputError('a sheet tab is an object');
    const id = typeof t.id === 'string' && SHEET_ID.test(t.id) && !ids.has(t.id) ? t.id : `s${i + 1}`;
    ids.add(id);
    const name = cleanName(t.name ?? `Sheet${i + 1}`, SHEET_MAX.nameChars, 'A tab name');
    if (names.has(name.toLowerCase())) throw new InputError(`two tabs are called "${name}"`);
    names.add(name.toLowerCase());
    if (!isObj(t.cells)) throw new InputError('a sheet tab holds its cells');
    const out: Record<string, SheetCell> = {};
    for (const [key, c] of Object.entries(t.cells)) {
      const m = CELL_KEY.exec(key);
      if (!m || colOf(m[1]!) >= SHEET_MAX.cols || Number(m[2]) > SHEET_MAX.rows) throw new InputError(`"${key.slice(0, 12)}" is not a cell of a sheet`);
      if (!isObj(c)) throw new InputError('a cell is an object');
      const v = typeof c.v === 'string' ? cleanText(c.v) : typeof c.v === 'number' && Number.isFinite(c.v) ? String(c.v) : '';
      if (v.length > SHEET_MAX.cellChars) throw new InputError(`a cell holds at most ${SHEET_MAX.cellChars} characters`);
      const s = cellStyle(c.s);
      if (!v && !s) continue;
      if (++cells > SHEET_MAX.cells) throw new InputError(`a sheet holds at most ${SHEET_MAX.cells} cells`, 'too-large');
      out[key] = s ? { v, s } : { v };
    }
    const freeze = isObj(t.freeze) ? { r: int(t.freeze.r, 0, 50) ?? 0, c: int(t.freeze.c, 0, 20) ?? 0 } : undefined;
    return defined({
      id,
      name,
      cells: out,
      cols: sizes(t.cols, SHEET_MAX.cols, 24, 1200),
      rows: sizes(t.rows, SHEET_MAX.rows, 16, 600),
      freeze: freeze && (freeze.r || freeze.c) ? freeze : undefined,
    }) as SheetTab;
  });
  const active = int(raw.active, 0, sheets.length - 1);
  return { v: 1, sheets, ...(active ? { active } : {}) };
}

/* ------------------------------------------------------------------ board ----- */

const BOARD_ID = /^[A-Za-z0-9_-]{1,24}$/;

function boardElement(raw: unknown, seen: Set<string>): BoardElement | null {
  if (!isObj(raw)) return null;
  const type = oneOf(raw.type, BOARD_TYPES);
  if (!type || typeof raw.id !== 'string' || !BOARD_ID.test(raw.id) || seen.has(raw.id)) return null;
  const C = BOARD_MAX.coord;
  const x = num(raw.x, -C, C);
  const y = num(raw.y, -C, C);
  const w = num(raw.w, 0, BOARD_MAX.size);
  const h = num(raw.h, 0, BOARD_MAX.size);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  let points: number[] | undefined;
  if (type === 'pen' || type === 'line' || type === 'arrow') {
    if (!Array.isArray(raw.points) || raw.points.length < 4 || raw.points.length % 2 || raw.points.length > BOARD_MAX.points) return null;
    if (!raw.points.every((p) => typeof p === 'number' && Number.isFinite(p) && Math.abs(p) <= C)) return null;
    points = (raw.points as number[]).map((p) => Math.round(p * 10) / 10);
  }
  const file = type === 'image' ? (typeof raw.file === 'string' && ITEM_ID_RE.test(raw.file) ? raw.file : null) : undefined;
  const ref = type === 'item' ? (typeof raw.ref === 'string' && ITEM_ID_RE.test(raw.ref) ? raw.ref : null) : undefined;
  if (file === null || ref === null) return null;
  const link = (v: unknown) => (typeof v === 'string' && BOARD_ID.test(v) ? v : undefined);
  const text = typeof raw.text === 'string' ? cleanText(raw.text).slice(0, BOARD_MAX.text) : undefined;
  seen.add(raw.id);
  return defined({
    id: raw.id,
    type,
    x,
    y,
    w,
    h,
    rot: num(raw.rot, -360, 360) || undefined,
    text: text || undefined,
    fill: color(raw.fill),
    stroke: color(raw.stroke),
    sw: num(raw.sw, 0, 40),
    op: num(raw.op, 0.05, 1),
    fs: num(raw.fs, 6, 400),
    align: oneOf(raw.align, ['l', 'c', 'r'] as const),
    valign: oneOf(raw.valign, ['t', 'm', 'b'] as const),
    bold: raw.bold === true ? true : undefined,
    dash: oneOf(raw.dash, ['solid', 'dashed', 'dotted'] as const),
    radius: num(raw.radius, 0, 1000),
    points,
    from: link(raw.from),
    to: link(raw.to),
    head: oneOf(raw.head, BOARD_ENDS),
    tail: oneOf(raw.tail, BOARD_ENDS),
    file,
    ref,
    name: typeof raw.name === 'string' ? cleanText(raw.name).replace(/\s+/g, ' ').trim().slice(0, 120) || undefined : undefined,
    lock: raw.lock === true ? true : undefined,
    group: link(raw.group),
  }) as BoardElement;
}

export function checkBoard(raw: unknown): BoardData {
  if (!isObj(raw) || raw.v !== 1 || !Array.isArray(raw.elements)) throw new InputError('a board is a list of elements (v 1)');
  if (raw.elements.length > BOARD_MAX.elements) throw new InputError(`a board holds at most ${BOARD_MAX.elements} things`, 'too-large');
  const seen = new Set<string>();
  const elements = raw.elements.map((e) => boardElement(e, seen)).filter((e): e is BoardElement => e !== null);
  const bg = oneOf(raw.bg, ['dots', 'grid', 'none'] as const);
  return { v: 1, elements, ...(bg ? { bg } : {}) };
}

/** The ids of the attachments a doc or a board shows (the sweep keeps these). */
export function attachmentRefs(kind: JsonKind, data: unknown): string[] {
  const out = new Set<string>();
  if (kind === 'board' && isObj(data) && Array.isArray(data.elements)) {
    for (const e of data.elements) if (isObj(e) && typeof e.file === 'string') out.add(e.file);
  } else if (kind === 'doc' && isObj(data) && isObj(data.doc)) {
    const walk = (n: unknown): void => {
      if (!isObj(n)) return;
      if (n.type === 'image' && isObj(n.attrs) && typeof n.attrs.file === 'string') out.add(n.attrs.file);
      if (Array.isArray(n.content)) n.content.forEach(walk);
    };
    walk(data.doc);
  }
  return [...out];
}

/* ------------------------------------------------------------------ tweet ----- */

const TAG = /^[\p{L}\p{N}_-]{1,32}$/u;

export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().replace(/^#/, '').toLowerCase();
    if (TAG.test(tag) && !out.includes(tag)) out.push(tag);
    if (out.length >= TWEET_MAX.tags) break;
  }
  return out;
}

export function checkTweet(raw: unknown): TweetData {
  if (!isObj(raw)) throw new InputError('a saved post is an object');
  const ref = parseTweetUrl(raw.url);
  if (!ref) throw new InputError('a saved post needs its link on x.com');
  const handle = typeof raw.handle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(raw.handle) ? raw.handle : ref.handle;
  const time = typeof raw.time === 'number' && Number.isFinite(raw.time) && raw.time > 0 ? Math.round(raw.time) : null;
  const lang = typeof raw.lang === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(raw.lang) ? raw.lang : undefined;
  const note = str(raw.note, TWEET_MAX.note).trim();
  const tags = cleanTags(raw.tags);
  return defined({
    url: handle ? `https://x.com/${handle}/status/${ref.id}` : ref.url,
    id: ref.id,
    handle,
    author: str(raw.author, 100).replace(/\s+/g, ' ').trim(),
    text: str(raw.text, TWEET_MAX.text).trim(),
    time,
    lang,
    fetched: raw.fetched === true,
    note: note || undefined,
    tags: tags.length ? tags : undefined,
  }) as TweetData;
}

/* ------------------------------------------------------------------- news ----- */

export function checkNews(raw: unknown): SavedNewsData {
  if (!isObj(raw)) throw new InputError('a news story is an object');
  const href = safeHref(raw.href, false);
  if (!href) throw new InputError('a news story needs its http(s) link');
  const s = (v: unknown, max: number): string => str(v, max).trim();
  const title = s(raw.title, 600);
  if (!title) throw new InputError('a news story needs its title');
  const time = typeof raw.time === 'number' && Number.isFinite(raw.time) && raw.time >= 0 ? Math.round(raw.time) : 0;
  const symbols = Array.isArray(raw.symbols)
    ? raw.symbols.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9.]{1,16}$/.test(x)).slice(0, 8)
    : [];
  const summary = s(raw.summary, 1200);
  return {
    id: s(raw.id, 120),
    title,
    href,
    time,
    author: s(raw.author, 120) || null,
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
    case 'doc': {
      const d = checkDoc(raw);
      data = d;
      meta = { excerpt: excerptOf(docText(d, 400)) };
      break;
    }
    case 'sheet': {
      const s = checkSheet(raw);
      data = s;
      meta = { sheets: s.sheets.length, cells: s.sheets.reduce((n, t) => n + Object.keys(t.cells).length, 0) };
      break;
    }
    case 'board': {
      const b = checkBoard(raw);
      data = b;
      meta = { elements: b.elements.length };
      break;
    }
    case 'tweet': {
      // A longer excerpt: the page's wall of saved posts shows it without loading each one.
      const t = checkTweet(raw);
      data = t;
      meta = defined({ href: t.url, author: t.author || null, handle: t.handle || undefined, time: t.time, excerpt: excerptOf(t.text || t.note || '', 400), tags: t.tags });
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
export function sniffFile(b: Uint8Array, complete = true): FileType | null {
  // Only the first bytes of a large upload are read (blobs.ts HEAD_BYTES): a character cut in two
  // at their end is not the file's fault.
  if (!complete) b = trimUtf8Tail(b);
  if (b.length < 4) return b.length > 0 && isPlainText(b) ? 'text' : null;
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp'; // RIFF....WEBP
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'gif';
  return isPlainText(b) ? 'text' : null;
}

/** Bytes without a UTF-8 sequence that their end cuts off (at most three bytes go). */
export function trimUtf8Tail(b: Uint8Array): Uint8Array {
  for (let back = 1; back <= Math.min(3, b.length); back++) {
    const c = b[b.length - back]!;
    if ((c & 0xc0) === 0x80) continue; // a continuation byte: look further back for its lead
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    return need > back ? b.subarray(0, b.length - back) : b;
  }
  return b;
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
