/**
 * The knowledge sheets' formula engine (formula.ts, refs.ts): literals,
 * Excel's operators and coercions, every function, errors, cross-sheet refs,
 * cycles, long chains and the time budget, copy/fill shifting, row/column and
 * sheet edits, reference offsets for the editor, and display formats.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_COLS, MAX_ROWS, cellKey, colIndex, colName, parseKey, rangeLabel } from './refs';
import {
  FUNCTION_HELP,
  dateToSerial,
  deleteCols,
  deleteRows,
  evaluateWorkbook,
  formatValue,
  insertCols,
  insertRows,
  isError,
  isFormula,
  parseLiteral,
  referencedRanges,
  renameSheet,
  serialToDate,
  shiftFormula,
  type CellValue,
} from './formula';

const NOW = Date.UTC(2024, 4, 17, 12); // 2024-05-17 12:00 UTC, serial 45429.5

type Cells = Record<string, string>;
const cellsOf = (o: Cells): Record<string, { v: string }> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { v }]));
const book = (...sheets: Array<[string, Cells]>) => ({ sheets: sheets.map(([name, c]) => ({ name, cells: cellsOf(c) })) });

/** Every sheet's values as plain objects. */
function run(...sheets: Array<[string, Cells]>): Array<Record<string, CellValue>> {
  return evaluateWorkbook(book(...sheets), { now: NOW }).map((m) => Object.fromEntries(m));
}

const e = (code: string): CellValue => ({ error: code }) as CellValue;
const DIV0 = e('#DIV/0!'), VALUE = e('#VALUE!'), REF = e('#REF!'), NAME = e('#NAME?'), NA = e('#N/A'), NUM = e('#NUM!'), CIRC = e('#CIRC!'), ERROR = e('#ERROR!');

/** Evaluates each formula (in column CV, beside `data`) and compares; numbers to 1e-9. */
function check(data: Cells, cases: ReadonlyArray<readonly [string, CellValue]>): void {
  const formulas: Cells = {};
  cases.forEach(([f], i) => {
    formulas[cellKey(i, 99)] = f;
  });
  const out = run(['Sheet1', { ...data, ...formulas }])[0]!;
  cases.forEach(([f, want], i) => {
    const got = out[cellKey(i, 99)] ?? null;
    if (typeof want === 'number' && typeof got === 'number') {
      assert.ok(Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want)), `${f} gave ${got}, want ${want}`);
    } else assert.deepEqual(got, want, `${f} gave ${JSON.stringify(got)}`);
  });
}

/** A small table the function tests read. */
const DATA: Cells = {
  A1: '1', A2: '2', A3: '3', A4: '4', A5: '5',
  B1: 'x', B3: '7', B4: 'TRUE', B5: 'hello',
  C1: '=1/0',
  D1: 'apple', D2: 'banana', D3: 'cherry', D4: 'date',
  E1: '1.5', E2: '2.5', E3: '3.5', E4: '4.5',
  G1: '0', G2: '10', G3: '20', G4: '30',
  H1: 'F', H2: 'D', H3: 'C', H4: 'A',
  J1: 'a', K1: 'b', L1: 'c', J2: '1', K2: '2', L2: '3',
  M1: '30', M2: '20', M3: '10', M4: '0',
  N1: '=""',
};

// ------------------------------------------------------------------ refs

test('refs: column letters both ways, cell keys and range labels', () => {
  assert.equal(MAX_ROWS, 5000);
  assert.equal(MAX_COLS, 100);
  assert.deepEqual([0, 25, 26, 51, 99, 701, 702].map(colName), ['A', 'Z', 'AA', 'AZ', 'CV', 'ZZ', 'AAA']);
  assert.deepEqual(['A', 'z', 'AA', 'aa', 'CV', 'ZZ', 'AAA'].map(colIndex), [0, 25, 26, 26, 99, 701, 702]);
  assert.deepEqual(['', 'A1', '1', '$A', 'A-'].map(colIndex), [-1, -1, -1, -1, -1]);
  assert.equal(cellKey(0, 0), 'A1');
  assert.equal(cellKey(4999, 99), 'CV5000');
  assert.deepEqual(parseKey('B12'), { r: 11, c: 1 });
  assert.deepEqual(parseKey('cv5000'), { r: 4999, c: 99 });
  for (const bad of ['', 'A', '12', 'A0', 'A01', '1A', 'A1B', '$A$1', 'ABCD1']) assert.equal(parseKey(bad), null, bad);
  assert.equal(rangeLabel(0, 0, 3, 2), 'A1:C4');
  assert.equal(rangeLabel(3, 2, 0, 0), 'A1:C4');
  assert.equal(rangeLabel(1, 1, 1, 1), 'B2');
});

// ------------------------------------------------------------------ literals

test('parseLiteral: numbers with separators, percent and currency, booleans, forced text', () => {
  const cases: Array<[string, CellValue]> = [
    ['', null],
    ['1,234.5', 1234.5],
    ['-3.2e5', -320000],
    ['12%', 0.12],
    ['$1,234.50', 1234.5],
    ['€5', 5],
    ['£-2', -2],
    ['-$3', -3],
    ['5 €', 5],
    ['.5', 0.5],
    ['1.', 1],
    [' 42 ', 42],
    ['-0', 0],
    ['true', true],
    ['FALSE', false],
    ["'123", '123'],
    ["'TRUE", 'TRUE'],
    ["'", ''],
    ['abc', 'abc'],
    ['1,23', '1,23'],
    ['12abc', '12abc'],
    ['1e999', '1e999'],
    ['#N/A', '#N/A'],
    ['2024-05-17', '2024-05-17'],
  ];
  for (const [raw, want] of cases) assert.deepEqual(parseLiteral(raw), want, JSON.stringify(raw));
  assert.ok(Object.is(parseLiteral('-0'), 0));
});

test('isFormula and isError', () => {
  assert.equal(isFormula('=1'), true);
  assert.equal(isFormula('='), false);
  assert.equal(isFormula(''), false);
  assert.equal(isFormula('a=1'), false);
  assert.equal(isError({ error: '#N/A' }), true);
  assert.equal(isError('#N/A'), false);
  assert.equal(isError(null), false);
  assert.equal(isError(0), false);
});

test('evaluateWorkbook returns only non-empty cells; a lone "=" is text, a formula on an empty cell is 0', () => {
  const [s] = run(['S', { A1: '', A2: '1', A3: '=', A4: '=B9', A5: "'" }]);
  assert.deepEqual(s, { A2: 1, A3: '=', A4: 0, A5: '' });
});

// ------------------------------------------------------------------ operators

test('operators and Excel precedence: comparison < & < +- < */ < ^ < unary < %', () => {
  check({}, [
    ['=1+2*3', 7],
    ['=(1+2)*3', 9],
    ['=10-4-3', 3],
    ['=8/4/2', 1],
    ['=2*3^2', 18],
    ['=2^3^2', 64],
    ['=-2^2', 4],
    ['=0-2^2', -4],
    ['=-(2^2)', -4],
    ['=2^-1', 0.5],
    ['=--3', 3],
    ['=+"abc"', 'abc'],
    ['=50%', 0.5],
    ['=200%*3', 6],
    ['=-50%', -0.5],
    ['=5%%', 0.0005],
    ['=10^2%', Math.pow(10, 0.02)],
    ['=1+2&3', '33'],
    ['="a"&"b"="ab"', true],
    ['=1+1=2', true],
    ['=1<2=TRUE', true],
    ['=2>1+1', false],
    ['=1=1', true],
    ['=1<>2', true],
    ['=1<1', false],
    ['=1>0', true],
    ['=2<=2', true],
    ['=3>=4', false],
    ['= 1 +\t2 ', 3],
  ]);
});

test('literals: numbers, escaped strings, booleans and error values', () => {
  check({}, [
    ['=1e3', 1000],
    ['=.5', 0.5],
    ['=1.5E-2', 0.015],
    ['="a ""quoted"" word"', 'a "quoted" word'],
    ['=""', ''],
    ['=TRUE', true],
    ['=false', false],
    ['=#N/A', NA],
    ['=#DIV/0!', DIV0],
    ['=#ref!', REF],
  ]);
});

test('coercion: empty is 0 or "", numeric text and booleans become numbers, other text is #VALUE!', () => {
  check(DATA, [
    ['=B2+1', 1],
    ['=B2&"x"', 'x'],
    ['="5"+1', 6],
    ['="1,000"*2', 2000],
    ['="2024-05-17"+0', 45429],
    ['="abc"+1', VALUE],
    ['=""+1', VALUE],
    ['=TRUE+TRUE', 2],
    ['=B4*3', 3],
    ['=B1*1', VALUE],
    ['=1&TRUE', '1TRUE'],
    ['=0.1+0.2&""', '0.3'],
    ['=1/3&""', '0.333333333333333'],
    ['=1/0', DIV0],
    ['=1/B2', DIV0],
    ['=0^0', NUM],
    ['=0^-1', DIV0],
    ['=(-8)^(1/3)', NUM],
    ['=10^400', NUM],
    ['=B2', 0],
  ]);
});

test('comparison across types: numbers < text < booleans, text case-insensitive, empty as 0 or ""', () => {
  check(DATA, [
    ['=1<"a"', true],
    ['="a"<TRUE', true],
    ['=2>"10"', false],
    ['="abc"="ABC"', true],
    ['="b">"A"', true],
    ['="Z"<"a"', false],
    ['=FALSE<TRUE', true],
    ['=1="1"', false],
    ['=B2=0', true],
    ['=B2=""', true],
    ['=B2=FALSE', true],
    ['=B2<1', true],
    ['=0.1+0.2=0.3', true],
  ]);
});

test('references: anchors and case, ranges, whole columns; a block in a scalar position is #VALUE!', () => {
  check(DATA, [
    ['=a1+$A$2+A$3+$A4', 10],
    ['=SUM(A:A)', 15],
    ['=SUM(A:B)', 22],
    ['=SUM($A$1:A5, E1:E4)', 27],
    ['=SUM(A3:A1)', 6],
    ['=A1:A3+1', VALUE],
    ['=-A1:A2', VALUE],
    ['=A1:A1+1', 2],
    ['=CW1', REF],
  ]);
});

// ------------------------------------------------------------------ functions

test('aggregates: blocks skip text and blanks, direct text must be numeric, errors propagate', () => {
  check(DATA, [
    ['=SUM(A1:A5)', 15],
    ['=SUM(1,"2",TRUE)', 4],
    ['=SUM("x")', VALUE],
    ['=SUM(B1:B5)', 7],
    ['=SUM(B1)', 0],
    ['=SUM(A1:C1)', DIV0],
    ['=SUM(1,#N/A)', NA],
    ['=AVERAGE(A1:A5)', 3],
    ['=AVERAGE(A1:A5,9)', 4],
    ['=AVERAGE(B1)', DIV0],
    ['=MIN(A1:A5)', 1],
    ['=MAX(A1:A5,9)', 9],
    ['=MAX(-1,-5)', -1],
    ['=MIN(B1)', 0],
    ['=COUNT(A1:B5)', 6],
    ['=COUNT(1,"2","x",TRUE)', 3],
    ['=COUNT(C1)', 0],
    ['=COUNTA(A1:B5)', 9],
    ['=COUNTA(1,"",FALSE)', 3],
    ['=COUNTBLANK(A1:B5)', 1],
    ['=COUNTBLANK(N1:N2)', 2],
    ['=COUNTBLANK(A:A)', MAX_ROWS - 5],
    ['=COUNTBLANK(1)', VALUE],
    ['=PRODUCT(A1:A5)', 120],
    ['=PRODUCT(B1)', 0],
    ['=MEDIAN(1,3,2,4)', 2.5],
    ['=MEDIAN(A1:A5)', 3],
    ['=MEDIAN(B1)', NUM],
    ['=STDEV(2,4,4,4,5,5,7,9)', 2.138089935299395],
    ['=STDEV(1)', DIV0],
  ]);
});

test('COUNTIF, SUMIF, AVERAGEIF: operators, numbers, wildcards, blanks, an aligned sum range', () => {
  check(DATA, [
    ['=COUNTIF(A1:A5,">2")', 3],
    ['=COUNTIF(A1:A5,3)', 1],
    ['=COUNTIF(A1:A5,"3")', 1],
    ['=COUNTIF(A1:A5,"<>3")', 4],
    ['=COUNTIF(A1:A5,"<=2")', 2],
    ['=COUNTIF(A:A,">=4")', 2],
    ['=COUNTIF(D1:D4,"a*")', 1],
    ['=COUNTIF(D1:D4,"*an*")', 1],
    ['=COUNTIF(D1:D4,"?????")', 1],
    ['=COUNTIF(D1:D4,"APPLE")', 1],
    ['=COUNTIF(D1:D4,"<>apple")', 3],
    ['=COUNTIF(D1:D4,"<c")', 2],
    ['=COUNTIF(B1:B5,"")', 1],
    ['=COUNTIF(B1:B5,"<>")', 4],
    ['=COUNTIF(B1:B5,TRUE)', 1],
    ['=COUNTIF(A1:A5,A2)', 1],
    ['=COUNTIF(5,">1")', VALUE],
    ['=SUMIF(A1:A5,">=3")', 12],
    ['=SUMIF(A1:A5,">9")', 0],
    ['=SUMIF(D1:D4,"b*",E1:E4)', 2.5],
    ['=SUMIF(D1:D4,"<>apple",E1)', 10.5],
    ['=AVERAGEIF(A1:A5,">1")', 3.5],
    ['=AVERAGEIF(A1:A5,">10")', DIV0],
    ['=AVERAGEIF(D1:D4,"*e*",E1:E4)', 9.5 / 3],
  ]);
});

test('logic: IF short-circuits, IFERROR / IFNA catch, AND / OR / NOT, IS functions', () => {
  check(DATA, [
    ['=IF(1>2,"a","b")', 'b'],
    ['=IF(FALSE,1)', false],
    ['=IF("x",1,2)', VALUE],
    ['=IF("true",1,2)', 1],
    ['=IF(A1,"yes","no")', 'yes'],
    ['=IF(B2,1,2)', 2],
    ['=IF(TRUE,1,1/0)', 1],
    ['=IF(TRUE,,1)', 0],
    ['=IF(C1,1,2)', DIV0],
    ['=SUM(IF(TRUE,A1:A3,0))', 6],
    ['=IFERROR(1/0,"oops")', 'oops'],
    ['=IFERROR(5,0)', 5],
    ['=IFERROR(C1,"bad")', 'bad'],
    ['=IFNA(#N/A,"none")', 'none'],
    ['=IFNA(1/0,"none")', DIV0],
    ['=IFNA(VLOOKUP("kiwi",D1:E4,2,FALSE),0)', 0],
    ['=AND(TRUE,1,A1:A2)', true],
    ['=AND(TRUE,0)', false],
    ['=AND(B1:B5)', true],
    ['=AND("x")', VALUE],
    ['=AND(B1)', VALUE],
    ['=OR(FALSE,0)', false],
    ['=OR(A1:A2)', true],
    ['=OR(FALSE,C1)', DIV0],
    ['=NOT(TRUE)', false],
    ['=NOT(0)', true],
    ['=NOT("x")', VALUE],
    ['=ISBLANK(B2)', true],
    ['=ISBLANK(B1)', false],
    ['=ISBLANK("")', false],
    ['=ISBLANK(N1)', false],
    ['=ISNUMBER(A1)', true],
    ['=ISNUMBER(B3)', true],
    ['=ISNUMBER("1")', false],
    ['=ISTEXT(B1)', true],
    ['=ISTEXT(A1)', false],
    ['=ISERROR(C1)', true],
    ['=ISERROR(Nope!A1)', true],
    ['=ISERROR(1)', false],
  ]);
});

test('rounding: half away from zero, up, down, INT, CEILING and FLOOR with Excel signs', () => {
  check({}, [
    ['=ROUND(2.675,2)', 2.68],
    ['=ROUND(1.005,2)', 1.01],
    ['=ROUND(2.5,0)', 3],
    ['=ROUND(-2.5,0)', -3],
    ['=ROUND(2.5)', 3],
    ['=ROUND(1234.5,-2)', 1200],
    ['=ROUND(1250,-2)', 1300],
    ['=ROUNDUP(1.21,1)', 1.3],
    ['=ROUNDUP(-1.21,1)', -1.3],
    ['=ROUNDUP(0.1+0.2,1)', 0.3],
    ['=ROUNDDOWN(1.29,1)', 1.2],
    ['=ROUNDDOWN(-1.29,1)', -1.2],
    ['=ROUNDDOWN(1999,-3)', 1000],
    ['=INT(-1.5)', -2],
    ['=INT(1.9)', 1],
    ['=CEILING(2.1,1)', 3],
    ['=CEILING(7)', 7],
    ['=CEILING(-2.5,-2)', -4],
    ['=CEILING(-2.5,2)', -2],
    ['=CEILING(0.123,0.01)', 0.13],
    ['=CEILING(2,-1)', NUM],
    ['=CEILING(5,0)', 0],
    ['=FLOOR(2.9,1)', 2],
    ['=FLOOR(7.5,2)', 6],
    ['=FLOOR(-2.5,2)', -4],
    ['=FLOOR(-2.5,-2)', -2],
    ['=FLOOR(1,0)', DIV0],
    ['=FLOOR(2,-1)', NUM],
  ]);
});

test('math: ABS, SQRT, POWER, MOD with the divisor sign, logs, EXP, PI, SIGN', () => {
  check({}, [
    ['=ABS(-3)', 3],
    ['=SQRT(16)', 4],
    ['=SQRT(-1)', NUM],
    ['=POWER(2,10)', 1024],
    ['=POWER(0,0)', NUM],
    ['=MOD(10,3)', 1],
    ['=MOD(-3,2)', 1],
    ['=MOD(3,-2)', -1],
    ['=MOD(5.5,1)', 0.5],
    ['=MOD(1,0)', DIV0],
    ['=LN(EXP(1))', 1],
    ['=LN(0)', NUM],
    ['=LOG(100)', 2],
    ['=LOG(8,2)', 3],
    ['=LOG(-1)', NUM],
    ['=LOG(5,1)', DIV0],
    ['=LOG10(1000)', 3],
    ['=EXP(0)', 1],
    ['=PI()', Math.PI],
    ['=SIGN(-5)', -1],
    ['=SIGN(0)', 0],
    ['=ABS("x")', VALUE],
  ]);
  for (let i = 0; i < 20; i++) {
    const r = run(['S', { A1: '=RAND()' }])[0]!['A1'];
    assert.ok(typeof r === 'number' && r >= 0 && r < 1);
  }
});

test('text: joining, case, TRIM, LEFT / RIGHT / MID, SUBSTITUTE, FIND vs SEARCH, TEXTJOIN, VALUE', () => {
  check(DATA, [
    ['=CONCAT("a",A1:A3,TRUE)', 'a123TRUE'],
    ['=CONCAT(B1:B3)', 'x7'],
    ['=CONCATENATE("a",1,"b")', 'a1b'],
    ['=CONCATENATE(A1:A2)', VALUE],
    ['=LEN("hello")', 5],
    ['=LEN(123.5)', 5],
    ['=LEN(B2)', 0],
    ['=UPPER("abc")', 'ABC'],
    ['=LOWER("ABC")', 'abc'],
    ['=UPPER(C1)', DIV0],
    ['=TRIM("  a   b  ")', 'a b'],
    ['=LEFT("hello",2)', 'he'],
    ['=LEFT("hello")', 'h'],
    ['=LEFT("hi",-1)', VALUE],
    ['=RIGHT("hello",3)', 'llo'],
    ['=RIGHT("hello",0)', ''],
    ['=RIGHT("hi",9)', 'hi'],
    ['=MID("hello",2,3)', 'ell'],
    ['=MID("hello",9,2)', ''],
    ['=MID("hello",0,1)', VALUE],
    ['=SUBSTITUTE("a-b-c","-","+")', 'a+b+c'],
    ['=SUBSTITUTE("a-b-c","-","+",2)', 'a-b+c'],
    ['=SUBSTITUTE("a-b-c","-","+",5)', 'a-b-c'],
    ['=SUBSTITUTE("abc","","x")', 'abc'],
    ['=FIND("l","hello")', 3],
    ['=FIND("L","hello")', VALUE],
    ['=FIND("l","hello",4)', 4],
    ['=FIND("","abc")', 1],
    ['=FIND("a","abc",9)', VALUE],
    ['=SEARCH("L","hello")', 3],
    ['=SEARCH("h*o","say hello")', 5],
    ['=SEARCH("?l","hello")', 2],
    ['=SEARCH("~*","a*b")', 2],
    ['=SEARCH("z","abc")', VALUE],
    ['=TEXTJOIN(", ",TRUE,"a","","b")', 'a, b'],
    ['=TEXTJOIN("-",FALSE,A1:A3,"")', '1-2-3-'],
    ['=TEXTJOIN("-",TRUE,B1:B3)', 'x-7'],
    ['=TEXTJOIN("-",FALSE,B1:B3)', 'x--7'],
    ['=VALUE("1,234")', 1234],
    ['=VALUE("12%")', 0.12],
    ['=VALUE("$5")', 5],
    ['=VALUE("abc")', VALUE],
    ['=VALUE(TRUE)', VALUE],
  ]);
});

test('dates: TODAY and NOW from the clock given, DATE with overflow, YEAR / MONTH / DAY', () => {
  check({}, [
    ['=TODAY()', 45429],
    ['=NOW()', 45429.5],
    ['=DATE(2024,5,17)', 45429],
    ['=DATE(2024,13,1)', 45658],
    ['=DATE(2024,3,0)', 45351],
    ['=DATE(24,1,1)', dateToSerial(Date.UTC(1924, 0, 1))],
    ['=DATE(-1,1,1)', NUM],
    ['=YEAR(45429)', 2024],
    ['=MONTH(45429.9)', 5],
    ['=DAY(45429)', 17],
    ['=YEAR("2024-05-17")', 2024],
    ['=DAY(DATE(2024,2,29)+1)', 1],
    ['=MONTH(TODAY())', 5],
    ['=YEAR(-1)', NUM],
  ]);
  assert.equal(dateToSerial(Date.UTC(1970, 0, 1)), 25569);
  assert.equal(serialToDate(45429.5), NOW);
  assert.equal(serialToDate(dateToSerial(NOW)), NOW);
  const real = run(['S', { A1: '=TODAY()' }]);
  assert.equal(typeof real[0]!['A1'], 'number');
});

test('lookups: VLOOKUP / HLOOKUP exact and sorted, INDEX (incl. whole rows), MATCH types, CHOOSE', () => {
  check(DATA, [
    ['=VLOOKUP("banana",D1:E4,2,FALSE)', 2.5],
    ['=VLOOKUP("BANANA",D1:E4,2,0)', 2.5],
    ['=VLOOKUP("ch*",D1:E4,2,FALSE)', 3.5],
    ['=VLOOKUP("kiwi",D1:E4,2,FALSE)', NA],
    ['=VLOOKUP("banana",D1:E4,3,FALSE)', REF],
    ['=VLOOKUP("banana",D1:E4,0,FALSE)', VALUE],
    ['=VLOOKUP(15,G1:H4,2)', 'D'],
    ['=VLOOKUP(30,G1:H4,2,TRUE)', 'A'],
    ['=VLOOKUP(99,G1:H4,2)', 'A'],
    ['=VLOOKUP(-1,G1:H4,2)', NA],
    ['=VLOOKUP(10,G1:H4,2,FALSE)', 'D'],
    ['=VLOOKUP("10",G1:H4,2,FALSE)', NA],
    ['=VLOOKUP(B2,G1:H4,2,FALSE)', NA],
    ['=VLOOKUP(1,5,1)', VALUE],
    ['=HLOOKUP("b",J1:L2,2,FALSE)', 2],
    ['=HLOOKUP("b",J1:L2,3,FALSE)', REF],
    ['=HLOOKUP("c",J1:L2,2)', 3],
    ['=INDEX(D1:E4,2,2)', 2.5],
    ['=INDEX(D1:E4,3,1)', 'cherry'],
    ['=INDEX(A1:A5,3)', 3],
    ['=INDEX(J1:L1,2)', 'b'],
    ['=INDEX(A1:A5,9)', REF],
    ['=INDEX(B1:B5,2)', 0],
    ['=SUM(INDEX(D1:E4,0,2))', 12],
    ['=SUM(INDEX(G1:H4,2,0))', 10],
    ['=MATCH("cherry",D1:D4,0)', 3],
    ['=MATCH("b?nana",D1:D4,0)', 2],
    ['=MATCH("x",D1:D4,0)', NA],
    ['=MATCH(25,G1:G4)', 3],
    ['=MATCH(25,G1:G4,1)', 3],
    ['=MATCH(-5,G1:G4,1)', NA],
    ['=MATCH(15,M1:M4,-1)', 2],
    ['=MATCH("b",J1:L1,0)', 2],
    ['=MATCH(1,D1:E4,0)', NA],
    ['=CHOOSE(2,"a","b","c")', 'b'],
    ['=CHOOSE(4,"a","b","c")', VALUE],
    ['=CHOOSE(0,"a")', VALUE],
    ['=CHOOSE(1,"a",1/0)', 'a'],
    ['=SUM(CHOOSE(2,A1:A2,A3:A5))', 12],
  ]);
});

test('every function in FUNCTION_HELP is implemented and every signature names itself', () => {
  const names = Object.keys(FUNCTION_HELP);
  assert.ok(names.length >= 60);
  const out = run(['S', Object.fromEntries(names.map((n, i) => [cellKey(i, 0), `=${n}()`]))])[0]!;
  names.forEach((n, i) => {
    assert.notDeepEqual(out[cellKey(i, 0)], NAME, n);
    assert.ok(FUNCTION_HELP[n]!.startsWith(n + '('), n);
  });
});

// ------------------------------------------------------------------ errors

test('errors: unknown names, bad syntax, wrong argument counts, and propagation through operators and functions', () => {
  check(DATA, [
    ['=FOO(1)', NAME],
    ['=foo', NAME],
    ['=A1B', NAME],
    ['=sum(1,2)', 3],
    ['=Sum(A1:A2)', 3],
    ['=1+', ERROR],
    ['=(1', ERROR],
    ['="abc', ERROR],
    ['=1 2', ERROR],
    ['=SUM(1,2', ERROR],
    ['=A1:', ERROR],
    ['=@A1', ERROR],
    ['=Sheet1!', ERROR],
    ['=SUM()', VALUE],
    ['=PI(1)', VALUE],
    ['=C1+1', DIV0],
    ['=-C1', DIV0],
    ['=C1%', DIV0],
    ['=C1=1', DIV0],
    ['=#N/A&"x"', NA],
    ['=#N/A+#DIV/0!', NA],
    ['=1+#REF!', REF],
    ['=ABS(#VALUE!)', VALUE],
    ['=LEN(1/0)', DIV0],
    ['=ROUND(C1,1)', DIV0],
    ['=VLOOKUP(C1,D1:E4,2,FALSE)', DIV0],
  ]);
  const deep = run(['S', {
    A1: '=' + '('.repeat(500) + '1' + ')'.repeat(500),
    A2: '=' + '-'.repeat(1000) + '1',
    A3: '=1' + '+1'.repeat(3000),
  }])[0]!;
  assert.deepEqual(deep['A1'], ERROR, 'nesting past the limit is a formula error, not a crash');
  assert.deepEqual(deep['A2'], ERROR);
  assert.equal(deep['A3'], 3001);
});

// ------------------------------------------------------------------ sheets

test('cross-sheet refs: plain and quoted names, doubled quotes, case-insensitive, unknown sheet is #REF!', () => {
  const [s1, s2] = run(
    ['Sheet1', {
      A1: '=Sheet2!A1*2',
      A2: "='My Sheet'!B2",
      A3: "=SUM('My Sheet'!A1:B2)",
      A4: '=sheet2!a1',
      A5: '=Nope!A1',
      A6: "='No Sheet'!A1:B2",
      A7: "='It''s'!A1",
      A8: '=SUM(Sheet2!A:A)',
      B1: '100',
    }],
    ['Sheet2', { A1: '21', A2: '=Sheet1!B1+1' }],
    ['My Sheet', { A1: '1', A2: '2', B1: '3', B2: '4' }],
    ["It's", { A1: 'quoted' }],
  );
  assert.deepEqual(s1, { A1: 42, A2: 4, A3: 10, A4: 21, A5: REF, A6: REF, A7: 'quoted', A8: 122, B1: 100 });
  assert.deepEqual(s2, { A1: 21, A2: 101 });
});

test('cycles: a self-reference, a 3-cell loop and a range loop are #CIRC!, and so is whatever reads them', () => {
  const [s] = run(['S', {
    A1: '=A1',
    B1: '=C1', C1: '=D1', D1: '=B1',
    E1: '=B1+1',
    F1: '=IFERROR(B1,0)',
    G1: '=SUM(G2:G3)', G2: '1', G3: '=G1',
    H1: '5', H2: '=H1*2', H3: '=H2+E1',
    I1: '=SUM(I:I)',
  }]);
  for (const k of ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'G3', 'H3', 'I1']) assert.deepEqual(s![k], CIRC, k);
  assert.equal(s!['G2'], 1);
  assert.equal(s!['H2'], 10);
  const cross = run(['A', { A1: '=B!A1' }], ['B', { A1: '=A!A1' }]);
  assert.deepEqual(cross[0]!['A1'], CIRC);
  assert.deepEqual(cross[1]!['A1'], CIRC);
});

test('a 5000-cell chain, in either direction and with keys in any order, does not overflow the stack', () => {
  const down: Cells = {};
  for (let r = MAX_ROWS; r >= 2; r--) down[`A${r}`] = `=A${r - 1}+1`;
  down['A1'] = '1';
  const up: Cells = { B5000: '1' };
  for (let r = 1; r < MAX_ROWS; r++) up[`B${r}`] = `=B${r + 1}+1`;
  const [s] = run(['S', { ...down, ...up }]);
  assert.equal(s!['A5000'], 5000);
  assert.equal(s!['B1'], 5000);
});

test('performance: 60,000 cells with 20,000 formulas evaluate well inside the budget', (t) => {
  const cells: Record<string, { v: string }> = {};
  const rows = 600;
  for (let r = 1; r <= rows; r++) {
    for (let c = 0; c < MAX_COLS; c++) {
      const L = colName(c - 1);
      let v: string;
      if (c < 66) v = String((r * 7 + c * 13) % 100);
      else if (c === 99) v = r === 1 ? '=1' : `=CV${r - 1}+1`;
      else {
        v = [
          `=A${r}*2+B${r}`,
          `=SUM(A${r}:J${r})`,
          `=${L}${r}+1`,
          `=IF(C${r}>50,"hi","lo")&D${r}`,
          `=ROUND(AVERAGE(A${r}:Z${r}),2)`,
          `=COUNTIF(A${r}:Z${r},">50")`,
        ][c % 6]!;
      }
      cells[cellKey(r - 1, c)] = { v };
    }
  }
  const wb = { sheets: [{ name: 'Big', cells }] };
  assert.equal(Object.keys(cells).length, 60_000);
  let t0 = performance.now();
  const cold = evaluateWorkbook(wb);
  const coldMs = performance.now() - t0;
  t0 = performance.now();
  const warm = evaluateWorkbook(wb);
  const warmMs = performance.now() - t0;
  t.diagnostic(`cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms`);
  assert.equal(cold[0]!.size, 60_000);
  assert.equal(warm[0]!.get('CV600'), 600);
  assert.equal(warm[0]!.get(cellKey(0, 66)), 7 * 2 + 20, 'BO1 = A1*2+B1');
  assert.ok(coldMs < 2000, `cold ${coldMs} ms`);
  assert.ok(warmMs < 2000, `warm ${warmMs} ms`);
});

// ------------------------------------------------------------------ shifting

test('shiftFormula: relative parts move, $ parts stay, off the grid is #REF!, text and spacing are kept', () => {
  assert.equal(shiftFormula('=A1+$B$1+C$2+$D3', 1, 1), '=B2+$B$1+D$2+$D4');
  assert.equal(shiftFormula('=SUM(A1:B2)', 2, 0), '=SUM(A3:B4)');
  assert.equal(shiftFormula('=sum( a1 , 2 )', 1, 0), '=sum( A2 , 2 )');
  assert.equal(shiftFormula('="A1"&A1', 1, 0), '="A1"&A2');
  assert.equal(shiftFormula('=Sheet2!A1', 0, 1), '=Sheet2!B1');
  assert.equal(shiftFormula("='My Sheet'!A1:A2*2", 1, 0), "='My Sheet'!A2:A3*2");
  assert.equal(shiftFormula('=SUM(A:A)', 5, 1), '=SUM(B:B)');
  assert.equal(shiftFormula('=SUM($A:A)', 0, 2), '=SUM($A:C)');
  assert.equal(shiftFormula('=LOG10(A1)', 1, 0), '=LOG10(A2)');
  assert.equal(shiftFormula('=A1', -1, 0), '=#REF!');
  assert.equal(shiftFormula('=A1:B2+1', 0, -1), '=#REF!+1');
  assert.equal(shiftFormula('=CV1', 0, 1), '=#REF!');
  assert.equal(shiftFormula('=A5000', 1, 0), '=#REF!');
  assert.equal(shiftFormula('=Sheet2!A1', -1, 0), '=#REF!');
  assert.equal(shiftFormula('=$A$1', -5, -5), '=$A$1');
  assert.equal(shiftFormula('=A1', 0, 0), '=A1');
  assert.equal(shiftFormula('A1', 3, 3), 'A1');
  assert.equal(shiftFormula('=B2', 3, 1), '=C5');
  assert.equal(shiftFormula(shiftFormula('=B2*$C$3', 3, 1), -3, -1), '=B2*$C$3');
  assert.deepEqual(run(['S', { A1: '=#REF!+1' }])[0]!['A1'], REF);
});

// ------------------------------------------------------------------ structure edits

type Cell = { v: string; s?: string };
type Book = { title: string; sheets: Array<{ name: string; id: number; cells: Record<string, Cell> }> };

function edBook(): Book {
  return {
    title: 'kept',
    sheets: [
      {
        name: 'Data',
        id: 1,
        cells: {
          A1: { v: '1' },
          A2: { v: '2', s: 'bold' },
          A3: { v: '3' },
          A4: { v: '=SUM(A1:A3)' },
          B1: { v: '=A2*10' },
          B2: { v: '=$A$3' },
          C1: { v: '=SUM(A:A)' },
        },
      },
      { name: 'Other', id: 2, cells: { A1: { v: '=Data!A2+Data!A4' }, A2: { v: '=Data!B1' }, A3: { v: '=A1' } } },
    ],
  };
}

const formulas = (wb: Book, s: number): Record<string, string> =>
  Object.fromEntries(Object.entries(wb.sheets[s]!.cells).map(([k, c]) => [k, c.v]));
const values = (wb: Book): Array<Record<string, CellValue>> => evaluateWorkbook(wb).map((m) => Object.fromEntries(m));

test('insertRows: cells move down, refs follow (incl. $ and other sheets), ranges grow, other fields survive', () => {
  const wb = edBook();
  const next = insertRows(wb, 0, 1, 2);
  assert.notEqual(next, wb);
  assert.equal(next.title, 'kept');
  assert.equal(next.sheets[0]!.id, 1);
  assert.deepEqual(formulas(next, 0), {
    A1: '1', A4: '2', A5: '3', A6: '=SUM(A1:A5)', B1: '=A4*10', B4: '=$A$5', C1: '=SUM(A:A)',
  });
  assert.deepEqual(next.sheets[0]!.cells['A4'], { v: '2', s: 'bold' });
  assert.deepEqual(formulas(next, 1), { A1: '=Data!A4+Data!A6', A2: '=Data!B1', A3: '=A1' });
  assert.equal(next.sheets[1]!.cells['A2'], wb.sheets[1]!.cells['A2'], 'untouched cells keep their identity');
  const v = values(next);
  assert.equal(v[0]!['A6'], 6);
  assert.equal(v[0]!['B1'], 20);
  assert.equal(v[0]!['B4'], 3);
  assert.equal(v[1]!['A1'], 8);
  assert.equal(formulas(wb, 0)['A4'], '=SUM(A1:A3)', 'the input is not mutated');
});

test('deleteRows: refs into the deleted rows become #REF!, ranges shrink, refs below move up', () => {
  const next = deleteRows(edBook(), 0, 1, 1);
  assert.deepEqual(formulas(next, 0), { A1: '1', A2: '3', A3: '=SUM(A1:A2)', B1: '=#REF!*10', C1: '=SUM(A:A)' });
  assert.deepEqual(formulas(next, 1), { A1: '=#REF!+Data!A3', A2: '=Data!B1', A3: '=A1' });
  const v = values(next);
  assert.equal(v[0]!['A3'], 4);
  assert.deepEqual(v[0]!['B1'], REF);
  assert.deepEqual(v[1]!['A1'], REF);
  assert.deepEqual(v[1]!['A3'], REF);

  const ranges: Book = { title: '', sheets: [{ name: 'S', id: 0, cells: {
    B1: { v: '=SUM(A1:A10)' }, B2: { v: '=SUM(A3:A10)' }, B3: { v: '=SUM(A2:A3)' }, B4: { v: '=SUM(A10:A1)' }, B5: { v: '=A$9' },
  } }] };
  // Delete rows 2..3 (B2 and B3 go with them).
  assert.deepEqual(formulas(deleteRows(ranges, 0, 1, 2), 0), { B1: '=SUM(A1:A8)', B2: '=SUM(A8:A1)', B3: '=A$7' });
  assert.deepEqual(formulas(deleteRows(ranges, 0, 0, 5), 0), {});
  // Delete rows 1..5: a range starting inside the cut starts where the cut was; one wholly inside is gone.
  const right: Book = { title: '', sheets: [{ name: 'S', id: 0, cells: { C9: { v: '=SUM(A3:A10)+SUM(A2:A3)+A1' } } }] };
  assert.deepEqual(formulas(deleteRows(right, 0, 0, 5), 0), { C4: '=SUM(A1:A5)+SUM(#REF!)+#REF!' });
});

test('insertCols / deleteCols: columns move, whole-column ranges grow or vanish, other sheets follow', () => {
  const ins = insertCols(edBook(), 0, 0, 1);
  assert.deepEqual(formulas(ins, 0), {
    B1: '1', B2: '2', B3: '3', B4: '=SUM(B1:B3)', C1: '=B2*10', C2: '=$B$3', D1: '=SUM(B:B)',
  });
  assert.deepEqual(formulas(ins, 1), { A1: '=Data!B2+Data!B4', A2: '=Data!C1', A3: '=A1' });
  assert.equal(values(ins)[0]!['D1'], 12);

  const del = deleteCols(edBook(), 0, 0, 1);
  assert.deepEqual(formulas(del, 0), { A1: '=#REF!*10', A2: '=#REF!', B1: '=SUM(#REF!)' });
  assert.deepEqual(formulas(del, 1), { A1: '=#REF!+#REF!', A2: '=Data!A1', A3: '=A1' });

  const grow: Book = { title: '', sheets: [{ name: 'S', id: 0, cells: { E1: { v: '=SUM(A1:C1)+SUM(A:C)+SUM($B:$B)' } } }] };
  assert.deepEqual(formulas(insertCols(grow, 0, 1, 2), 0), { G1: '=SUM(A1:E1)+SUM(A:E)+SUM($D:$D)' });
  assert.deepEqual(formulas(deleteCols(grow, 0, 1, 1), 0), { D1: '=SUM(A1:B1)+SUM(A:B)+SUM(#REF!)' });
});

test('structure edits refuse to push filled cells off the grid, and ignore nonsense', () => {
  const full: Book = { title: '', sheets: [{ name: 'S', id: 0, cells: { A5000: { v: 'last' }, CV1: { v: 'edge' } } }] };
  assert.equal(insertRows(full, 0, 0, 1), full);
  assert.equal(insertCols(full, 0, 0, 1), full);
  assert.equal(insertRows(full, 3, 0, 1), full);
  assert.equal(deleteRows(full, 0, 0, 0), full);
  const pinned: Book = { title: '', sheets: [{ name: 'S', id: 0, cells: { B1: { v: '=SUM(A1:A5000)+A4999' } } }] };
  assert.deepEqual(formulas(insertRows(pinned, 0, 1, 1), 0), { B1: '=SUM(A1:A5000)+A5000' });
  assert.deepEqual(formulas(insertRows(pinned, 0, 1, 2), 0), { B1: '=SUM(A1:A5000)+#REF!' });
});

test('renameSheet: refs follow the new name, quoted when it needs it, strings and other sheets untouched', () => {
  const wb: Book = {
    title: '',
    sheets: [
      { name: 'Data', id: 1, cells: { A1: { v: '5' } } },
      { name: 'Other', id: 2, cells: {
        A1: { v: '=Data!A1*2', s: 'x' },
        A2: { v: "='Data'!A1+data!A1" },
        A3: { v: '="Data!A1"&Data!A1' },
        A4: { v: '=Other!A1' },
      } },
    ],
  };
  const spaced = renameSheet(wb, 0, 'My Data');
  assert.equal(spaced.sheets[0]!.name, 'My Data');
  assert.equal(spaced.sheets[0]!.id, 1);
  assert.deepEqual(formulas(spaced, 1), {
    A1: "='My Data'!A1*2",
    A2: "='My Data'!A1+'My Data'!A1",
    A3: `="Data!A1"&'My Data'!A1`,
    A4: '=Other!A1',
  });
  assert.equal(spaced.sheets[1]!.cells['A1']!.s, 'x');
  assert.deepEqual(values(spaced)[1], { A1: 10, A2: 10, A3: 'Data!A15', A4: 10 });
  assert.equal(formulas(renameSheet(wb, 0, "Bob's"), 1)['A1'], "='Bob''s'!A1*2");
  assert.equal(formulas(renameSheet(wb, 0, 'Q4'), 1)['A1'], "='Q4'!A1*2");
  assert.equal(formulas(renameSheet(wb, 0, 'Plain_2'), 1)['A1'], '=Plain_2!A1*2');
  assert.equal(formulas(renameSheet(wb, 0, 'Übersicht'), 1)['A1'], '=Übersicht!A1*2');
  assert.equal(values(renameSheet(wb, 0, "Bob's"))[1]!['A1'], 10);
  assert.equal(renameSheet(wb, 7, 'x'), wb);
});

// ------------------------------------------------------------------ editor support

test('referencedRanges: each ref with its offsets, sheet and 0-based corners; strings and functions are not refs', () => {
  const raw = "=SUM(A1:B2)+Sheet2!C3*'My Sheet'!$D$4:E5+a:a";
  const refs = referencedRanges(raw);
  assert.deepEqual(refs.map((r) => raw.slice(r.start, r.end)), ['A1:B2', 'Sheet2!C3', "'My Sheet'!$D$4:E5", 'a:a']);
  assert.deepEqual(refs[0], { sheet: null, r1: 0, c1: 0, r2: 1, c2: 1, start: 5, end: 10 });
  assert.deepEqual(refs[1], { sheet: 'Sheet2', r1: 2, c1: 2, r2: 2, c2: 2, start: 12, end: 21 });
  assert.deepEqual(refs[2], { sheet: 'My Sheet', r1: 3, c1: 3, r2: 4, c2: 4, start: 22, end: 40 });
  assert.deepEqual(refs[3], { sheet: null, r1: 0, c1: 0, r2: MAX_ROWS - 1, c2: 0, start: 41, end: 44 });
  assert.deepEqual(referencedRanges('=B3:A1'), [{ sheet: null, r1: 0, c1: 0, r2: 2, c2: 1, start: 1, end: 6 }]);
  assert.deepEqual(referencedRanges('="A1"&LOG10(B2)').map((r) => [r.start, r.end]), [[12, 14]]);
  assert.deepEqual(referencedRanges('A1+B2'), []);
  assert.deepEqual(referencedRanges('=SUM(A1'), [{ sheet: null, r1: 0, c1: 0, r2: 0, c2: 0, start: 5, end: 7 }]);
});

test('formatValue: general, num, pct, usd, date, fixed decimals; booleans, errors and empty', () => {
  assert.equal(formatValue(1 / 3), '0.3333333333');
  assert.equal(formatValue(0.1 + 0.2), '0.3');
  assert.equal(formatValue(1234567), '1234567');
  assert.equal(formatValue(123456.7890123), '123456.789');
  assert.equal(formatValue(-2.50), '-2.5');
  assert.equal(formatValue(-0), '0');
  assert.equal(formatValue(1e20), '1E+20');
  assert.equal(formatValue(1.5e-9), '1.5E-09');
  assert.equal(formatValue(2.5, { dp: 0 }), '3');
  assert.equal(formatValue(-2.5, { dp: 0 }), '-3');
  assert.equal(formatValue(1.005, { dp: 2 }), '1.01');
  assert.equal(formatValue(-0.001, { dp: 2 }), '0.00');
  assert.equal(formatValue(1234567.891, { fmt: 'num' }), '1,234,567.891');
  assert.equal(formatValue(1234567.891, { fmt: 'num', dp: 2 }), '1,234,567.89');
  assert.equal(formatValue(-1234.5, { fmt: 'num' }), '-1,234.5');
  assert.equal(formatValue(999.5, { fmt: 'num', dp: 0 }), '1,000');
  assert.equal(formatValue(0.1234, { fmt: 'pct' }), '12.34%');
  assert.equal(formatValue(0.1234, { fmt: 'pct', dp: 1 }), '12.3%');
  assert.equal(formatValue(0.12, { fmt: 'pct' }), '12%');
  assert.equal(formatValue(1234.5, { fmt: 'usd' }), '$1,234.50');
  assert.equal(formatValue(1234.5, { fmt: 'usd', dp: 0 }), '$1,235');
  assert.equal(formatValue(-5, { fmt: 'usd' }), '-$5.00');
  assert.equal(formatValue(-0.001, { fmt: 'usd' }), '$0.00');
  assert.equal(formatValue(45429, { fmt: 'date' }), '2024-05-17');
  assert.equal(formatValue(45429.75, { fmt: 'date' }), '2024-05-17');
  assert.equal(formatValue(5, { fmt: 'text' }), '5');
  assert.equal(formatValue(true), 'TRUE');
  assert.equal(formatValue(false, { fmt: 'num' }), 'FALSE');
  assert.equal(formatValue({ error: '#N/A' }), '#N/A');
  assert.equal(formatValue(null), '');
  assert.equal(formatValue('abc', { fmt: 'usd' }), 'abc');
});
