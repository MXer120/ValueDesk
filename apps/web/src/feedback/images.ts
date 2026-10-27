/**
 * Screenshots for the feedback form: images only (owner, 2026-10-27 - "nothing
 * else bc of hack/malware risk").
 *
 * A file the visitor picks or pastes is never uploaded as it is: it is decoded
 * by the browser and drawn onto a canvas, and the canvas's pixels are what goes -
 * as PNG, or as JPEG when the PNG would be over 2 MB, scaled down until it fits.
 * That drops the file's metadata (EXIF: a phone's location, the camera) and
 * anything hidden in or behind the image; a file the browser cannot decode as an
 * image is refused here. The server checks the bytes again on arrival
 * (apps/server ops/imageCheck.ts).
 */

export const ACCEPT = 'image/png,image/jpeg,image/webp';
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES = 3;
/** The longest side a screenshot is sent with. */
export const MAX_SIDE = 2560;

/** A file the picker or the clipboard gave us is worth trying: its type claims an image we take. */
export const acceptable = (f: { type: string }): boolean => /^image\/(png|jpeg|webp)$/.test(f.type);

/** The size to draw at: the image's own, the longest side at most `max`. */
export function fitSize(w: number, h: number, max = MAX_SIDE): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

const toBlob = (c: HTMLCanvasElement, type: string, q?: number): Promise<Blob | null> => new Promise((r) => c.toBlob(r, type, q));

/** The re-encoded screenshot, or a sentence why not. */
export async function reencode(file: Blob): Promise<{ ok: true; blob: Blob; width: number; height: number; url: string } | { ok: false; error: string }> {
  if (!acceptable(file)) return { ok: false, error: 'Only PNG, JPEG and WebP screenshots can be attached.' };
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return { ok: false, error: 'That file is not an image this browser can read.' };
  }
  try {
    let max = MAX_SIDE;
    for (let attempt = 0; attempt < 6; attempt++) {
      const { w, h } = fitSize(bmp.width, bmp.height, max);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) return { ok: false, error: 'The screenshot could not be prepared.' };
      ctx.drawImage(bmp, 0, 0, w, h);
      const pngBlob = await toBlob(c, 'image/png');
      const blob = pngBlob && pngBlob.size <= MAX_BYTES ? pngBlob : await toBlob(c, 'image/jpeg', 0.85);
      if (blob && blob.size <= MAX_BYTES) return { ok: true, blob, width: w, height: h, url: URL.createObjectURL(blob) };
      max = Math.round(Math.max(w, h) * 0.75);
    }
    return { ok: false, error: 'That screenshot is too large, even made smaller.' };
  } finally {
    bmp.close();
  }
}
