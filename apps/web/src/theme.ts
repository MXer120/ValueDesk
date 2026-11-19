/**
 * Dark or light, per browser (Settings > Appearance, and the last step of the first-signup flow).
 *
 * The choice is `data-theme` on <html>, read by theme-light.css, which restates the design tokens of
 * styles.css. Dark is the default and has no attribute, so nothing changes for anyone who never
 * chooses. public/theme-boot.js sets the attribute before the first paint (the CSP allows no inline
 * script), so a light page never flashes dark.
 *
 * What cannot read a CSS variable - the canvas charts - follows through onTheme (chart/theme.ts).
 */
import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

const KEY = 'vs.theme';
const listeners = new Set<() => void>();
/** Each theme's --bg: the browser toolbar's colour (`<meta name="theme-color">`, index.html). */
export const THEME_COLOR: Record<Theme, string> = { dark: '#0e0e0e', light: '#efefed' };

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

let current: Theme = typeof window === 'undefined' ? 'dark' : stored();

function apply(t: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (t === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  root.style.colorScheme = t;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', t);
  // Android Chrome tints its toolbar with this: the page's --bg (styles.css, theme-light.css), as theme-boot.js sets it.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[t]);
}
apply(current);

export const currentTheme = (): Theme => current;
export const isLight = (): boolean => current === 'light';

/** Choose a theme: at once, kept in this browser. */
export function setTheme(t: Theme): void {
  if (t === current) return;
  current = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* for this tab only */
  }
  apply(t);
  for (const l of [...listeners]) l();
}

/** Called after every change of theme. Returns the way to stop. */
export function onTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(onTheme, currentTheme, currentTheme);
}
