/**
 * The spreadsheet editor's pure side (SheetEditor.tsx): selection and keyboard
 * movement, cell writes that always stay inside what the server keeps
 * (validate.ts checkSheet), styles over a range, the clipboard block and its
 * paste, the fill handle's series, sorting, row/column/tab edits, sizes and
 * freezing. Nothing here touches the DOM.
 */
import { COLOR_RE, SHEET_MAX, type SheetCell, type SheetCellStyle, type SheetData, type SheetTab } from '@sign/folders/types.js';
import { MAX_COLS, MAX_ROWS, cellKey, colIndex, parseKey } from './refs';
import { deleteCols, deleteRows, insertCols, insertRows, isFormula, parseLiteral, renameSheet, shiftFormula, type CellValue } from './formula';

export interface Pos { r: number; c: number }
/** A block of cells, corners inclusive, r1 <= r2 and c1 <= c2. */
export interface Range { r1: number; c1: number; r2: number; c2: number }
/** The active cell `a` (where typing goes) and the range's other corner `f`. */
export interface Sel { a: Pos; f: Pos }

export const DEFAULT_COL_W = 100;
export const DEFAULT_ROW_H = 26;
export const COL_W = { min: 24, max: 1200 } as const;
export const ROW_H = { min: 16, max: 600 } as const;
/** The most rows and columns a tab may freeze (the server's bounds). */
export const FREEZE_MAX = { r: 50, c: 20 } as const;
export const AUTOFIT_MAX = 600;

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// ------------------------------------------------------------------ selection

export const single = (p: Pos): Sel => ({ a: { ...p }, f: { ...p } });

export function rangeOf(s: Sel): Range {
  return { r1: Math.min(s.a.r, s.f.r), c1: Math.min(s.a.c, s.f.c), r2: Math.max(s.a.r, s.f.r), c2: Math.max(s.a.c, s.f.c) };
}

/** A range as a selection: anchored at `active` when that is one of its corners, else at its top left. */
export const selOf = (rg: Range, active?: Pos): Sel =>
  active && (active.r === rg.r1 || active.r === rg.r2) && (active.c === rg.c1 || active.c === rg.c2)
    ? { a: active, f: { r: active.r === rg.r1 ? rg.r2 : rg.r1, c: active.c === rg.c1 ? rg.c2 : rg.c1 } }
    : { a: { r: rg.r1, c: rg.c1 }, f: { r: rg.r2, c: rg.c2 } };

export const inRange = (rg: Range, r: number, c: number): boolean => r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2;
export const isOneCell = (rg: Range): boolean => rg.r1 === rg.r2 && rg.c1 === rg.c2;
export const areaOf = (rg: Range): number => (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1);
export const sameRange = (a: Range, b: Range): boolean => a.r1 === b.r1 && a.r2 === b.r2 && a.c1 === b.c1 && a.c2 === b.c2;
export const intersect = (a: Range, b: Range): Range | null => {
  const r = { r1: Math.max(a.r1, b.r1), c1: Math.max(a.c1, b.c1), r2: Math.min(a.r2, b.r2), c2: Math.min(a.c2, b.c2) };
  return r.r1 > r.r2 || r.c1 > r.c2 ? null : r;
};
export const wholeCols = (c1: number, c2: number): Range => ({ r1: 0, c1: Math.min(c1, c2), r2: MAX_ROWS - 1, c2: Math.max(c1, c2) });
export const wholeRows = (r1: number, r2: number): Range => ({ r1: Math.min(r1, r2), c1: 0, r2: Math.max(r1, r2), c2: MAX_COLS - 1 });
export const isWholeCols = (rg: Range): boolean => rg.r1 === 0 && rg.r2 === MAX_ROWS - 1;
export const isWholeRows = (rg: Range): boolean => rg.c1 === 0 && rg.c2 === MAX_COLS - 1;

export function clampPos(p: Pos, rows = MAX_ROWS, cols = MAX_COLS): Pos {
  return { r: clamp(p.r, 0, rows - 1), c: clamp(p.c, 0, cols - 1) };
}

/** An arrow key: the active cell moves (and the range collapses), or with shift the far corner moves. */
export function moveSel(s: Sel, dr: number, dc: number, extend: boolean): Sel {
  if (extend) return { a: s.a, f: clampPos({ r: s.f.r + dr, c: s.f.c + dc }) };
  return single(clampPos({ r: s.a.r + dr, c: s.a.c + dc }));
}

/**
 * Ctrl+arrow: to the end of the run of filled cells, or to the next filled
 * cell across a gap, or to the grid's edge when there is none.
 */
export function dataEdge(has: (r: number, c: number) => boolean, from: Pos, dr: number, dc: number): Pos {
  const inside = (r: number, c: number): boolean => r >= 0 && c >= 0 && r < MAX_ROWS && c < MAX_COLS;
  let { r, c } = from;
  if (!inside(r + dr, c + dc)) return from;
  if (has(r, c) && has(r + dr, c + dc)) {
    while (inside(r + dr, c + dc) && has(r + dr, c + dc)) {
      r += dr;
      c += dc;
    }
    return { r, c };
  }
  r += dr;
  c += dc;
  while (!has(r, c) && inside(r + dr, c + dc)) {
    r += dr;
    c += dc;
  }
  return { r, c };
}

/**
 * The filled block around a cell (Excel's current region): grown while any
 * cell just outside it, diagonals included, holds something.
 */
export function dataRegion(has: (r: number, c: number) => boolean, p: Pos): Range {
  const rg = { r1: p.r, c1: p.c, r2: p.r, c2: p.c };
  const rowHas = (r: number, c1: number, c2: number): boolean => {
    for (let c = Math.max(0, c1); c <= Math.min(MAX_COLS - 1, c2); c++) if (has(r, c)) return true;
    return false;
  };
  const colHas = (c: number, r1: number, r2: number): boolean => {
    for (let r = Math.max(0, r1); r <= Math.min(MAX_ROWS - 1, r2); r++) if (has(r, c)) return true;
    return false;
  };
  for (let grew = true; grew; ) {
    grew = false;
    if (rg.r1 > 0 && rowHas(rg.r1 - 1, rg.c1 - 1, rg.c2 + 1)) (rg.r1--, (grew = true));
    if (rg.r2 < MAX_ROWS - 1 && rowHas(rg.r2 + 1, rg.c1 - 1, rg.c2 + 1)) (rg.r2++, (grew = true));
    if (rg.c1 > 0 && colHas(rg.c1 - 1, rg.r1 - 1, rg.r2 + 1)) (rg.c1--, (grew = true));
    if (rg.c2 < MAX_COLS - 1 && colHas(rg.c2 + 1, rg.r1 - 1, rg.r2 + 1)) (rg.c2++, (grew = true));
  }
  return rg;
}

/** What the name box takes: "B7", "a1:c4", "$A$1", whole columns "A:C", whole rows "3:5". */
export function parseRangeInput(text: string): Range | null {
  const t = text.trim().replace(/\$/g, '').toUpperCase();
  const okR = (r: number): boolean => r >= 0 && r < MAX_ROWS;
  const okC = (c: number): boolean => c >= 0 && c < MAX_COLS;
  let m = /^([A-Z]{1,3})(\d{1,7})(?::([A-Z]{1,3})(\d{1,7}))?$/.exec(t);
  if (m) {
    const c1 = colIndex(m[1]!), r1 = Number(m[2]) - 1;
    const c2 = m[3] ? colIndex(m[3]) : c1, r2 = m[4] ? Number(m[4]) - 1 : r1;
    if (!okR(r1) || !okR(r2) || !okC(c1) || !okC(c2)) return null;
    return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
  }
  m = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(t);
  if (m) {
    const c1 = colIndex(m[1]!), c2 = colIndex(m[2]!);
    return okC(c1) && okC(c2) ? wholeCols(c1, c2) : null;
  }
  m = /^(\d{1,7}):(\d{1,7})$/.exec(t);
  if (m) {
    const r1 = Number(m[1]) - 1, r2 = Number(m[2]) - 1;
    return okR(r1) && okR(r2) ? wholeRows(r1, r2) : null;
  }
  return null;
}

// ------------------------------------------------------------------ cells

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const FMTS = ['num', 'pct', 'usd', 'date', 'text'] as const;

/** A value as the server keeps it: no control characters but tab and newlines, at most cellChars. */
export const cleanValue = (v: string): string => v.replace(CONTROL, '').slice(0, SHEET_MAX.cellChars);

/** A style with only what the server keeps (true flags, #rrggbb lowercased, dp 0-10); undefined when empty. */
export function cleanStyle(s: SheetCellStyle | null | undefined): SheetCellStyle | undefined {
  if (!s) return undefined;
  const out: SheetCellStyle = {};
  if (s.b === true) out.b = true;
  if (s.i === true) out.i = true;
  if (s.u === true) out.u = true;
  if (s.s === true) out.s = true;
  if (s.al === 'l' || s.al === 'c' || s.al === 'r') out.al = s.al;
  if (typeof s.fg === 'string' && COLOR_RE.test(s.fg)) out.fg = s.fg.toLowerCase();
  if (typeof s.bg === 'string' && COLOR_RE.test(s.bg)) out.bg = s.bg.toLowerCase();
  if (s.fmt && (FMTS as readonly string[]).includes(s.fmt)) out.fmt = s.fmt;
  if (typeof s.dp === 'number' && Number.isInteger(s.dp) && s.dp >= 0 && s.dp <= 10) out.dp = s.dp;
  if (s.wrap === true) out.wrap = true;
  return Object.keys(out).length ? out : undefined;
}

/** A cell as stored, or null when there is nothing to keep (no value, no style). */
export function makeCell(v: string, s?: SheetCellStyle | null): SheetCell | null {
  const val = cleanValue(v);
  const st = cleanStyle(s);
  if (!val && !st) return null;
  return st ? { v: val, s: st } : { v: val };
}

export const cellAt = (tab: SheetTab, r: number, c: number): SheetCell | undefined => tab.cells[cellKey(r, c)];

/** Writes into a cells map being built (a copy), dropping the cell when it keeps nothing. */
function put(cells: Record<string, SheetCell>, r: number, c: number, cell: SheetCell | null): void {
  const k = cellKey(r, c);
  if (cell) cells[k] = cell;
  else delete cells[k];
}

/** Every stored cell in a range, without walking the empty part of a big range. */
export function cellsIn(tab: SheetTab, rg: Range): Array<{ r: number; c: number; cell: SheetCell }> {
  const out: Array<{ r: number; c: number; cell: SheetCell }> = [];
  const keys = Object.keys(tab.cells);
  if (areaOf(rg) <= keys.length) {
    for (let r = rg.r1; r <= rg.r2; r++) {
      for (let c = rg.c1; c <= rg.c2; c++) {
        const cell = tab.cells[cellKey(r, c)];
        if (cell) out.push({ r, c, cell });
      }
    }
    return out;
  }
  for (const k of keys) {
    const p = parseKey(k);
    if (p && inRange(rg, p.r, p.c)) out.push({ r: p.r, c: p.c, cell: tab.cells[k]! });
  }
  return out;
}

/** Rows and columns in use (cells with a value, or with anything when `styled`), as counts. */
export function usedSize(tab: SheetTab, styled = true): { rows: number; cols: number } {
  let rows = 0, cols = 0;
  for (const k in tab.cells) {
    if (!styled && !tab.cells[k]!.v) continue;
    const p = parseKey(k);
    if (!p) continue;
    if (p.r + 1 > rows) rows = p.r + 1;
    if (p.c + 1 > cols) cols = p.c + 1;
  }
  return { rows, cols };
}

/** A range cut down to the part that holds cells (a whole column becomes its filled rows). */
export function clipToUsed(tab: SheetTab, rg: Range): Range | null {
  const u = usedSize(tab);
  if (!u.rows) return null;
  return intersect(rg, { r1: 0, c1: 0, r2: u.rows - 1, c2: u.cols - 1 });
}

export const countCells = (data: SheetData): number => data.sheets.reduce((n, t) => n + Object.keys(t.cells).length, 0);
export const fitsLimits = (data: SheetData): boolean => countCells(data) <= SHEET_MAX.cells;

/**
 * What typing `raw` stores in a cell: in a Text-formatted cell a number, a
 * boolean or a formula is kept as text (a leading apostrophe), as in Excel.
 */
export function inputFor(raw: string, style?: SheetCellStyle): string {
  if (style?.fmt !== 'text' || raw.startsWith("'")) return raw;
  return isFormula(raw) || (raw !== '' && typeof parseLiteral(raw) !== 'string') ? `'${raw}` : raw;
}

/** One cell's value, its style kept. */
export function setValue(tab: SheetTab, p: Pos, raw: string): SheetTab {
  const cells = { ...tab.cells };
  const old = cells[cellKey(p.r, p.c)];
  put(cells, p.r, p.c, makeCell(raw, old?.s));
  return { ...tab, cells };
}

/** Delete / Backspace: values go, styles stay. */
export function clearValues(tab: SheetTab, rg: Range): SheetTab {
  const hit = cellsIn(tab, rg);
  if (!hit.length) return tab;
  const cells = { ...tab.cells };
  for (const { r, c, cell } of hit) put(cells, r, c, makeCell('', cell.s));
  return { ...tab, cells };
}

export function clearFormats(tab: SheetTab, rg: Range): SheetTab {
  const hit = cellsIn(tab, rg).filter((x) => x.cell.s);
  if (!hit.length) return tab;
  const cells = { ...tab.cells };
  for (const { r, c, cell } of hit) put(cells, r, c, makeCell(cell.v));
  return { ...tab, cells };
}

export function clearAll(tab: SheetTab, rg: Range): SheetTab {
  const hit = cellsIn(tab, rg);
  if (!hit.length) return tab;
  const cells = { ...tab.cells };
  for (const { r, c } of hit) put(cells, r, c, null);
  return { ...tab, cells };
}

/**
 * A style change over every cell of a range. Empty cells get the style only
 * inside `create` (the part of the sheet the grid shows), so styling a whole
 * column cannot fill the sheet with thousands of blank cells.
 */
export function styleRange(tab: SheetTab, rg: Range, change: (s: SheetCellStyle) => SheetCellStyle, create: Range): SheetTab {
  const cells = { ...tab.cells };
  const touch = (r: number, c: number): void => {
    const old = cells[cellKey(r, c)];
    put(cells, r, c, makeCell(old?.v ?? '', change({ ...(old?.s ?? {}) })));
  };
  for (const { r, c } of cellsIn(tab, rg)) touch(r, c);
  const fresh = intersect(rg, create);
  if (fresh) {
    for (let r = fresh.r1; r <= fresh.r2; r++) {
      for (let c = fresh.c1; c <= fresh.c2; c++) if (!tab.cells[cellKey(r, c)]) touch(r, c);
    }
  }
  return { ...tab, cells };
}

// ------------------------------------------------------------------ sizes and freezing

export const colWidth = (tab: SheetTab, c: number): number => tab.cols?.[String(c)] ?? DEFAULT_COL_W;
export const rowHeight = (tab: SheetTab, r: number): number => tab.rows?.[String(r)] ?? DEFAULT_ROW_H;

function setSize(map: Record<string, number> | undefined, i: number, px: number, def: number, lo: number, hi: number): Record<string, number> | undefined {
  const next = { ...(map ?? {}) };
  const v = Math.round(clamp(px, lo, hi));
  if (v === def) delete next[String(i)];
  else next[String(i)] = v;
  return Object.keys(next).length ? next : undefined;
}

function withSizes(tab: SheetTab, key: 'cols' | 'rows', map: Record<string, number> | undefined): SheetTab {
  const next = { ...tab };
  if (map) next[key] = map;
  else delete next[key];
  return next;
}

export const setColWidth = (tab: SheetTab, c: number, px: number): SheetTab =>
  withSizes(tab, 'cols', setSize(tab.cols, c, px, DEFAULT_COL_W, COL_W.min, COL_W.max));
export const setRowHeight = (tab: SheetTab, r: number, px: number): SheetTab =>
  withSizes(tab, 'rows', setSize(tab.rows, r, px, DEFAULT_ROW_H, ROW_H.min, ROW_H.max));

/** Auto-fit: the widest text plus padding, between the column minimum and AUTOFIT_MAX. */
export const fitWidth = (widths: number[], pad = 14): number =>
  Math.round(clamp(Math.max(0, ...widths) + pad, COL_W.min + 16, AUTOFIT_MAX));

export function setFreeze(tab: SheetTab, r: number, c: number): SheetTab {
  const next = { ...tab };
  const f = { r: clamp(Math.round(r), 0, FREEZE_MAX.r), c: clamp(Math.round(c), 0, FREEZE_MAX.c) };
  if (f.r || f.c) next.freeze = f;
  else delete next.freeze;
  return next;
}

/** Sizes after rows or columns are inserted or deleted at `at`. */
function shiftSizes(map: Record<string, number> | undefined, at: number, count: number, del: boolean, limit: number): Record<string, number> | undefined {
  if (!map) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) {
    const i = Number(k);
    let j = i;
    if (i >= at) {
      if (del) j = i < at + count ? -1 : i - count;
      else j = i + count;
    }
    if (j >= 0 && j < limit) out[String(j)] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// ------------------------------------------------------------------ workbook

export const emptyData = (): SheetData => ({ v: 1, sheets: [{ id: 's1', name: 'Sheet1', cells: {} }] });

/** What the editor works on: the stored data, or an empty sheet when there is none to read. */
export function loadData(raw: unknown): SheetData {
  const d = raw as SheetData | null;
  if (!d || d.v !== 1 || !Array.isArray(d.sheets) || !d.sheets.length) return emptyData();
  const sheets = d.sheets.map((t, i) => ({ ...t, id: t.id || `s${i + 1}`, name: t.name || `Sheet${i + 1}`, cells: t.cells ?? {} }));
  return setActive({ ...d, sheets }, d.active ?? 0);
}

export const activeIndex = (data: SheetData): number => clamp(data.active ?? 0, 0, data.sheets.length - 1);

/** `active` as the server stores it: absent for the first tab. */
export function setActive(data: SheetData, i: number): SheetData {
  const next = { ...data };
  const a = clamp(i, 0, data.sheets.length - 1);
  if (a > 0) next.active = a;
  else delete next.active;
  return next;
}

export function withTab(data: SheetData, i: number, tab: SheetTab): SheetData {
  const sheets = data.sheets.slice();
  sheets[i] = tab;
  return { ...data, sheets };
}

/** Rows or columns in or out of tab `i`, every formula in the workbook following (null: no room). */
export function editLines(data: SheetData, i: number, axis: 'rows' | 'cols', at: number, count: number, del: boolean): SheetData | null {
  const fn = axis === 'rows' ? (del ? deleteRows : insertRows) : del ? deleteCols : insertCols;
  const next = fn(data, i, at, count);
  if (next === data) return null;
  const tab = next.sheets[i]!;
  const limit = axis === 'rows' ? MAX_ROWS : MAX_COLS;
  return withTab(next, i, withSizes(tab, axis, shiftSizes(tab[axis], at, count, del, limit)));
}

/** A tab name as the server keeps it: one line, spaces collapsed, at most nameChars. */
export function cleanTabName(raw: string): string {
  const s = raw.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, SHEET_MAX.nameChars).join('');
}

const nameTaken = (data: SheetData, name: string, except = -1): boolean =>
  data.sheets.some((t, j) => j !== except && t.name.toLowerCase() === name.toLowerCase());

function freeId(data: SheetData): string {
  const ids = new Set(data.sheets.map((t) => t.id));
  for (let n = 1; ; n++) if (!ids.has(`s${n}`)) return `s${n}`;
}

/** A new tab at the end ("Sheet2"…), made active; null when the sheet has all the tabs it may. */
export function addTab(data: SheetData): SheetData | null {
  if (data.sheets.length >= SHEET_MAX.sheets) return null;
  let n = data.sheets.length + 1;
  while (nameTaken(data, `Sheet${n}`)) n++;
  const next = { ...data, sheets: [...data.sheets, { id: freeId(data), name: `Sheet${n}`, cells: {} }] };
  return setActive(next, next.sheets.length - 1);
}

/** Renames tab i and every reference to it; an error to show when the name cannot be used. */
export function renameTab(data: SheetData, i: number, raw: string): SheetData | string {
  const name = cleanTabName(raw);
  if (!name) return 'A tab needs a name.';
  if (name === data.sheets[i]?.name) return data;
  if (nameTaken(data, name, i)) return `Another tab is called "${name}".`;
  return renameSheet(data, i, name);
}

/** A copy of tab i right after it ("Name (2)"), made active; null when there is no room. */
export function duplicateTab(data: SheetData, i: number): SheetData | null {
  const src = data.sheets[i];
  if (!src || data.sheets.length >= SHEET_MAX.sheets) return null;
  if (countCells(data) + Object.keys(src.cells).length > SHEET_MAX.cells) return null;
  let name = '';
  for (let n = 2; ; n++) {
    const tail = ` (${n})`;
    name = [...src.name].slice(0, SHEET_MAX.nameChars - tail.length).join('').trimEnd() + tail;
    if (!nameTaken(data, name)) break;
  }
  const copy: SheetTab = { ...src, id: freeId(data), name };
  const sheets = data.sheets.slice();
  sheets.splice(i + 1, 0, copy);
  return setActive({ ...data, sheets }, i + 1);
}

/** Deletes tab i (never the last one); references to it become #REF! when computed. */
export function deleteTab(data: SheetData, i: number): SheetData | null {
  if (data.sheets.length <= 1 || !data.sheets[i]) return null;
  const sheets = data.sheets.filter((_, j) => j !== i);
  const a = activeIndex(data);
  return setActive({ ...data, sheets }, a > i ? a - 1 : a === i ? Math.max(0, i - 1) : a);
}

export function moveTab(data: SheetData, i: number, dir: -1 | 1): SheetData {
  const j = i + dir;
  if (j < 0 || j >= data.sheets.length) return data;
  const sheets = data.sheets.slice();
  [sheets[i], sheets[j]] = [sheets[j]!, sheets[i]!];
  const a = activeIndex(data);
  return setActive({ ...data, sheets }, a === i ? j : a === j ? i : a);
}

// ------------------------------------------------------------------ clipboard

/** A copied block: the raw cells with their styles, and where they came from (formulas shift by the offset). */
export interface Clip {
  tab: string;
  src: Range;
  cells: Array<Array<SheetCell | null>>;
  /** The text written to the system clipboard, to recognise our own copy on paste. */
  text: string;
  cut: boolean;
}

export function copyBlock(tab: SheetTab, rg: Range): Array<Array<SheetCell | null>> {
  const out: Array<Array<SheetCell | null>> = [];
  for (let r = rg.r1; r <= rg.r2; r++) {
    const row: Array<SheetCell | null> = [];
    for (let c = rg.c1; c <= rg.c2; c++) row.push(tab.cells[cellKey(r, c)] ?? null);
    out.push(row);
  }
  return out;
}

/** Where a block of h × w lands: tiled over the selection when it is a multiple of the block (one cell fills it), else at its corner. */
export function pasteTarget(sel: Range, h: number, w: number): Range {
  const sh = sel.r2 - sel.r1 + 1, sw = sel.c2 - sel.c1 + 1;
  const tile = sh >= h && sw >= w && sh % h === 0 && sw % w === 0;
  const r2 = tile ? sel.r2 : sel.r1 + h - 1, c2 = tile ? sel.c2 : sel.c1 + w - 1;
  return { r1: sel.r1, c1: sel.c1, r2: Math.min(r2, MAX_ROWS - 1), c2: Math.min(c2, MAX_COLS - 1) };
}

/**
 * Our own block pasted: cells with their styles, a formula shifted by how far
 * it moved from `from` (the block's source corner; null keeps formulas as they
 * are, as a cut does). Blank source cells clear their target.
 */
export function pasteBlock(tab: SheetTab, sel: Range, block: Array<Array<SheetCell | null>>, from: Pos | null): { tab: SheetTab; range: Range } {
  const h = block.length, w = block[0]?.length ?? 0;
  if (!h || !w) return { tab, range: sel };
  const range = pasteTarget(sel, h, w);
  const cells = { ...tab.cells };
  for (let r = range.r1; r <= range.r2; r++) {
    for (let c = range.c1; c <= range.c2; c++) {
      const bi = (r - range.r1) % h, bj = (c - range.c1) % w;
      const src = block[bi]![bj] ?? null;
      if (!src) {
        put(cells, r, c, null);
        continue;
      }
      const v = from && isFormula(src.v) ? shiftFormula(src.v, r - (from.r + bi), c - (from.c + bj)) : src.v;
      put(cells, r, c, makeCell(v, src.s));
    }
  }
  return { tab: { ...tab, cells }, range };
}

/** Text from elsewhere (parseGrid's rows) pasted as raw values; the target cells keep their styles. */
export function pasteText(tab: SheetTab, sel: Range, rows: string[][]): { tab: SheetTab; range: Range } {
  const h = rows.length, w = Math.max(0, ...rows.map((r) => r.length));
  if (!h || !w) return { tab, range: sel };
  const range = pasteTarget(sel, h, w);
  const cells = { ...tab.cells };
  for (let r = range.r1; r <= range.r2; r++) {
    for (let c = range.c1; c <= range.c2; c++) {
      const v = rows[(r - range.r1) % h]![(c - range.c1) % w] ?? '';
      put(cells, r, c, makeCell(v, cells[cellKey(r, c)]?.s));
    }
  }
  return { tab: { ...tab, cells }, range };
}

/** After a cut is pasted: the source cells go, except where the paste landed on them. */
export function clearCutSource(tab: SheetTab, src: Range, landed: Range | null): SheetTab {
  const cells = { ...tab.cells };
  for (const { r, c } of cellsIn(tab, src)) if (!landed || !inRange(landed, r, c)) put(cells, r, c, null);
  return { ...tab, cells };
}

// ------------------------------------------------------------------ fill handle

const PLAIN_NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const TEXT_NUMBER = /^(.*?)(\d{1,15})$/s;
const numText = (x: number): string => String(Number(x.toPrecision(15)));

/**
 * A run of values continued: one number counts up by 1, numbers in an
 * arithmetic progression keep their step, and text ending in a number
 * ("Q1", "Week 3") counts the same way. `at(i)` is the value at position i,
 * 0 being the run's first cell (negative before it). Null: not a series.
 */
export function series(values: string[]): ((i: number) => string) | null {
  if (!values.length) return null;
  const trimmed = values.map((v) => v.trim());
  const step = (nums: number[]): number | null => {
    if (nums.length === 1) return 1;
    const d = nums[1]! - nums[0]!;
    for (let k = 2; k < nums.length; k++) {
      if (Math.abs(nums[k]! - nums[k - 1]! - d) > 1e-9 * Math.max(1, Math.abs(d), Math.abs(nums[k]!))) return null;
    }
    return d;
  };
  if (trimmed.every((v) => PLAIN_NUMBER.test(v))) {
    const nums = trimmed.map(Number);
    const d = step(nums);
    return d === null ? null : (i) => numText(nums[0]! + d * i);
  }
  // "1,000", "$5" or "10%" are numbers to the engine, not text with a counter: they repeat.
  if (values.some((v) => typeof parseLiteral(v) !== 'string')) return null;
  const parts = values.map((v) => TEXT_NUMBER.exec(v));
  if (parts.every((m) => m && m[1] && !isFormula(m[1]) && m[1] === parts[0]![1])) {
    const nums = parts.map((m) => Number(m![2]));
    const d = step(nums);
    if (d === null || !Number.isInteger(d)) return null;
    const prefix = parts[0]![1]!;
    const digits = parts[0]![2]!;
    // "Item 007" keeps its zero padding.
    const width = digits.length > 1 && digits.startsWith('0') ? digits.length : 0;
    return (i) => {
      const n = nums[0]! + d * i;
      return n < 0 ? `${prefix}${n}` : `${prefix}${String(n).padStart(width, '0')}`;
    };
  }
  return null;
}

const mod = (n: number, m: number): number => ((n % m) + m) % m;

/**
 * The fill handle dragged from `src` to `dest` (which holds src and reaches
 * past it in one direction): each column (or row) continues its series, or
 * repeats its cells with formulas shifted to their new place. Styles repeat.
 */
export function fillRange(tab: SheetTab, src: Range, dest: Range): SheetTab {
  const vertical = dest.r1 !== src.r1 || dest.r2 !== src.r2;
  const cells = { ...tab.cells };
  const lines = vertical ? [src.c1, src.c2] : [src.r1, src.r2];
  const n = vertical ? src.r2 - src.r1 + 1 : src.c2 - src.c1 + 1;
  const from = vertical ? dest.r1 : dest.c1, to = vertical ? dest.r2 : dest.c2;
  const start = vertical ? src.r1 : src.c1;
  for (let line = lines[0]!; line <= lines[1]!; line++) {
    const at = (k: number): SheetCell | undefined => (vertical ? tab.cells[cellKey(start + k, line)] : tab.cells[cellKey(line, start + k)]);
    const run: Array<SheetCell | undefined> = [];
    for (let k = 0; k < n; k++) run.push(at(k));
    const values = run.map((c) => c?.v ?? '');
    const gen = values.some((v) => v === '' || isFormula(v)) ? null : series(values);
    for (let p = from; p <= to; p++) {
      const i = p - start;
      if (i >= 0 && i < n) continue;
      const k = mod(i, n);
      const srcCell = run[k];
      const r = vertical ? p : line, c = vertical ? line : p;
      let v = srcCell?.v ?? '';
      if (gen) v = gen(i);
      else if (isFormula(v)) v = vertical ? shiftFormula(v, i - k, 0) : shiftFormula(v, 0, i - k);
      put(cells, r, c, makeCell(v, srcCell?.s));
    }
  }
  return { ...tab, cells };
}

/** Where the fill handle has been dragged to: src grown towards p along the axis it moved most on. */
export function fillTarget(src: Range, p: Pos): Range {
  const dr = p.r > src.r2 ? p.r - src.r2 : p.r < src.r1 ? p.r - src.r1 : 0;
  const dc = p.c > src.c2 ? p.c - src.c2 : p.c < src.c1 ? p.c - src.c1 : 0;
  if (!dr && !dc) return src;
  if (Math.abs(dr) >= Math.abs(dc)) return dr > 0 ? { ...src, r2: p.r } : { ...src, r1: p.r };
  return dc > 0 ? { ...src, c2: p.c } : { ...src, c1: p.c };
}

// ------------------------------------------------------------------ sorting

/** Sort order of a computed value: numbers, then text, then booleans, then errors; blanks apart (always last). */
function compareValues(a: CellValue, b: CellValue): number {
  const rank = (v: CellValue): number => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 3);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return 0;
}

const blank = (v: CellValue): boolean => v === null || v === '';

/**
 * The rows of a range reordered by column `col`'s computed values (`valueAt`),
 * stably; blanks stay last both ways; a header row stays on top. Each row's
 * cells move with their styles, and formulas shift with their row.
 */
export function sortRange(tab: SheetTab, rg: Range, col: number, desc: boolean, header: boolean, valueAt: (r: number, c: number) => CellValue): SheetTab {
  const top = header ? rg.r1 + 1 : rg.r1;
  if (top >= rg.r2) return tab;
  const rows: Array<{ r: number; v: CellValue }> = [];
  for (let r = top; r <= rg.r2; r++) rows.push({ r, v: valueAt(r, col) });
  const sorted = rows.slice().sort((x, y) => {
    const bx = blank(x.v), by = blank(y.v);
    if (bx || by) return bx === by ? x.r - y.r : bx ? 1 : -1;
    const d = compareValues(x.v, y.v);
    return d === 0 ? x.r - y.r : desc ? -d : d;
  });
  if (sorted.every((x, i) => x.r === rows[i]!.r)) return tab;
  const cells = { ...tab.cells };
  for (let r = top; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) delete cells[cellKey(r, c)];
  sorted.forEach(({ r: from }, i) => {
    const r = top + i;
    for (let c = rg.c1; c <= rg.c2; c++) {
      const cell = tab.cells[cellKey(from, c)];
      if (!cell) continue;
      const v = isFormula(cell.v) && r !== from ? shiftFormula(cell.v, r - from, 0) : cell.v;
      put(cells, r, c, makeCell(v, cell.s));
    }
  });
  return { ...tab, cells };
}
