/**
 * A lossless patch between two JSON values, for the live channels (routes/liveHub.ts) and the browser that applies them
 * (apps/web/src/live/liveSocket.ts imports this same file). apply(a, diff(a, b)) is always deep-equal to b: nothing is
 * rounded or dropped, so a pushed window is the very answer the HTTP route would give (owner rule: never trade away
 * fidelity for bytes).
 *
 * Why not the whole answer each time: a forming BTC candle's Trade flow answer is 10-20 KB and a print moves a handful of
 * its rows; a cohort page is ~15 KB brotli and a new load moves numbers but keeps the shape. A patch carries only what moved.
 *
 * Shape of a patch (P):
 *   undefined                     nothing changed (diff's result; never sent)
 *   { $: value }                  replace with value
 *   { o: { key: P }, x?: [keys] } an object: changed keys' patches, keys gone
 *   { a: [ref...] }               an array, rebuilt from refs in order:
 *                                   number i       the old element i as it was
 *                                   [i, P]         the old element i, patched
 *                                   { $: value }   a new element
 *
 * Array elements are matched by identity when they carry one (idOf: a row's venue + key, a cohort's id, a coin), else by
 * position. A reordered table of 100 rows therefore costs ~100 small integers, not 100 rows.
 */

export type Patch =
  | { $: unknown }
  | { o: Record<string, Patch>; x?: string[] }
  | { a: Array<number | [number, Patch] | { $: unknown }> };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An element's identity inside an array, or null (matched by position). */
export function idOf(v: unknown): string | null {
  if (!isObj(v)) return null;
  const venue = typeof v.venue === 'string' ? v.venue : '';
  for (const k of ['id', 'key', 'address', 'coin', 'symbol', 'sector']) {
    const x = v[k];
    if (typeof x === 'string' || typeof x === 'number') return `${venue}|${k}|${x}`;
  }
  return null;
}

/** The patch from a to b, or undefined when they are equal. */
export function diff(a: unknown, b: unknown): Patch | undefined {
  if (a === b) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) return diffArray(a, b);
  if (isObj(a) && isObj(b)) {
    const o: Record<string, Patch> = {};
    const x: string[] = [];
    let any = false;
    for (const k of Object.keys(b)) {
      if (!(k in a)) { o[k] = { $: b[k] }; any = true; continue; }
      const p = diff(a[k], b[k]);
      if (p !== undefined) { o[k] = p; any = true; }
    }
    for (const k of Object.keys(a)) if (!(k in b)) { x.push(k); any = true; }
    if (!any) return undefined;
    return x.length ? { o, x } : { o };
  }
  // Numbers, strings, booleans, null, or a change of type: equal only when identical (NaN is not JSON).
  return { $: b };
}

function diffArray(a: unknown[], b: unknown[]): Patch | undefined {
  // Identity when every element on both sides has one and none repeats; else by position.
  const ids = (xs: unknown[]): string[] | null => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of xs) {
      const id = idOf(v);
      if (id === null || seen.has(id)) return null;
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  const ia = ids(a);
  const ib = ia && ids(b);
  const refs: Array<number | [number, Patch] | { $: unknown }> = [];
  let same = a.length === b.length;
  if (ia && ib) {
    const at = new Map(ia.map((id, i) => [id, i]));
    b.forEach((v, j) => {
      const i = at.get(ib[j]!);
      if (i === undefined) { refs.push({ $: v }); same = false; return; }
      const p = diff(a[i], v);
      if (p === undefined) refs.push(i); else refs.push([i, p]);
      if (i !== j || p !== undefined) same = false;
    });
  } else {
    b.forEach((v, j) => {
      if (j >= a.length) { refs.push({ $: v }); same = false; return; }
      const p = diff(a[j], v);
      if (p === undefined) refs.push(j); else { refs.push([j, p]); same = false; }
    });
  }
  if (same) return undefined;
  // A series that slid by one point (a spark line) patches every element: then the array itself is shorter.
  const patch = { a: refs };
  return JSON.stringify(patch).length < JSON.stringify(b).length + 6 ? patch : { $: b };
}

/** b from a and diff(a, b). The input is not changed; unchanged parts are shared with it (React keeps their identity). */
export function apply(a: unknown, p: Patch | undefined): unknown {
  if (p === undefined) return a;
  if ('$' in p) return p.$;
  if ('a' in p) {
    const old = Array.isArray(a) ? a : [];
    return p.a.map((r) => {
      if (typeof r === 'number') return old[r];
      if (Array.isArray(r)) return apply(old[r[0]], r[1]);
      return r.$;
    });
  }
  const out: Obj = isObj(a) ? { ...a } : {};
  for (const [k, sub] of Object.entries(p.o)) out[k] = apply(out[k], sub);
  for (const k of p.x ?? []) delete out[k];
  return out;
}
