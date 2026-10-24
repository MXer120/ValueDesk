/**
 * The spreadsheet editor's pure side (model.ts): selection and movement, the
 * fill handle's series, the clipboard block and its paste, sorting, tab and
 * row/column edits, and that whatever it writes is exactly what the server
 * keeps (checkSheet returns it unchanged).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHEET_MAX, type SheetCell, type SheetData, type SheetTab } from '@sign/folders/types.js';
import { checkSheet } from '@sign/folders/validate.js';
import { evaluateWorkbook, type CellValue } from './formula';
import { MAX_COLS, MAX_ROWS, cellKey } from './refs';
import * as M from './model';

const tabOf = (cells: Record<string, string | SheetCell>, extra: Partial<SheetTab> = {}): SheetTab => ({
  id: 's1',
  name: 'Sheet1',
  cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, typeof v === 'string' ? { v } : v])),
  ...extra,
});
const raw = (t: SheetTab): Record<string, string> => Object.fromEntries(Object.entries(t.cells).map(([k, c]) => [k, c.v]));
const kept = (d: SheetData): void => assert.deepEqual(checkSheet(structuredClone(d)), d, 'the server keeps it unchanged');

// ------------------------------------------------------------------ selection

test('selection: ranges from either corner, arrows move or extend, the grid edges hold', () => {
  const s: M.Sel = { a: { r: 4, c: 3 }, f: { r: 1, c: 5 } };
  assert.deepEqual(M.rangeOf(s), { r1: 1, c1: 3, r2: 4, c2: 5 });
  assert.deepEqual(M.moveSel(s, 1, 0, false), M.single({ r: 5, c: 3 }), 'a plain arrow collapses to the moved active cell');
  assert.deepEqual(M.moveSel(s, 0, 1, true), { a: { r: 4, c: 3 }, f: { r: 1, c: 6 } }, 'shift moves the far corner');
  assert.deepEqual(M.moveSel(M.single({ r: 0, c: 0 }), -1, -1, false), M.single({ r: 0, c: 0 }));
  assert.deepEqual(M.moveSel(M.single({ r: MAX_ROWS - 1, c: MAX_COLS - 1 }), 1, 1, false), M.single({ r: MAX_ROWS - 1, c: MAX_COLS - 1 }));
  assert.equal(M.isOneCell(M.rangeOf(M.single({ r: 2, c: 2 }))), true);
  assert.equal(M.areaOf({ r1: 0, c1: 0, r2: 2, c2: 3 }), 12);
  assert.deepEqual(M.intersect({ r1: 0, c1: 0, r2: 5, c2: 5 }, { r1: 3, c1: 4, r2: 9, c2: 9 }), { r1: 3, c1: 4, r2: 5, c2: 5 });
  assert.equal(M.intersect({ r1: 0, c1: 0, r2: 1, c2: 1 }, { r1: 3, c1: 3, r2: 4, c2: 4 }), null);
  assert.equal(M.isWholeCols(M.wholeCols(2, 1)), true);
  assert.deepEqual(M.wholeRows(3, 1), { r1: 1, c1: 0, r2: 3, c2: MAX_COLS - 1 });
  // A range made a selection keeps the active cell where it was, if inside.
  assert.deepEqual(M.selOf({ r1: 1, c1: 1, r2: 3, c2: 3 }, { r: 3, c: 1 }), { a: { r: 3, c: 1 }, f: { r: 1, c: 3 } });
  assert.deepEqual(M.selOf({ r1: 1, c1: 1, r2: 3, c2: 3 }, { r: 9, c: 9 }), { a: { r: 1, c: 1 }, f: { r: 3, c: 3 } });
  const mid = M.selOf({ r1: 0, c1: 0, r2: 5, c2: 3 }, { r: 1, c: 0 });
  assert.deepEqual(M.rangeOf(mid), { r1: 0, c1: 0, r2: 5, c2: 3 }, 'an active cell inside the range never shrinks it');
});

test('Ctrl+arrows: to the end of a run, across a gap to the next value, or to the edge', () => {
  const filled = new Set(['0,0', '1,0', '2,0', '6,0', '0,4']);
  const has = (r: number, c: number) => filled.has(`${r},${c}`);
  assert.deepEqual(M.dataEdge(has, { r: 0, c: 0 }, 1, 0), { r: 2, c: 0 }, 'end of the run');
  assert.deepEqual(M.dataEdge(has, { r: 2, c: 0 }, 1, 0), { r: 6, c: 0 }, 'across the gap');
  assert.deepEqual(M.dataEdge(has, { r: 6, c: 0 }, 1, 0), { r: MAX_ROWS - 1, c: 0 }, 'nothing below: the last row');
  assert.deepEqual(M.dataEdge(has, { r: 0, c: 0 }, 0, 1), { r: 0, c: 4 });
  assert.deepEqual(M.dataEdge(has, { r: 0, c: 0 }, -1, 0), { r: 0, c: 0 }, 'already at the edge');
  assert.deepEqual(M.dataRegion(has, { r: 1, c: 0 }), { r1: 0, c1: 0, r2: 2, c2: 0 });
  const block = new Set(['0,0', '0,1', '1,1', '2,2', '5,5']);
  assert.deepEqual(M.dataRegion((r, c) => block.has(`${r},${c}`), { r: 0, c: 0 }), { r1: 0, c1: 0, r2: 2, c2: 2 }, 'diagonal neighbours count');
});

test('name box: cells, ranges, anchors, whole columns and rows; nonsense and off-grid refs are refused', () => {
  assert.deepEqual(M.parseRangeInput('B7'), { r1: 6, c1: 1, r2: 6, c2: 1 });
  assert.deepEqual(M.parseRangeInput(' c4:a1 '), { r1: 0, c1: 0, r2: 3, c2: 2 });
  assert.deepEqual(M.parseRangeInput('$A$1'), { r1: 0, c1: 0, r2: 0, c2: 0 });
  assert.deepEqual(M.parseRangeInput('A:C'), M.wholeCols(0, 2));
  assert.deepEqual(M.parseRangeInput('3:5'), M.wholeRows(2, 4));
  for (const bad of ['', 'foo', 'A0', 'A5001', 'CW1', 'A1:', 'SUM(A1)', '1']) assert.equal(M.parseRangeInput(bad), null, bad);
});

// ------------------------------------------------------------------ fill

test('fill series: one number counts up, a progression keeps its step, text with a number counts, the rest repeats', () => {
  const run = (vals: string[], at: number[]) => {
    const g = M.series(vals);
    return g ? at.map(g) : null;
  };
  assert.deepEqual(run(['1'], [1, 2, 3]), ['2', '3', '4']);
  assert.deepEqual(run(['1', '2'], [2, 3]), ['3', '4']);
  assert.deepEqual(run(['10', '20', '30'], [3, -1]), ['40', '0']);
  assert.deepEqual(run(['0.1', '0.2'], [2]), ['0.3'], 'no binary noise');
  assert.deepEqual(run(['5', '3'], [2, 3]), ['1', '-1']);
  assert.deepEqual(run(['Q1'], [1, 2]), ['Q2', 'Q3']);
  assert.deepEqual(run(['Week 2', 'Week 4'], [2]), ['Week 6']);
  assert.deepEqual(run(['Item 007'], [1]), ['Item 008'], 'zero padding kept');
  assert.equal(M.series(['1', '2', '4']), null);
  assert.equal(M.series(['apple']), null);
  assert.equal(M.series(['1,000']), null, 'a formatted number repeats');
  assert.equal(M.series(['10%']), null);
  assert.equal(M.series(['A1', 'B1']), null, 'different prefixes');
});

test('fillRange: down continues series per column, repeats text and styles, shifts formulas; up and right work too', () => {
  const bold = { b: true as const };
  const t = tabOf({ A1: '1', A2: '2', B1: { v: 'x', s: bold }, B2: 'y', C1: '=A1*2', C2: '=$A$1+A2' });
  const down = M.fillRange(t, { r1: 0, c1: 0, r2: 1, c2: 2 }, { r1: 0, c1: 0, r2: 4, c2: 2 });
  assert.deepEqual(raw(down), {
    A1: '1', A2: '2', A3: '3', A4: '4', A5: '5',
    B1: 'x', B2: 'y', B3: 'x', B4: 'y', B5: 'x',
    C1: '=A1*2', C2: '=$A$1+A2', C3: '=A3*2', C4: '=$A$1+A4', C5: '=A5*2',
  });
  assert.deepEqual(down.cells['B3'], { v: 'x', s: bold });
  const one = M.fillRange(tabOf({ B2: '7' }), { r1: 1, c1: 1, r2: 1, c2: 1 }, { r1: 1, c1: 1, r2: 1, c2: 4 });
  assert.deepEqual(raw(one), { B2: '7', C2: '8', D2: '9', E2: '10' });
  const up = M.fillRange(tabOf({ A4: '10', A5: '20' }), { r1: 3, c1: 0, r2: 4, c2: 0 }, { r1: 1, c1: 0, r2: 4, c2: 0 });
  assert.deepEqual(raw(up), { A2: '-10', A3: '0', A4: '10', A5: '20' });
  const blanks = M.fillRange(tabOf({ A1: 'a', A3: 'old' }), { r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 });
  assert.deepEqual(raw(blanks), { A1: 'a', A3: 'a' }, 'a blank in the pattern clears its target');
  assert.deepEqual(M.fillTarget({ r1: 1, c1: 1, r2: 2, c2: 2 }, { r: 9, c: 3 }), { r1: 1, c1: 1, r2: 9, c2: 2 });
  assert.deepEqual(M.fillTarget({ r1: 1, c1: 1, r2: 2, c2: 2 }, { r: 2, c: 7 }), { r1: 1, c1: 1, r2: 2, c2: 7 });
  assert.deepEqual(M.fillTarget({ r1: 1, c1: 1, r2: 2, c2: 2 }, { r: 0, c: 1 }), { r1: 0, c1: 1, r2: 2, c2: 2 });
  assert.deepEqual(M.fillTarget({ r1: 1, c1: 1, r2: 2, c2: 2 }, { r: 2, c: 2 }), { r1: 1, c1: 1, r2: 2, c2: 2 });
});

// ------------------------------------------------------------------ clipboard

test('paste: our block shifts its formulas by the move, a cut keeps them, one cell fills a range, blanks clear', () => {
  const src = tabOf({ A1: '5', B1: { v: '=A1*2', s: { fg: '#ff6b6b' } }, A2: '=SUM(A1:B1)' });
  const block = M.copyBlock(src, { r1: 0, c1: 0, r2: 1, c2: 1 });
  assert.deepEqual(block, [[{ v: '5' }, { v: '=A1*2', s: { fg: '#ff6b6b' } }], [{ v: '=SUM(A1:B1)' }, null]]);
  const at = { r1: 4, c1: 2, r2: 4, c2: 2 };
  const copied = M.pasteBlock(src, at, block, { r: 0, c: 0 });
  assert.deepEqual(copied.range, { r1: 4, c1: 2, r2: 5, c2: 3 });
  assert.equal(copied.tab.cells['D5']!.v, '=C5*2');
  assert.deepEqual(copied.tab.cells['D5']!.s, { fg: '#ff6b6b' });
  assert.equal(copied.tab.cells['C6']!.v, '=SUM(C5:D5)');
  assert.equal(copied.tab.cells['D6'], undefined);
  const moved = M.pasteBlock(src, at, block, null);
  assert.equal(moved.tab.cells['D5']!.v, '=A1*2', 'a cut moves the formula as it is');
  const cleared = M.clearCutSource(moved.tab, { r1: 0, c1: 0, r2: 1, c2: 1 }, moved.range);
  assert.deepEqual(Object.keys(cleared.cells).sort(), ['C5', 'C6', 'D5']);
  const offGrid = M.pasteBlock(src, { r1: 0, c1: 0, r2: 0, c2: 0 }, block, { r: 1, c: 1 });
  assert.equal(offGrid.tab.cells['B1']!.v, '=#REF!*2', 'a reference pushed off the grid is #REF!');

  const fill = M.pasteBlock(tabOf({ A1: '=B1' }), { r1: 0, c1: 3, r2: 2, c2: 3 }, [[{ v: '=B1' }]], { r: 0, c: 0 });
  assert.deepEqual(raw(fill.tab), { A1: '=B1', D1: '=E1', D2: '=E2', D3: '=E3' });
  assert.deepEqual(M.pasteTarget({ r1: 0, c1: 0, r2: 3, c2: 3 }, 2, 2), { r1: 0, c1: 0, r2: 3, c2: 3 }, 'a multiple is tiled');
  assert.deepEqual(M.pasteTarget({ r1: 0, c1: 0, r2: 2, c2: 2 }, 2, 2), { r1: 0, c1: 0, r2: 1, c2: 1 }, 'otherwise at the corner');
  assert.deepEqual(M.pasteTarget({ r1: MAX_ROWS - 1, c1: 0, r2: MAX_ROWS - 1, c2: 0 }, 3, 1), { r1: MAX_ROWS - 1, c1: 0, r2: MAX_ROWS - 1, c2: 0 }, 'never past the grid');
});

test('paste text from elsewhere: raw values, the target keeps its styles, one value fills the selection', () => {
  const t = tabOf({ B2: { v: 'old', s: { b: true } } });
  const out = M.pasteText(t, { r1: 1, c1: 1, r2: 1, c2: 1 }, [['1', '=A1'], ['', 'x']]);
  assert.deepEqual(out.tab.cells, { B2: { v: '1', s: { b: true } }, C2: { v: '=A1' }, C3: { v: 'x' } });
  const many = M.pasteText(tabOf({}), { r1: 0, c1: 0, r2: 2, c2: 1 }, [['7']]);
  assert.equal(Object.keys(many.tab.cells).length, 6);
});

// ------------------------------------------------------------------ sorting

test('sort: numbers before text, text naturally, blanks last both ways, the header stays, rows move whole', () => {
  const t = tabOf({
    A1: { v: 'Coin', s: { b: true } }, B1: 'Size', C1: 'Twice',
    A2: 'eth', B2: '10', C2: '=B2*2',
    A3: 'BTC', B3: '2', C3: '=B3*2',
    A4: '', B4: '7',
    A5: 'sol 10', B5: '1', C5: '=B5*2',
    A6: 'sol 9', B6: { v: '5', s: { i: true } },
    A7: '3', B7: '0',
  });
  const tab = { ...t, cells: Object.fromEntries(Object.entries(t.cells).filter(([, c]) => c.v || c.s)) };
  const values = evaluateWorkbook({ sheets: [tab] })[0]!;
  const at = (r: number, c: number): CellValue => values.get(cellKey(r, c)) ?? null;
  const rg = { r1: 0, c1: 0, r2: 6, c2: 2 };
  const col = (x: SheetTab, c: string) => [1, 2, 3, 4, 5, 6, 7].map((r) => x.cells[`${c}${r}`]?.v ?? '');

  const asc = M.sortRange(tab, rg, 0, false, true, at);
  assert.deepEqual(col(asc, 'A'), ['Coin', '3', 'BTC', 'eth', 'sol 9', 'sol 10', '']);
  assert.deepEqual(col(asc, 'B'), ['Size', '0', '2', '10', '5', '1', '7']);
  assert.deepEqual(col(asc, 'C'), ['Twice', '', '=B3*2', '=B4*2', '', '=B6*2', ''], 'formulas follow their row');
  assert.deepEqual(asc.cells['A1']!.s, { b: true });
  assert.deepEqual(asc.cells['B5']!.s, { i: true }, 'styles move with the row');

  const desc = M.sortRange(tab, rg, 0, true, true, at);
  assert.deepEqual(col(desc, 'A'), ['Coin', 'sol 10', 'sol 9', 'eth', 'BTC', '3', ''], 'blanks stay last descending');

  const bySize = M.sortRange(tab, rg, 1, false, true, at);
  assert.deepEqual(col(bySize, 'B'), ['Size', '0', '1', '2', '5', '7', '10']);
  const noHeader = M.sortRange(tab, { r1: 1, c1: 1, r2: 6, c2: 1 }, 1, true, false, at);
  assert.deepEqual(col(noHeader, 'B'), ['Size', '10', '7', '5', '2', '1', '0'], 'only the range moves');
  assert.equal(noHeader.cells['A2']!.v, 'eth');
  assert.equal(M.sortRange(tab, { r1: 1, c1: 1, r2: 1, c2: 1 }, 1, false, false, at), tab, 'one row: nothing to do');
});

// ------------------------------------------------------------------ cells and styles

test('cells keep only what the server keeps: control characters, length, styles, blanks', () => {
  assert.equal(M.cleanValue('a\u0000b\tc\nd\u007f'), 'ab\tc\nd');
  assert.equal(M.cleanValue('x'.repeat(SHEET_MAX.cellChars + 9)).length, SHEET_MAX.cellChars);
  assert.equal(M.makeCell(''), null);
  assert.deepEqual(M.makeCell('', { b: true }), { v: '', s: { b: true } });
  assert.deepEqual(
    M.cleanStyle({ b: true, i: false as unknown as true, al: 'x' as 'l', fg: '#FF00AA', bg: 'red', fmt: 'num', dp: 11, wrap: true }),
    { b: true, fg: '#ff00aa', fmt: 'num', wrap: true },
  );
  assert.equal(M.cleanStyle({ dp: 2.5 }), undefined);
  assert.equal(M.inputFor('123', { fmt: 'text' }), "'123");
  assert.equal(M.inputFor('=A1', { fmt: 'text' }), "'=A1");
  assert.equal(M.inputFor('abc', { fmt: 'text' }), 'abc');
  assert.equal(M.inputFor('123', { fmt: 'num' }), '123');
  const t = tabOf({ A1: { v: '1', s: { b: true } }, A2: '2', B1: { v: '', s: { bg: '#1f4d36' } } });
  assert.deepEqual(M.clearValues(t, { r1: 0, c1: 0, r2: 1, c2: 1 }).cells, { A1: { v: '', s: { b: true } }, B1: { v: '', s: { bg: '#1f4d36' } } });
  assert.deepEqual(M.clearFormats(t, { r1: 0, c1: 0, r2: 1, c2: 1 }).cells, { A1: { v: '1' }, A2: { v: '2' } });
  assert.deepEqual(M.clearAll(t, M.wholeCols(0, 0)).cells, { B1: { v: '', s: { bg: '#1f4d36' } } });
  assert.deepEqual(M.cellsIn(t, M.wholeCols(1, 1)).map((x) => [x.r, x.c]), [[0, 1]]);
  assert.deepEqual(M.usedSize(t), { rows: 2, cols: 2 });
  assert.deepEqual(M.usedSize(t, false), { rows: 2, cols: 1 });
  assert.deepEqual(M.clipToUsed(t, M.wholeCols(0, 3)), { r1: 0, c1: 0, r2: 1, c2: 1 });
});

test('styling a whole column touches its filled cells and only the shown part of the rest', () => {
  const t = tabOf({ A1: 'x', A400: 'far' });
  const out = M.styleRange(t, M.wholeCols(0, 0), (s) => ({ ...s, b: true }), { r1: 0, c1: 0, r2: 99, c2: 25 });
  assert.equal(Object.keys(out.cells).length, 101, '100 shown rows plus the filled cell beyond them');
  assert.deepEqual(out.cells['A400'], { v: 'far', s: { b: true } });
  const off = M.styleRange(out, M.wholeCols(0, 0), (s) => ({ ...s, b: undefined }), { r1: 0, c1: 0, r2: 99, c2: 25 });
  assert.deepEqual(off.cells, { A1: { v: 'x' }, A400: { v: 'far' } }, 'taking the style off drops the blank cells again');
});

// ------------------------------------------------------------------ sizes, freezing, lines

test('sizes and freezing stay in the server bounds; defaults are not stored', () => {
  let t = tabOf({});
  t = M.setColWidth(t, 2, 5000);
  assert.deepEqual(t.cols, { 2: M.COL_W.max });
  t = M.setColWidth(t, 2, M.DEFAULT_COL_W);
  assert.equal(t.cols, undefined);
  t = M.setRowHeight(t, 4, 3.4);
  assert.deepEqual(t.rows, { 4: M.ROW_H.min });
  assert.equal(M.colWidth(t, 0), M.DEFAULT_COL_W);
  assert.equal(M.rowHeight(t, 4), M.ROW_H.min);
  t = M.setFreeze(t, 99, 1);
  assert.deepEqual(t.freeze, { r: M.FREEZE_MAX.r, c: 1 });
  t = M.setFreeze(t, 0, 0);
  assert.equal('freeze' in t, false);
  assert.equal(M.fitWidth([20]), 40);
  assert.equal(M.fitWidth([9000]), M.AUTOFIT_MAX);
});

test('rows and columns in and out: refs in every tab follow, sizes move, a full sheet refuses', () => {
  const d: SheetData = {
    v: 1,
    sheets: [tabOf({ A1: '1', A2: '2', A3: '=SUM(A1:A2)' }, { rows: { 1: 40, 3: 30 }, cols: { 0: 150 } }), { id: 's2', name: 'Other', cells: { A1: { v: '=Sheet1!A2*2' } } }],
  };
  const ins = M.editLines(d, 0, 'rows', 1, 2, false)!;
  assert.deepEqual(raw(ins.sheets[0]!), { A1: '1', A4: '2', A5: '=SUM(A1:A4)' });
  assert.equal(ins.sheets[1]!.cells['A1']!.v, '=Sheet1!A4*2');
  assert.deepEqual(ins.sheets[0]!.rows, { 3: 40, 5: 30 });
  const del = M.editLines(d, 0, 'rows', 1, 1, true)!;
  assert.deepEqual(raw(del.sheets[0]!), { A1: '1', A2: '=SUM(A1:A1)' });
  assert.equal(del.sheets[1]!.cells['A1']!.v, '=#REF!*2');
  assert.deepEqual(del.sheets[0]!.rows, { 2: 30 });
  const cols = M.editLines(d, 0, 'cols', 0, 1, true)!;
  assert.equal(cols.sheets[0]!.cols, undefined);
  assert.equal(M.editLines({ v: 1, sheets: [tabOf({ A5000: 'end' })] }, 0, 'rows', 0, 1, false), null);
  kept(ins);
  kept(del);
});

// ------------------------------------------------------------------ tabs

test('tabs: added up to the limit, renamed with refs following, duplicated, moved, deleted but never the last', () => {
  let d: SheetData = { v: 1, sheets: [tabOf({ A1: '5' })] };
  d = M.addTab(d)!;
  assert.deepEqual(d.sheets.map((t) => [t.id, t.name]), [['s1', 'Sheet1'], ['s2', 'Sheet2']]);
  assert.equal(d.active, 1);
  d = M.withTab(d, 1, { ...d.sheets[1]!, cells: { A1: { v: '=Sheet1!A1+1' } } });
  const renamed = M.renameTab(d, 0, '  Prices   2024 ');
  assert.ok(typeof renamed !== 'string');
  assert.equal(renamed.sheets[0]!.name, 'Prices 2024');
  assert.equal(renamed.sheets[1]!.cells['A1']!.v, "='Prices 2024'!A1+1");
  assert.equal(M.renameTab(d, 1, 'sheet1'), 'Another tab is called "sheet1".');
  assert.equal(M.renameTab(d, 1, '   '), 'A tab needs a name.');
  assert.equal(M.cleanTabName('x'.repeat(60)).length, SHEET_MAX.nameChars);

  const dup = M.duplicateTab(renamed, 0)!;
  assert.deepEqual(dup.sheets.map((t) => t.name), ['Prices 2024', 'Prices 2024 (2)', 'Sheet2']);
  assert.equal(dup.active, 1);
  assert.equal(new Set(dup.sheets.map((t) => t.id)).size, 3);
  const dup2 = M.duplicateTab(dup, 0)!;
  assert.equal(dup2.sheets[1]!.name, 'Prices 2024 (3)');
  const long = M.duplicateTab({ v: 1, sheets: [tabOf({}, { name: 'y'.repeat(40) })] }, 0)!;
  assert.equal([...long.sheets[1]!.name].length, SHEET_MAX.nameChars);

  const moved = M.moveTab(dup, 1, 1);
  assert.deepEqual(moved.sheets.map((t) => t.name), ['Prices 2024', 'Sheet2', 'Prices 2024 (2)']);
  assert.equal(moved.active, 2, 'the active tab moves with itself');
  assert.equal(M.moveTab(moved, 0, -1), moved);

  const gone = M.deleteTab(moved, 2)!;
  assert.equal(gone.active, 1);
  assert.equal(M.deleteTab({ v: 1, sheets: [tabOf({})] }, 0), null);
  const first = M.deleteTab(M.setActive(gone, 0), 1)!;
  assert.equal('active' in first, false, 'the first tab is stored without "active"');

  let full: SheetData = { v: 1, sheets: [tabOf({})] };
  while (full.sheets.length < SHEET_MAX.sheets) full = M.addTab(full)!;
  assert.equal(M.addTab(full), null);
  assert.equal(M.duplicateTab(full, 0), null);
  kept(full);
  kept(dup2);
});

test('loadData: stored data is used as is; anything unreadable is an empty sheet', () => {
  const d: SheetData = { v: 1, sheets: [tabOf({ A1: '1' }), { id: 's2', name: 'B', cells: {} }], active: 1 };
  assert.deepEqual(M.loadData(d), d);
  assert.deepEqual(M.loadData(null), M.emptyData());
  assert.deepEqual(M.loadData({ v: 1, sheets: [] }), M.emptyData());
  assert.equal(M.activeIndex({ ...d, active: 9 }), 1);
});

// ------------------------------------------------------------------ what the server keeps

test('everything the model writes passes checkSheet unchanged and inside SHEET_MAX', () => {
  let d: SheetData = M.emptyData();
  let t = d.sheets[0]!;
  t = M.setValue(t, { r: 0, c: 0 }, 'Name\u0001');
  t = M.setValue(t, { r: 0, c: 1 }, '=SUM(B2:B9)');
  t = M.setValue(t, { r: 4999, c: 99 }, 'x'.repeat(5000));
  t = M.setValue(t, { r: 1, c: 1 }, M.inputFor('42', { fmt: 'text' }));
  t = M.styleRange(t, { r1: 0, c1: 0, r2: 2, c2: 3 }, (s) => ({ ...s, b: true, fg: '#ABCDEF', dp: 3, fmt: 'usd', al: 'c' }), { r1: 0, c1: 0, r2: 99, c2: 25 });
  t = M.clearValues(t, { r1: 2, c1: 2, r2: 2, c2: 2 });
  t = M.clearFormats(t, { r1: 2, c1: 3, r2: 2, c2: 3 });
  t = M.fillRange(t, { r1: 0, c1: 1, r2: 1, c2: 1 }, { r1: 0, c1: 1, r2: 20, c2: 1 });
  t = M.pasteText(t, { r1: 30, c1: 0, r2: 30, c2: 0 }, [['a\u0007', 'b'], ['', '=A31']]).tab;
  t = M.pasteBlock(t, { r1: 40, c1: 5, r2: 41, c2: 5 }, M.copyBlock(t, { r1: 0, c1: 0, r2: 1, c2: 1 }), { r: 0, c: 0 }).tab;
  t = M.setColWidth(M.setColWidth(t, 3, 17), 99, 333.7);
  t = M.setRowHeight(t, 4999, 9999);
  t = M.setFreeze(t, 1, 1);
  d = M.withTab(d, 0, t);
  d = M.addTab(d)!;
  d = M.duplicateTab(d, 0)!;
  const r = M.renameTab(d, 1, "Bob's\ttab");
  assert.ok(typeof r !== 'string');
  assert.equal(M.editLines(r, 0, 'cols', 2, 1, false), null, 'CV5000 is filled: no column can be inserted');
  d = M.editLines(r, 0, 'cols', 2, 1, true)!;
  d = M.setActive(d, 0);
  for (const tab of d.sheets) {
    for (const [k, c] of Object.entries(tab.cells)) {
      assert.match(k, /^[A-Z]{1,2}[1-9]\d{0,3}$/);
      assert.ok(c.v.length <= SHEET_MAX.cellChars);
    }
  }
  assert.ok(M.fitsLimits(d));
  kept(d);
});
