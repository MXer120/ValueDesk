/**
 * Identicon: a 5x5 mirrored grid and a hue, both from the address bytes, so the
 * same wallet always gets the same face (blockies-style, written in-house; no
 * dependency). Used by the search palette, the address book's own contacts and
 * the X posts' accounts (components/Identicon.tsx draws it).
 */

/** FNV-1a over the lower-cased address. */
function hash32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface IdenticonSpec {
  hue: number;
  /** 25 cells, row-major, mirrored left/right. */
  cells: boolean[];
}

export function identicon(address: string): IdenticonSpec {
  const a = address.toLowerCase();
  const h1 = hash32(a);
  const h2 = hash32(a, 0x9e3779b9);
  const cells: boolean[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const col = x < 3 ? x : 4 - x; // mirror
      const bit = y * 3 + col; // 15 bits
      cells.push(((h2 >>> bit) & 1) === 1);
    }
  }
  // Never an empty face.
  if (!cells.some(Boolean)) cells[12] = true;
  return { hue: h1 % 360, cells };
}
