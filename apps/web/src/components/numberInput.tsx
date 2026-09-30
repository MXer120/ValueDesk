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

/**
 * What a decimal box keeps of a keystroke or a paste: digits and ONE decimal
 * point (and a leading minus when `signed`).
 *
 * Commas: with no point in the box, a single comma IS the decimal point ("0,5")
 * and several are thousands separators ("1,234,567"). With a point present every
 * comma goes - a pasted "83,941.5" is 83941.5, and a comma typed after "1.5" is
 * dropped rather than turning the point into a thousands separator (which would
 * silently make it 15). A second point is dropped the same way.
 */
export function decimalInput(raw: string, opts: { signed?: boolean } = {}): string {
  let s = raw.trim();
  const neg = opts.signed === true && s.startsWith('-');
  if (!s.includes('.')) {
    const commas = s.split(',').length - 1;
    s = commas === 1 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else {
    s = s.replace(/,/g, '');
  }
  s = s.replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  return (neg ? '-' : '') + s;
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
export function tickInput(raw: string, tick: string | undefined): string {
  const cleaned = decimalInput(raw);
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
      value={draft ?? value}
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
