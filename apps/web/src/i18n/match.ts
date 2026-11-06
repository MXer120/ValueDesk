/**
 * Looking up a piece of on-screen English in a language's catalogue (public/i18n/<code>.json, keyed by
 * the English). Exact text first, then patterns: "{0} of {1}" came from a template in the code, so
 * "11 of 14" finds it and the numbers carry over in the order the translation wants them. A miss returns
 * null and the English stays, so nothing here can garble what it does not know.
 *
 * Patterns are matched by walking their literal pieces with indexOf, never by regular expression: with
 * several holes a regex backtracks without end on text it does not match, and that froze the page. This is
 * linear in the text. Each value is as short as it can be, and a value that is itself a known word comes
 * through translated ('made', 'rises'); numbers and names have no entry and pass as they are.
 */

export type Catalogue = Readonly<Record<string, string>>;

const HOLE = /\{(\d+)\}/g;
/** Longer than any label or sentence in the app: long text is someone's data, not ours. */
const MAX_PATTERN_TEXT = 400;
/* Endings and the verb that agrees with them ('order' + 's are', 'order' + ' is'). */
const ENGLISH_ENDING = new Set(['s', 'es', 'y', 'ies', 's are', ' is', 'is', 'are']);

interface Pattern {
  /** The literal text between the holes: one more piece than there are holes, the first and last may be empty. */
  pieces: string[];
  holes: string[];
  to: string;
}

/** Whether `s` has a word in it: a price, a time or a lone mark is never looked up. */
export const hasWords = (s: string): boolean => /\p{L}{2}/u.test(s);

/** The placeholders a catalogue entry uses, sorted: the same set on both sides or the entry is wrong. */
export function holesOf(s: string): string[] {
  return [...s.matchAll(HOLE)].map((m) => m[1]!).sort();
}

/** The values of `text` under this pattern, or null when it does not fit. */
function valuesOf(p: Pattern, text: string): string[] | null {
  const first = p.pieces[0]!;
  const last = p.pieces[p.pieces.length - 1]!;
  if (!text.startsWith(first) || !text.endsWith(last) || text.length < first.length + last.length + p.holes.length) return null;
  const end = text.length - last.length;
  const out: string[] = [];
  let at = first.length;
  for (let i = 1; i < p.pieces.length - 1; i++) {
    // +1: a value is never empty.
    const next = text.indexOf(p.pieces[i]!, at + 1);
    if (next < 0 || next >= end) return null;
    out.push(text.slice(at, next));
    at = next + p.pieces[i]!.length;
  }
  if (at >= end) return null;
  out.push(text.slice(at, end));
  return out;
}

export function createMatcher(catalogue: Catalogue, cacheSize = 4000) {
  const exact = new Map<string, string>();
  const byStart = new Map<string, Pattern[]>();
  const open: Pattern[] = [];
  for (const [key, to] of Object.entries(catalogue)) {
    if (!to) continue;
    if (!/\{\d+\}/.test(key)) {
      exact.set(key, to);
      continue;
    }
    const parts = key.split(/\{\d+\}/);
    // Two holes side by side, or nothing but holes: no way to tell the values apart, so the English stays.
    if (parts.slice(1, -1).some((m) => m === '') || !hasWords(parts.join(''))) continue;
    const p: Pattern = { pieces: parts, holes: [...key.matchAll(HOLE)].map((m) => m[1]!), to };
    if (parts[0]!.length >= 2) {
      const bucket = parts[0]!.slice(0, 2);
      byStart.set(bucket, [...(byStart.get(bucket) ?? []), p]);
    } else {
      open.push(p);
    }
  }
  // The most literal text first: "{0} of {1} wallets" before "{0} of {1}".
  const weight = (p: Pattern) => p.pieces.join('').length;
  for (const list of byStart.values()) list.sort((a, b) => weight(b) - weight(a));
  open.sort((a, b) => weight(b) - weight(a));
  const seen = new Map<string, string | null>();

  const byPattern = (core: string): string | null => {
    if (core.length > MAX_PATTERN_TEXT) return null;
    for (const list of [byStart.get(core.slice(0, 2)), open]) {
      for (const p of list ?? []) {
        const values = valuesOf(p, core);
        if (!values) continue;
        return p.to.replace(HOLE, (_, n: string) => {
          const v = values[p.holes.indexOf(n)] ?? '';
          // The code's English plural ending ("order" + "s", "retr" + "ies") means nothing in another language.
          if (ENGLISH_ENDING.has(v)) return '';
          return exact.get(v.trim()) ?? v;
        });
      }
    }
    return null;
  };

  /** The translation of `text` (its own outer spaces kept), or null to leave it. */
  return function translate(text: string): string | null {
    const core = text.trim();
    if (!core || !hasWords(core)) return null;
    let hit = seen.get(core);
    if (hit === undefined) {
      hit = exact.get(core) ?? exact.get(core.replace(/\s+/g, ' ')) ?? byPattern(core);
      if (seen.size >= cacheSize) seen.clear(); // clocks and prices make new strings all day
      seen.set(core, hit);
    }
    if (hit === null) return null;
    if (core === text) return hit;
    const start = text.indexOf(core);
    return text.slice(0, start) + hit + text.slice(start + core.length);
  };
}
