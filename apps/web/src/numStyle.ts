/**
 * The number format: which characters group thousands and mark decimals
 * (Settings > Appearance > Number format; owner, 2026-10-28: "per default ...
 * . for spacing and , for decimals. Can be changed in settings").
 *
 * THE ONE PLACE the separators are chosen. Every formatter that puts a number on
 * the screen builds it in en-US first (Intl's 'en-US', toFixed, or an exact
 * decimal string) and hands it to `localize`, which swaps the two characters for
 * the chosen ones. Building in en-US and swapping - rather than formatting with
 * a 'de-DE' Intl - keeps every other detail of the string identical across the
 * settings: compact suffixes stay "K"/"M"/"B" (de-DE would write "Mio."), signs,
 * units and rounding do not move. Only the two separator characters change.
 *
 * DISPLAY ONLY. Nothing here is ever sent: order prices and sizes, API payloads,
 * CSV exports and clipboard copies stay machine format ("." decimal, no
 * grouping). An input field's text goes through `parseNumInput`, which returns
 * the machine string - or refuses an ambiguous entry rather than guess.
 */
import { useSyncExternalStore } from 'react';
import { formatNumber } from './intlCache';

export type NumStyle = 'dot-comma' | 'comma-dot' | 'space-comma' | 'apos-dot';

export interface NumSeps {
  /** Between groups of three digits. */
  group: string;
  /** Before the fraction. */
  decimal: string;
}

/** NO-BREAK SPACE: a grouped figure never wraps across a line. */
const NBSP = ' ';

export const NUM_STYLES: Record<NumStyle, NumSeps & { label: string; sample: string }> = {
  'dot-comma': { group: '.', decimal: ',', label: '1.234.567,89', sample: '1.234.567,89' },
  'comma-dot': { group: ',', decimal: '.', label: '1,234,567.89', sample: '1,234,567.89' },
  'space-comma': { group: NBSP, decimal: ',', label: '1 234 567,89', sample: `1${NBSP}234${NBSP}567,89` },
  'apos-dot': { group: '’', decimal: '.', label: '1’234’567.89', sample: '1’234’567.89' },
};

export const NUM_STYLE_LIST = Object.keys(NUM_STYLES) as NumStyle[];

/** The app's default (owner, 2026-10-28): "." groups, "," marks decimals. */
export const NUM_STYLE_DEFAULT: NumStyle = 'dot-comma';

const KEY = 'vs.numberFormat';
const listeners = new Set<() => void>();

const isStyle = (v: unknown): v is NumStyle => typeof v === 'string' && v in NUM_STYLES;

function load(): NumStyle {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    return isStyle(v) ? v : NUM_STYLE_DEFAULT;
  } catch {
    return NUM_STYLE_DEFAULT;
  }
}

let current: NumStyle = load();
let seps: NumSeps = NUM_STYLES[current];

export const getNumStyle = (): NumStyle => current;
export const getNumSeps = (): NumSeps => seps;

/** Switch the format; every subscribed view re-renders at once, no reload. Kept in this browser. */
export function setNumStyle(style: NumStyle): void {
  if (!isStyle(style)) return;
  current = style;
  seps = NUM_STYLES[style];
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, style);
  } catch { /* private mode: this tab only */ }
  for (const l of [...listeners]) l();
}

export function subscribeNumStyle(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** The current format, re-rendering the caller when it changes. */
export function useNumStyle(): NumStyle {
  return useSyncExternalStore(subscribeNumStyle, getNumStyle, getNumStyle);
}

// Another tab changed it: follow.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY && isStyle(e.newValue) && e.newValue !== current) setNumStyle(e.newValue);
  });
}

/**
 * An en-US number text in the chosen format: "," -> group, "." -> decimal.
 *
 * Only for text that is a number (with its sign, currency glyph, unit or compact
 * suffix: "$1,234.5K", "+0.25%", "1.5x"). Never a sentence - its commas would
 * turn into dots.
 */
export function localize(s: string): string {
  const { group, decimal } = seps;
  if (group === ',' && decimal === '.') return s;
  return s.replace(/[.,]/g, (c) => (c === ',' ? group : decimal));
}

/** `n.toLocaleString('en-US', options)`, cached, in the chosen format. */
export function fmtNum(n: number, options?: Intl.NumberFormatOptions): string {
  return localize(formatNumber(n, 'en-US', options));
}

/** `n.toFixed(dp)` (no grouping, exactly as toFixed rounds) in the chosen format. */
export function fmtFixed(n: number, dp: number): string {
  return localize(n.toFixed(dp));
}

/** The plain number as JS writes it (`String(n)`), decimal mark swapped. No grouping. */
export function fmtPlain(n: number | string): string {
  return localize(String(n));
}

/**
 * An exact decimal string ("-1234567.891", as a venue sends it) grouped and in
 * the chosen format - no float round trip, so every digit stays as given.
 */
export function fmtDecimalString(s: string): string {
  const m = /^([+\-−]?)(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return s;
  const int = m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, seps.group);
  return `${m[1]}${int}${m[3] !== undefined && m[3] !== '' ? seps.decimal + m[3] : ''}`;
}

/* ===========================================================================
 *  Inputs
 * ======================================================================== */

/**
 * A machine number ("1234.5", as kept in state and sent) as an input shows it:
 * the chosen decimal mark, NO grouping. Grouping inside an input is what makes
 * "1.000" ambiguous, so the app never writes it there.
 */
export function toInputText(machine: string | number | null | undefined): string {
  if (machine === null || machine === undefined) return '';
  const s = String(machine);
  return seps.decimal === '.' ? s : s.replace('.', seps.decimal);
}

export type ParsedInput =
  | { ok: true; value: string }
  | { ok: false; value: null; error: string };

/**
 * What a number field's text means, as a machine string ("1234.5") - or why it
 * cannot be read. THE RULE (both formats accept both marks where it is safe):
 *
 * 1. Spaces (any kind) and apostrophes (' ’) are grouping, and dropped.
 * 2. Both "." and "," present: the LAST one is the decimal mark; the other is
 *    grouping and must sit between groups of exactly three digits.
 *    "1.234,5" and "1,234.5" are both 1234.5, in any format.
 * 3. One kind only, appearing more than once: grouping (groups of three, a
 *    first group of 1-3 digits not starting with 0). "1.000.000" = 1,000,000.
 * 4. One kind only, once:
 *    - it is the format's own decimal mark: decimal ("1,5" = 1.5 in 1.234,56).
 *    - it is the other mark and could NOT be grouping (not exactly three digits
 *      after it, or the part before is 0 / starts with 0 / has 4+ digits):
 *      decimal, for convenience - "1.5", "0.001", "1234.567", ".5".
 *    - it is the other mark and COULD be grouping ("1.000", "12.345" in
 *      1.234,56; "1,000" in 1,234.56): AMBIGUOUS, refused with a hint. Never
 *      a guess: 1.000 BTC and 1000 BTC are both plausible orders.
 *
 * Empty text is `{ ok: true, value: '' }` (an empty field). A leading "-" is
 * kept only when `allowNegative`.
 */
export function parseNumInput(
  text: string,
  opts: { style?: NumStyle; allowNegative?: boolean } = {},
): ParsedInput {
  const dec = NUM_STYLES[opts.style ?? current].decimal;
  const other = dec === ',' ? '.' : ',';
  let s = text.replace(/[\s   '’]/g, '');
  if (s === '') return { ok: true, value: '' };
  let sign = '';
  if (/^[\-−]/.test(s)) {
    if (!opts.allowNegative) return bad('Enter a positive number');
    sign = '-';
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return bad('Not a number');

  const dots = count(s, '.');
  const commas = count(s, ',');
  let int: string;
  let frac = '';

  if (dots > 0 && commas > 0) {
    const decMark = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const grpMark = decMark === '.' ? ',' : '.';
    if (count(s, decMark) !== 1) return bad(hintFor(dec));
    const at = s.indexOf(decMark);
    const head = s.slice(0, at);
    frac = s.slice(at + 1);
    if (frac.includes(grpMark) || !validGroups(head, grpMark)) return bad(hintFor(dec));
    int = head.split(grpMark).join('');
  } else if (dots + commas === 0) {
    int = s;
  } else {
    const mark = dots > 0 ? '.' : ',';
    const n = dots + commas;
    if (n > 1) {
      if (!validGroups(s, mark)) return bad(hintFor(dec));
      int = s.split(mark).join('');
    } else {
      const at = s.indexOf(mark);
      const head = s.slice(0, at);
      const tail = s.slice(at + 1);
      const couldGroup = tail.length === 3 && /^[1-9]\d{0,2}$/.test(head);
      if (mark === other && couldGroup) {
        return bad(`Ambiguous: “${text.trim()}”. Write ${head}${tail} or ${head}${dec}${tail}`);
      }
      int = head;
      frac = tail;
    }
  }
  if (int === '' && frac === '') return bad('Not a number');
  const intNorm = int.replace(/^0+(?=\d)/, '') || '0';
  const value = frac === '' ? intNorm : `${intNorm}.${frac}`;
  return { ok: true, value: sign && Number(value) !== 0 ? `-${value}` : value };
}

const count = (s: string, c: string): number => s.split(c).length - 1;
const bad = (error: string): ParsedInput => ({ ok: false, value: null, error });
const hintFor = (dec: string): string => `Not a number. Decimals with “${dec}”, e.g. 1234${dec}5`;

/** "1.234.567" with `mark` "." is valid grouping: first group 1-3 digits (no leading 0), then threes. */
function validGroups(s: string, mark: string): boolean {
  const parts = s.split(mark);
  if (parts.length === 1) return /^\d+$/.test(s);
  return /^[1-9]\d{0,2}$/.test(parts[0]!) && parts.slice(1).every((p) => /^\d{3}$/.test(p));
}
