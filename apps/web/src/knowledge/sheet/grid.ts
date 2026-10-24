/**
 * A sheet's text in and out: a block pasted from a spreadsheet (tab-separated,
 * or comma-separated with quotes), and the sheet's values as CSV (RFC 4180)
 * that can never run as a formula where it is opened.
 */

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

/** Tab-separated, as a spreadsheet copies (a cell with a tab, a newline or a quote is quoted). */
export function toTsv(rows: string[][]): string {
  const cell = (v: string): string => (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join('\t')).join('\n');
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/**
 * Values as CSV. A cell that a spreadsheet would run as a formula (starting
 * with = + - @, a tab or a carriage return) is written with a leading
 * apostrophe, so opening the export can never execute it - a number keeps its
 * sign.
 */
export function toCsv(rows: string[][]): string {
  const cell = (s: string): string => {
    let v = s;
    if (/^[=+\-@\t\r]/.test(v) && !NUMBER.test(v)) v = `'${v}`;
    return /[",\n\r]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
