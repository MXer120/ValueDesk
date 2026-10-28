/**
 * Number boxes for the order ticket (and anything else that takes a typed
 * amount).
 *
 * THE TICKET READ WHAT IT WAS GIVEN, AND THAT WAS THE BUG.
 *   - A comma is how a de-DE keyboard types a decimal point. "0,01" in the size
 *     box was no size at all (no order value, no margin), and "83900,5" in the
 *     price box was valued as 83900 - parseFloat stops at the comma - so the
 *     ticket previewed one order and would have signed another.
 *   - Boxes whose shown value is DERIVED (the % of balance, the gain a TP price
 *     implies) re-derived on every keystroke: "5" became "5.00", the next "0"
 *     landed after the decimals, and "50" could not be typed. `DraftInput` shows
 *     exactly what is being typed while it has focus, and the derived value again
 *     once it has not.
 */
import { useState, type InputHTMLAttributes } from 'react';
import { parseNumInput, toInputText } from '../numStyle';

/**
 * What a decimal box keeps of a keystroke or a paste: the MACHINE string ("."
 * decimal, no grouping - what state holds and what is sent), digits and ONE
 * decimal point (and a leading minus when `signed`). The box SHOWS it through
 * `toInputText` (numStyle.ts): the chosen decimal mark, never grouping, so the
 * text being edited is never itself ambiguous.
 *
 * TYPING (one keystroke at a time, the box showing canonical text):
 *   - one mark, "." or ",": it is the decimal point, whichever the format.
 *     A de-DE keypad types ",", a plain one "."; both mean the same, and the
 *     box at once shows it as the format's own mark, so what it took is visible.
 *   - a mark typed after a decimal point is dropped ("1,5" + "." stays 1.5);
 *     a second point anywhere keeps the first one ("1..5" is 1.5). A mark is
 *     never promoted to a thousands separator by a keystroke - that would
 *     silently make 1.234 into 1234.
 *   - several of one kind in valid groups of three ("1,234,567") and a full
 *     grouped figure ("83,941.5", "83.941,5") are read as grouped: that text
 *     only arrives by a paste.
 * A PASTE (or `pasted: true`) is read strictly by `parseNumInput`: "1.234,5"
 * and "1,234.5" are both 1234.5, and an AMBIGUOUS figure - "1.000" in the
 * 1.234,56 format, "1,000" in 1,234.56 - is refused (the box keeps `prev`, or
 * empties) with a hint saying what to type, never read as a guess.
 */
export function decimalInput(raw: string, opts: { signed?: boolean; prev?: string; pasted?: boolean } = {}): string {
  const isPaste = opts.pasted ?? takePaste(raw);
  let s = raw.replace(/[\s   '’]/g, '');
  const neg = opts.signed === true && /^[\-−]/.test(s);
  s = s.replace(/[^\d.,]/g, '');
  const sign = neg ? '-' : '';
  if (isPaste && /\d/.test(s)) {
    const p = parseNumInput(s);
    if (p.ok) return sign + p.value;
    hint(p.error);
    return opts.prev ?? '';
  }
  return sign + typed(s);
}

/** The keystroke rules above, on text of digits and marks only. */
function typed(s: string): string {
  const dots = s.split('.').length - 1;
  const commas = s.split(',').length - 1;
  if (dots + commas === 0) return s;
  if (dots + commas === 1) return s.replace(',', '.');
  const last = s[s.length - 1]!;
  // A stray mark typed at the end of a figure that already has one: dropped.
  if ((last === '.' || last === ',') && /[.,]/.test(s.slice(0, -1))) return typed(s.slice(0, -1));
  // A whole grouped figure (only a paste writes one): read as grouped.
  if (/^\d/.test(s)) {
    const p = parseNumInput(s);
    if (p.ok) return p.value;
  }
  // Otherwise the first mark is the point; every later mark goes.
  const at = s.search(/[.,]/);
  return `${s.slice(0, at)}.${s.slice(at + 1).replace(/[.,]/g, '')}`;
}

/**
 * Whether the text being read came from a paste: the capture listener notes the
 * field pasted (or dropped) into, and the read counts as a paste only when it is
 * THAT field's own current text, within a second. So a sanitizer run on a
 * computed machine value (tickInput on a toFixed price at submit) is never read
 * by the paste rule, however soon after a paste it runs.
 */
let pasted: { el: HTMLInputElement; at: number } | null = null;
if (typeof document !== 'undefined') {
  const mark = (e: Event) => {
    pasted = e.target instanceof HTMLInputElement ? { el: e.target, at: Date.now() } : null;
  };
  document.addEventListener('paste', mark, true);
  document.addEventListener('drop', mark, true);
}
function takePaste(raw: string): boolean {
  const p = pasted;
  if (!p || Date.now() - p.at > 1000 || p.el.value !== raw) return false;
  pasted = null;
  return true;
}

/** The refusal, as a toast (loaded on demand: tests and the parser stay free of the UI). */
function hint(message: string): void {
  if (typeof window === 'undefined') return;
  void import('../toast').then((m) => m.notify('warn', message)).catch(() => {});
}

/** Whole numbers only (a percentage, a multiplier), at most `maxDigits` long. */
export const integerInput = (raw: string, maxDigits = 3): string => raw.replace(/\D/g, '').slice(0, maxDigits);

/** "0.01000" -> "0.01", "5.000" -> "5", "120" -> "120": a converted size without the padding toFixed adds. */
export const trimZeros = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

const scaled = (text: string, scale: number): bigint => {
  const [i = '0', f = ''] = text.split('.');
  const digits = (i === '' ? '0' : i) + f.padEnd(scale, '0').slice(0, scale);
  return BigInt(digits.replace(/^0+(?=\d)/, '') || '0');
};

const fromScaled = (n: bigint, scale: number): string => {
  let s = n.toString().padStart(scale + 1, '0');
  if (scale === 0) return s.replace(/^0+(?=\d)/, '');
  const head = s.slice(0, s.length - scale).replace(/^0+(?=\d)/, '') || '0';
  const tail = s.slice(s.length - scale).replace(/0+$/, '');
  return tail ? `${head}.${tail}` : head;
};

const onGrid = (text: string, step: string, scale: number): boolean => {
  const s = scaled(step, scale);
  return s === 0n || scaled(text, scale) % s === 0n;
};

const nearest = (text: string, step: string, scale: number): string => {
  const s = scaled(step, scale);
  const v = scaled(text, scale);
  if (s === 0n) return fromScaled(v, scale);
  let q = v / s;
  const r = v % s;
  if (r * 2n >= s) q += 1n;
  return fromScaled(q * s, scale);
};

/** Some completion of the missing decimal places lands on the tick. */
const completable = (intPart: string, frac: string, scale: number, step: string): boolean => {
  const missing = scale - frac.length;
  if (missing <= 0) return onGrid(`${intPart}.${frac}`, step, scale);
  const base = scaled(`${intPart}.${frac}`, scale);
  const span = 10n ** BigInt(missing);
  const s = scaled(step, scale);
  if (s === 0n) return true;
  let k = base / s;
  if (k * s < base) k += 1n;
  return k * s < base + span;
};

/**
 * A price box that cannot hold an off-tick value.
 *
 * Extra decimals past the tick are refused. A digit that cannot be finished
 * into a multiple of the tick is replaced by the nearest tick, so the field
 * never sits on a price the venue would have to correct.
 */
export function tickInput(raw: string, tick: string | undefined, prev?: string): string {
  const cleaned = decimalInput(raw, { prev });
  if (!tick) return cleaned;
  const step = trimZeros(tick);
  if (!/^\d+(\.\d+)?$/.test(step) || step === '0') return cleaned;
  const scale = (step.split('.')[1] ?? '').length;
  if (cleaned === '') return '';

  if (scale === 0) {
    const [whole = '', frac = ''] = cleaned.split('.');
    if (frac === '') return whole === '' ? '' : (onGrid(whole, step, 0) ? whole.replace(/^0+(?=\d)/, '') : nearest(whole, step, 0));
    const snapped = nearest(`${whole || '0'}.${frac}`, step, frac.length);
    return snapped;
  }

  if (cleaned === '.') return '.';
  const dot = cleaned.indexOf('.');
  const intPart = dot >= 0 ? cleaned.slice(0, dot) : cleaned;
  const frac = dot >= 0 ? cleaned.slice(dot + 1) : '';
  if (frac.length > scale) return tickInput(`${intPart}.${frac.slice(0, scale)}`, tick);

  const body = intPart === '' ? '0' : intPart;
  if (cleaned.endsWith('.') || frac.length < scale) {
    if (completable(body, frac, scale, step)) return cleaned;
    return nearest(frac.length ? `${body}.${frac}` : body, step, scale);
  }
  const full = `${body}.${frac}`;
  if (onGrid(full, step, scale)) return intPart === '' ? `.${frac}` : `${intPart}.${frac}`;
  return nearest(full, step, scale);
}

/**
 * An input whose shown value is derived elsewhere. While focused it holds the
 * text being typed (each change still reported through `onDraft`); on blur it
 * goes back to showing `value`.
 */
export function DraftInput({ value, onDraft, sanitize, onFocus, onBlur, ...rest }: {
  value: string;
  onDraft: (text: string) => void;
  sanitize: (raw: string) => string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      // A figure, not a form field: no browser history dropdown under it.
      autoComplete="off"
      {...rest}
      // Machine text in state; the format's decimal mark on screen (numStyle.ts).
      value={toInputText(draft ?? value)}
      onFocus={(e) => {
        setDraft(value);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setDraft(null);
        onBlur?.(e);
      }}
      onChange={(e) => {
        const text = sanitize(e.target.value);
        setDraft(text);
        onDraft(text);
      }}
    />
  );
}
