/**
 * THE STATIC SHELL IN index.html, TAKEN DOWN WHEN THE APP IS ON SCREEN (phone pass, 2026-11-18).
 *
 * index.html paints a picture of the app - the bars, the tab bar, the page's cards as neutral blocks - before the
 * stylesheet and the code have arrived (its own inline <style>, the theme from theme-boot.js, the page from the
 * `data-boot` attribute theme-boot.js sets). It lies over everything (position: fixed) under the dialogs, so the terms
 * popup can open on it while the page's code is still on its way (App.tsx).
 *
 * Whatever takes the screen calls `dropBootShell()` once, in a layout effect, so the shell goes in the same frame the
 * real thing is first painted: the app's shell (App.tsx AppShell), the sanctioned-place notice (legal/LegalGate.tsx),
 * the beta site's door (beta/BetaGate.tsx). The chrome in the shell is drawn where the app draws its own, so the swap
 * reads as the page filling in; the blocks fade out over the real cards in 200 ms (--dur-med, --ease-out), at once
 * with reduced motion or in a hidden tab. Then the shell, its <style> and the attribute are removed: nothing of it
 * stays in the document.
 */

/** The ids index.html gives the shell and its stylesheet. */
export const BOOT_SHELL_ID = 'vs-boot';
export const BOOT_SHELL_CSS_ID = 'vs-boot-css';
/** What public/theme-boot.js sets on <html> for the shell: the page, its lit tab, the market type. */
export const BOOT_ATTRS = ['data-boot', 'data-boot-tab', 'data-boot-spot'] as const;
/** The fade in index.html's `.vsb.is-out`, plus a frame or two: removed by then even if no transitionend came. */
export const BOOT_FADE_MS = 200;
const FADE_GUARD_MS = BOOT_FADE_MS + 150;

interface BootDoc {
  getElementById(id: string): { remove(): void; classList?: { add(c: string): void }; addEventListener?: (t: string, f: () => void, o?: { once?: boolean }) => void } | null;
  documentElement: { removeAttribute(name: string): void };
  visibilityState?: string;
}

let dropped = false;

/** Take the shell down (once; later calls do nothing). `fade: false` removes it in this frame. */
export function dropBootShell(opts: { fade?: boolean; doc?: BootDoc; later?: (f: () => void, ms: number) => void } = {}): void {
  if (dropped) return;
  dropped = true;
  const doc: BootDoc | undefined = opts.doc ?? (typeof document === 'undefined' ? undefined : (document as unknown as BootDoc));
  if (!doc) return;
  const el = doc.getElementById(BOOT_SHELL_ID);
  let gone = false;
  const done = () => {
    if (gone) return;
    gone = true;
    el?.remove();
    doc.getElementById(BOOT_SHELL_CSS_ID)?.remove();
    for (const a of BOOT_ATTRS) doc.documentElement.removeAttribute(a);
  };
  const fade = (opts.fade ?? !reducedMotion()) && doc.visibilityState !== 'hidden';
  if (!el || !fade || !el.classList || !el.addEventListener) return done();
  el.classList.add('is-out');
  el.addEventListener('transitionend', done, { once: true });
  (opts.later ?? ((f, ms) => window.setTimeout(f, ms)))(done, FADE_GUARD_MS);
}

/**
 * THE APP NEVER RENDERS UNSTYLED. The built index.html has its stylesheet after the shell, in <body>
 * (tools/boot-shell.mjs, id `vs-css`), so the shell paints before it. A browser runs the module entry only once a
 * parser-inserted stylesheet has loaded (HTML: "no style sheet that is blocking scripts"), so the sheet is in by
 * the time main.tsx renders; this is the check that it is: null when it is (or there is none: the dev server, the
 * admin page), else a promise for its load. A sheet whose fetch already ended (resource timing has it) but has no
 * rules failed: nothing to wait for.
 */
export function sheetPending(doc: Document = document): Promise<void> | null {
  const link = doc.getElementById('vs-css') as HTMLLinkElement | null;
  if (!link || link.sheet) return null;
  try {
    if (performance.getEntriesByName(link.href).length > 0) return null;
  } catch {
    /* no resource timing: wait for the events */
  }
  return new Promise((done) => {
    const end = () => done();
    link.addEventListener('load', end, { once: true });
    link.addEventListener('error', end, { once: true });
  });
}

/** Whether the shell has been taken down (or is fading out). */
export const bootShellDropped = (): boolean => dropped;

/** For tests: forget that it was dropped. */
export function resetBootShell(): void {
  dropped = false;
}

function reducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
