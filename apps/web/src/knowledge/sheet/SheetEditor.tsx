/**
 * The spreadsheet (a sheet item), Excel- and Google Sheets-like:
 *
 *   grid      virtualized rows and columns (only what is in view, plus a margin,
 *             is in the page), sticky headers, frozen rows and columns, column
 *             and row resizing (double-click a column's edge to fit it); it opens
 *             at 26 × 100 and grows as the user goes further
 *   editing   type over a cell, or Enter / F2 / double-click to edit it; formulas
 *             (formula.ts) with their references coloured on the grid and in the
 *             text, pointing at cells to insert them, function autocomplete and
 *             the signature of the call the caret is in
 *   commands  undo / redo, marks, alignment, wrap, colours, number formats and
 *             decimals, sort, freeze, CSV out; the clipboard (our own block keeps
 *             formulas and styles, text from elsewhere is pasted as values), the
 *             fill handle (series or repeat), rows / columns in and out, tabs
 *
 * What is stored is SheetData (raw typed text and styles per cell); values are
 * computed here, never saved. Every write goes through model.ts, which keeps
 * the data inside what the server accepts (validate.ts checkSheet).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { SHEET_MAX, type SheetCellStyle, type SheetData, type SheetTab } from '@sign/folders/types.js';
import { notify } from '../../toast';
import { saveBlob } from '../../folders/ui';
import { MENU_ICONS, TabMenu, menuAt, type TabMenuItem } from '../../dashboard/tabExtras';
import { ConflictBar, useEditorSave, type EditorProps } from '../editing';
import { FUNCTION_HELP, evaluateWorkbook, formatValue, isError, referencedRanges, type CellValue } from './formula';
import { MAX_COLS, MAX_ROWS, cellKey, colName, parseKey, rangeLabel } from './refs';
import { parseGrid, toCsv, toTsv } from './grid';
import * as M from './model';
import type { Pos, Range, Sel } from './model';
import './sheet.css';

const HEAD_W = 46;
const HEAD_H = 24;
const INIT_ROWS = 100;
const INIT_COLS = 26;
const GROW_ROWS = 100;
const GROW_COLS = 10;
const OVER_R = 12;
const OVER_C = 4;
const HISTORY = 100;
const MORE_H = 44;

/** References in a formula take these colours, in order, on the grid and in the text. */
const REF_COLORS = ['#5aa9ff', '#ff7a6b', '#b48cff', '#5fd18f', '#ffa94d', '#f783ac', '#3bc9db', '#e8c547'];
const TEXT_COLORS = ['#f7f7f7', '#bcbcbc', '#7b7b7b', '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa', '#f783ac'];
const FILLS = ['#2c2c2e', '#3a3a3e', '#5c2626', '#5c3d1a', '#5c4a1a', '#1f4d36', '#17474d', '#1d3b5c', '#33285c', '#4a2350'];
const FORMATS: Array<{ v: '' | NonNullable<SheetCellStyle['fmt']>; label: string }> = [
  { v: '', label: 'Auto' },
  { v: 'num', label: 'Number' },
  { v: 'pct', label: 'Percent' },
  { v: 'usd', label: 'USD' },
  { v: 'date', label: 'Date' },
  { v: 'text', label: 'Text' },
];

type Dir = 'up' | 'down' | 'left' | 'right';
const STEP: Record<Dir, [number, number]> = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
const EMPTY_VALUES = new Map<string, CellValue>();

interface Edit {
  tab: number;
  r: number;
  c: number;
  text: string;
  orig: string;
  caret: number;
  /** Typed over the cell (arrows commit a plain value) or opened to edit (arrows move the caret). */
  mode: 'enter' | 'edit';
  where: 'cell' | 'bar';
  /** A reference put in by pointing at the grid, replaced while the pointer keeps choosing. */
  point: { start: number; end: number } | null;
  ac: number;
  acOff: boolean;
  /** Bumped when the text or caret is set from outside the field, so the field takes the caret. */
  sync: number;
}

type Drag =
  | { kind: 'cells'; anchor: Pos }
  | { kind: 'cols'; anchor: number }
  | { kind: 'rows'; anchor: number }
  | { kind: 'point'; anchor: Pos }
  | { kind: 'fill'; src: Range }
  | { kind: 'size'; axis: 'col' | 'row'; i: number; start: number; from: number };

interface Hit { r: number; c: number; zone: 'cell' | 'colhead' | 'rowhead' | 'corner' }

// ------------------------------------------------------------------ icons

const ic = (d: ReactNode) => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const I = {
  undo: ic(<><path d="M5.5 6.5H10a3 3 0 0 1 0 6H7" /><path d="M7.5 4 5 6.5 7.5 9" /></>),
  redo: ic(<><path d="M10.5 6.5H6a3 3 0 0 0 0 6h3" /><path d="M8.5 4 11 6.5 8.5 9" /></>),
  bold: ic(<path d="M4.5 3h4a2.5 2.5 0 0 1 0 5h-4zM4.5 8h4.8a2.5 2.5 0 0 1 0 5H4.5z" />),
  italic: ic(<path d="M9.5 3H13M3 13h3.5M10.5 3 6 13" />),
  underline: ic(<path d="M4.5 3v4.5a3.5 3.5 0 0 0 7 0V3M3.5 13.5h9" />),
  strike: ic(<path d="M2.5 8h11M11 4.8C10.5 3.8 9.4 3 8 3 6.3 3 5 4 5 5.3M5 11.2c.5 1 1.6 1.8 3 1.8 1.7 0 3-1 3-2.3" />),
  left: ic(<path d="M2.5 4h11M2.5 7h7M2.5 10h11M2.5 13h7" />),
  center: ic(<path d="M2.5 4h11M4.5 7h7M2.5 10h11M4.5 13h7" />),
  right: ic(<path d="M2.5 4h11M6.5 7h7M2.5 10h11M6.5 13h7" />),
  wrap: ic(<><path d="M2.5 4h11M2.5 8h8.5a2 2 0 0 1 0 4H8" /><path d="M9.5 10.5 8 12l1.5 1.5M2.5 12h3" /></>),
  color: ic(<path d="M5 11.5 8 3.5l3 8M6 9h4" />),
  fill: ic(<><path d="m3.2 7.6 4.4-4.4 4.6 4.6-4.4 4.4a1.3 1.3 0 0 1-1.8 0L3.2 9.4a1.3 1.3 0 0 1 0-1.8zM5.2 5.6h7" /><path d="M13.6 10.2s.9 1.2.9 1.9a.9.9 0 0 1-1.8 0c0-.7.9-1.9.9-1.9z" /></>),
  eraser: ic(<><path d="m6.4 12.8 6.8-6.8-3.4-3.4-7.3 7.3 2.9 2.9z" /><path d="M5.2 6.5l3.4 3.4M6.4 12.8h7.1" /></>),
  sortAsc: ic(<path d="M4.5 3v10M2.5 11l2 2 2-2M8.5 4.5h2M8.5 8h3.5M8.5 11.5h5" />),
  sortDesc: ic(<path d="M4.5 3v10M2.5 11l2 2 2-2M8.5 4.5h5M8.5 8h3.5M8.5 11.5h2" />),
  freeze: ic(<><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M2.5 6.2h11M6.2 2.5v11" /></>),
  download: ic(<><path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2" /><path d="M2.8 11v1.2c0 .7.6 1.3 1.3 1.3h7.8c.7 0 1.3-.6 1.3-1.3V11" /></>),
  cut: ic(<><circle cx="4.5" cy="11.5" r="1.8" /><circle cx="11.5" cy="11.5" r="1.8" /><path d="M5.8 10.2 12 3M10.2 10.2 4 3" /></>),
  paste: ic(<><rect x="3.5" y="3.5" width="9" height="10" rx="1.5" /><path d="M6 3.5V3c0-.3.2-.5.5-.5h3c.3 0 .5.2.5.5v.5M6 8h4M6 10.5h2.5" /></>),
  clear: ic(<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />),
};

// ------------------------------------------------------------------ helpers

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Prefix sums of sizes: start of item i at a[i], total at a[n]. */
function prefix(n: number, size: (i: number) => number): Float64Array {
  const a = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) a[i + 1] = a[i]! + size(i);
  return a;
}

/** The item whose span holds x (clamped to 0..n-1). */
function indexAt(a: Float64Array, n: number, x: number): number {
  if (x <= 0) return 0;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The name box: "B7", "A1:C4", whole columns "A:C", whole rows "3:5". */
function selLabel(rg: Range): string {
  if (M.isWholeCols(rg) && M.isWholeRows(rg)) return 'All';
  if (M.isWholeCols(rg)) return `${colName(rg.c1)}:${colName(rg.c2)}`;
  if (M.isWholeRows(rg)) return `${rg.r1 + 1}:${rg.r2 + 1}`;
  return rangeLabel(rg.r1, rg.c1, rg.r2, rg.c2);
}

const quoteSheet = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);
const fileSafe = (s: string): string => s.replace(/[\\/:*?"<>|]+/g, ' ').trim();

/** Where pointing at the grid inserts a reference: after an operator, "(" or "," (or over the one just pointed at). */
function pointable(e: Edit): boolean {
  if (!e.text.startsWith('=')) return false;
  if (e.point) return true;
  const before = e.text.slice(0, e.caret).trimEnd();
  if ((before.match(/"/g)?.length ?? 0) % 2) return false;
  return /[=(,+\-*/^&<>:]$/.test(before);
}

/** The function name being typed at the caret, and the functions it could be. */
function autocomplete(text: string, caret: number): { start: number; names: string[] } | null {
  if (!text.startsWith('=')) return null;
  const before = text.slice(0, caret);
  if ((before.match(/"/g)?.length ?? 0) % 2) return null;
  const m = /([A-Za-z][A-Za-z0-9.]*)$/.exec(before);
  if (!m) return null;
  const start = caret - m[1]!.length;
  const prev = before[start - 1];
  if (prev && /[A-Za-z0-9_.$'!:]/.test(prev)) return null;
  if (text[caret] === '(') return null;
  const up = m[1]!.toUpperCase();
  // Shorter names first: "SU" offers SUM before SUBSTITUTE.
  const names = Object.keys(FUNCTION_HELP)
    .filter((n) => n.startsWith(up))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (!names.length || (names.length === 1 && names[0] === up && text[caret] === '(')) return null;
  return { start, names: names.slice(0, 8) };
}

/** The innermost function call around the caret and which of its arguments the caret is in. */
function callAt(text: string, caret: number): { name: string; arg: number } | null {
  if (!text.startsWith('=')) return null;
  const stack: Array<{ name: string; arg: number }> = [];
  let inStr = false;
  for (let i = 1; i < caret; i++) {
    const ch = text[i];
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '(') {
      const m = /([A-Za-z][A-Za-z0-9.]*)$/.exec(text.slice(0, i));
      stack.push({ name: m ? m[1]!.toUpperCase() : '', arg: 0 });
    } else if (ch === ')') stack.pop();
    else if (ch === ',' && stack.length) stack[stack.length - 1]!.arg++;
  }
  const top = stack[stack.length - 1];
  return top && FUNCTION_HELP[top.name] ? top : null;
}

/** Closes the parentheses a formula left open (outside strings), as Excel does on Enter. */
function closeParens(text: string): string {
  if (!text.startsWith('=')) return text;
  let depth = 0;
  let inStr = false;
  for (const ch of text) {
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === '(') depth++;
    else if (!inStr && ch === ')') depth = Math.max(0, depth - 1);
  }
  return inStr || depth <= 0 ? text : text + ')'.repeat(depth);
}

const measureCanvas = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
const widthCache = new Map<string, number>();
function textWidth(text: string, font: string): number {
  const key = `${font}|${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  if (!measureCanvas) return text.length * 7;
  measureCanvas.font = font;
  const w = measureCanvas.measureText(text).width;
  if (widthCache.size > 5000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

// ------------------------------------------------------------------ the editor

export default function SheetEditor({ item, data: initial, limitBytes, onStatus }: EditorProps<SheetData>) {
  const [data, setData] = useState<SheetData>(() => M.loadData(initial));
  const dataRef = useRef(data);
  const read = useCallback((): SheetData => dataRef.current, []);
  const save = useEditorSave(item, read, limitBytes, onStatus);
  const { touched } = save;
  const history = useRef<{ past: SheetData[]; future: SheetData[] }>({ past: [], future: [] });

  const ti = M.activeIndex(data);
  const tab = data.sheets[ti]!;
  const [sel, setSel] = useState<Sel>(M.single({ r: 0, c: 0 }));
  const [edit, setEdit] = useState<Edit | null>(null);
  const [clip, setClip] = useState<M.Clip | null>(null);
  const [fillTo, setFillTo] = useState<Range | null>(null);
  const [resize, setResize] = useState<{ axis: 'col' | 'row'; i: number; size: number } | null>(null);
  const [extents, setExtents] = useState<Record<string, { rows: number; cols: number }>>({});
  const [win, setWin] = useState({ r0: 0, r1: 40, c0: 0, c1: 14 });
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: TabMenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [nameBox, setNameBox] = useState<string | null>(null);
  const [font, setFont] = useState('system-ui, sans-serif');

  const scroller = useRef<HTMLDivElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const cellField = useRef<HTMLTextAreaElement>(null);
  const barField = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<Drag | null>(null);
  const selByTab = useRef<Record<string, { sel: Sel; top: number; left: number }>>({});
  const wantReveal = useRef(false);
  const tabRun = useRef<Pos | null>(null);

  // ---- values: recomputed only when some tab's cells or a tab name changed
  const evalCache = useRef<{ keys: unknown[]; out: Array<Map<string, CellValue>> } | null>(null);
  const values = useMemo(() => {
    const keyList = data.sheets.flatMap((s) => [s.cells, s.name]);
    const prev = evalCache.current;
    if (prev && prev.keys.length === keyList.length && prev.keys.every((k, i) => k === keyList[i])) return prev.out;
    const out = evaluateWorkbook(data);
    evalCache.current = { keys: keyList, out };
    return out;
  }, [data]);
  const tabVals = values[ti] ?? EMPTY_VALUES;

  // ---- extent and geometry
  const used = useMemo(() => M.usedSize(tab), [tab]);
  const ext = extents[tab.id];
  const fr0 = tab.freeze?.r ?? 0, fc0 = tab.freeze?.c ?? 0;
  const nrows = clamp(Math.max(INIT_ROWS, used.rows + 30, ext?.rows ?? 0, fr0 + 1), 1, MAX_ROWS);
  const ncols = clamp(Math.max(INIT_COLS, used.cols + 3, ext?.cols ?? 0, fc0 + 1), 1, MAX_COLS);
  const colX = useMemo(
    () => prefix(ncols, (c) => (resize?.axis === 'col' && resize.i === c ? resize.size : M.colWidth(tab, c))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.cols, ncols, resize],
  );
  const rowY = useMemo(
    () => prefix(nrows, (r) => (resize?.axis === 'row' && resize.i === r ? resize.size : M.rowHeight(tab, r))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.rows, nrows, resize],
  );
  const fr = Math.min(fr0, nrows), fc = Math.min(fc0, ncols);
  const frozenW = colX[fc]!, frozenH = rowY[fr]!;
  const totalW = colX[ncols]!, totalH = rowY[nrows]!;
  const range = M.rangeOf(sel);

  const grow = useCallback((id: string, rows: number, cols: number) => {
    setExtents((m) => {
      const cur = m[id];
      const next = { rows: Math.min(MAX_ROWS, Math.max(cur?.rows ?? 0, rows)), cols: Math.min(MAX_COLS, Math.max(cur?.cols ?? 0, cols)) };
      return cur && cur.rows === next.rows && cur.cols === next.cols ? m : { ...m, [id]: next };
    });
  }, []);

  // The latest of everything, for handlers on window and timers.
  const st = useRef({ data, tab, ti, sel, edit, clip, nrows, ncols, colX, rowY, fr, fc, frozenW, frozenH, totalW, totalH, tabVals, fillTo });
  st.current = { data, tab, ti, sel, edit, clip, nrows, ncols, colX, rowY, fr, fc, frozenW, frozenH, totalW, totalH, tabVals, fillTo };

  // ---- saving and history

  const commit = useCallback(
    (next: SheetData, keepHistory = true): boolean => {
      const prev = dataRef.current;
      if (next === prev) return false;
      const n = M.countCells(next);
      if (n > SHEET_MAX.cells && n > M.countCells(prev)) {
        notify('warn', `A sheet holds at most ${SHEET_MAX.cells.toLocaleString('en-US')} cells; that change would go past it.`);
        return false;
      }
      if (keepHistory) {
        const h = history.current;
        h.past.push(prev);
        if (h.past.length > HISTORY) h.past.shift();
        h.future = [];
      }
      dataRef.current = next;
      setData(next);
      touched();
      return true;
    },
    [touched],
  );
  const commitTab = (next: SheetTab): boolean => commit(M.withTab(dataRef.current, st.current.ti, next));

  const undo = () => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(dataRef.current);
    dataRef.current = prev;
    setData(prev);
    touched();
  };
  const redo = () => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(dataRef.current);
    dataRef.current = next;
    setData(next);
    touched();
  };

  // ---- focus, scrolling, the visible window

  const focusGrid = () => keys.current?.focus({ preventScroll: true });

  const computeWin = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const g = st.current;
    const top = el.scrollTop, left = el.scrollLeft, h = el.clientHeight, w = el.clientWidth;
    const r0 = indexAt(g.rowY, g.nrows, top + g.frozenH), r1 = indexAt(g.rowY, g.nrows, top + h - HEAD_H);
    const c0 = indexAt(g.colX, g.ncols, left + g.frozenW), c1 = indexAt(g.colX, g.ncols, left + w - HEAD_W);
    setWin((p) =>
      r0 >= p.r0 && r1 <= p.r1 && c0 >= p.c0 && c1 <= p.c1 && p.r1 < g.nrows && p.c1 < g.ncols
        ? p
        : { r0: Math.max(0, r0 - OVER_R), r1: Math.min(g.nrows - 1, r1 + OVER_R), c0: Math.max(0, c0 - OVER_C), c1: Math.min(g.ncols - 1, c1 + OVER_C) },
    );
    // Near the end the grid grows, as far as the sheet may go.
    if (g.nrows < MAX_ROWS && top + h > HEAD_H + g.totalH - 300) grow(g.tab.id, g.nrows + GROW_ROWS, 0);
    if (g.ncols < MAX_COLS && left + w > HEAD_W + g.totalW - 200) grow(g.tab.id, 0, g.ncols + GROW_COLS);
  }, [grow]);

  useLayoutEffect(computeWin, [computeWin, colX, rowY, nrows, ncols, fr, fc]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => computeWin());
    ro.observe(el);
    return () => ro.disconnect();
  }, [computeWin]);
  useEffect(() => {
    if (scroller.current) setFont(getComputedStyle(scroller.current).fontFamily || font);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Scrolls so cell p is in view (frozen panes and headers allowed for). */
  const reveal = useCallback((p: Pos) => {
    const el = scroller.current;
    if (!el) return;
    const g = st.current;
    if (p.r >= g.fr && p.r < g.nrows) {
      const top = g.rowY[p.r]!, bottom = g.rowY[p.r + 1]!;
      const viewTop = el.scrollTop + g.frozenH, viewBottom = el.scrollTop + el.clientHeight - HEAD_H;
      if (top < viewTop) el.scrollTop = top - g.frozenH;
      else if (bottom > viewBottom) el.scrollTop = bottom - (el.clientHeight - HEAD_H);
    }
    if (p.c >= g.fc && p.c < g.ncols) {
      const left = g.colX[p.c]!, right = g.colX[p.c + 1]!;
      const viewLeft = el.scrollLeft + g.frozenW, viewRight = el.scrollLeft + el.clientWidth - HEAD_W;
      if (left < viewLeft) el.scrollLeft = left - g.frozenW;
      else if (right > viewRight) el.scrollLeft = Math.min(left - g.frozenW, right - (el.clientWidth - HEAD_W));
    }
  }, []);

  /** A new selection; the grid grows to hold it, and keyboard moves scroll it into view. */
  const select = useCallback(
    (s: Sel, show = false) => {
      const rg = M.rangeOf(s);
      if (!M.isWholeCols(rg) && !M.isWholeRows(rg)) {
        const g = st.current;
        const needR = Math.max(s.a.r, s.f.r) + 1, needC = Math.max(s.a.c, s.f.c) + 1;
        if (needR > g.nrows || needC > g.ncols) grow(g.tab.id, needR > g.nrows ? Math.max(needR, g.nrows + GROW_ROWS) : 0, needC > g.ncols ? Math.max(needC, g.ncols + GROW_COLS) : 0);
      }
      wantReveal.current = show;
      setSel(s);
    },
    [grow],
  );
  useLayoutEffect(() => {
    if (!wantReveal.current) return;
    wantReveal.current = false;
    reveal(sel.f);
  }, [sel, reveal, nrows, ncols]);

  // ---- switching tabs: each keeps its selection and scroll position

  const switchTab = (i: number) => {
    if (i === st.current.ti) return;
    if (st.current.edit) commitEdit(null);
    const el = scroller.current;
    selByTab.current[st.current.tab.id] = { sel: st.current.sel, top: el?.scrollTop ?? 0, left: el?.scrollLeft ?? 0 };
    commit(M.setActive(dataRef.current, i), false);
  };
  const shownTab = useRef(tab.id);
  useLayoutEffect(() => {
    if (shownTab.current === tab.id) return;
    shownTab.current = tab.id;
    const kept = selByTab.current[tab.id];
    setSel(kept?.sel ?? M.single({ r: 0, c: 0 }));
    setEdit(null);
    setFillTo(null);
    const el = scroller.current;
    if (el) {
      el.scrollTop = kept?.top ?? 0;
      el.scrollLeft = kept?.left ?? 0;
    }
  }, [tab.id]);

  // ---- editing

  const startEdit = (p: Pos, typed: string | null, where: 'cell' | 'bar' = 'cell') => {
    const raw = st.current.tab.cells[cellKey(p.r, p.c)]?.v ?? '';
    const text = typed ?? raw;
    if (where === 'cell') reveal(p);
    setEdit({ tab: st.current.ti, r: p.r, c: p.c, text, orig: raw, caret: text.length, mode: typed !== null ? 'enter' : 'edit', where, point: null, ac: 0, acOff: false, sync: 1 });
  };

  /** Writes what is being edited, then moves the active cell (Enter down, Tab right, shift back). */
  function commitEdit(move: Dir | null) {
    const e = st.current.edit;
    if (!e) return;
    setEdit(null);
    const d = dataRef.current;
    const t = d.sheets[e.tab];
    if (t) {
      const text = closeParens(e.text);
      if (text !== e.orig) {
        const old = t.cells[cellKey(e.r, e.c)];
        if (commit(M.withTab(d, e.tab, M.setValue(t, { r: e.r, c: e.c }, M.inputFor(text, old?.s))))) setClip(null);
      }
    }
    if (move) {
      // After a row typed with Tab, Enter goes back to the column the row started in.
      const from = tabRun.current;
      tabRun.current = move === 'right' ? (from && from.r === e.r ? from : { r: e.r, c: e.c }) : null;
      const [dr, dc] = STEP[move];
      const c = move === 'down' && from && from.r === e.r ? from.c : e.c + dc;
      select(M.single(M.clampPos({ r: e.r + dr, c })), true);
    }
    focusGrid();
  }

  const cancelEdit = () => {
    setEdit(null);
    focusGrid();
  };

  const updateEdit = (patch: Partial<Edit>) => setEdit((e) => (e ? { ...e, ...patch } : e));
  // React reports the caret on keydown too, before a change made in that same keydown reaches
  // the field: a caret read from text that is no longer the edit's is stale and ignored.
  const moveCaret = (caret: number, text: string) => setEdit((e) => (e && e.text === text && e.caret !== caret ? { ...e, caret } : e));

  /** Pointing at the grid while writing a formula puts the reference in at the caret. */
  const pointAt = (rg: Range) =>
    setEdit((e) => {
      if (!e) return e;
      const label = rangeLabel(rg.r1, rg.c1, rg.r2, rg.c2);
      const start = e.point ? e.point.start : e.caret;
      const end = e.point ? e.point.end : e.caret;
      const text = e.text.slice(0, start) + label + e.text.slice(end);
      return { ...e, text, caret: start + label.length, point: { start, end: start + label.length }, acOff: true, sync: e.sync + 1 };
    });

  const insertFunction = (name: string) =>
    setEdit((e) => {
      if (!e) return e;
      const a = autocomplete(e.text, e.caret);
      if (!a) return e;
      const text = `${e.text.slice(0, a.start)}${name}(${e.text.slice(e.caret)}`;
      return { ...e, text, caret: a.start + name.length + 1, ac: 0, point: null, sync: e.sync + 1 };
    });

  const ac = edit && !edit.acOff ? autocomplete(edit.text, edit.caret) : null;
  const call = edit ? callAt(edit.text, edit.caret) : null;
  const editRefs = useMemo(() => {
    if (!edit || !edit.text.startsWith('=')) return [];
    return referencedRanges(edit.text).map((r, i) => ({ ...r, color: REF_COLORS[i % REF_COLORS.length]! }));
  }, [edit]);

  const onEditKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const cur = st.current.edit;
    if (!cur) return;
    if (ac && ac.names.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = ac.names.length;
        updateEdit({ ac: (cur.ac + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.altKey)) {
        e.preventDefault();
        insertFunction(ac.names[Math.min(cur.ac, ac.names.length - 1)]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        updateEdit({ acOff: true });
        return;
      }
    }
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      const t = e.currentTarget;
      const a = t.selectionStart, b = t.selectionEnd;
      updateEdit({ text: cur.text.slice(0, a) + '\n' + cur.text.slice(b), caret: a + 1, point: null, sync: cur.sync + 1 });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit(e.shiftKey ? 'up' : 'down');
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      commitEdit(e.shiftKey ? 'left' : 'right');
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
      return;
    }
    const arrow = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[e.key as 'ArrowUp'];
    if (arrow && cur.mode === 'enter' && cur.where === 'cell' && !cur.text.startsWith('=') && !e.shiftKey) {
      e.preventDefault();
      commitEdit(arrow);
    }
  };

  const onEditBlur = () => {
    // Leaving both fields (not moving between the cell and the bar) keeps what was typed.
    setTimeout(() => {
      const a = document.activeElement;
      if (st.current.edit && a !== cellField.current && a !== barField.current) commitEdit(null);
    }, 0);
  };

  // ---- the grid's own keys

  const valueAt = (r: number, c: number): CellValue => st.current.tabVals.get(cellKey(r, c)) ?? null;
  const has = (r: number, c: number): boolean => !!st.current.tab.cells[cellKey(r, c)]?.v;

  const onGridKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const g = st.current;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    const key = e.key;
    if (mod) {
      const k = key.toLowerCase();
      if (k === 'z') return void (e.preventDefault(), e.shiftKey ? redo() : undo());
      if (k === 'y') return void (e.preventDefault(), redo());
      if (k === 'b' || k === 'i' || k === 'u') return void (e.preventDefault(), toggleMark(k));
      if (k === 'a') return void (e.preventDefault(), select({ a: g.sel.a, f: { r: MAX_ROWS - 1, c: MAX_COLS - 1 } }));
      if (k === 'c' || k === 'x' || k === 'v') return; // the copy / cut / paste events do these
      // As in Excel: the first cell past the frozen panes, scrolled to the top.
      if (key === 'Home') return void (e.preventDefault(), select(M.single({ r: g.fr, c: g.fc }), true));
      if (key === 'End') {
        e.preventDefault();
        const u = M.usedSize(g.tab, false);
        return void select(M.single({ r: Math.max(0, u.rows - 1), c: Math.max(0, u.cols - 1) }), true);
      }
    }
    const arrow = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[key as 'ArrowUp'];
    if (arrow) {
      e.preventDefault();
      const [dr, dc] = STEP[arrow];
      if (mod) {
        const from = e.shiftKey ? g.sel.f : g.sel.a;
        const to = M.dataEdge(has, from, dr, dc);
        select(e.shiftKey ? { a: g.sel.a, f: to } : M.single(to), true);
      } else select(M.moveSel(g.sel, dr, dc, e.shiftKey), true);
      return;
    }
    switch (key) {
      case 'Tab':
        e.preventDefault();
        select(M.moveSel(g.sel, 0, e.shiftKey ? -1 : 1, false), true);
        return;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        startEdit(g.sel.a, null);
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        commitTab(M.clearValues(g.tab, M.rangeOf(g.sel)));
        return;
      case 'Home':
        e.preventDefault();
        select(e.shiftKey ? { a: g.sel.a, f: { r: g.sel.f.r, c: 0 } } : M.single({ r: g.sel.a.r, c: 0 }), true);
        return;
      case 'End': {
        e.preventDefault();
        let last = 0;
        for (let c = MAX_COLS - 1; c >= 0; c--) if (has(g.sel.a.r, c)) { last = c; break; }
        select(e.shiftKey ? { a: g.sel.a, f: { r: g.sel.f.r, c: last } } : M.single({ r: g.sel.a.r, c: last }), true);
        return;
      }
      case 'PageDown':
      case 'PageUp': {
        e.preventDefault();
        const el = scroller.current;
        const rows = Math.max(1, Math.floor(((el?.clientHeight ?? 400) - HEAD_H - g.frozenH) / 26) - 1);
        select(M.moveSel(g.sel, key === 'PageDown' ? rows : -rows, 0, e.shiftKey), true);
        return;
      }
      case 'Escape':
        if (g.clip || g.fillTo) {
          e.preventDefault();
          e.stopPropagation();
          setClip(null);
          setFillTo(null);
        }
        return;
      default:
        break;
    }
    // A character starts editing, replacing the cell (AltGr is Ctrl+Alt on Windows).
    if (key.length === 1 && !e.metaKey && !(e.ctrlKey && !e.altKey)) {
      e.preventDefault();
      startEdit(g.sel.a, key);
    }
  };

  // ---- styles

  const activeStyle: SheetCellStyle = tab.cells[cellKey(sel.a.r, sel.a.c)]?.s ?? {};
  const extentRange = (): Range => ({ r1: 0, c1: 0, r2: st.current.nrows - 1, c2: st.current.ncols - 1 });
  const styleSel = (change: (s: SheetCellStyle) => SheetCellStyle) => {
    const g = st.current;
    commitTab(M.styleRange(g.tab, M.rangeOf(g.sel), change, extentRange()));
  };
  const toggleMark = (k: 'b' | 'i' | 'u' | 's') => {
    const g = st.current;
    const on = !g.tab.cells[cellKey(g.sel.a.r, g.sel.a.c)]?.s?.[k];
    styleSel((s) => ({ ...s, [k]: on || undefined }));
  };
  const setAlign = (al: 'l' | 'c' | 'r') => styleSel((s) => ({ ...s, al: activeStyle.al === al ? undefined : al }));
  const setFormat = (fmt: SheetCellStyle['fmt'] | '') => styleSel((s) => ({ ...s, fmt: fmt || undefined, dp: fmt ? s.dp : undefined }));
  const decimals = (delta: number) => {
    const v = tabVals.get(cellKey(sel.a.r, sel.a.c));
    let cur = activeStyle.dp;
    if (cur === undefined) {
      const shown = typeof v === 'number' ? formatValue(v, activeStyle) : '';
      const m = /\.(\d+)/.exec(shown);
      cur = m ? m[1]!.length : activeStyle.fmt === 'usd' ? 2 : 0;
    }
    const dp = clamp(cur + delta, 0, 10);
    styleSel((s) => ({ ...s, dp }));
  };

  // ---- clipboard

  /** The selection as a block for the clipboard (a whole row or column: its filled part). */
  const makeClip = (cut: boolean): M.Clip | null => {
    const g = st.current;
    let rg: Range | null = M.rangeOf(g.sel);
    if (M.isWholeCols(rg) || M.isWholeRows(rg)) rg = M.clipToUsed(g.tab, rg);
    if (!rg) return null;
    const rows: string[][] = [];
    for (let r = rg.r1; r <= rg.r2; r++) {
      const row: string[] = [];
      for (let c = rg.c1; c <= rg.c2; c++) row.push(formatValue(valueAt(r, c), g.tab.cells[cellKey(r, c)]?.s));
      rows.push(row);
    }
    return { tab: g.tab.id, src: rg, cells: M.copyBlock(g.tab, rg), text: toTsv(rows), cut };
  };

  const pasteFrom = (text: string) => {
    const g = st.current;
    const d = dataRef.current;
    const norm = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    // A whole row or column pasted into is held to the part of the grid shown.
    const target = M.intersect(M.rangeOf(g.sel), extentRange()) ?? M.rangeOf(g.sel);
    const c = g.clip;
    let next: SheetData;
    let landed: Range;
    if (c && norm(text) === norm(c.text)) {
      const out = M.pasteBlock(g.tab, target, c.cells, c.cut ? null : { r: c.src.r1, c: c.src.c1 });
      next = M.withTab(d, g.ti, out.tab);
      landed = out.range;
      if (c.cut) {
        const si = next.sheets.findIndex((t) => t.id === c.tab);
        if (si >= 0) next = M.withTab(next, si, M.clearCutSource(next.sheets[si]!, c.src, si === g.ti ? landed : null));
      }
    } else {
      const rows = parseGrid(text);
      if (!rows.length || (rows.length === 1 && rows[0]!.length === 1 && rows[0]![0] === '' && !text)) return;
      const out = M.pasteText(g.tab, target, rows);
      next = M.withTab(d, g.ti, out.tab);
      landed = out.range;
    }
    if (commit(next)) {
      if (c?.cut) setClip(null);
      select(M.selOf(landed, g.sel.a));
    }
  };

  const copyToSystem = (cut: boolean) => {
    const c = makeClip(cut);
    if (!c) return;
    setClip(c);
    void navigator.clipboard?.writeText(c.text).catch(() => undefined);
  };
  const pasteFromSystem = () => {
    const fallback = () => (st.current.clip ? pasteFrom(st.current.clip.text) : notify('info', 'Press Ctrl+V to paste here.'));
    if (!navigator.clipboard?.readText) return fallback();
    navigator.clipboard.readText().then(pasteFrom, fallback);
  };

  // ---- rows, columns, sorting, sizes

  const lines = (axis: 'rows' | 'cols', where: 'before' | 'after' | 'delete') => {
    const g = st.current;
    const rg = M.rangeOf(g.sel);
    const lo = axis === 'rows' ? rg.r1 : rg.c1;
    const hi = Math.min(axis === 'rows' ? rg.r2 : rg.c2, (axis === 'rows' ? g.nrows : g.ncols) - 1);
    const count = hi - lo + 1;
    const at = where === 'after' ? hi + 1 : lo;
    const next = M.editLines(dataRef.current, g.ti, axis, at, count, where === 'delete');
    if (!next) {
      notify('warn', `There is no room to insert: the last ${axis === 'rows' ? 'rows' : 'columns'} of the sheet hold data.`);
      return;
    }
    if (!commit(next)) return;
    if (where === 'delete') select(M.single(M.clampPos({ r: axis === 'rows' ? lo : g.sel.a.r, c: axis === 'cols' ? lo : g.sel.a.c })));
    else {
      grow(g.tab.id, axis === 'rows' ? g.nrows + count : 0, axis === 'cols' ? g.ncols + count : 0);
      select(axis === 'rows' ? { a: { r: at, c: 0 }, f: { r: at + count - 1, c: MAX_COLS - 1 } } : { a: { r: 0, c: at }, f: { r: MAX_ROWS - 1, c: at + count - 1 } });
    }
  };

  const sortSel = (desc: boolean) => {
    const g = st.current;
    let rg: Range | null = M.rangeOf(g.sel);
    if (M.isOneCell(rg)) rg = M.dataRegion(has, g.sel.a);
    else if (M.isWholeCols(rg) || M.isWholeRows(rg)) rg = M.clipToUsed(g.tab, rg);
    if (!rg || rg.r1 === rg.r2) return;
    const header = (g.tab.freeze?.r ?? 0) === 1 && rg.r1 === 0;
    const col = clamp(g.sel.a.c, rg.c1, rg.c2);
    const next = M.sortRange(g.tab, rg, col, desc, header, valueAt);
    if (next !== g.tab && commitTab(next)) select(M.selOf(rg, g.sel.a));
  };

  const cellFont = (s?: SheetCellStyle): string => `${s?.i ? 'italic ' : ''}${s?.b ? 600 : 400} 12.5px ${font}`;
  const autofit = (c: number) => {
    const g = st.current;
    const widths = M.cellsIn(g.tab, M.wholeCols(c, c)).map(({ r, cell }) =>
      textWidth(formatValue(valueAt(r, c), cell.s).split('\n')[0]!, cellFont(cell.s)),
    );
    commitTab(M.setColWidth(g.tab, c, widths.length ? M.fitWidth(widths) : M.DEFAULT_COL_W));
  };

  const freeze = (r: number, c: number) => commitTab(M.setFreeze(st.current.tab, r, c));

  const exportCsv = () => {
    const g = st.current;
    const u = M.usedSize(g.tab, false);
    const rows: string[][] = [];
    for (let r = 0; r < u.rows; r++) {
      const row: string[] = [];
      for (let c = 0; c < u.cols; c++) {
        const v = valueAt(r, c);
        const s = g.tab.cells[cellKey(r, c)]?.s;
        // Numbers at full precision; a date as a date; everything else as shown.
        row.push(typeof v === 'number' && s?.fmt !== 'date' ? String(v) : formatValue(v, s?.fmt === 'date' ? s : undefined));
      }
      rows.push(row);
    }
    const name = fileSafe(item.title) || 'sheet';
    const tabPart = dataRef.current.sheets.length > 1 ? ` - ${fileSafe(g.tab.name)}` : '';
    saveBlob(new Blob(['﻿', toCsv(rows.length ? rows : [['']])], { type: 'text/csv;charset=utf-8' }), `${name}${tabPart}.csv`);
  };

  // ---- the pointer on the grid

  const hit = (x: number, y: number): Hit => {
    const el = scroller.current!;
    const g = st.current;
    const rect = el.getBoundingClientRect();
    const vx = x - rect.left, vy = y - rect.top;
    const cx = vx >= HEAD_W && vx < HEAD_W + g.frozenW ? vx - HEAD_W : vx - HEAD_W + el.scrollLeft;
    const cy = vy >= HEAD_H && vy < HEAD_H + g.frozenH ? vy - HEAD_H : vy - HEAD_H + el.scrollTop;
    const r = clamp(indexAt(g.rowY, g.nrows, cy), 0, g.nrows - 1);
    const c = clamp(indexAt(g.colX, g.ncols, cx), 0, g.ncols - 1);
    const zone = vx < HEAD_W && vy < HEAD_H ? 'corner' : vy < HEAD_H && vy >= 0 ? 'colhead' : vx < HEAD_W && vx >= 0 ? 'rowhead' : 'cell';
    return { r, c, zone };
  };

  const dragTo = (x: number, y: number) => {
    const d = drag.current;
    if (!d) return;
    const h = hit(x, y);
    switch (d.kind) {
      case 'cells':
        setSel({ a: d.anchor, f: { r: h.r, c: h.c } });
        break;
      case 'cols':
        setSel({ a: { r: 0, c: d.anchor }, f: { r: MAX_ROWS - 1, c: h.c } });
        break;
      case 'rows':
        setSel({ a: { r: d.anchor, c: 0 }, f: { r: h.r, c: MAX_COLS - 1 } });
        break;
      case 'point':
        pointAt(M.rangeOf({ a: d.anchor, f: { r: h.r, c: h.c } }));
        break;
      case 'fill':
        setFillTo(M.fillTarget(d.src, { r: h.r, c: h.c }));
        break;
      case 'size': {
        const lo = d.axis === 'col' ? M.COL_W.min : M.ROW_H.min;
        const hi = d.axis === 'col' ? M.COL_W.max : M.ROW_H.max;
        setResize({ axis: d.axis, i: d.i, size: Math.round(clamp(d.from + (d.axis === 'col' ? x : y) - d.start, lo, hi)) });
        break;
      }
    }
  };

  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const g = st.current;
    if (d.kind === 'fill') {
      const to = g.fillTo;
      setFillTo(null);
      if (to && !M.sameRange(to, d.src) && commitTab(M.fillRange(g.tab, d.src, to))) select(M.selOf(to, g.sel.a));
    } else if (d.kind === 'size') {
      setResize((rz) => {
        if (rz) {
          const t = st.current.tab;
          commitTab(rz.axis === 'col' ? M.setColWidth(t, rz.i, rz.size) : M.setRowHeight(t, rz.i, rz.size));
        }
        return null;
      });
    }
  };

  /** Runs a drag until the button is released, scrolling when the pointer leaves the grid. */
  const startDrag = (d: Drag, x0: number, y0: number) => {
    drag.current = d;
    let x = x0, y = y0;
    let raf = 0;
    const tick = () => {
      raf = 0;
      const el = scroller.current;
      if (!el || !drag.current || drag.current.kind === 'size') return;
      const rect = el.getBoundingClientRect();
      const speed = (out: number): number => Math.sign(out) * Math.min(40, 4 + Math.abs(out) / 2);
      const dx = x < rect.left + HEAD_W ? speed(x - rect.left - HEAD_W) : x > rect.right ? speed(x - rect.right) : 0;
      const dy = y < rect.top + HEAD_H ? speed(y - rect.top - HEAD_H) : y > rect.bottom ? speed(y - rect.bottom) : 0;
      if (dx || dy) {
        el.scrollBy(dx, dy);
        dragTo(x, y);
        raf = requestAnimationFrame(tick);
      }
    };
    const move = (ev: PointerEvent) => {
      x = ev.clientX;
      y = ev.clientY;
      dragTo(x, y);
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (raf) cancelAnimationFrame(raf);
      endDrag();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const tap = useRef<{ x: number; y: number } | null>(null);

  const onGridPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.button !== 0 || t.closest('[data-k="editor"],[data-k="more"]')) return;
    if (e.pointerType === 'touch') {
      tap.current = { x: e.clientX, y: e.clientY };
      return;
    }
    const g = st.current;
    const k = t.closest<HTMLElement>('[data-k]')?.dataset.k;
    const idx = Number(t.closest<HTMLElement>('[data-i]')?.dataset.i ?? -1);
    if (k === 'colsize' || k === 'rowsize') {
      const axis = k === 'colsize' ? 'col' : 'row';
      const from = axis === 'col' ? g.colX[idx + 1]! - g.colX[idx]! : g.rowY[idx + 1]! - g.rowY[idx]!;
      setResize({ axis, i: idx, size: from });
      startDrag({ kind: 'size', axis, i: idx, start: axis === 'col' ? e.clientX : e.clientY, from }, e.clientX, e.clientY);
      return;
    }
    if (k === 'fill') {
      const src = M.rangeOf(g.sel);
      setFillTo(src);
      startDrag({ kind: 'fill', src }, e.clientX, e.clientY);
      return;
    }
    const h = hit(e.clientX, e.clientY);
    const ed = g.edit;
    if (ed && h.zone === 'cell' && pointable(ed)) {
      pointAt(M.rangeOf(M.single(h)));
      startDrag({ kind: 'point', anchor: { r: h.r, c: h.c } }, e.clientX, e.clientY);
      return;
    }
    if (ed) commitEdit(null);
    focusGrid();
    if (h.zone === 'corner') {
      select({ a: { r: 0, c: 0 }, f: { r: MAX_ROWS - 1, c: MAX_COLS - 1 } });
      return;
    }
    if (h.zone === 'colhead') {
      const anchor = e.shiftKey ? g.sel.a.c : h.c;
      select({ a: { r: 0, c: anchor }, f: { r: MAX_ROWS - 1, c: h.c } });
      startDrag({ kind: 'cols', anchor }, e.clientX, e.clientY);
      return;
    }
    if (h.zone === 'rowhead') {
      const anchor = e.shiftKey ? g.sel.a.r : h.r;
      select({ a: { r: anchor, c: 0 }, f: { r: h.r, c: MAX_COLS - 1 } });
      startDrag({ kind: 'rows', anchor }, e.clientX, e.clientY);
      return;
    }
    const anchor = e.shiftKey ? g.sel.a : { r: h.r, c: h.c };
    select({ a: anchor, f: { r: h.r, c: h.c } });
    startDrag({ kind: 'cells', anchor }, e.clientX, e.clientY);
  };

  // A tap selects; a tap on the active cell edits it (touch scrolls instead of dragging).
  const onGridPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const t0 = tap.current;
    tap.current = null;
    if (!t0 || e.pointerType !== 'touch' || Math.hypot(e.clientX - t0.x, e.clientY - t0.y) > 8) return;
    const g = st.current;
    const h = hit(e.clientX, e.clientY);
    if (g.edit) {
      if (h.zone === 'cell' && pointable(g.edit)) return pointAt(M.rangeOf(M.single(h)));
      commitEdit(null);
    }
    if (h.zone === 'colhead') return select({ a: { r: 0, c: h.c }, f: { r: MAX_ROWS - 1, c: h.c } });
    if (h.zone === 'rowhead') return select({ a: { r: h.r, c: 0 }, f: { r: h.r, c: MAX_COLS - 1 } });
    if (h.zone === 'corner') return;
    if (M.isOneCell(M.rangeOf(g.sel)) && g.sel.a.r === h.r && g.sel.a.c === h.c) startEdit(h, null);
    else select(M.single(h));
  };

  const onGridDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-k="editor"],[data-k="more"]')) return;
    const k = t.closest<HTMLElement>('[data-k]')?.dataset.k;
    const idx = Number(t.closest<HTMLElement>('[data-i]')?.dataset.i ?? -1);
    if (k === 'colsize') return autofit(idx);
    if (k === 'rowsize') return void commitTab(M.setRowHeight(st.current.tab, idx, M.DEFAULT_ROW_H));
    const h = hit(e.clientX, e.clientY);
    if (h.zone === 'cell' && !st.current.edit) startEdit(h, null);
  };

  const onGridContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-k="editor"]')) return;
    const at = menuAt(e);
    const g = st.current;
    if (g.edit) commitEdit(null);
    const h = hit(e.clientX, e.clientY);
    const rg = M.rangeOf(g.sel);
    if (h.zone === 'colhead' && !(M.isWholeCols(rg) && h.c >= rg.c1 && h.c <= rg.c2)) select({ a: { r: 0, c: h.c }, f: { r: MAX_ROWS - 1, c: h.c } });
    else if (h.zone === 'rowhead' && !(M.isWholeRows(rg) && h.r >= rg.r1 && h.r <= rg.r2)) select({ a: { r: h.r, c: 0 }, f: { r: h.r, c: MAX_COLS - 1 } });
    else if (h.zone === 'cell' && !M.inRange(rg, h.r, h.c)) select(M.single(h));
    focusGrid();
    // The menu reads the selection when an item runs, so it can be built now.
    setTimeout(() => setMenu({ at, items: gridMenu(h.zone) }), 0);
  };

  const gridMenu = (zone: Hit['zone']): TabMenuItem[] => {
    const rg = M.rangeOf(st.current.sel);
    const nr = Math.min(rg.r2, st.current.nrows - 1) - rg.r1 + 1;
    const nc = Math.min(rg.c2, st.current.ncols - 1) - rg.c1 + 1;
    const rowItems: TabMenuItem[] = [
      { label: nr > 1 ? `Insert ${nr} rows above` : 'Insert row above', icon: MENU_ICONS.up, onClick: () => lines('rows', 'before') },
      { label: nr > 1 ? `Insert ${nr} rows below` : 'Insert row below', icon: MENU_ICONS.down, onClick: () => lines('rows', 'after') },
    ];
    const colItems: TabMenuItem[] = [
      { label: nc > 1 ? `Insert ${nc} columns left` : 'Insert column left', icon: MENU_ICONS.add, onClick: () => lines('cols', 'before') },
      { label: nc > 1 ? `Insert ${nc} columns right` : 'Insert column right', icon: MENU_ICONS.add, onClick: () => lines('cols', 'after') },
    ];
    const delRows: TabMenuItem = { label: nr > 1 ? `Delete ${nr} rows` : 'Delete row', icon: MENU_ICONS.remove, danger: true, onClick: () => lines('rows', 'delete') };
    const delCols: TabMenuItem = { label: nc > 1 ? `Delete ${nc} columns` : 'Delete column', icon: MENU_ICONS.remove, danger: true, onClick: () => lines('cols', 'delete') };
    const common: TabMenuItem[] = [
      { label: 'Cut', icon: I.cut, onClick: () => copyToSystem(true) },
      { label: 'Copy', icon: MENU_ICONS.duplicate, onClick: () => copyToSystem(false) },
      { label: 'Paste', icon: I.paste, onClick: pasteFromSystem },
      { label: 'Sort A → Z', icon: I.sortAsc, onClick: () => sortSel(false) },
      { label: 'Sort Z → A', icon: I.sortDesc, onClick: () => sortSel(true) },
      { label: 'Clear contents', icon: I.clear, onClick: () => commitTab(M.clearValues(st.current.tab, M.rangeOf(st.current.sel))) },
    ];
    if (zone === 'colhead') return [...common, ...colItems, delCols];
    if (zone === 'rowhead') return [...common, ...rowItems, delRows];
    return [...common, ...rowItems, ...colItems, delRows, delCols];
  };

  // ---- tabs

  const tabMenu = (i: number, at: { x: number; y: number }) => {
    const d = dataRef.current;
    setMenu({
      at,
      items: [
        { label: 'Rename', icon: MENU_ICONS.rename, onClick: () => setRenaming(i) },
        { label: 'Duplicate', icon: MENU_ICONS.duplicate, disabled: d.sheets.length >= SHEET_MAX.sheets, onClick: () => {
          const next = M.duplicateTab(dataRef.current, i);
          if (next) commit(next);
          else notify('warn', 'There is no room for a copy of this tab.');
        } },
        { label: 'Move left', icon: MENU_ICONS.up, disabled: i === 0, onClick: () => commit(M.moveTab(dataRef.current, i, -1)) },
        { label: 'Move right', icon: MENU_ICONS.down, disabled: i === d.sheets.length - 1, onClick: () => commit(M.moveTab(dataRef.current, i, 1)) },
        { label: 'Delete tab', icon: MENU_ICONS.remove, danger: true, disabled: d.sheets.length <= 1, onClick: () => {
          const next = M.deleteTab(dataRef.current, i);
          if (next) commit(next);
        } },
      ],
    });
  };

  const addTab = () => {
    if (st.current.edit) commitEdit(null);
    const next = M.addTab(dataRef.current);
    if (next) commit(next);
  };

  const rename = (i: number, name: string | null) => {
    setRenaming(null);
    if (name === null) return;
    const next = M.renameTab(dataRef.current, i, name);
    if (typeof next === 'string') notify('warn', next);
    else commit(next);
  };

  // ---- the status line: sum, average and count of a range

  const stats = useMemo(() => {
    if (M.isOneCell(range)) return null;
    let sum = 0, nums = 0, count = 0;
    const take = (v: CellValue | undefined) => {
      if (v === undefined || v === null || v === '') return;
      count++;
      if (typeof v === 'number') {
        sum += v;
        nums++;
      }
    };
    if (M.areaOf(range) <= tabVals.size) {
      for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) take(tabVals.get(cellKey(r, c)));
    } else {
      for (const [k, v] of tabVals) {
        const p = parseKey(k);
        if (p && M.inRange(range, p.r, p.c)) take(v);
      }
    }
    return { sum, avg: nums ? sum / nums : null, count, nums };
  }, [range.r1, range.r2, range.c1, range.c2, tabVals]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- drawing

  const bodyRows: [number, number] = [Math.max(fr, win.r0), Math.min(nrows - 1, win.r1)];
  const bodyCols: [number, number] = [Math.max(fc, win.c0), Math.min(ncols - 1, win.c1)];
  const topRows: [number, number] = [0, fr - 1];
  const leftCols: [number, number] = [0, fc - 1];

  /** One pane's gridlines and cells (memoized: selection and editing do not redraw them). */
  const paneCells = (rr: [number, number], cc: [number, number], dx: number, dy: number): ReactNode => {
    if (rr[0] > rr[1] || cc[0] > cc[1]) return null;
    const out: ReactNode[] = [];
    const top = rowY[rr[0]]! + dy, bottom = rowY[rr[1] + 1]! + dy;
    const left = colX[cc[0]]! + dx, right = colX[cc[1] + 1]! + dx;
    for (let c = cc[0]; c <= cc[1]; c++) out.push(<i key={`v${c}`} className="ks-vl" style={{ left: colX[c + 1]! + dx - 1, top, height: bottom - top }} />);
    for (let r = rr[0]; r <= rr[1]; r++) out.push(<i key={`h${r}`} className="ks-hl" style={{ top: rowY[r + 1]! + dy - 1, left, width: right - left }} />);
    for (let r = rr[0]; r <= rr[1]; r++) {
      const y = rowY[r]! + dy, h = rowY[r + 1]! - rowY[r]!;
      for (let c = cc[0]; c <= cc[1]; c++) {
        const key = cellKey(r, c);
        const cell = tab.cells[key];
        if (!cell) continue;
        const s = cell.s;
        const v = tabVals.get(key) ?? null;
        const text = cell.v ? formatValue(v, s) : '';
        if (!text && !s?.bg) continue;
        const kind = typeof v === 'number' ? 'num' : isError(v) ? 'err' : typeof v === 'boolean' ? 'bool' : 'text';
        const al = s?.al ?? (kind === 'num' ? 'r' : kind === 'text' ? 'l' : 'c');
        const w = colX[c + 1]! - colX[c]!;
        // Left-aligned text runs on over empty cells to its right, as in a spreadsheet.
        let spill = 0;
        if (kind === 'text' && al === 'l' && !s?.wrap && text) {
          const need = textWidth(text.split('\n')[0]!, cellFont(s)) + 10 - w;
          for (let k = c + 1; need > spill && k < ncols && k < c + 30 && !tab.cells[cellKey(r, k)]; k++) spill += colX[k + 1]! - colX[k]!;
          spill = Math.min(spill, Math.max(0, need));
        }
        const style: CSSProperties = { left: colX[c]! + dx, top: y, width: w + spill, height: h };
        if (s?.bg) style.background = s.bg;
        if (s?.fg && kind !== 'err') style.color = s.fg;
        if (s?.b) style.fontWeight = 600;
        if (s?.i) style.fontStyle = 'italic';
        if (s?.u || s?.s) style.textDecoration = `${s.u ? 'underline' : ''} ${s.s ? 'line-through' : ''}`.trim();
        out.push(
          <div key={key} className={`ks-c ks-c--${kind} is-${al}${s?.wrap ? ' is-wrap' : ''}${spill ? ' is-spill' : ''}`} style={style}>
            {text}
          </div>,
        );
      }
    }
    return out;
  };

  const cellsBody = useMemo(() => paneCells(bodyRows, bodyCols, HEAD_W, HEAD_H),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.cells, tabVals, colX, rowY, bodyRows[0], bodyRows[1], bodyCols[0], bodyCols[1], font]);
  const cellsTop = useMemo(() => paneCells(topRows, bodyCols, HEAD_W, HEAD_H),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.cells, tabVals, colX, rowY, fr, bodyCols[0], bodyCols[1], font]);
  const cellsLeft = useMemo(() => paneCells(bodyRows, leftCols, HEAD_W, -frozenH),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.cells, tabVals, colX, rowY, fc, frozenH, bodyRows[0], bodyRows[1], font]);
  const cellsCorner = useMemo(() => paneCells(topRows, leftCols, HEAD_W, HEAD_H),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.cells, tabVals, colX, rowY, fr, fc, font]);

  /** A range's box within a pane, with the edges that are its own (not the pane's cut). */
  const boxIn = (rg: Range, rr: [number, number], cc: [number, number], dx: number, dy: number) => {
    const r1 = Math.max(rg.r1, rr[0]), r2 = Math.min(rg.r2, rr[1]);
    const c1 = Math.max(rg.c1, cc[0]), c2 = Math.min(rg.c2, cc[1]);
    if (r1 > r2 || c1 > c2) return null;
    return {
      style: { left: colX[c1]! + dx, top: rowY[r1]! + dy, width: colX[c2 + 1]! - colX[c1]!, height: rowY[r2 + 1]! - rowY[r1]! } as CSSProperties,
      edges: `${rg.r1 === r1 ? ' t' : ''}${rg.r2 === r2 ? ' b' : ''}${rg.c1 === c1 ? ' l' : ''}${rg.c2 === c2 ? ' r' : ''}`,
      corner: rg.r2 === r2 && rg.c2 === c2,
    };
  };

  /** One pane's selection, references being edited, fill preview, copy outline and the cell editor. */
  const paneMarks = (paneRows: [number, number], paneCols: [number, number], rr: [number, number], cc: [number, number], dx: number, dy: number): ReactNode => {
    if (paneRows[0] > paneRows[1] || paneCols[0] > paneCols[1]) return null;
    const out: ReactNode[] = [];
    const editing = edit && edit.tab === ti;
    if (editing) {
      editRefs.forEach((rf, i) => {
        if (rf.sheet !== null && rf.sheet.toLowerCase() !== tab.name.toLowerCase()) return;
        const b = boxIn({ r1: rf.r1, c1: rf.c1, r2: Math.min(rf.r2, nrows - 1), c2: Math.min(rf.c2, ncols - 1) }, rr, cc, dx, dy);
        if (b) out.push(<div key={`ref${i}`} className={`ks-ref${b.edges}`} style={{ ...b.style, '--ref': rf.color } as CSSProperties} />);
      });
    }
    const sb = boxIn(range, rr, cc, dx, dy);
    if (sb && !M.isOneCell(range)) out.push(<div key="sel" className={`ks-sel${sb.edges}`} style={sb.style} />);
    const ab = boxIn(M.single(sel.a) && { r1: sel.a.r, c1: sel.a.c, r2: sel.a.r, c2: sel.a.c }, rr, cc, dx, dy);
    if (ab && !editing) out.push(<div key="act" className="ks-active" style={ab.style} />);
    if (sb?.corner && !edit && !fillTo && !M.isWholeCols(range) && !M.isWholeRows(range)) {
      const s = sb.style as { left: number; top: number; width: number; height: number };
      out.push(<span key="fill" className="ks-fillh" data-k="fill" style={{ left: s.left + s.width - 4, top: s.top + s.height - 4 }} />);
    }
    if (fillTo) {
      const fb = boxIn(fillTo, rr, cc, dx, dy);
      if (fb) out.push(<div key="fillto" className={`ks-fillto${fb.edges}`} style={fb.style} />);
    }
    if (clip && clip.tab === tab.id) {
      const cb = boxIn(clip.src, rr, cc, dx, dy);
      if (cb) out.push(<div key="clip" className={`ks-clip${cb.edges}`} style={cb.style} />);
    }
    if (editing && edit.r >= paneRows[0] && edit.r <= paneRows[1] && edit.c >= paneCols[0] && edit.c <= paneCols[1]) {
      const w = colX[edit.c + 1]! - colX[edit.c]!, h = rowY[edit.r + 1]! - rowY[edit.r]!;
      const s = tab.cells[cellKey(edit.r, edit.c)]?.s;
      out.push(
        <div
          key="editor"
          data-k="editor"
          className="ks-editor"
          style={{ left: colX[edit.c]! + dx, top: rowY[edit.r]! + dy, minWidth: w + 1, minHeight: h + 1, maxWidth: Math.max(w + 1, 620) }}
        >
          <FormulaField
            fieldRef={cellField}
            edit={edit}
            refs={editRefs}
            className={`ks-ff--cell${s?.b ? ' is-b' : ''}${s?.i ? ' is-i' : ''}`}
            label={`Edit ${cellKey(edit.r, edit.c)}`}
            autoFocus={edit.where === 'cell'}
            onChange={(text, caret) => updateEdit({ text, caret, point: null, acOff: false, ac: 0 })}
            onCaret={moveCaret}
            onKeyDown={onEditKey}
            onBlur={onEditBlur}
            onFocus={() => edit.where !== 'cell' && updateEdit({ where: 'cell' })}
          />
          {edit.where === 'cell' && <Assist ac={ac} index={edit.ac} call={call} onPick={insertFunction} />}
        </div>,
      );
    }
    return out;
  };

  const marksBody = paneMarks([fr, nrows - 1], [fc, ncols - 1], bodyRows, bodyCols, HEAD_W, HEAD_H);
  const marksTop = paneMarks([0, fr - 1], [fc, ncols - 1], topRows, bodyCols, HEAD_W, HEAD_H);
  const marksLeft = paneMarks([fr, nrows - 1], [0, fc - 1], bodyRows, leftCols, HEAD_W, -frozenH);
  const marksCorner = paneMarks([0, fr - 1], [0, fc - 1], topRows, leftCols, HEAD_W, HEAD_H);

  const colHead = (c: number): ReactNode => {
    const on = c >= range.c1 && c <= range.c2;
    const all = on && M.isWholeCols(range);
    return (
      <div key={`ch${c}`} className={`ks-ch${on ? ' is-sel' : ''}${all ? ' is-all' : ''}`} style={{ left: HEAD_W + colX[c]!, width: colX[c + 1]! - colX[c]! }}>
        {colName(c)}
        <span className="ks-ch__size" data-k="colsize" data-i={c} title="Drag to resize, double-click to fit" />
      </div>
    );
  };
  const rowHead = (r: number, dy: number): ReactNode => {
    const on = r >= range.r1 && r <= range.r2;
    const all = on && M.isWholeRows(range);
    return (
      <div key={`rh${r}`} className={`ks-rh${on ? ' is-sel' : ''}${all ? ' is-all' : ''}`} style={{ top: rowY[r]! + dy, height: rowY[r + 1]! - rowY[r]! }}>
        {r + 1}
        <span className="ks-rh__size" data-k="rowsize" data-i={r} title="Drag to resize, double-click to reset" />
      </div>
    );
  };
  const heads = (from: number, to: number, make: (i: number) => ReactNode): ReactNode[] => {
    const out: ReactNode[] = [];
    for (let i = from; i <= to; i++) out.push(make(i));
    return out;
  };

  // ---- the formula bar

  const activeRaw = tab.cells[cellKey(sel.a.r, sel.a.c)]?.v ?? '';
  const barEdit: Edit = edit ?? { tab: ti, r: sel.a.r, c: sel.a.c, text: activeRaw, orig: activeRaw, caret: activeRaw.length, mode: 'edit', where: 'cell', point: null, ac: 0, acOff: true, sync: 0 };
  const barRefs = edit ? editRefs : [];

  const goName = (text: string) => {
    setNameBox(null);
    const rg = M.parseRangeInput(text);
    if (!rg) {
      if (text.trim()) notify('warn', `"${text.trim().slice(0, 20)}" is not a cell or a range here.`);
      focusGrid();
      return;
    }
    select(M.selOf(rg), true);
    focusGrid();
  };

  // ---- toolbar pieces

  const btn = (label: string, icon: ReactNode, on: boolean, run: () => void, disabled = false) => (
    <button type="button" className={`ks-tool${on ? ' is-on' : ''}`} aria-label={label} title={label} aria-pressed={on} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {icon}
    </button>
  );
  const freezeMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const g = st.current;
    setMenu({
      at: { x: r.left, y: r.bottom + 4 },
      items: [
        { label: 'Freeze first row', icon: MENU_ICONS.lock, onClick: () => freeze(1, g.tab.freeze?.c ?? 0) },
        { label: 'Freeze first column', icon: MENU_ICONS.lock, onClick: () => freeze(g.tab.freeze?.r ?? 0, 1) },
        { label: `Freeze up to ${cellKey(g.sel.a.r, g.sel.a.c)}`, icon: MENU_ICONS.lock, disabled: g.sel.a.r > M.FREEZE_MAX.r || g.sel.a.c > M.FREEZE_MAX.c || (g.sel.a.r === 0 && g.sel.a.c === 0), onClick: () => freeze(g.sel.a.r, g.sel.a.c) },
        { label: 'Unfreeze', icon: MENU_ICONS.unlock, disabled: !g.tab.freeze, onClick: () => freeze(0, 0) },
      ],
    });
  };

  const fmtValue = activeStyle.fmt ?? '';
  const statText = stats
    ? stats.count
      ? [stats.nums ? `Sum ${formatValue(stats.sum, { fmt: 'num' })}` : '', stats.avg !== null ? `Average ${formatValue(stats.avg, { fmt: 'num' })}` : '', `Count ${stats.count}`].filter(Boolean).join('  ·  ')
      : ''
    : '';
  const canvasW = HEAD_W + totalW + (ncols < MAX_COLS ? 60 : 0);

  return (
    <div className="ks">
      <div className="ks-bar" role="toolbar" aria-label="Sheet tools">
        {btn('Undo (Ctrl+Z)', I.undo, false, undo, !history.current.past.length)}
        {btn('Redo (Ctrl+Y)', I.redo, false, redo, !history.current.future.length)}
        <span className="ks-sep" />
        <select className="ks-select" aria-label="Number format" title="Number format" value={fmtValue} onChange={(e) => { setFormat(e.target.value as SheetCellStyle['fmt'] | ''); focusGrid(); }}>
          {FORMATS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
        </select>
        <button type="button" className="ks-tool ks-tool--text" aria-label="Fewer decimals" title="Fewer decimals" onMouseDown={(e) => e.preventDefault()} onClick={() => decimals(-1)}>.0<small>−</small></button>
        <button type="button" className="ks-tool ks-tool--text" aria-label="More decimals" title="More decimals" onMouseDown={(e) => e.preventDefault()} onClick={() => decimals(1)}>.00<small>+</small></button>
        <span className="ks-sep" />
        {btn('Bold (Ctrl+B)', I.bold, !!activeStyle.b, () => toggleMark('b'))}
        {btn('Italic (Ctrl+I)', I.italic, !!activeStyle.i, () => toggleMark('i'))}
        {btn('Underline (Ctrl+U)', I.underline, !!activeStyle.u, () => toggleMark('u'))}
        {btn('Strikethrough', I.strike, !!activeStyle.s, () => toggleMark('s'))}
        <Swatches label="Text color" icon={I.color} colors={TEXT_COLORS} current={activeStyle.fg} onPick={(c) => styleSel((s) => ({ ...s, fg: c ?? undefined }))} />
        <Swatches label="Fill color" icon={I.fill} colors={FILLS} current={activeStyle.bg} onPick={(c) => styleSel((s) => ({ ...s, bg: c ?? undefined }))} />
        <span className="ks-sep" />
        {btn('Align left', I.left, activeStyle.al === 'l', () => setAlign('l'))}
        {btn('Align center', I.center, activeStyle.al === 'c', () => setAlign('c'))}
        {btn('Align right', I.right, activeStyle.al === 'r', () => setAlign('r'))}
        {btn('Wrap text', I.wrap, !!activeStyle.wrap, () => styleSel((s) => ({ ...s, wrap: activeStyle.wrap ? undefined : true })))}
        {btn('Clear formatting', I.eraser, false, () => commitTab(M.clearFormats(st.current.tab, M.rangeOf(st.current.sel))))}
        <span className="ks-sep" />
        {btn('Sort A → Z by this column', I.sortAsc, false, () => sortSel(false))}
        {btn('Sort Z → A by this column', I.sortDesc, false, () => sortSel(true))}
        <button type="button" className={`ks-tool${tab.freeze ? ' is-on' : ''}`} aria-label="Freeze rows and columns" title="View: freeze rows and columns" onMouseDown={(e) => e.preventDefault()} onClick={(e) => freezeMenu(e.currentTarget)}>
          {I.freeze}
        </button>
        <span className="ks-fill" />
        {btn('Download this tab as CSV', I.download, false, exportCsv)}
      </div>

      <div className="ks-fx">
        <input
          className="ks-name"
          aria-label="Name box: the selected cell or range; type one and press Enter to go there"
          value={nameBox ?? selLabel(range)}
          spellCheck={false}
          onFocus={(e) => { setNameBox(selLabel(range)); e.currentTarget.select(); }}
          onChange={(e) => setNameBox(e.target.value)}
          onBlur={() => setNameBox(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); goName(e.currentTarget.value); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNameBox(null); focusGrid(); }
          }}
        />
        <span className="ks-fx__label" aria-hidden="true">fx</span>
        <div className="ks-fx__field">
          <FormulaField
            fieldRef={barField}
            edit={barEdit}
            refs={barRefs}
            className="ks-ff--bar"
            label={`Contents of ${cellKey(sel.a.r, sel.a.c)}`}
            autoFocus={false}
            onFocus={() => {
              if (!st.current.edit) startEdit(st.current.sel.a, null, 'bar');
              else if (st.current.edit.where !== 'bar') updateEdit({ where: 'bar' });
            }}
            onChange={(text, caret) => updateEdit({ text, caret, point: null, acOff: false, ac: 0 })}
            onCaret={moveCaret}
            onKeyDown={onEditKey}
            onBlur={onEditBlur}
          />
          {edit?.where === 'bar' && <Assist ac={ac} index={edit.ac} call={call} onPick={insertFunction} />}
        </div>
      </div>

      <ConflictBar
        status={save.status}
        message={save.message}
        onKeep={save.keepMine}
        onLoad={() =>
          void save.loadTheirs().then((fresh) => {
            if (!fresh) return;
            const d = M.loadData(fresh.data);
            dataRef.current = d;
            history.current = { past: [], future: [] };
            setEdit(null);
            setClip(null);
            setData(d);
          })
        }
      />

      <div className="ks-grid">
        <textarea
          ref={keys}
          className="ks-keys"
          aria-label={`Sheet ${tab.name}, ${selLabel(range)}${activeRaw ? `: ${formatValue(tabVals.get(cellKey(sel.a.r, sel.a.c)) ?? null, activeStyle)}` : ''}`}
          value=""
          onChange={(e) => {
            // Text that arrives without a key press (a phone keyboard, an IME, dictation) starts editing too.
            const text = e.target.value;
            if (text && !(e.nativeEvent as InputEvent).isComposing) startEdit(st.current.sel.a, text);
          }}
          onCompositionEnd={(e) => {
            if (e.data) startEdit(st.current.sel.a, e.data);
          }}
          onKeyDown={onGridKey}
          onCopy={(e) => {
            e.preventDefault();
            const c = makeClip(false);
            if (c) { e.clipboardData.setData('text/plain', c.text); setClip(c); }
          }}
          onCut={(e) => {
            e.preventDefault();
            const c = makeClip(true);
            if (c) { e.clipboardData.setData('text/plain', c.text); setClip(c); }
          }}
          onPaste={(e) => {
            e.preventDefault();
            pasteFrom(e.clipboardData.getData('text/plain'));
          }}
        />
        <div
          className="ks-scroll"
          ref={scroller}
          onScroll={computeWin}
          onPointerDown={onGridPointerDown}
          onPointerUp={onGridPointerUp}
          onMouseDown={(e) => {
            // The grid keeps the keyboard (or the formula being written keeps it while pointing).
            if (!(e.target as HTMLElement).closest('[data-k="editor"]')) e.preventDefault();
          }}
          onDoubleClick={onGridDoubleClick}
          onContextMenu={onGridContextMenu}
        >
          <div className="ks-canvas" style={{ width: canvasW }}>
            <div className={`ks-top${fr ? ' is-frozen' : ''}`} style={{ height: HEAD_H + frozenH }}>
              <div className={`ks-top__left${fc ? ' is-frozen' : ''}`} style={{ width: HEAD_W + frozenW, height: HEAD_H + frozenH }}>
                <div className="ks-corner" title="Select all" />
                {heads(0, fc - 1, colHead)}
                {heads(0, fr - 1, (r) => rowHead(r, HEAD_H))}
                {cellsCorner}
                {marksCorner}
              </div>
              {heads(bodyCols[0], bodyCols[1], colHead)}
              {cellsTop}
              {marksTop}
            </div>
            <div className={`ks-left${fc ? ' is-frozen' : ''}`} style={{ width: HEAD_W + frozenW, height: totalH - frozenH }}>
              {heads(bodyRows[0], bodyRows[1], (r) => rowHead(r, -frozenH))}
              {cellsLeft}
              {marksLeft}
            </div>
            <div className="ks-body">
              {cellsBody}
              {marksBody}
            </div>
            {nrows < MAX_ROWS && (
              <div className="ks-more" style={{ height: MORE_H }}>
                <div className="ks-more__in" data-k="more">
                  <button type="button" className="ks-more__btn" onClick={() => grow(tab.id, nrows + GROW_ROWS, 0)}>
                    Add {Math.min(GROW_ROWS, MAX_ROWS - nrows)} rows
                  </button>
                  <span className="ks-more__hint">{nrows.toLocaleString('en-US')} of {MAX_ROWS.toLocaleString('en-US')} rows</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="ks-foot">
        <div className="ks-tabs" role="tablist" aria-label="Tabs">
          {data.sheets.map((t, i) =>
            renaming === i ? (
              <TabName key={t.id} initial={t.name} onDone={(name) => rename(i, name)} />
            ) : (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={i === ti}
                className={`ks-tab${i === ti ? ' is-on' : ''}`}
                title={i === ti ? 'Double-click to rename, right-click for more' : t.name}
                onClick={() => switchTab(i)}
                onDoubleClick={() => setRenaming(i)}
                onContextMenu={(e) => tabMenu(i, menuAt(e))}
              >
                {t.name}
              </button>
            ),
          )}
          <button type="button" className="ks-tabadd" aria-label="Add a tab" title={data.sheets.length >= SHEET_MAX.sheets ? `A sheet has at most ${SHEET_MAX.sheets} tabs` : 'Add a tab'} disabled={data.sheets.length >= SHEET_MAX.sheets} onClick={addTab}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="ks-stat" aria-live="polite">{statText}</div>
      </footer>

      {menu && <TabMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ pieces

/**
 * The text being edited, over a copy of it in which each reference has its
 * colour: the field's own text is transparent, its caret and selection are not.
 */
function FormulaField({ fieldRef, edit, refs, className, label, autoFocus, onChange, onCaret, onKeyDown, onBlur, onFocus }: {
  fieldRef: RefObject<HTMLTextAreaElement>;
  edit: Edit;
  refs: Array<{ start: number; end: number; color: string }>;
  className: string;
  label: string;
  autoFocus: boolean;
  onChange: (text: string, caret: number) => void;
  onCaret: (caret: number, text: string) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur: () => void;
  onFocus?: () => void;
}) {
  const mirror = useRef<HTMLDivElement>(null);
  const sync = () => {
    const t = fieldRef.current, m = mirror.current;
    if (t && m) {
      m.scrollLeft = t.scrollLeft;
      m.scrollTop = t.scrollTop;
    }
  };
  useLayoutEffect(() => {
    const t = fieldRef.current;
    if (!t || !edit.sync) return;
    if (autoFocus && document.activeElement !== t) t.focus({ preventScroll: true });
    if (document.activeElement === t) t.setSelectionRange(edit.caret, edit.caret);
    sync();
    // Only when the text is set from outside (a new edit, a pointed reference, a picked function).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.sync, edit.r, edit.c]);

  const parts: ReactNode[] = [];
  let at = 0;
  for (const rf of refs) {
    if (rf.start < at) continue;
    if (rf.start > at) parts.push(edit.text.slice(at, rf.start));
    parts.push(<span key={rf.start} style={{ color: rf.color }}>{edit.text.slice(rf.start, rf.end)}</span>);
    at = rf.end;
  }
  parts.push(edit.text.slice(at));
  const lines = edit.text.split('\n').length;

  return (
    <div className={`ks-ff ${className}`} style={{ '--lines': Math.min(lines, 4) } as CSSProperties}>
      <div className="ks-ff__mirror" ref={mirror} aria-hidden="true">{parts}{'​'}</div>
      <textarea
        ref={fieldRef}
        className="ks-ff__input"
        aria-label={label}
        value={edit.text}
        rows={1}
        wrap="off"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
        onSelect={(e) => onCaret(e.currentTarget.selectionStart, e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onScroll={sync}
        onBlur={onBlur}
        onFocus={onFocus}
      />
    </div>
  );
}

/** Function names matching what is typed, or the signature of the call the caret is in. */
function Assist({ ac, index, call, onPick }: { ac: { names: string[] } | null; index: number; call: { name: string; arg: number } | null; onPick: (name: string) => void }) {
  if (ac && ac.names.length) {
    return (
      <div className="ks-assist" role="listbox" aria-label="Functions">
        {ac.names.map((n, i) => (
          <button key={n} type="button" role="option" aria-selected={i === index} className={`ks-assist__item${i === index ? ' is-on' : ''}`} onMouseDown={(e) => { e.preventDefault(); onPick(n); }}>
            <b>{n}</b>
            <span>{FUNCTION_HELP[n]!.slice(n.length)}</span>
          </button>
        ))}
        <p className="ks-assist__tip">Tab or Enter to insert</p>
      </div>
    );
  }
  if (!call) return null;
  const sig = FUNCTION_HELP[call.name]!;
  const inner = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
  const args = inner ? inner.split(', ') : [];
  const last = args.length - 1;
  const cur = call.arg <= last ? call.arg : args[last] === '…' ? last - 1 : last;
  return (
    <div className="ks-assist ks-assist--sig" role="tooltip">
      <b>{call.name}</b>(
      {args.map((a, i) => (
        <span key={i}>
          {i > 0 && ', '}
          {i === cur ? <em>{a}</em> : a}
        </span>
      ))}
      )
    </div>
  );
}

/** A colour menu: none, then the swatches; the button shows the colour in use. */
function Swatches({ label, icon, colors, current, onPick }: { label: string; icon: ReactNode; colors: string[]; current?: string; onPick: (c: string | null) => void }) {
  // Fixed, under the button: the toolbar scrolls sideways on a phone and would clip a dropdown.
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!at) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setAt(null);
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setAt(null);
    };
    const away = () => setAt(null);
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', away);
    };
  }, [at]);
  const pick = (c: string | null) => {
    onPick(c);
    setAt(null);
  };
  return (
    <span className="ks-swatch" ref={ref}>
      <button
        type="button"
        className={`ks-tool ks-tool--swatch${at ? ' is-on' : ''}`}
        aria-label={label}
        title={label}
        aria-expanded={!!at}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          if (at) return setAt(null);
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ left: Math.max(6, Math.min(r.left, window.innerWidth - 212)), top: r.bottom + 6 });
        }}
      >
        {icon}
        <i className="ks-swatch__bar" style={{ background: current ?? 'transparent' }} />
      </button>
      {at && (
        <span className="ks-swatch__menu" role="menu" aria-label={label} style={at} onMouseDown={(e) => e.preventDefault()}>
          <button type="button" className="ks-swatch__none" role="menuitem" aria-label="None" title="None" onClick={() => pick(null)} />
          {colors.map((c) => (
            <button key={c} type="button" role="menuitem" className={`ks-swatch__c${current === c ? ' is-on' : ''}`} style={{ background: c }} aria-label={c} title={c} onClick={() => pick(c)} />
          ))}
        </span>
      )}
    </span>
  );
}

/** A tab's name, edited in place: Enter or leaving saves, Escape keeps the old one. */
function TabName({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="ks-tab ks-tab--edit"
      value={v}
      maxLength={SHEET_MAX.nameChars}
      aria-label="Tab name"
      autoFocus
      size={Math.max(6, v.length + 1)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(v);
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}
