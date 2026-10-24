/**
 * The knowledge sheets' formula engine, Excel-flavoured and dependency-free:
 * literal parsing, a formula parser with Excel's precedence, a whole-workbook
 * evaluator that orders cells by their dependencies (no recursion across
 * cells, so long chains are safe, and cycles become #CIRC!), reference
 * rewriting for copy/fill and for row, column and sheet edits, and the display
 * text of values.
 */
import { MAX_COLS, MAX_ROWS, cellKey, colIndex, colName, parseKey } from './refs';

// ---------------------------------------------------------------- values

export type ErrorCode = '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#N/A' | '#NUM!' | '#CIRC!' | '#ERROR!';
export interface SheetError { error: ErrorCode }
/** null is an empty cell. */
export type CellValue = number | string | boolean | SheetError | null;

export interface WorkbookInput {
  sheets: ReadonlyArray<{ name: string; cells: Readonly<Record<string, { v: string }>> }>;
}

const isErr = (v: unknown): v is SheetError => typeof v === 'object' && v !== null && 'error' in v;
export const isError = (v: CellValue): v is SheetError => isErr(v);

const mkErr = (error: ErrorCode): SheetError => Object.freeze({ error });
const DIV0 = mkErr('#DIV/0!');
const VALUE = mkErr('#VALUE!');
const REF = mkErr('#REF!');
const NAME = mkErr('#NAME?');
const NA = mkErr('#N/A');
const NUM = mkErr('#NUM!');
const CIRC = mkErr('#CIRC!');
const ERROR = mkErr('#ERROR!');
const ERR_LITERALS: ReadonlyArray<SheetError> = [DIV0, VALUE, REF, NAME, NA, NUM, CIRC, ERROR];

/** A block of cells handed to a function; a single-cell ref is a 1×1 block. */
class Rng {
  readonly s: number;
  readonly r1: number;
  readonly c1: number;
  readonly r2: number;
  readonly c2: number;
  constructor(s: number, r1: number, c1: number, r2: number, c2: number) {
    this.s = s;
    this.r1 = r1;
    this.c1 = c1;
    this.r2 = r2;
    this.c2 = c2;
  }
  get h(): number { return this.r2 - this.r1 + 1; }
  get w(): number { return this.c2 - this.c1 + 1; }
}
type Val = CellValue | Rng;

// ---------------------------------------------------------------- literals

const CURRENCY = new Set(['$', '€', '£']);
const NUM_BODY = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?(?:e[+-]?\d+)?$|^\.\d+(?:e[+-]?\d+)?$/i;

/** "1,234.5", "-3.2e5", "12%", "$1,234.50", "-€5", "5 €"; null when it is not a number. */
function parseNumber(text: string): number | null {
  let s = text.trim();
  if (s === '') return null;
  let sign = 1;
  let pct = false;
  if (s.endsWith('%')) {
    pct = true;
    s = s.slice(0, -1).trimEnd();
  }
  const takeSign = (): boolean => {
    if (s[0] !== '-' && s[0] !== '+') return false;
    if (s[0] === '-') sign = -1;
    s = s.slice(1);
    return true;
  };
  const signed = takeSign();
  if (CURRENCY.has(s[0] ?? '')) {
    s = s.slice(1).trimStart();
    if (!signed) takeSign();
  } else if (CURRENCY.has(s[s.length - 1] ?? '')) {
    s = s.slice(0, -1).trimEnd();
  }
  if (!NUM_BODY.test(s)) return null;
  let n = sign * Number(s.replace(/,/g, ''));
  if (pct) n /= 100;
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : n;
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/** Text that arithmetic accepts as a number: anything parseNumber takes, plus an ISO date. */
function textToNum(text: string): number | null {
  const n = parseNumber(text);
  if (n !== null) return n;
  const m = ISO_DATE.exec(text.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return dateToSerial(ms);
}

/** What a typed (non-formula) cell holds. */
export function parseLiteral(raw: string): CellValue {
  if (raw === '') return null;
  if (raw[0] === "'") return raw.slice(1);
  const t = raw.trim();
  const up = t.toUpperCase();
  if (up === 'TRUE') return true;
  if (up === 'FALSE') return false;
  const n = parseNumber(t);
  return n === null ? raw : n;
}

export function isFormula(raw: string): boolean {
  return raw.length > 1 && raw[0] === '=';
}

// ---------------------------------------------------------------- dates

const DAY_MS = 86_400_000;
/** Days from 1899-12-30 (Excel's day 0) to 1970-01-01. */
const EPOCH_SERIAL = 25_569;

export function dateToSerial(ms: number): number {
  return ms / DAY_MS + EPOCH_SERIAL;
}

export function serialToDate(serial: number): number {
  return Math.round((serial - EPOCH_SERIAL) * DAY_MS);
}

// ---------------------------------------------------------------- coercion

/** Excel's general text for a number in `&` and text functions: 15 significant digits. */
function numText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return String(Number(n.toPrecision(15))).replace('e', 'E');
}

function toNum(v: CellValue): number | SheetError {
  if (typeof v === 'number') return v;
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return textToNum(v) ?? VALUE;
  return v;
}

function toText(v: CellValue): string | SheetError {
  if (typeof v === 'string') return v;
  if (v === null) return '';
  if (typeof v === 'number') return numText(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

function toBool(v: CellValue): boolean | SheetError {
  if (typeof v === 'boolean') return v;
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const up = v.toUpperCase();
    return up === 'TRUE' ? true : up === 'FALSE' ? false : VALUE;
  }
  return v;
}

/** A number result, or #NUM! when it overflowed or is undefined; never -0. */
function fin(v: number | SheetError): number | SheetError {
  if (typeof v !== 'number') return v;
  if (!Number.isFinite(v)) return NUM;
  return v === 0 ? 0 : v;
}

const typeRank = (v: number | string | boolean): number => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);

/** Excel's ordering: numbers < text < booleans, text case-insensitive, empty as 0, "" or FALSE. */
function cmp(a: Exclude<CellValue, SheetError>, b: Exclude<CellValue, SheetError>): number {
  if (a === null && b === null) return 0;
  const x = a ?? (typeof b === 'number' ? 0 : typeof b === 'string' ? '' : false);
  const y = b ?? (typeof x === 'number' ? 0 : typeof x === 'string' ? '' : false);
  const rx = typeRank(x), ry = typeRank(y);
  if (rx !== ry) return rx < ry ? -1 : 1;
  if (typeof x === 'string') {
    const p = x.toLowerCase(), q = (y as string).toLowerCase();
    return p < q ? -1 : p > q ? 1 : 0;
  }
  if (x === y) return 0;
  // Excel keeps 15 significant digits, so 0.1 + 0.2 equals 0.3.
  if (typeof x === 'number' && x.toPrecision(15) === (y as number).toPrecision(15)) return 0;
  return x < y ? -1 : 1;
}

/** Half away from zero (Excel's ROUND), with up/down variants; binary noise is cut at 15 digits first. */
function roundTo(x: number, digits: number, mode: 'half' | 'up' | 'down'): number {
  const d = Math.trunc(digits);
  const ax = Math.abs(x);
  if (d > 0 && ax >= 1e15) return x;
  const p = Math.pow(10, Math.abs(d));
  let v = d >= 0 ? ax * p : ax / p;
  v = Number(v.toPrecision(15));
  v = mode === 'half' ? Math.round(v) : mode === 'up' ? Math.ceil(v) : Math.floor(v);
  const r = d >= 0 ? v / p : v * p;
  return x < 0 ? -r : r;
}

function reEscape(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? '\\' + ch : ch;
}

/** Excel wildcards: * any run, ? one character, ~ escapes either (or itself). */
function wildcardSource(p: string): string {
  let s = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    const next = p[i + 1];
    if (ch === '~' && next !== undefined && (next === '*' || next === '?' || next === '~')) {
      s += reEscape(next);
      i++;
    } else if (ch === '*') s += '[\\s\\S]*';
    else if (ch === '?') s += '[\\s\\S]';
    else s += reEscape(ch);
  }
  return s;
}

const wildcard = (p: string): RegExp => new RegExp('^' + wildcardSource(p) + '$', 'i');

// ---------------------------------------------------------------- lexer

/** One end of a reference; r is -1 for a whole-column reference. */
interface Part { c: number; cAbs: boolean; r: number; rAbs: boolean }

/** A reference as written: `sheet` unquoted (null when none), `prefix` the raw "Sheet!" text. */
interface RefTok {
  t: 'ref';
  s: number;
  e: number;
  sheet: string | null;
  prefix: string;
  a: Part;
  b: Part | null;
}

type Tok =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'str'; v: string; s: number; e: number }
  | { t: 'err'; v: SheetError; s: number; e: number }
  | { t: 'id'; v: string; s: number; e: number }
  | { t: 'op'; v: string; s: number; e: number }
  | { t: 'bad'; s: number; e: number }
  | RefTok;

const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const CELL_RE = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/y;
const COLS_RE = /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/y;
const SHEET_RE = /[\p{L}_][\p{L}\p{N}_.]*!/uy;
const ID_RE = /[\p{L}_][\p{L}\p{N}_.]*/uy;
const WORDISH = /[\p{L}\p{N}_.]/u;
const OPS = '+-*/^&=<>%(),:';

const isDigit = (code: number): boolean => code >= 48 && code <= 57;

function isWordStart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || ch === '_' || ch === '$' || ch === "'") return true;
  return code > 127 && /\p{L}/u.test(ch);
}

/** A reference ends where a name could not continue (so LOG10( is a function, A1B a name). */
function refEnds(src: string, k: number): boolean {
  const ch = src[k];
  if (ch === undefined) return true;
  if (ch === '(') return false;
  return !WORDISH.test(ch);
}

function cellAt(src: string, j: number): { p: Part; e: number } | null {
  CELL_RE.lastIndex = j;
  const m = CELL_RE.exec(src);
  if (!m) return null;
  const r = Number(m[4]) - 1;
  if (r < 0) return null;
  return { p: { c: colIndex(m[2]!), cAbs: m[1] === '$', r, rAbs: m[3] === '$' }, e: j + m[0].length };
}

function lexWord(src: string, i: number): Tok {
  let j = i;
  let sheet: string | null = null;
  if (src[i] === "'") {
    let k = i + 1;
    let name = '';
    for (;;) {
      if (k >= src.length) return { t: 'bad', s: i, e: src.length };
      const ch = src[k]!;
      if (ch === "'") {
        if (src[k + 1] === "'") {
          name += "'";
          k += 2;
          continue;
        }
        break;
      }
      name += ch;
      k++;
    }
    if (src[k + 1] !== '!') return { t: 'bad', s: i, e: k + 1 };
    sheet = name;
    j = k + 2;
  } else {
    SHEET_RE.lastIndex = i;
    const m = SHEET_RE.exec(src);
    if (m) {
      sheet = m[0].slice(0, -1);
      j = i + m[0].length;
    }
  }
  const prefix = src.slice(i, j);
  const a = cellAt(src, j);
  if (a) {
    if (src[a.e] === ':') {
      const b = cellAt(src, a.e + 1);
      if (b && refEnds(src, b.e)) return { t: 'ref', s: i, e: b.e, sheet, prefix, a: a.p, b: b.p };
    }
    if (refEnds(src, a.e)) return { t: 'ref', s: i, e: a.e, sheet, prefix, a: a.p, b: null };
  }
  COLS_RE.lastIndex = j;
  const cols = COLS_RE.exec(src);
  if (cols && refEnds(src, j + cols[0].length)) {
    return {
      t: 'ref', s: i, e: j + cols[0].length, sheet, prefix,
      a: { c: colIndex(cols[2]!), cAbs: cols[1] === '$', r: -1, rAbs: false },
      b: { c: colIndex(cols[4]!), cAbs: cols[3] === '$', r: -1, rAbs: false },
    };
  }
  if (sheet !== null) {
    // What Excel leaves behind for a deleted sheet-qualified ref: Sheet2!#REF!
    if (src.slice(j, j + 5).toUpperCase() === '#REF!') return { t: 'err', v: REF, s: i, e: j + 5 };
    return { t: 'bad', s: i, e: Math.max(j, i + 1) };
  }
  ID_RE.lastIndex = i;
  const id = ID_RE.exec(src);
  if (!id) return { t: 'bad', s: i, e: i + 1 };
  return { t: 'id', v: id[0], s: i, e: i + id[0].length };
}

/** Tokens of a formula from `from` (1, past the "="), with offsets into src. Never throws. */
function lex(src: string, from: number): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = from;
  while (i < n) {
    const ch = src[i]!;
    const code = src.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 160) {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let v = '';
      let closed = false;
      while (j < n) {
        const c = src[j]!;
        if (c === '"') {
          if (src[j + 1] === '"') {
            v += '"';
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        v += c;
        j++;
      }
      if (!closed) {
        toks.push({ t: 'bad', s: i, e: n });
        break;
      }
      toks.push({ t: 'str', v, s: i, e: j + 1 });
      i = j + 1;
      continue;
    }
    if (isDigit(code) || (ch === '.' && isDigit(src.charCodeAt(i + 1)))) {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(src)!;
      toks.push({ t: 'num', v: Number(m[0]), s: i, e: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (ch === '#') {
      const up = src.slice(i, i + 7).toUpperCase();
      const lit = ERR_LITERALS.find((x) => up.startsWith(x.error));
      const e = lit ? i + lit.error.length : i + 1;
      toks.push(lit ? { t: 'err', v: lit, s: i, e } : { t: 'bad', s: i, e });
      i = e;
      continue;
    }
    if (isWordStart(ch)) {
      const t = lexWord(src, i);
      toks.push(t);
      i = t.e;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') {
      toks.push({ t: 'op', v: two, s: i, e: i + 2 });
      i += 2;
      continue;
    }
    toks.push(OPS.includes(ch) ? { t: 'op', v: ch, s: i, e: i + 1 } : { t: 'bad', s: i, e: i + 1 });
    i++;
  }
  return toks;
}

// ---------------------------------------------------------------- parser

/** A cell (one) or a block; `sheet` lowercased for lookup, null for the formula's own sheet. */
interface RefNode { k: 'ref'; sheet: string | null; r1: number; c1: number; r2: number; c2: number; one: boolean }

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'err'; v: SheetError }
  | { k: 'miss' }
  | { k: 'name'; v: string }
  | RefNode
  | { k: 'neg' | 'pos' | 'pct'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; fn: FnDef | undefined; args: Node[] };

interface Compiled { ast: Node; refs: RefNode[] }

class ParseError extends Error {}

const CMP_OPS = new Set(['=', '<>', '<', '>', '<=', '>=']);
/** Nesting limit, so a pathological formula fails as #ERROR! instead of exhausting the stack. */
const MAX_DEPTH = 200;

function refNode(t: RefTok): RefNode {
  const sheet = t.sheet === null ? null : t.sheet.toLowerCase();
  const { a } = t;
  if (!t.b) return { k: 'ref', sheet, r1: a.r, c1: a.c, r2: a.r, c2: a.c, one: true };
  const b = t.b;
  const c1 = Math.min(a.c, b.c), c2 = Math.max(a.c, b.c);
  if (a.r < 0) return { k: 'ref', sheet, r1: 0, c1, r2: MAX_ROWS - 1, c2, one: false };
  return { k: 'ref', sheet, r1: Math.min(a.r, b.r), c1, r2: Math.max(a.r, b.r), c2, one: false };
}

class Parser {
  private i = 0;
  private depth = 0;
  private readonly toks: Tok[];
  readonly refs: RefNode[] = [];

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  parse(): Node {
    const n = this.cmp();
    if (this.i < this.toks.length) throw new ParseError();
    return n;
  }

  private op(): string | null {
    const t = this.toks[this.i];
    return t && t.t === 'op' ? t.v : null;
  }

  private nest(): void {
    if (++this.depth > MAX_DEPTH) throw new ParseError();
  }

  private cmp(): Node {
    let a = this.cat();
    for (let op = this.op(); op !== null && CMP_OPS.has(op); op = this.op()) {
      this.i++;
      a = { k: 'bin', op, a, b: this.cat() };
    }
    return a;
  }

  private cat(): Node {
    let a = this.add();
    while (this.op() === '&') {
      this.i++;
      a = { k: 'bin', op: '&', a, b: this.add() };
    }
    return a;
  }

  private add(): Node {
    let a = this.mul();
    for (let op = this.op(); op === '+' || op === '-'; op = this.op()) {
      this.i++;
      a = { k: 'bin', op, a, b: this.mul() };
    }
    return a;
  }

  private mul(): Node {
    let a = this.pow();
    for (let op = this.op(); op === '*' || op === '/'; op = this.op()) {
      this.i++;
      a = { k: 'bin', op, a, b: this.pow() };
    }
    return a;
  }

  // Left-associative, and its operands are unary: Excel's =-2^2 is 4, =2^3^2 is 64.
  private pow(): Node {
    let a = this.unary();
    while (this.op() === '^') {
      this.i++;
      a = { k: 'bin', op: '^', a, b: this.unary() };
    }
    return a;
  }

  private unary(): Node {
    const op = this.op();
    if (op === '-' || op === '+') {
      this.i++;
      this.nest();
      const a = this.unary();
      this.depth--;
      return { k: op === '-' ? 'neg' : 'pos', a };
    }
    let a = this.primary();
    while (this.op() === '%') {
      this.i++;
      a = { k: 'pct', a };
    }
    return a;
  }

  private primary(): Node {
    const t = this.toks[this.i++];
    if (!t) throw new ParseError();
    switch (t.t) {
      case 'num':
        return { k: 'num', v: t.v };
      case 'str':
        return { k: 'str', v: t.v };
      case 'err':
        return { k: 'err', v: t.v };
      case 'ref': {
        const n = refNode(t);
        this.refs.push(n);
        return n;
      }
      case 'id': {
        if (this.op() === '(') {
          this.i++;
          return this.call(t.v);
        }
        const up = t.v.toUpperCase();
        if (up === 'TRUE' || up === 'FALSE') return { k: 'bool', v: up === 'TRUE' };
        return { k: 'name', v: t.v };
      }
      case 'op': {
        if (t.v !== '(') break;
        this.nest();
        const inner = this.cmp();
        if (this.op() !== ')') throw new ParseError();
        this.i++;
        this.depth--;
        return inner;
      }
      default:
        break;
    }
    throw new ParseError();
  }

  private call(name: string): Node {
    this.nest();
    const args: Node[] = [];
    if (this.op() === ')') this.i++;
    else {
      for (;;) {
        const op = this.op();
        args.push(op === ',' || op === ')' ? { k: 'miss' } : this.cmp());
        const next = this.op();
        this.i++;
        if (next === ',') continue;
        if (next === ')') break;
        throw new ParseError();
      }
    }
    this.depth--;
    const up = name.toUpperCase();
    return { k: 'call', name: up, fn: FUNCS.get(up), args };
  }
}

function compileFormula(raw: string): Compiled {
  try {
    const p = new Parser(lex(raw, 1));
    const ast = p.parse();
    return { ast, refs: p.refs };
  } catch {
    return { ast: { k: 'err', v: ERROR }, refs: [] };
  }
}

/** Parsed formulas by raw text, so recomputing after each edit only parses what changed. */
const CACHE_MAX = 100_000;
const astCache = new Map<string, Compiled>();

function compile(raw: string): Compiled {
  const hit = astCache.get(raw);
  if (hit) return hit;
  const c = compileFormula(raw);
  if (astCache.size >= CACHE_MAX) {
    const oldest = astCache.keys().next();
    if (!oldest.done) astCache.delete(oldest.value);
  }
  astCache.set(raw, c);
  return c;
}

// ---------------------------------------------------------------- evaluator

type Visit = (v: CellValue, r: number, c: number) => SheetError | undefined | void;

class Ev {
  cur = 0;
  readonly vals: ReadonlyArray<Map<number, CellValue>>;
  readonly sheets: ReadonlyMap<string, number>;
  readonly now: number;

  constructor(vals: ReadonlyArray<Map<number, CellValue>>, sheets: ReadonlyMap<string, number>, now: number) {
    this.vals = vals;
    this.sheets = sheets;
    this.now = now;
  }

  get(s: number, r: number, c: number): CellValue {
    return this.vals[s]!.get(r * MAX_COLS + c) ?? null;
  }

  private sheetOf(name: string | null): number | undefined {
    return name === null ? this.cur : this.sheets.get(name);
  }

  ref(n: RefNode): Rng | SheetError {
    const s = this.sheetOf(n.sheet);
    if (s === undefined || n.r2 >= MAX_ROWS || n.c2 >= MAX_COLS) return REF;
    return new Rng(s, n.r1, n.c1, n.r2, n.c2);
  }

  /** A formula's final value: a 1×1 block is its cell, an empty cell shows as 0. */
  result(ast: Node): CellValue {
    const v = this.scalar(this.node(ast));
    if (v === null) return 0;
    return typeof v === 'number' ? fin(v) : v;
  }

  node(n: Node): Val {
    switch (n.k) {
      case 'num':
      case 'str':
      case 'bool':
      case 'err':
        return n.v;
      case 'miss':
        return null;
      case 'name':
        return NAME;
      case 'ref': {
        if (!n.one) return this.ref(n);
        const s = this.sheetOf(n.sheet);
        if (s === undefined || n.r1 >= MAX_ROWS || n.c1 >= MAX_COLS) return REF;
        return this.get(s, n.r1, n.c1);
      }
      case 'neg': {
        const x = toNum(this.sc(n.a));
        return typeof x === 'number' ? fin(-x) : x;
      }
      case 'pos':
        return this.sc(n.a);
      case 'pct': {
        const x = toNum(this.sc(n.a));
        return typeof x === 'number' ? x / 100 : x;
      }
      case 'bin':
        return binary(n.op, this.sc(n.a), this.sc(n.b));
      case 'call': {
        const fn = n.fn;
        if (!fn) return NAME;
        if (n.args.length < fn.min || n.args.length > fn.max) return VALUE;
        if (fn.lazy) return fn.lazy(this, n.args);
        const vals: Val[] = new Array(n.args.length);
        for (let i = 0; i < n.args.length; i++) vals[i] = this.arg(n.args[i]!);
        return fn.f!(this, vals);
      }
    }
  }

  /** A function argument: references stay blocks, so SUM can tell A1 from "text". */
  arg(n: Node): Val {
    return n.k === 'ref' ? this.ref(n) : this.node(n);
  }

  sc(n: Node): CellValue {
    return this.scalar(this.node(n));
  }

  scalar(v: Val): CellValue {
    if (!(v instanceof Rng)) return v;
    return v.r1 === v.r2 && v.c1 === v.c2 ? this.get(v.s, v.r1, v.c1) : VALUE;
  }

  num(v: Val): number | SheetError {
    return toNum(this.scalar(v));
  }

  str(v: Val): string | SheetError {
    return toText(this.scalar(v));
  }

  bool(v: Val): boolean | SheetError {
    return toBool(this.scalar(v));
  }

  /**
   * Visits a block's cells, stopping at the first error the visitor returns.
   * Without `blanks` only filled cells are visited, and a block bigger than the
   * sheet's filled cells (A:A) walks those cells instead, in no set order;
   * `ordered` forces row-major order.
   */
  each(g: Rng, fn: Visit, blanks = false, ordered = false): SheetError | undefined {
    const m = this.vals[g.s]!;
    if (!blanks && !ordered && g.h * g.w > m.size) {
      for (const [pos, v] of m) {
        const r = (pos / MAX_COLS) | 0;
        const c = pos - r * MAX_COLS;
        if (r < g.r1 || r > g.r2 || c < g.c1 || c > g.c2) continue;
        const e = fn(v, r, c);
        if (e) return e;
      }
      return undefined;
    }
    for (let r = g.r1; r <= g.r2; r++) {
      for (let c = g.c1; c <= g.c2; c++) {
        const v = m.get(r * MAX_COLS + c);
        if (v === undefined && !blanks) continue;
        const e = fn(v ?? null, r, c);
        if (e) return e;
      }
    }
    return undefined;
  }
}

function binary(op: string, a: CellValue, b: CellValue): CellValue {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  if (op === '&') return (toText(a) as string) + (toText(b) as string);
  if (CMP_OPS.has(op)) {
    const d = cmp(a, b);
    switch (op) {
      case '=': return d === 0;
      case '<>': return d !== 0;
      case '<': return d < 0;
      case '>': return d > 0;
      case '<=': return d <= 0;
      default: return d >= 0;
    }
  }
  const x = toNum(a);
  if (typeof x !== 'number') return x;
  const y = toNum(b);
  if (typeof y !== 'number') return y;
  switch (op) {
    case '+': return fin(x + y);
    case '-': return fin(x - y);
    case '*': return fin(x * y);
    case '/': return y === 0 ? DIV0 : fin(x / y);
    default: return power(x, y);
  }
}

function power(x: number, y: number): number | SheetError {
  if (x === 0 && y === 0) return NUM;
  if (x === 0 && y < 0) return DIV0;
  return fin(Math.pow(x, y));
}

// ---------------------------------------------------------------- functions

interface FnDef {
  min: number;
  max: number;
  /** Gets its arguments evaluated (references as blocks). */
  f?: (ev: Ev, a: Val[]) => Val;
  /** Evaluates its own arguments, for IF-style short circuits. */
  lazy?: (ev: Ev, a: Node[]) => Val;
}

const MANY = 255;
const eager = (min: number, max: number, f: (ev: Ev, a: Val[]) => Val): FnDef => ({ min, max, f });
const lazy = (min: number, max: number, f: (ev: Ev, a: Node[]) => Val): FnDef => ({ min, max, lazy: f });

/** Numeric arguments, `defs[i]` standing in for an absent optional one. */
function numsOf(ev: Ev, a: Val[], defs: ReadonlyArray<number>): number[] | SheetError {
  const out: number[] = [];
  for (let i = 0; i < defs.length; i++) {
    const v = a[i];
    if (v === undefined) {
      out.push(defs[i]!);
      continue;
    }
    const x = ev.num(v);
    if (typeof x !== 'number') return x;
    out.push(x);
  }
  return out;
}

const math1 = (f: (x: number) => number | SheetError): FnDef =>
  eager(1, 1, (ev, a) => {
    const x = ev.num(a[0]!);
    return typeof x === 'number' ? fin(f(x)) : x;
  });

const math2 = (f: (x: number, y: number) => number | SheetError, defY = NaN): FnDef =>
  eager(Number.isNaN(defY) ? 2 : 1, 2, (ev, a) => {
    const n = numsOf(ev, a, [0, defY]);
    if (!Array.isArray(n)) return n;
    return fin(f(n[0]!, n[1]!));
  });

const text1 = (f: (s: string) => Val): FnDef =>
  eager(1, 1, (ev, a) => {
    const s = ev.str(a[0]!);
    return typeof s === 'string' ? f(s) : s;
  });

/** Aggregate inputs: numbers in blocks (text, booleans and blanks skipped), direct arguments coerced. */
function collect(ev: Ev, a: Val[]): number[] | SheetError {
  const out: number[] = [];
  for (const v of a) {
    if (v instanceof Rng) {
      const e = ev.each(v, (x) => {
        if (typeof x === 'number') out.push(x);
        else if (isErr(x)) return x;
      });
      if (e) return e;
    } else if (v === null) continue;
    else if (typeof v === 'number') out.push(v);
    else if (typeof v === 'boolean') out.push(v ? 1 : 0);
    else if (typeof v === 'string') {
      const n = textToNum(v);
      if (n === null) return VALUE;
      out.push(n);
    } else return v;
  }
  return out;
}

const agg = (f: (xs: number[]) => number | SheetError): FnDef =>
  eager(1, MANY, (ev, a) => {
    const xs = collect(ev, a);
    return Array.isArray(xs) ? fin(f(xs)) : xs;
  });

const total = (xs: number[]): number => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};

const area = (g: Rng): number => g.h * g.w;

/** COUNTIF-style criteria: ">5", "<=3", "<>x", "=x", "x" with * and ? wildcards, or a value. */
function criterion(c: Exclude<CellValue, SheetError>): (v: CellValue) => boolean {
  if (typeof c === 'number') return (v) => numOf(v) === c;
  if (typeof c === 'boolean') return (v) => v === c;
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(c ?? '')!;
  const op = m[1] ?? '=';
  const rest = m[2]!;
  if (rest === '') {
    if (op === '=') return (v) => v === null || v === '';
    if (op === '<>') return (v) => v !== null && v !== '';
    return () => false;
  }
  const order = (d: number): boolean =>
    op === '<' ? d < 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : op === '>=' ? d >= 0 : op === '=' ? d === 0 : d !== 0;
  const n = textToNum(rest);
  if (n !== null) {
    if (op === '=') return (v) => numOf(v) === n;
    if (op === '<>') return (v) => numOf(v) !== n;
    return (v) => typeof v === 'number' && order(v < n ? -1 : v > n ? 1 : 0);
  }
  const up = rest.toUpperCase();
  if (up === 'TRUE' || up === 'FALSE') {
    const b = up === 'TRUE';
    if (op === '<>') return (v) => v !== b;
    return (v) => typeof v === 'boolean' && order(cmp(v, b));
  }
  if (op === '=' || op === '<>') {
    const re = wildcard(rest);
    const hit = (v: CellValue): boolean => typeof v === 'string' && re.test(v);
    return op === '=' ? hit : (v) => !hit(v);
  }
  return (v) => typeof v === 'string' && order(cmp(v, rest));
}

/** The number in a cell for criteria: numbers, and text that reads as one. */
function numOf(v: CellValue): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return textToNum(v);
  return null;
}

/** SUMIF / AVERAGEIF: the matching cells' partners in `target`, aligned to the criteria block. */
function conditional(ev: Ev, a: Val[], done: (sum: number, count: number) => Val): Val {
  const g = a[0];
  if (!(g instanceof Rng)) return isErr(g) ? g : VALUE;
  const crit = ev.scalar(a[1]!);
  if (isErr(crit)) return crit;
  const pred = criterion(crit);
  let target = g;
  const t = a[2];
  if (t !== undefined && t !== null) {
    if (!(t instanceof Rng)) return isErr(t) ? t : VALUE;
    target = t;
  }
  let sum = 0;
  let count = 0;
  const e = ev.each(
    g,
    (v, r, c) => {
      if (!pred(v)) return;
      const x = ev.get(target.s, target.r1 + r - g.r1, target.c1 + c - g.c1);
      if (typeof x === 'number') {
        sum += x;
        count++;
      } else if (isErr(x)) return x;
    },
    pred(null),
  );
  return e ?? done(sum, count);
}

/** Position of x in a vector: exact (0, wildcards for text), or sorted ascending (1) / descending (-1). */
function lookup(x: Exclude<CellValue, SheetError | null>, len: number, at: (i: number) => CellValue, mode: number): number {
  if (mode === 0) {
    const re = typeof x === 'string' ? wildcard(x) : null;
    for (let i = 0; i < len; i++) {
      const v = at(i);
      if (re) {
        if (typeof v === 'string' && re.test(v)) return i;
      } else if (typeof v === typeof x && cmp(v as typeof x, x) === 0) return i;
    }
    return -1;
  }
  let best = -1;
  for (let i = 0; i < len; i++) {
    const v = at(i);
    if (v === null || typeof v !== typeof x) continue;
    const d = cmp(v as typeof x, x);
    if (mode > 0 ? d <= 0 : d >= 0) best = i;
    else break;
  }
  return best;
}

function tableLookup(ev: Ev, a: Val[], vertical: boolean): Val {
  const x = ev.scalar(a[0]!);
  if (isErr(x)) return x;
  const g = a[1];
  if (!(g instanceof Rng)) return isErr(g) ? g : VALUE;
  const k = ev.num(a[2]!);
  if (typeof k !== 'number') return k;
  const idx = Math.trunc(k);
  if (idx < 1) return VALUE;
  if (idx > (vertical ? g.w : g.h)) return REF;
  const approx = a.length > 3 ? ev.bool(a[3]!) : true;
  if (typeof approx !== 'boolean') return approx;
  if (x === null) return NA;
  const len = vertical ? g.h : g.w;
  const i = lookup(x, len, (j) => (vertical ? ev.get(g.s, g.r1 + j, g.c1) : ev.get(g.s, g.r1, g.c1 + j)), approx ? 1 : 0);
  if (i < 0) return NA;
  return vertical ? ev.get(g.s, g.r1 + i, g.c1 + idx - 1) : ev.get(g.s, g.r1 + idx - 1, g.c1 + i);
}

/** Joins values in row-major order; blocks contribute every cell. */
function joinTexts(ev: Ev, a: Val[], sep: string, skipEmpty: boolean): string | SheetError {
  const parts: string[] = [];
  const add = (v: CellValue): SheetError | undefined => {
    const s = toText(v);
    if (typeof s !== 'string') return s;
    if (!(skipEmpty && s === '')) parts.push(s);
    return undefined;
  };
  for (const v of a) {
    const e = v instanceof Rng ? ev.each(v, add, !skipEmpty, true) : add(v);
    if (e) return e;
  }
  return parts.join(sep);
}

function substitute(s: string, from: string, to: string, nth: number | null): string {
  if (from === '') return s;
  if (nth === null) return s.split(from).join(to);
  let at = -1;
  for (let k = 0; k < nth; k++) {
    at = s.indexOf(from, at + 1);
    if (at < 0) return s;
  }
  return s.slice(0, at) + to + s.slice(at + from.length);
}

function findText(ev: Ev, a: Val[], insensitive: boolean): Val {
  const needle = ev.str(a[0]!);
  if (typeof needle !== 'string') return needle;
  const hay = ev.str(a[1]!);
  if (typeof hay !== 'string') return hay;
  const st = a.length > 2 ? ev.num(a[2]!) : 1;
  if (typeof st !== 'number') return st;
  const start = Math.trunc(st);
  if (start < 1 || start > hay.length + 1) return VALUE;
  if (!insensitive) {
    const i = hay.indexOf(needle, start - 1);
    return i < 0 ? VALUE : i + 1;
  }
  const re = new RegExp(wildcardSource(needle), 'i');
  const m = re.exec(hay.slice(start - 1));
  return m ? m.index + start : VALUE;
}

const datePart = (f: (d: Date) => number): FnDef =>
  math1((x) => (x < 0 ? NUM : f(new Date(serialToDate(Math.floor(x))))));

const FUNCS = new Map<string, FnDef>(Object.entries({
  // aggregates
  SUM: agg(total),
  AVERAGE: agg((xs) => (xs.length ? total(xs) / xs.length : DIV0)),
  MIN: agg((xs) => xs.reduce((m, x) => (x < m ? x : m), xs.length ? Infinity : 0)),
  MAX: agg((xs) => xs.reduce((m, x) => (x > m ? x : m), xs.length ? -Infinity : 0)),
  PRODUCT: agg((xs) => (xs.length ? xs.reduce((p, x) => p * x, 1) : 0)),
  MEDIAN: agg((xs) => {
    if (!xs.length) return NUM;
    const s = [...xs].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  }),
  STDEV: agg((xs) => {
    if (xs.length < 2) return DIV0;
    const mean = total(xs) / xs.length;
    let q = 0;
    for (const x of xs) q += (x - mean) ** 2;
    return Math.sqrt(q / (xs.length - 1));
  }),
  COUNT: eager(1, MANY, (ev, a) => {
    let n = 0;
    for (const v of a) {
      if (v instanceof Rng) {
        ev.each(v, (x) => {
          if (typeof x === 'number') n++;
        });
      } else if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && textToNum(v) !== null)) n++;
    }
    return n;
  }),
  COUNTA: eager(1, MANY, (ev, a) => {
    let n = 0;
    for (const v of a) {
      if (v instanceof Rng) {
        ev.each(v, () => {
          n++;
        });
      } else if (v !== null) n++;
    }
    return n;
  }),
  COUNTBLANK: eager(1, 1, (ev, a) => {
    const g = a[0];
    if (!(g instanceof Rng)) return isErr(g) ? g : VALUE;
    let filled = 0;
    ev.each(g, (v) => {
      if (v !== '') filled++;
    });
    return area(g) - filled;
  }),

  // conditional aggregates
  COUNTIF: eager(2, 2, (ev, a) => {
    const g = a[0];
    if (!(g instanceof Rng)) return isErr(g) ? g : VALUE;
    const crit = ev.scalar(a[1]!);
    if (isErr(crit)) return crit;
    const pred = criterion(crit);
    let n = 0;
    let filled = 0;
    ev.each(g, (v) => {
      filled++;
      if (pred(v)) n++;
    });
    return pred(null) ? n + area(g) - filled : n;
  }),
  SUMIF: eager(2, 3, (ev, a) => conditional(ev, a, (sum) => sum)),
  AVERAGEIF: eager(2, 3, (ev, a) => conditional(ev, a, (sum, count) => (count ? sum / count : DIV0))),

  // logic
  IF: lazy(2, 3, (ev, a) => {
    const c = toBool(ev.sc(a[0]!));
    if (typeof c !== 'boolean') return c;
    if (c) return ev.arg(a[1]!);
    return a[2] ? ev.arg(a[2]) : false;
  }),
  IFERROR: lazy(2, 2, (ev, a) => {
    const v = ev.sc(a[0]!);
    return isErr(v) ? ev.arg(a[1]!) : v;
  }),
  IFNA: lazy(2, 2, (ev, a) => {
    const v = ev.sc(a[0]!);
    return isErr(v) && v.error === '#N/A' ? ev.arg(a[1]!) : v;
  }),
  AND: eager(1, MANY, (ev, a) => logical(ev, a, true)),
  OR: eager(1, MANY, (ev, a) => logical(ev, a, false)),
  NOT: eager(1, 1, (ev, a) => {
    const b = ev.bool(a[0]!);
    return typeof b === 'boolean' ? !b : b;
  }),
  ISBLANK: eager(1, 1, (ev, a) => ev.scalar(a[0]!) === null),
  ISNUMBER: eager(1, 1, (ev, a) => typeof ev.scalar(a[0]!) === 'number'),
  ISTEXT: eager(1, 1, (ev, a) => typeof ev.scalar(a[0]!) === 'string'),
  ISERROR: eager(1, 1, (ev, a) => isErr(ev.scalar(a[0]!))),

  // rounding
  ROUND: math2((x, d) => roundTo(x, d, 'half'), 0),
  ROUNDUP: math2((x, d) => roundTo(x, d, 'up'), 0),
  ROUNDDOWN: math2((x, d) => roundTo(x, d, 'down'), 0),
  INT: math1(Math.floor),
  CEILING: math2((x, sig) => {
    if (sig === 0) return 0;
    if (x > 0 && sig < 0) return NUM;
    return Number((Math.ceil(Number((x / sig).toPrecision(15))) * sig).toPrecision(15));
  }, 1),
  FLOOR: math2((x, sig) => {
    if (sig === 0) return DIV0;
    if (x > 0 && sig < 0) return NUM;
    return Number((Math.floor(Number((x / sig).toPrecision(15))) * sig).toPrecision(15));
  }, 1),

  // math
  ABS: math1(Math.abs),
  SQRT: math1((x) => (x < 0 ? NUM : Math.sqrt(x))),
  POWER: math2(power),
  MOD: math2((x, d) => (d === 0 ? DIV0 : x - d * Math.floor(Number((x / d).toPrecision(15))))),
  LN: math1((x) => (x <= 0 ? NUM : Math.log(x))),
  LOG: math2((x, b) => (x <= 0 || b <= 0 ? NUM : b === 1 ? DIV0 : Math.log(x) / Math.log(b)), 10),
  LOG10: math1((x) => (x <= 0 ? NUM : Math.log10(x))),
  EXP: math1(Math.exp),
  PI: eager(0, 0, () => Math.PI),
  SIGN: math1(Math.sign),
  RAND: eager(0, 0, () => Math.random()),

  // text
  CONCAT: eager(1, MANY, (ev, a) => joinTexts(ev, a, '', false)),
  CONCATENATE: eager(1, MANY, (ev, a) => {
    let s = '';
    for (const v of a) {
      const t = ev.str(v);
      if (typeof t !== 'string') return t;
      s += t;
    }
    return s;
  }),
  LEN: text1((s) => s.length),
  UPPER: text1((s) => s.toUpperCase()),
  LOWER: text1((s) => s.toLowerCase()),
  TRIM: text1((s) => s.replace(/^ +| +$/g, '').replace(/ {2,}/g, ' ')),
  LEFT: eager(1, 2, (ev, a) => {
    const s = ev.str(a[0]!);
    if (typeof s !== 'string') return s;
    const n = a.length > 1 ? ev.num(a[1]!) : 1;
    if (typeof n !== 'number') return n;
    return n < 0 ? VALUE : s.slice(0, Math.trunc(n));
  }),
  RIGHT: eager(1, 2, (ev, a) => {
    const s = ev.str(a[0]!);
    if (typeof s !== 'string') return s;
    const n = a.length > 1 ? ev.num(a[1]!) : 1;
    if (typeof n !== 'number') return n;
    const k = Math.trunc(n);
    return k < 0 ? VALUE : k === 0 ? '' : s.slice(Math.max(0, s.length - k));
  }),
  MID: eager(3, 3, (ev, a) => {
    const s = ev.str(a[0]!);
    if (typeof s !== 'string') return s;
    const n = numsOf(ev, a.slice(1), [0, 0]);
    if (!Array.isArray(n)) return n;
    const start = Math.trunc(n[0]!), len = Math.trunc(n[1]!);
    if (start < 1 || len < 0) return VALUE;
    return s.slice(start - 1, start - 1 + len);
  }),
  SUBSTITUTE: eager(3, 4, (ev, a) => {
    const t: string[] = [];
    for (const v of a.slice(0, 3)) {
      const s = ev.str(v);
      if (typeof s !== 'string') return s;
      t.push(s);
    }
    let nth: number | null = null;
    if (a.length > 3) {
      const n = ev.num(a[3]!);
      if (typeof n !== 'number') return n;
      nth = Math.trunc(n);
      if (nth < 1) return VALUE;
    }
    return substitute(t[0]!, t[1]!, t[2]!, nth);
  }),
  FIND: eager(2, 3, (ev, a) => findText(ev, a, false)),
  SEARCH: eager(2, 3, (ev, a) => findText(ev, a, true)),
  TEXTJOIN: eager(3, MANY, (ev, a) => {
    const sep = ev.str(a[0]!);
    if (typeof sep !== 'string') return sep;
    const skip = ev.bool(a[1]!);
    if (typeof skip !== 'boolean') return skip;
    return joinTexts(ev, a.slice(2), sep, skip);
  }),
  VALUE: eager(1, 1, (ev, a) => {
    const v = ev.scalar(a[0]!);
    if (typeof v === 'number' || isErr(v)) return v;
    if (v === null) return 0;
    if (typeof v === 'boolean') return VALUE;
    return textToNum(v) ?? VALUE;
  }),

  // dates
  TODAY: eager(0, 0, (ev) => Math.floor(dateToSerial(ev.now))),
  NOW: eager(0, 0, (ev) => dateToSerial(ev.now)),
  DATE: eager(3, 3, (ev, a) => {
    const n = numsOf(ev, a, [0, 0, 0]);
    if (!Array.isArray(n)) return n;
    let y = Math.trunc(n[0]!);
    if (y >= 0 && y < 1900) y += 1900;
    if (y < 0 || y > 9999) return NUM;
    const s = dateToSerial(Date.UTC(y, Math.trunc(n[1]!) - 1, Math.trunc(n[2]!)));
    return s < 0 ? NUM : fin(s);
  }),
  YEAR: datePart((d) => d.getUTCFullYear()),
  MONTH: datePart((d) => d.getUTCMonth() + 1),
  DAY: datePart((d) => d.getUTCDate()),

  // lookup
  VLOOKUP: eager(3, 4, (ev, a) => tableLookup(ev, a, true)),
  HLOOKUP: eager(3, 4, (ev, a) => tableLookup(ev, a, false)),
  INDEX: eager(2, 3, (ev, a) => {
    const g = a[0]!;
    const n = numsOf(ev, a.slice(1), a.length > 2 ? [0, 0] : [0]);
    if (!Array.isArray(n)) return n;
    if (!(g instanceof Rng)) {
      if (isErr(g)) return g;
      return n.every((x) => Math.trunc(x) <= 1 && x >= 0) ? g : REF;
    }
    let r: number;
    let c: number;
    if (a.length > 2) {
      r = Math.trunc(n[0]!);
      c = Math.trunc(n[1]!);
    } else if (g.h === 1) {
      r = 1;
      c = Math.trunc(n[0]!);
    } else {
      r = Math.trunc(n[0]!);
      c = g.w === 1 ? 1 : 0;
    }
    if (r < 0 || c < 0 || r > g.h || c > g.w) return REF;
    // Row or column 0 hands back the whole column or row, as a block, like Excel's INDEX reference form.
    const r1 = r === 0 ? g.r1 : g.r1 + r - 1, r2 = r === 0 ? g.r2 : r1;
    const c1 = c === 0 ? g.c1 : g.c1 + c - 1, c2 = c === 0 ? g.c2 : c1;
    return new Rng(g.s, r1, c1, r2, c2);
  }),
  MATCH: eager(2, 3, (ev, a) => {
    const x = ev.scalar(a[0]!);
    if (isErr(x)) return x;
    const g = a[1];
    if (isErr(g)) return g;
    const t = a.length > 2 ? ev.num(a[2]!) : 1;
    if (typeof t !== 'number') return t;
    if (x === null || !(g instanceof Rng) || (g.h !== 1 && g.w !== 1)) return NA;
    const row = g.h === 1;
    const i = lookup(x, row ? g.w : g.h, (j) => (row ? ev.get(g.s, g.r1, g.c1 + j) : ev.get(g.s, g.r1 + j, g.c1)), Math.sign(Math.trunc(t)));
    return i < 0 ? NA : i + 1;
  }),
  CHOOSE: lazy(2, MANY, (ev, a) => {
    const k = toNum(ev.sc(a[0]!));
    if (typeof k !== 'number') return k;
    const i = Math.trunc(k);
    if (i < 1 || i >= a.length) return VALUE;
    return ev.arg(a[i]!);
  }),
}));

function logical(ev: Ev, a: Val[], all: boolean): Val {
  let seen = false;
  let acc = all;
  const take = (b: boolean): void => {
    seen = true;
    acc = all ? acc && b : acc || b;
  };
  for (const v of a) {
    if (v instanceof Rng) {
      const e = ev.each(v, (x) => {
        if (typeof x === 'boolean') take(x);
        else if (typeof x === 'number') take(x !== 0);
        else if (isErr(x)) return x;
      });
      if (e) return e;
    } else if (v !== null) {
      const b = toBool(v);
      if (typeof b !== 'boolean') return b;
      take(b);
    }
  }
  return seen ? acc : VALUE;
}

/** Signatures for autocomplete. */
export const FUNCTION_HELP: Record<string, string> = {
  SUM: 'SUM(number1, [number2], …)',
  AVERAGE: 'AVERAGE(number1, [number2], …)',
  MIN: 'MIN(number1, [number2], …)',
  MAX: 'MAX(number1, [number2], …)',
  COUNT: 'COUNT(value1, [value2], …)',
  COUNTA: 'COUNTA(value1, [value2], …)',
  COUNTBLANK: 'COUNTBLANK(range)',
  PRODUCT: 'PRODUCT(number1, [number2], …)',
  MEDIAN: 'MEDIAN(number1, [number2], …)',
  STDEV: 'STDEV(number1, [number2], …)',
  COUNTIF: 'COUNTIF(range, criteria)',
  SUMIF: 'SUMIF(range, criteria, [sum_range])',
  AVERAGEIF: 'AVERAGEIF(range, criteria, [average_range])',
  IF: 'IF(logical_test, value_if_true, [value_if_false])',
  IFERROR: 'IFERROR(value, value_if_error)',
  IFNA: 'IFNA(value, value_if_na)',
  AND: 'AND(logical1, [logical2], …)',
  OR: 'OR(logical1, [logical2], …)',
  NOT: 'NOT(logical)',
  ISBLANK: 'ISBLANK(value)',
  ISNUMBER: 'ISNUMBER(value)',
  ISTEXT: 'ISTEXT(value)',
  ISERROR: 'ISERROR(value)',
  ROUND: 'ROUND(number, num_digits)',
  ROUNDUP: 'ROUNDUP(number, num_digits)',
  ROUNDDOWN: 'ROUNDDOWN(number, num_digits)',
  INT: 'INT(number)',
  CEILING: 'CEILING(number, [significance])',
  FLOOR: 'FLOOR(number, [significance])',
  ABS: 'ABS(number)',
  SQRT: 'SQRT(number)',
  POWER: 'POWER(number, power)',
  MOD: 'MOD(number, divisor)',
  LN: 'LN(number)',
  LOG: 'LOG(number, [base])',
  LOG10: 'LOG10(number)',
  EXP: 'EXP(number)',
  PI: 'PI()',
  SIGN: 'SIGN(number)',
  RAND: 'RAND()',
  CONCAT: 'CONCAT(text1, [text2], …)',
  CONCATENATE: 'CONCATENATE(text1, [text2], …)',
  LEN: 'LEN(text)',
  UPPER: 'UPPER(text)',
  LOWER: 'LOWER(text)',
  TRIM: 'TRIM(text)',
  LEFT: 'LEFT(text, [num_chars])',
  RIGHT: 'RIGHT(text, [num_chars])',
  MID: 'MID(text, start_num, num_chars)',
  SUBSTITUTE: 'SUBSTITUTE(text, old_text, new_text, [instance_num])',
  FIND: 'FIND(find_text, within_text, [start_num])',
  SEARCH: 'SEARCH(find_text, within_text, [start_num])',
  TEXTJOIN: 'TEXTJOIN(delimiter, ignore_empty, text1, [text2], …)',
  VALUE: 'VALUE(text)',
  TODAY: 'TODAY()',
  NOW: 'NOW()',
  DATE: 'DATE(year, month, day)',
  YEAR: 'YEAR(serial_number)',
  MONTH: 'MONTH(serial_number)',
  DAY: 'DAY(serial_number)',
  VLOOKUP: 'VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])',
  HLOOKUP: 'HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])',
  INDEX: 'INDEX(array, row_num, [column_num])',
  MATCH: 'MATCH(lookup_value, lookup_array, [match_type])',
  CHOOSE: 'CHOOSE(index_num, value1, [value2], …)',
};

// ---------------------------------------------------------------- workbook evaluation

function lowerBound(ids: number[], rowOf: number[], r: number): number {
  let lo = 0, hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowOf[ids[mid]!]! < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Every non-empty cell's value, per sheet. Formulas are ordered by their
 * static references with an iterative Tarjan pass: each strongly connected
 * group comes out after everything it reads, so a cell is evaluated once and
 * cells are never recursed into. Cycles, and cells that read them, are #CIRC!.
 */
export function evaluateWorkbook(wb: WorkbookInput, opts?: { now?: number }): Array<Map<string, CellValue>> {
  const now = opts?.now ?? Date.now();
  const sheets = wb.sheets;
  const sheetIdx = new Map<string, number>();
  sheets.forEach((sh, i) => {
    const k = sh.name.toLowerCase();
    if (!sheetIdx.has(k)) sheetIdx.set(k, i);
  });
  const vals = sheets.map(() => new Map<number, CellValue>());
  const out = sheets.map(() => new Map<string, CellValue>());

  // Formula cells, by number: sheet, grid position, row, key and parse.
  const fSheet: number[] = [];
  const fPos: number[] = [];
  const fRow: number[] = [];
  const fKey: string[] = [];
  const fComp: Compiled[] = [];
  const fAt = sheets.map(() => new Map<number, number>());
  const byCol: Array<Array<number[] | undefined>> = sheets.map(() => []);

  sheets.forEach((sh, s) => {
    const cells = sh.cells;
    for (const key in cells) {
      const raw = cells[key]?.v;
      if (typeof raw !== 'string' || raw === '') continue;
      const p = parseKey(key);
      if (!p || p.r >= MAX_ROWS || p.c >= MAX_COLS) continue;
      const pos = p.r * MAX_COLS + p.c;
      if (isFormula(raw)) {
        const id = fSheet.length;
        fSheet.push(s);
        fPos.push(pos);
        fRow.push(p.r);
        fKey.push(key);
        fComp.push(compile(raw));
        fAt[s]!.set(pos, id);
        (byCol[s]![p.c] ??= []).push(id);
      } else {
        const v = parseLiteral(raw);
        vals[s]!.set(pos, v);
        out[s]!.set(key, v);
      }
    }
  });
  for (const cols of byCol) for (const ids of cols) ids?.sort((x, y) => fRow[x]! - fRow[y]!);

  const N = fSheet.length;
  const deps: number[][] = new Array(N);
  for (let i = 0; i < N; i++) {
    const own = fSheet[i]!;
    const d: number[] = [];
    for (const ref of fComp[i]!.refs) {
      const s = ref.sheet === null ? own : sheetIdx.get(ref.sheet);
      if (s === undefined) continue;
      if (ref.one) {
        if (ref.r1 >= MAX_ROWS || ref.c1 >= MAX_COLS) continue;
        const j = fAt[s]!.get(ref.r1 * MAX_COLS + ref.c1);
        if (j !== undefined) d.push(j);
        continue;
      }
      const cols = byCol[s]!;
      const last = Math.min(ref.c2, MAX_COLS - 1);
      for (let c = ref.c1; c <= last; c++) {
        const ids = cols[c];
        if (!ids) continue;
        for (let k = lowerBound(ids, fRow, ref.r1); k < ids.length && fRow[ids[k]!]! <= ref.r2; k++) d.push(ids[k]!);
      }
    }
    deps[i] = d;
  }

  const ev = new Ev(vals, sheetIdx, now);
  const circ = new Uint8Array(N);
  const settle = (id: number, v: CellValue): void => {
    const s = fSheet[id]!;
    vals[s]!.set(fPos[id]!, v);
    out[s]!.set(fKey[id]!, v);
  };
  const evaluate = (id: number): void => {
    const d = deps[id]!;
    for (let k = 0; k < d.length; k++) {
      if (circ[d[k]!]) {
        circ[id] = 1;
        settle(id, CIRC);
        return;
      }
    }
    ev.cur = fSheet[id]!;
    let v: CellValue;
    try {
      v = ev.result(fComp[id]!.ast);
    } catch {
      v = ERROR;
    }
    settle(id, v);
  };

  // Iterative Tarjan: index, lowlink, the SCC stack and an explicit call stack.
  const index = new Int32Array(N).fill(-1);
  const low = new Int32Array(N);
  const onStack = new Uint8Array(N);
  const edge = new Int32Array(N);
  const stack: number[] = [];
  const calls: number[] = [];
  let counter = 0;
  const open = (v: number): void => {
    index[v] = low[v] = counter++;
    stack.push(v);
    onStack[v] = 1;
    edge[v] = 0;
    calls.push(v);
  };
  for (let root = 0; root < N; root++) {
    if (index[root] !== -1) continue;
    open(root);
    while (calls.length) {
      const v = calls[calls.length - 1]!;
      const d = deps[v]!;
      const k = edge[v]!;
      if (k < d.length) {
        edge[v] = k + 1;
        const w = d[k]!;
        if (index[w] === -1) open(w);
        else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
        continue;
      }
      calls.pop();
      const parent = calls[calls.length - 1];
      if (parent !== undefined) low[parent] = Math.min(low[parent]!, low[v]!);
      if (low[v] !== index[v]) continue;
      const group: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = 0;
        group.push(w);
      } while (w !== v);
      if (group.length > 1 || d.includes(v)) {
        for (const g of group) {
          circ[g] = 1;
          settle(g, CIRC);
        }
      } else evaluate(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------- reference rewriting

function partText(p: Part): string {
  return (p.cAbs ? '$' : '') + colName(p.c) + (p.r < 0 ? '' : (p.rAbs ? '$' : '') + (p.r + 1));
}

/** Rewrites each reference token for which `fn` returns new text; everything else is kept verbatim. */
function rewriteRefs(raw: string, fn: (t: RefTok) => string | null): string {
  if (!isFormula(raw)) return raw;
  let out = '';
  let last = 0;
  for (const t of lex(raw, 1)) {
    if (t.t !== 'ref') continue;
    const rep = fn(t);
    if (rep === null) continue;
    out += raw.slice(last, t.s) + rep;
    last = t.e;
  }
  return last === 0 ? raw : out + raw.slice(last);
}

function shiftPart(p: Part, dRow: number, dCol: number): Part | null {
  const c = p.cAbs ? p.c : p.c + dCol;
  const r = p.r < 0 || p.rAbs ? p.r : p.r + dRow;
  if (c !== p.c && (c < 0 || c >= MAX_COLS)) return null;
  if (r !== p.r && (r < 0 || r >= MAX_ROWS)) return null;
  return { ...p, c, r };
}

/** Copy/fill: relative parts move by (dRow, dCol), $-anchored parts stay; off the grid is #REF!. */
export function shiftFormula(raw: string, dRow: number, dCol: number): string {
  if (dRow === 0 && dCol === 0) return raw;
  return rewriteRefs(raw, (t) => {
    const a = shiftPart(t.a, dRow, dCol);
    const b = t.b ? shiftPart(t.b, dRow, dCol) : null;
    if (!a || (t.b && !b)) return '#REF!';
    const same = a.r === t.a.r && a.c === t.a.c && (!b || (b.r === t.b!.r && b.c === t.b!.c));
    return same ? null : t.prefix + partText(a) + (b ? ':' + partText(b) : '');
  });
}

export interface ReferencedRange {
  sheet: string | null;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  start: number;
  end: number;
}

/** Each reference in a formula with its [start, end) offsets in `raw`, for colouring while editing. */
export function referencedRanges(raw: string): ReferencedRange[] {
  if (!isFormula(raw)) return [];
  const out: ReferencedRange[] = [];
  for (const t of lex(raw, 1)) {
    if (t.t !== 'ref') continue;
    const n = refNode(t);
    out.push({ sheet: t.sheet, r1: n.r1, c1: n.c1, r2: n.r2, c2: n.c2, start: t.s, end: t.e });
  }
  return out;
}

// ---------------------------------------------------------------- structure edits

type BookLike = { sheets: ReadonlyArray<{ name: string; cells: Readonly<Record<string, { v: string }>> }> };
type SheetOf<W extends BookLike> = W['sheets'][number];
type CellOf<W extends BookLike> = SheetOf<W>['cells'][string];

interface Edit { sheet: number; axis: 'r' | 'c'; at: number; count: number; del: boolean }

/** Where index i lands after the edit; -1 when it was deleted. */
function moved(i: number, e: Edit): number {
  if (i < e.at) return i;
  if (!e.del) return i + e.count;
  return i >= e.at + e.count ? i - e.count : -1;
}

function withIdx(p: Part, axis: 'r' | 'c', v: number): Part {
  return axis === 'r' ? { ...p, r: v } : { ...p, c: v };
}

/** A reference after a row/column edit of its sheet: moved, grown, shrunk, or #REF!. */
function editRef(t: RefTok, e: Edit): string | null {
  if (e.axis === 'r' && t.a.r < 0) return null; // whole columns ignore row edits
  const limit = e.axis === 'r' ? MAX_ROWS : MAX_COLS;
  const ia = t.a[e.axis];
  if (!t.b) {
    const j = moved(ia, e);
    if (j === ia) return null;
    return j < 0 || j >= limit ? '#REF!' : t.prefix + partText(withIdx(t.a, e.axis, j));
  }
  const ib = t.b[e.axis];
  const lo = Math.min(ia, ib), hi = Math.max(ia, ib);
  let nlo: number, nhi: number;
  if (!e.del) {
    nlo = moved(lo, e);
    nhi = moved(hi, e);
  } else {
    const end = e.at + e.count;
    if (lo >= e.at && hi < end) return '#REF!';
    nlo = lo < e.at ? lo : lo >= end ? lo - e.count : e.at;
    nhi = hi < e.at ? hi : hi >= end ? hi - e.count : e.at - 1;
  }
  if (nlo >= limit) return '#REF!';
  // A range that already ran to the grid's edge stays pinned there.
  if (nhi >= limit) nhi = limit - 1;
  if (nlo === lo && nhi === hi) return null;
  const aLow = ia <= ib;
  const a = withIdx(t.a, e.axis, aLow ? nlo : nhi);
  const b = withIdx(t.b, e.axis, aLow ? nhi : nlo);
  return t.prefix + partText(a) + ':' + partText(b);
}

function sheetIndexMap(sheets: BookLike['sheets']): Map<string, number> {
  const m = new Map<string, number>();
  sheets.forEach((sh, i) => {
    const k = sh.name.toLowerCase();
    if (!m.has(k)) m.set(k, i);
  });
  return m;
}

/**
 * Rewrites every formula in every sheet with `fix`, and rebuilds the cells of
 * sheet `move.sheet` through `move.key` (null drops a cell). Unchanged sheets
 * and cells keep their identity; cells keep their other fields.
 */
function rebuild<W extends BookLike>(
  wb: W,
  fix: (raw: string, host: number) => string,
  move?: { sheet: number; key: (r: number, c: number) => string | null },
): W {
  const sheets = wb.sheets.map((sh, s) => {
    const cells = sh.cells as Readonly<Record<string, CellOf<W>>>;
    const rekey = move && move.sheet === s ? move.key : null;
    let next: Record<string, CellOf<W>> | null = rekey ? {} : null;
    for (const key in cells) {
      const cell = cells[key]!;
      const v = isFormula(cell.v) ? fix(cell.v, s) : cell.v;
      const nc = v === cell.v ? cell : ({ ...cell, v } as CellOf<W>);
      if (rekey) {
        const p = parseKey(key);
        const nk = p ? rekey(p.r, p.c) : key;
        if (nk !== null) next![nk] = nc;
      } else if (nc !== cell) {
        next ??= { ...cells };
        next[key] = nc;
      }
    }
    return next ? { ...sh, cells: next } : sh;
  });
  return { ...wb, sheets } as W;
}

function structural<W extends BookLike>(wb: W, e: Edit): W {
  const sheet = wb.sheets[e.sheet];
  const limit = e.axis === 'r' ? MAX_ROWS : MAX_COLS;
  if (!sheet || !(e.count > 0) || !(e.at >= 0) || e.at >= limit) return wb;
  e.at = Math.floor(e.at);
  e.count = Math.floor(e.count);
  if (e.del) e.count = Math.min(e.count, limit - e.at);
  else {
    // Like Excel, refuse an insert that would push filled cells off the grid.
    for (const key in sheet.cells) {
      const p = parseKey(key);
      if (!p || sheet.cells[key]!.v === '') continue;
      const i = p[e.axis];
      if (i >= e.at && i + e.count >= limit) return wb;
    }
  }
  const names = sheetIndexMap(wb.sheets);
  const fix = (raw: string, host: number): string =>
    rewriteRefs(raw, (t) => {
      const target = t.sheet === null ? host : names.get(t.sheet.toLowerCase());
      return target === e.sheet ? editRef(t, e) : null;
    });
  return rebuild(wb, fix, {
    sheet: e.sheet,
    key: (r, c) => {
      const i = moved(e.axis === 'r' ? r : c, e);
      if (i < 0 || i >= limit) return null;
      return e.axis === 'r' ? cellKey(i, c) : cellKey(r, i);
    },
  });
}

export function insertRows<W extends BookLike>(wb: W, sheetIndex: number, at: number, count: number): W {
  return structural(wb, { sheet: sheetIndex, axis: 'r', at, count, del: false });
}

export function deleteRows<W extends BookLike>(wb: W, sheetIndex: number, at: number, count: number): W {
  return structural(wb, { sheet: sheetIndex, axis: 'r', at, count, del: true });
}

export function insertCols<W extends BookLike>(wb: W, sheetIndex: number, at: number, count: number): W {
  return structural(wb, { sheet: sheetIndex, axis: 'c', at, count, del: false });
}

export function deleteCols<W extends BookLike>(wb: W, sheetIndex: number, at: number, count: number): W {
  return structural(wb, { sheet: sheetIndex, axis: 'c', at, count, del: true });
}

const PLAIN_SHEET = /^[\p{L}_][\p{L}\p{N}_.]*$/u;
const CELL_LIKE = /^[A-Za-z]{1,3}\d+$/;

/** A sheet name as a formula prefix needs it: quoted (quotes doubled) unless it is a plain word. */
function quoteSheet(name: string): string {
  return PLAIN_SHEET.test(name) && !CELL_LIKE.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** Renames a sheet and every reference to it, in every sheet. */
export function renameSheet<W extends BookLike>(wb: W, sheetIndex: number, newName: string): W {
  const sheet = wb.sheets[sheetIndex];
  if (!sheet) return wb;
  const old = sheet.name.toLowerCase();
  const prefix = quoteSheet(newName) + '!';
  const fix = (raw: string): string =>
    rewriteRefs(raw, (t) =>
      t.sheet !== null && t.sheet.toLowerCase() === old && t.prefix !== prefix ? prefix + raw.slice(t.s + t.prefix.length, t.e) : null,
    );
  const next = rebuild(wb, fix);
  const sheets = next.sheets.map((sh, i) => (i === sheetIndex ? { ...sh, name: newName } : sh));
  return { ...next, sheets } as W;
}

// ---------------------------------------------------------------- display

/** Up to 10 significant digits, trailing zeros trimmed; E notation for the very large and small. */
function general(n: number): string {
  if (n === 0) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const r = Number(n.toPrecision(10));
  const s = String(r);
  if (Math.abs(r) < 1e15 && !s.includes('e')) return s;
  const [m, e] = r.toExponential(9).split('e');
  const exp = Number(e);
  return `${m!.replace(/\.?0+$/, '')}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
}

function fixed(n: number, dp: number): string {
  const r = roundTo(n, dp, 'half');
  return (r === 0 ? 0 : r).toFixed(dp);
}

/** "-1234.5" → "-1,234.5"; E notation is left alone. */
function grouped(s: string): string {
  if (/e/i.test(s)) return s;
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  return (neg ? '-' : '') + int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac === undefined ? '' : '.' + frac);
}

export function formatValue(
  v: CellValue,
  f?: { fmt?: 'num' | 'pct' | 'usd' | 'date' | 'text'; dp?: number },
): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.error;
  const dp = f?.dp === undefined || !Number.isFinite(f.dp) ? undefined : Math.min(20, Math.max(0, Math.trunc(f.dp)));
  const plain = (n: number): string => (dp === undefined ? general(n) : fixed(n, dp));
  switch (f?.fmt) {
    case 'num':
      return grouped(plain(v));
    case 'pct':
      return plain(v * 100) + '%';
    case 'usd': {
      const places = dp ?? 2;
      const r = roundTo(Math.abs(v), places, 'half');
      return (v < 0 && r !== 0 ? '-$' : '$') + grouped(r.toFixed(places));
    }
    case 'date': {
      const d = new Date(serialToDate(Math.floor(v)));
      const y = d.getUTCFullYear();
      if (Number.isNaN(d.getTime()) || y < 0 || y > 9999) return general(v);
      return d.toISOString().slice(0, 10);
    }
    default:
      return plain(v);
  }
}
