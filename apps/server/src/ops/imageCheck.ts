/**
 * Is this upload a screenshot, and only that? (The feedback form's attachments,
 * routes/reports.ts; owner, 2026-10-27: images only, "bc of hack/malware risk".)
 *
 * Judged by the BYTES, never by a file name or a Content-Type: a PNG, a JPEG or a
 * WebP whose structure is whole - the PNG's chunks walked from the signature to
 * IEND, the JPEG's segments to its frame header and its end marker, the WebP's
 * RIFF size matching the file - with NOTHING after the end of the image. That is
 * what defeats a polyglot (an image with a script, an archive or a page appended)
 * and a renamed file. On top, a scan for markup anywhere in the bytes, and the
 * image's own width and height inside sane bounds.
 *
 * The browser re-encodes every screenshot through a canvas before it uploads
 * (apps/web/src/feedback/images.ts), which already drops metadata and anything
 * appended; this check does not rely on that.
 */

export type ImageKind = 'png' | 'jpeg' | 'webp';

export const IMAGE_TYPES: Record<ImageKind, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_SIDE = 10_000;
export const MAX_PIXELS = 40_000_000;

export type ImageCheck = { ok: true; kind: ImageKind; width: number; height: number } | { ok: false; error: string };

const MARKUP = ['<script', '<html', '<?php', '<svg', '<iframe', '<!doctype', '<body', '<?xml', '%pdf-'];

const u32 = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u16 = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const le16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const le32 = (b: Uint8Array, i: number): number => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number): string => String.fromCharCode(...b.subarray(i, i + n));

function png(b: Uint8Array): { width: number; height: number } | string {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!SIG.every((v, i) => b[i] === v)) return 'not a PNG';
  let i = 8;
  let dims: { width: number; height: number } | null = null;
  for (let n = 0; n < 100_000; n++) {
    if (i + 12 > b.length) return 'the PNG is cut short';
    const len = u32(b, i);
    const type = ascii(b, i + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return 'the PNG has a broken chunk';
    if (i + 12 + len > b.length) return 'the PNG is cut short';
    if (n === 0) {
      if (type !== 'IHDR' || len !== 13) return 'the PNG has no header';
      dims = { width: u32(b, i + 8), height: u32(b, i + 12) };
    }
    i += 12 + len;
    if (type === 'IEND') return i === b.length ? dims! : 'there is data after the end of the PNG';
  }
  return 'the PNG has too many chunks';
}

function jpeg(b: Uint8Array): { width: number; height: number } | string {
  if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return 'not a JPEG';
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return 'there is data after the end of the JPEG';
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return 'the JPEG has a broken segment';
    const m = b[i + 1]!;
    if (m === 0xff) { i += 1; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = u16(b, i + 2);
    if (len < 2 || i + 2 + len > b.length) return 'the JPEG is cut short';
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) {
      if (len < 7) return 'the JPEG has a broken frame header';
      return { height: u16(b, i + 5), width: u16(b, i + 7) };
    }
    if (m === 0xda || m === 0xd9) return 'the JPEG has no frame header';
    i += 2 + len;
  }
  return 'the JPEG is cut short';
}

function webp(b: Uint8Array): { width: number; height: number } | string {
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return 'not a WebP';
  const size = le32(b, 4) + 8;
  if (size !== b.length && size + 1 !== b.length) return 'there is data after the end of the WebP';
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return 'the WebP has a broken frame';
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b.length >= 25) {
    if (b[20] !== 0x2f) return 'the WebP has a broken frame';
    const v = le32(b, 21);
    return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  return 'the WebP has no image';
}

/** The verdict on one upload. */
export function checkImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length < 16) return { ok: false, error: 'the file is not an image' };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: 'the image is larger than 2 MB' };
  const kind: ImageKind | null =
    bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpeg' : ascii(bytes, 0, 4) === 'RIFF' ? 'webp' : null;
  if (!kind) return { ok: false, error: 'only PNG, JPEG and WebP images can be attached' };
  const dims = kind === 'png' ? png(bytes) : kind === 'jpeg' ? jpeg(bytes) : webp(bytes);
  if (typeof dims === 'string') return { ok: false, error: dims };
  const { width, height } = dims;
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    return { ok: false, error: 'the image has impossible dimensions' };
  }
  // Markup or an archive anywhere in the bytes: not a screenshot, whatever its header says.
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1').toLowerCase();
  if (MARKUP.some((m) => text.includes(m))) return { ok: false, error: 'the file holds something other than an image' };
  return { ok: true, kind, width, height };
}
