/**
 * A1-style references for the knowledge sheets: column letters, cell keys
 * ("B7" is row 6, column 1, both 0-based here) and range labels.
 */

export const MAX_ROWS = 5000;
export const MAX_COLS = 100;

/** 0 → "A", 25 → "Z", 26 → "AA" (bijective base 26, as spreadsheets count). */
export function colName(c: number): string {
  let n = Math.floor(c) + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "A" → 0, "aa" → 26; -1 for anything that is not column letters. */
export function colIndex(name: string): number {
  if (!/^[A-Za-z]{1,7}$/.test(name)) return -1;
  let n = 0;
  for (let i = 0; i < name.length; i++) n = n * 26 + ((name.charCodeAt(i) | 32) - 96);
  return n - 1;
}

export function cellKey(r: number, c: number): string {
  return colName(c) + (r + 1);
}

const KEY_RE = /^([A-Za-z]{1,3})([1-9]\d{0,6})$/;

export function parseKey(key: string): { r: number; c: number } | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return { r: Number(m[2]) - 1, c: colIndex(m[1]!) };
}

/** "A1:C4", or "B2" when the range is one cell; corners in any order. */
export function rangeLabel(r1: number, c1: number, r2: number, c2: number): string {
  const top = Math.min(r1, r2), bottom = Math.max(r1, r2);
  const left = Math.min(c1, c2), right = Math.max(c1, c2);
  const a = cellKey(top, left);
  return top === bottom && left === right ? a : `${a}:${cellKey(bottom, right)}`;
}
