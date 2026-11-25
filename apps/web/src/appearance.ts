/**
 * The glass look, adjustable live (Settings > Appearance; owner, 2026-10-26:
 * "so I can change the brownish colour in Settings and play around to get that
 * look on the trading page"). The values are CSS variables on <html>, read by
 * SettingsMenu.css (the Settings window's two panes) and appearance.css (the
 * trading page's panels when the glass is switched on there). Kept in this
 * browser; "Copy values" hands them over as JSON.
 */
import { useSyncExternalStore } from 'react';
import './appearance.css';
import { isLight, onTheme } from './theme';

export interface Appearance {
  /** The window's tint (the warm brown) and how much of it covers the page, %. */
  tint: string;
  tintAlpha: number;
  /** The window's lower edge: the tint darkened, and its cover, %. */
  shade: number;
  shadeAlpha: number;
  /** The blur of the page behind, px, and its colour boost. */
  blur: number;
  saturate: number;
  /** The light across the window's top-left corner: colour and strength, %. */
  glow: string;
  glowAlpha: number;
  /** The inner pane: how much lighter than the window, %, and its own light, %. */
  lift: number;
  innerGlow: number;
  /** The trading page in glass: on, the panels' cover %, their blur px, and the light behind them. */
  trade: boolean;
  panelAlpha: number;
  panelBlur: number;
  pageGlow: string;
  pageGlowAlpha: number;
  pageGlow2: string;
  pageGlow2Alpha: number;
}

/** The home page's ink and heat (owner 2026-11-25; before: the owner's settings of 2026-10-26). */
export const APPEARANCE_DEFAULT: Appearance = {
  tint: '#101012',
  tintAlpha: 78,
  shade: 45,
  shadeAlpha: 50,
  blur: 20,
  saturate: 1,
  glow: '#f4f4f2',
  glowAlpha: 5,
  lift: 5,
  innerGlow: 9,
  trade: true,
  panelAlpha: 62,
  panelBlur: 25,
  pageGlow: '#440154',
  pageGlowAlpha: 20,
  pageGlow2: '#3b528b',
  pageGlow2Alpha: 20,
};

/**
 * The same glass on the light theme: a white tint, a soft edge, a lift towards white. The sliders in
 * Settings tune the dark look, the owner's; on light these values hold.
 */
const LIGHT_GLASS: Appearance = {
  tint: '#ffffff',
  tintAlpha: 66,
  shade: 4,
  shadeAlpha: 40,
  blur: 26,
  saturate: 1.7,
  glow: '#ffffff',
  glowAlpha: 40,
  lift: 34,
  innerGlow: 30,
  trade: true,
  panelAlpha: 58,
  panelBlur: 30,
  pageGlow: '#ddcfe6',
  pageGlowAlpha: 60,
  pageGlow2: '#cdd7ec',
  pageGlow2Alpha: 55,
};

// .2: values kept under the old key were the old palette's, and no control writes them any more.
const KEY = 'vs.appearance.2';
const listeners = new Set<() => void>();

function load(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Appearance> | null;
    if (!raw || typeof raw !== 'object') return APPEARANCE_DEFAULT;
    const out = { ...APPEARANCE_DEFAULT };
    for (const k of Object.keys(APPEARANCE_DEFAULT) as Array<keyof Appearance>) {
      if (typeof raw[k] === typeof APPEARANCE_DEFAULT[k]) (out as Record<string, unknown>)[k] = raw[k];
    }
    return out;
  } catch {
    return APPEARANCE_DEFAULT;
  }
}

let current: Appearance = typeof window === 'undefined' ? APPEARANCE_DEFAULT : load();

function apply(shown: Appearance): void {
  if (typeof document === 'undefined') return;
  const a = isLight() ? { ...LIGHT_GLASS, trade: shown.trade } : shown;
  const s = document.documentElement.style;
  s.setProperty('--stg-tint', a.tint);
  s.setProperty('--stg-tint-a', `${a.tintAlpha}%`);
  s.setProperty('--stg-shade', `${a.shade}%`);
  s.setProperty('--stg-shade-a', `${a.shadeAlpha}%`);
  s.setProperty('--stg-blur', `${a.blur}px`);
  s.setProperty('--stg-sat', String(a.saturate));
  s.setProperty('--stg-glow', a.glow);
  s.setProperty('--stg-glow-a', `${a.glowAlpha}%`);
  s.setProperty('--stg-lift', `${a.lift}%`);
  s.setProperty('--stg-inner-glow', `${a.innerGlow}%`);
  s.setProperty('--pn-a', `${a.panelAlpha}%`);
  s.setProperty('--pn-blur', `${a.panelBlur}px`);
  s.setProperty('--pg-glow', a.pageGlow);
  s.setProperty('--pg-glow-a', `${a.pageGlowAlpha}%`);
  s.setProperty('--pg-glow2', a.pageGlow2);
  s.setProperty('--pg-glow2-a', `${a.pageGlow2Alpha}%`);
  document.documentElement.toggleAttribute('data-glass', a.trade);
  /* Saturation 1 changes nothing: on a phone such a pane drops its filter altogether (appearance.css, the phone block). */
  document.documentElement.toggleAttribute('data-glass-sat1', a.saturate === 1);
}
apply(current);
onTheme(() => apply(current));

export function setAppearance(patch: Partial<Appearance> | null): void {
  current = patch === null ? APPEARANCE_DEFAULT : { ...current, ...patch };
  try {
    if (patch === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(current));
  } catch { /* kept for this tab only */ }
  apply(current);
  for (const l of listeners) l();
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => current,
    () => current,
  );
}
