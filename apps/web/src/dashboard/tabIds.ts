/**
 * Extra tab ids (tabExtras.tsx), without React: a widget (`news`), another
 * market's chart (`asset:SOL-USD`), and a duplicate of either (`news#2`).
 */
/** A tab key for an extra: `x:<id>`. */
export const extraKey = (id: string) => `x:${id}`;
export const isExtraKey = (key: string) => key.startsWith('x:');
/** `news#2` -> `news`; `asset:SOL-USD#2` -> `asset:SOL-USD`. */
export const baseOf = (id: string) => id.replace(/#\d+$/, '');
/** The copy number of a duplicate (`news#2` -> 2), or null for the first. */
export const copyOf = (id: string): number | null => {
  const m = /#(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
};
export const assetOf = (id: string): string | null => {
  const b = baseOf(id);
  return b.startsWith('asset:') ? b.slice(6) : null;
};

/** `id` again, as the next free copy (`news`, then `news#2`, `news#3`...). */
export function nextCopy(ids: readonly string[], id: string): string {
  const base = baseOf(id);
  if (!ids.includes(base)) return base;
  let n = 2;
  while (ids.includes(`${base}#${n}`)) n += 1;
  return `${base}#${n}`;
}
