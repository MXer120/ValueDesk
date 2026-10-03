/**
 * Measure again once the web fonts are in.
 *
 * IBM Plex Sans and Asap are self-hosted and swap in when they arrive, which
 * can be after a component's first layout effect: anything placed from a
 * text's measured width (the sliding marker under the panel tabs) is then
 * placed against the fallback font's metrics. `onFontsSettled(cb)` calls `cb`
 * once `document.fonts.ready` resolves, and again each time a later font load
 * finishes. It returns the unsubscribe; after that `cb` is never called.
 */
export interface FontSetLike {
  ready: Promise<unknown>;
  addEventListener?: (type: 'loadingdone', fn: () => void) => void;
  removeEventListener?: (type: 'loadingdone', fn: () => void) => void;
}

export function onFontsSettled(
  cb: () => void,
  fonts: FontSetLike | undefined = typeof document === 'undefined' ? undefined : document.fonts,
): () => void {
  if (!fonts) return () => {};
  let live = true;
  const run = () => {
    if (live) cb();
  };
  fonts.ready.then(run, () => {});
  fonts.addEventListener?.('loadingdone', run);
  return () => {
    live = false;
    fonts.removeEventListener?.('loadingdone', run);
  };
}
