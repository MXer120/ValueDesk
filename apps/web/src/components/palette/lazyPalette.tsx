/**
 * The Cmd+K palette in a chunk of its own, loaded next to the landing page.
 *
 * The closed palette renders nothing, but its module pulls in the whole
 * palette UI plus - through the venue chooser - the Portfolio page's shared
 * parts. Keeping it out of the entry chunk lets it download IN PARALLEL with
 * the landing page's chunk instead of in series before it: App.tsx requests
 * both as soon as the entry runs and holds the first render until both are in
 * (`loadPalette` below), so the palette is mounted in the same commit as the
 * rest of the shell and opens exactly as fast as it always did - including for
 * a key pressed the moment the page appears.
 *
 * On a touch phone (no Cmd+K to press) App.tsx does not wait for it: the stand-in
 * below asks for the module as soon as it is mounted, with the app's first
 * commit, and a tap on search before it is in opens the palette when it lands.
 *
 * The stand-in otherwise only matters if that load failed (a network drop mid-boot): it
 * then retries in the background, answers Cmd/Ctrl+K the way the palette does
 * (capture phase, so App's own shortcut handler never sees it), and treats
 * printable keys typed while the open is pending as typing into the search
 * box - they are appended to the seed, and do not reach App's single-key
 * shortcuts (digits switch pages, `c` cancels orders) - just as they would
 * have gone into the focused input of an open palette.
 */
import { createElement, useEffect, useState } from 'react';
import type { CommandPaletteProps } from './CommandPalette';
import { logger } from '../../log';

type PaletteModule = typeof import('./CommandPalette');

const log = logger('palette');

let mod: PaletteModule | null = null;
let loading: Promise<PaletteModule> | null = null;
/** The mounted stand-in has handed over to the real palette. */
let live = false;
/** An open requested before the palette was mounted: replayed once it is. */
let queued: { seed: string } | null = null;
const onLoaded = new Set<(m: PaletteModule) => void>();

/** The palette module is in: the stand-in renders it synchronously. */
export const paletteReady = (): boolean => mod !== null;

/** Fetch the palette module (once; retried on the next request if it failed). */
export function loadPalette(): Promise<PaletteModule> {
  if (mod) return Promise.resolve(mod);
  loading ??= import('./CommandPalette').then(
    (m) => {
      mod = m;
      for (const fn of onLoaded) fn(m);
      return m;
    },
    (err: unknown) => {
      loading = null;
      log.warn('the search palette failed to load; it retries on the next open', { error: String(err) });
      throw err;
    },
  );
  return loading;
}

/** Open the palette, optionally with text already in the search box. */
export function openPalette(seed = ''): void {
  if (mod && live) {
    mod.openPalette(seed);
    return;
  }
  queued = { seed: (queued?.seed ?? '') + seed };
  loadPalette().catch(() => {});
}

/** Stand-in for <CommandPalette>: the real one once its module is in, nothing before. */
export function CommandPalette(p: CommandPaletteProps) {
  const [m, setM] = useState<PaletteModule | null>(mod);

  useEffect(() => {
    if (m) return;
    const take = (x: PaletteModule) => setM(() => x);
    onLoaded.add(take);
    loadPalette().catch(() => {});
    return () => {
      onLoaded.delete(take);
    };
  }, [m]);

  // Until it is in: Cmd/Ctrl+K as the palette answers it, and keys typed while
  // an open is pending go to the seed, as they would go to its search box.
  useEffect(() => {
    if (m) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.repeat && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopImmediatePropagation();
        queued ??= { seed: '' };
        loadPalette().catch(() => {});
        return;
      }
      if (!queued || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        queued = null;
      } else if (e.key === 'Backspace') {
        queued.seed = queued.seed.slice(0, -1);
      } else if (e.key.length === 1) {
        queued.seed += e.key;
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [m]);

  // Mounted: the palette's own effects (a child's) have run, so it can open.
  useEffect(() => {
    if (!m) return;
    live = true;
    if (queued) {
      const q = queued;
      queued = null;
      m.openPalette(q.seed);
    }
    return () => {
      live = false;
    };
  }, [m]);

  return m ? createElement(m.CommandPalette, p) : null;
}
