/**
 * Which addresses show the home page instead of the app (main.tsx): /home and its pages always; the bare / on a first
 * visit only. Whoever has answered the app's first popup in this browser (the terms, or "Just look around":
 * legal/acceptance.ts keys) has used the app, and / opens the trade page for them as it always has - so does any / with
 * a query (an invite, a share link), and the whole beta channel. public/theme-boot.js decides the same before the first paint.
 */
import { isHomePath } from './router';

export function showsHome(loc: { pathname: string; search: string }, keys: () => readonly string[] = storedKeys, beta = import.meta.env?.VITE_CHANNEL === 'beta'): boolean {
  if (isHomePath(loc.pathname)) return true;
  if (loc.pathname !== '/' || loc.search || beta) return false;
  return !keys().some((k) => k.startsWith('vd.site.terms'));
}

/** No storage (blocked): nothing says this browser is new, so / stays the app. */
function storedKeys(): readonly string[] {
  try { return Object.keys(localStorage); } catch { return ['vd.site.terms']; }
}
