/**
 * A folder table's edits, as pure functions over TableData (columns + rows of
 * text cells; apps/server/src/folders/types.ts): add and remove rows and
 * columns, paste a block copied from a spreadsheet, sort, and export as CSV.
 * Every function returns a new table and stays inside TABLE_MAX, the limits the
 * server holds a table to.
 */
import { TABLE_MAX, type TableData } from '@sign/folders/types.js';

export function emptyTable(): TableData {
  return { columns: ['Column 1', 'Column 2', 'Column 3'], rows: [['', '', ''], ['', '', ''], ['', '', '']] };
}

const fit = (s: string): string => s.slice(0, TABLE_MAX.cellChars);

export function setCell(t: TableData, row: number, col: number, value: string): TableData {
  if (row < 0) return { ...t, columns: t.columns.map((c, i) => (i === col ? fit(value) : c)) };
  return { ...t, rows: t.rows.map((r, i) => (i === row ? r.map((c, j) => (j === col ? fit(value) : c)) : r)) };
}

export function addRow(t: TableData, at = t.rows.length): TableData {
  if (t.rows.length >= TABLE_MAX.rows) return t;
  const rows = [...t.rows];
  rows.splice(Math.max(0, Math.min(at, rows.length)), 0, t.columns.map(() => ''));
  return { ...t, rows };
}

export function removeRow(t: TableData, at: number): TableData {
  return { ...t, rows: t.rows.filter((_, i) => i !== at) };
}

export function addColumn(t: TableData, at = t.columns.length): TableData {
  if (t.columns.length >= TABLE_MAX.columns) return t;
  const i = Math.max(0, Math.min(at, t.columns.length));
  const columns = [...t.columns];
  columns.splice(i, 0, `Column ${t.columns.length + 1}`);
  return { columns, rows: t.rows.map((r) => [...r.slice(0, i), '', ...r.slice(i)]) };
}

export function removeColumn(t: TableData, at: number): TableData {
  if (t.columns.length <= 1) return t;
  return { columns: t.columns.filter((_, i) => i !== at), rows: t.rows.map((r) => r.filter((_, i) => i !== at)) };
}

/** A number as a trader writes one: 64,000 · $1.2k · -3.5% · 2e3. */
export function cellNumber(s: string): number | null {
  const m = /^\s*([+-]?)\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?|\.[0-9]+)(?:e([+-]?\d+))?\s*([kKmMbB%])?\s*$/.exec(s);
  if (!m) return null;
  let n = Number(m[2]!.replace(/,/g, '')) * (m[3] ? 10 ** Number(m[3]) : 1);
  const unit = m[4]?.toLowerCase();
  if (unit === 'k') n *= 1e3;
  else if (unit === 'm') n *= 1e6;
  else if (unit === 'b') n *= 1e9;
  return Number.isFinite(n) ? (m[1] === '-' ? -n : n) : null;
}

/** Rows sorted by a column: numbers as numbers, text as text, empty cells last. */
export function sortBy(t: TableData, col: number, dir: 'asc' | 'desc'): TableData {
  const sign = dir === 'asc' ? 1 : -1;
  const rows = [...t.rows].sort((a, b) => {
    const x = a[col] ?? '';
    const y = b[col] ?? '';
    if (!x.trim() || !y.trim()) return !x.trim() && !y.trim() ? 0 : !x.trim() ? 1 : -1;
    const nx = cellNumber(x);
    const ny = cellNumber(y);
    if (nx !== null && ny !== null) return (nx - ny) * sign;
    return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }) * sign;
  });
  return { ...t, rows };
}

/**
 * A pasted block: tab-separated (what a spreadsheet copies) or, without a tab,
 * comma-separated with quotes. One cell for text with neither.
 */
export function parseGrid(text: string): string[][] {
  const src = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const sep = src.includes('\t') ? '\t' : src.includes(',') && src.includes('\n') ? ',' : null;
  if (!sep) return src.includes('\n') ? src.split('\n').map((l) => [l]) : [[src]];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** Paste a grid with its top-left cell at (row, col), growing the table as far as the limits allow. */
export function pasteGrid(t: TableData, row: number, col: number, grid: string[][]): TableData {
  let out = t;
  const width = Math.max(...grid.map((r) => r.length));
  while (out.columns.length < Math.min(col + width, TABLE_MAX.columns)) out = addColumn(out);
  while (out.rows.length < Math.min(row + grid.length, TABLE_MAX.rows)) out = addRow(out);
  const rows = out.rows.map((r) => [...r]);
  grid.forEach((g, i) => {
    const target = rows[row + i];
    if (!target) return;
    g.forEach((v, j) => {
      if (col + j < out.columns.length) target[col + j] = fit(v);
    });
  });
  return { ...out, rows };
}

/**
 * The table as CSV (RFC 4180). A cell that a spreadsheet would run as a formula
 * (starting with = + - @, a tab or a carriage return) is written with a leading
 * apostrophe, so opening the export can never execute it - a number keeps its sign.
 */
export function toCsv(t: TableData): string {
  const cell = (s: string): string => {
    let v = s;
    if (/^[=+\-@\t\r]/.test(v) && cellNumber(v) === null) v = `'${v}`;
    return /[",\n\r]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return [t.columns, ...t.rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
