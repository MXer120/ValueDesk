/**
 * The Live Feed's picture geometry. (This file used to talk to the YouTube player
 * by postMessage and crop its overlays; YouTube's terms forbid both, so the widget
 * now leaves every player as it comes - LiveFeed.tsx.)
 */

/** Where a 16:9 picture sits in a w × h box: as large as fits, centred. */
export function fitVideo(w: number, h: number): { x: number; y: number; w: number; h: number } {
  if (w <= 0 || h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const vw = Math.min(w, (h * 16) / 9);
  const vh = (vw * 9) / 16;
  return { x: Math.round((w - vw) / 2), y: Math.round((h - vh) / 2), w: Math.round(vw), h: Math.round(vh) };
}
