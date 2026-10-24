/**
 * A folder table's edits (table.ts): rows and columns within the server's
 * limits, a spreadsheet paste, number-aware sorting, and a CSV export that can
 * never run as a formula.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE_MAX } from '@sign/folders/types.js';
import { checkTable } from '@sign/folders/validate.js';
import { addColumn, addRow, cellNumber, emptyTable, parseGrid, pasteGrid, removeColumn, removeRow, setCell, sortBy, toCsv } from './table';

test('rows and columns: added where asked, removed, never past the limits, never below one column', () => {
  let t = emptyTable();
  t = setCell(t, -1, 0, 'Level');
  t = setCell(t, 0, 0, '64,000');
  t = addRow(t, 0);
  assert.deepEqual(t.rows[0], ['', '', '']);
  assert.deepEqual(t.rows[1], ['64,000', '', '']);
  t = addColumn(t, 1);
  assert.deepEqual(t.columns, ['Level', 'Column 4', 'Column 2', 'Column 3']);
  assert.equal(t.rows[1]!.length, 4);
  t = removeColumn(removeRow(t, 0), 1);
  assert.deepEqual(t.rows[0], ['64,000', '', '']);
  let one = { columns: ['a'], rows: [['1']] };
  one = removeColumn(one, 0);
  assert.equal(one.columns.length, 1);
  let wide = { columns: Array.from({ length: TABLE_MAX.columns }, (_, i) => `c${i}`), rows: [] as string[][] };
  wide = addColumn(wide);
  assert.equal(wide.columns.length, TABLE_MAX.columns);
  assert.equal(setCell(emptyTable(), 0, 0, 'x'.repeat(TABLE_MAX.cellChars + 5)).rows[0]![0]!.length, TABLE_MAX.cellChars);
  assert.deepEqual(checkTable(t), t, 'what the editor makes is what the server keeps');
});

test('paste: a block copied from a spreadsheet fills from the cell, growing the table', () => {
  assert.deepEqual(parseGrid('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseGrid('x,"y, z"\n"q""uote",2'), [['x', 'y, z'], ['q"uote', '2']]);
  assert.deepEqual(parseGrid('just text'), [['just text']]);
  const t = pasteGrid(emptyTable(), 2, 2, [['a', 'b'], ['c', 'd']]);
  assert.equal(t.columns.length, 4);
  assert.equal(t.rows.length, 4);
  assert.deepEqual(t.rows[2], ['', '', 'a', 'b']);
  assert.deepEqual(t.rows[3], ['', '', 'c', 'd']);
});

test('sort: numbers as numbers (with units), text as text, empty cells last', () => {
  assert.equal(cellNumber('$1.2k'), 1200);
  assert.equal(cellNumber('-3.5%'), -3.5);
  assert.equal(cellNumber('64,000'), 64000);
  assert.equal(cellNumber('2e3'), 2000);
  assert.equal(cellNumber('BTC'), null);
  const t = { columns: ['v'], rows: [['10'], [''], ['9'], ['1.5k'], ['-2']] };
  assert.deepEqual(sortBy(t, 0, 'asc').rows.map((r) => r[0]), ['-2', '9', '10', '1.5k', '']);
  assert.deepEqual(sortBy(t, 0, 'desc').rows.map((r) => r[0]), ['1.5k', '10', '9', '-2', '']);
});

test('CSV: quoted where needed, and a formula is written as text', () => {
  const csv = toCsv({ columns: ['Name', 'Note'], rows: [['=HYPERLINK("http://x")', 'a, b'], ['-5', '@SUM(A1)'], ['line\nbreak', ' padded']] });
  assert.equal(csv, 'Name,Note\r\n"\'=HYPERLINK(""http://x"")","a, b"\r\n-5,\'@SUM(A1)\r\n"line\nbreak"," padded"\r\n');
});
