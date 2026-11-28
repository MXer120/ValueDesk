/**
 * An index's picture (owner 2026-11-28: "make it possible to upload an image for the custom index, although a default
 * is generated. Ensure we cant get hacked through this"). The file never leaves the browser as it was picked:
 *
 *   only PNG, JPEG or WebP the browser itself can decode (createImageBitmap), never SVG or anything with markup
 *   redrawn on a canvas, centre-cropped to a 256 px square and encoded anew (WebP, else PNG): metadata, anything
 *   appended and anything that is not pixels is gone
 *   at most INDEX_IMAGE_MAX_BYTES, hashed (SHA-256) and the hash signed with the index
 *
 * The server checks the bytes again on its own (ops/imageCheck.ts) and serves them content-addressed with nosniff and a
 * sandboxing CSP; pages show them only as <img src>. A picture is never a URL someone typed.
 */
import { INDEX_IMAGE_MAX_BYTES } from '@sign/indexes/claim';

export const PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp';
export const PICTURE_SIDE = 256;
/** What the picker takes before re-encoding: a phone photo is fine, a 50 MB file is not. */
export const PICTURE_PICK_MAX = 12 * 1024 * 1024;

export interface Picture { bytes: Uint8Array; hash: string; dataUrl: string }

const toBlob = (c: HTMLCanvasElement, type: string, q?: number): Promise<Blob | null> => new Promise((r) => c.toBlob(r, type, q));

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}

const toDataUrl = (blob: Blob): Promise<string> => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });

/** The picked file as the index's picture, or a sentence why not. */
export async function makePicture(file: Blob): Promise<{ ok: true; picture: Picture } | { ok: false; error: string }> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return { ok: false, error: 'Only PNG, JPEG and WebP pictures can be used.' };
  if (file.size > PICTURE_PICK_MAX) return { ok: false, error: 'That file is larger than 12 MB.' };
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { return { ok: false, error: 'That file is not a picture this browser can read.' }; }
  try {
    const side = Math.min(bmp.width, bmp.height);
    if (side < 32) return { ok: false, error: 'That picture is too small: at least 32 by 32 pixels.' };
    const c = document.createElement('canvas');
    c.width = c.height = PICTURE_SIDE;
    const ctx = c.getContext('2d');
    if (!ctx) return { ok: false, error: 'The picture could not be prepared.' };
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, PICTURE_SIDE, PICTURE_SIDE);
    for (const [type, q] of [['image/webp', 0.86], ['image/webp', 0.7], ['image/jpeg', 0.82], ['image/png', undefined]] as const) {
      const blob = await toBlob(c, type, q);
      if (!blob || blob.type !== type || blob.size > INDEX_IMAGE_MAX_BYTES) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { ok: true, picture: { bytes, hash: await sha256Hex(bytes), dataUrl: await toDataUrl(blob) } };
    }
    return { ok: false, error: 'That picture could not be made small enough.' };
  } finally {
    bmp.close();
  }
}

/** A draft's picture back from its data URL (kept in this browser), checked to be one of ours. */
export async function pictureFromDataUrl(dataUrl: string): Promise<Picture | null> {
  const m = /^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[2]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length > INDEX_IMAGE_MAX_BYTES) return null;
  return { bytes, hash: await sha256Hex(bytes), dataUrl };
}

export function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Where a published picture is served (content-addressed; the hash is checked before it is put in a URL). */
export const pictureUrl = (hash: string): string | null => (/^[0-9a-f]{64}$/.test(hash) ? `/api/vs/indexes/image/${hash}` : null);
/** A draft's data URL, only when it is a picture this code made. */
export const safeDataUrl = (u: string | null | undefined): string | null => (u && /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(u) ? u : null);
