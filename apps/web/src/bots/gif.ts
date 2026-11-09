/**
 * A small animated-GIF encoder for the VIP share card (owner 2026-11-08: share as image or GIF, made in the browser,
 * so nothing is uploaded and no server has to be rate-limited). GIF89a, one global 256-colour palette tuned to the
 * card (greys and golds), looping forever, LZW as the format defines it (after omggif's writer).
 */

/** The palette: 96 greys and 160 golds (two strengths), enough for the card's ink, gold and white. */
function cardPalette(): Uint8Array {
  const p = new Uint8Array(256 * 3);
  let n = 0;
  const put = (r: number, g: number, b: number) => { p[n * 3] = r; p[n * 3 + 1] = g; p[n * 3 + 2] = b; n++; };
  for (let i = 0; i < 96; i++) { const v = Math.round((i / 95) * 255); put(v, v, v); }
  // Gold ramp: dark bronze, gold, light cream (the app's #8a651f, #d4a748, #f6dc8e, #fff1c2).
  const stops: Array<[number, number, number, number]> = [[0, 26, 20, 8], [0.3, 138, 101, 31], [0.6, 212, 167, 72], [0.82, 246, 220, 142], [1, 255, 241, 194]];
  const at = (t: number, k: 1 | 2 | 3) => {
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1]!, b = stops[i]!;
      if (t <= b[0]) { const f = (t - a[0]) / (b[0] - a[0]); return a[k] + (b[k] - a[k]) * f; }
    }
    return stops[stops.length - 1]![k];
  };
  for (let s = 0; s < 2; s++) {
    for (let i = 0; i < 80; i++) {
      const t = i / 79;
      const r = at(t, 1), g = at(t, 2), b = at(t, 3);
      // The second strength: halfway to grey, for soft light and glows.
      const m = (r + g + b) / 3;
      const w = s === 0 ? 1 : 0.5;
      put(Math.round(m + (r - m) * w), Math.round(m + (g - m) * w), Math.round(m + (b - m) * w));
    }
  }
  return p;
}

/** The nearest palette colour for every 5-bit RGB, worked out once. */
function lookup(pal: Uint8Array): Uint8Array {
  const out = new Uint8Array(32 * 32 * 32);
  for (let r = 0; r < 32; r++) for (let g = 0; g < 32; g++) for (let b = 0; b < 32; b++) {
    const R = r * 8 + 4, G = g * 8 + 4, B = b * 8 + 4;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 256; i++) {
      const dr = pal[i * 3]! - R, dg = pal[i * 3 + 1]! - G, db = pal[i * 3 + 2]! - B;
      const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
      if (d < bestD) { bestD = d; best = i; }
    }
    out[(r << 10) | (g << 5) | b] = best;
  }
  return out;
}

class Bytes {
  buf: number[] = [];
  byte(b: number) { this.buf.push(b & 0xff); }
  word(w: number) { this.byte(w); this.byte(w >> 8); }
  str(s: string) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  all(a: ArrayLike<number>) { for (let i = 0; i < a.length; i++) this.buf.push(a[i]!); }
}

/** LZW-compress one frame's palette indices into GIF sub-blocks. */
function lzw(out: Bytes, idx: Uint8Array, min = 8): void {
  out.byte(min);
  const clear = 1 << min, eoi = clear + 1;
  let next = eoi + 1, size = min + 1;
  let table = new Map<number, number>();
  const block: number[] = [];
  let cur = 0, shift = 0;
  const flushBlock = () => { if (!block.length) return; out.byte(block.length); out.all(block); block.length = 0; };
  const emit = (code: number) => {
    cur |= code << shift;
    shift += size;
    while (shift >= 8) { block.push(cur & 0xff); cur >>>= 8; shift -= 8; if (block.length === 255) flushBlock(); }
  };
  emit(clear);
  let prefix = idx[0]!;
  for (let i = 1; i < idx.length; i++) {
    const k = idx[i]!;
    const key = (prefix << 8) | k;
    const code = table.get(key);
    if (code !== undefined) { prefix = code; continue; }
    emit(prefix);
    if (next === 4096) { emit(clear); next = eoi + 1; size = min + 1; table = new Map(); }
    else { if (next >= 1 << size) size++; table.set(key, next++); }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (shift > 0) { block.push(cur & 0xff); if (block.length === 255) flushBlock(); }
  flushBlock();
  out.byte(0);
}

/**
 * Encode frames (RGBA, all `w` x `h`) as a looping GIF, `delayMs` each. Yields to the page between frames so the
 * popup stays responsive while it works.
 */
export async function encodeGif(frames: ImageData[], w: number, h: number, delayMs: number): Promise<Blob> {
  const pal = cardPalette();
  const near = lookup(pal);
  const out = new Bytes();
  out.str('GIF89a');
  out.word(w); out.word(h);
  out.byte(0xf7); // global table, 8 bits, 256 colours
  out.byte(0); out.byte(0);
  out.all(pal);
  // Loop forever (NETSCAPE2.0).
  out.byte(0x21); out.byte(0xff); out.byte(11); out.str('NETSCAPE2.0'); out.byte(3); out.byte(1); out.word(0); out.byte(0);
  const idx = new Uint8Array(w * h);
  for (const f of frames) {
    const d = f.data;
    for (let i = 0, j = 0; i < idx.length; i++, j += 4) idx[i] = near[((d[j]! >> 3) << 10) | ((d[j + 1]! >> 3) << 5) | (d[j + 2]! >> 3)]!;
    out.byte(0x21); out.byte(0xf9); out.byte(4); out.byte(0); out.word(Math.round(delayMs / 10)); out.byte(0); out.byte(0);
    out.byte(0x2c); out.word(0); out.word(0); out.word(w); out.word(h); out.byte(0);
    lzw(out, idx);
    await new Promise((r) => setTimeout(r, 0));
  }
  out.byte(0x3b);
  return new Blob([new Uint8Array(out.buf)], { type: 'image/gif' });
}
