/**
 * Valuetrade's look, expressed in TradingView's three theming channels:
 *
 *   overrides            the chart canvas (candles, pane, grid, scales)
 *   studies_overrides    default indicator colours (volume)
 *   --tv-color-*         the toolbars and popups (CSS custom properties,
 *                        applied with widget.setCSSCustomProperty)
 *
 * The chrome colours are READ from styles.css's tokens at runtime
 * (getComputedStyle on :root), so the TradingView toolbars follow the same
 * tokens every other panel does; the literals below are only the fallback when
 * a token cannot be read. The canvas colours (grid, axis ink) come from
 * chart/theme.ts's `T`, the canvas-side mirror the klinecharts chart already
 * draws with - so both charts put the same pixels on the same surface.
 */
import { FAMILY, NUM_FAMILY, T } from '../theme';
import type { Overrides } from './types';

export interface TvPalette {
  panel: string;
  elevated: string;
  hover: string;
  control: string;
  line: string;
  text: string;
  muted: string;
  dim: string;
  pos: string;
  neg: string;
  accent: string;
  warn: string;
  grid: string;
  axisText: string;
  fontText: string;
  fontNum: string;
}

/** styles.css :root values at the time of writing. */
export const FALLBACK_PALETTE: TvPalette = {
  panel: '#0f0f10',
  elevated: '#1a1a1b',
  hover: '#262627',
  control: '#3a3a3b',
  line: '#3a3a3b',
  text: '#f4f4f2',
  muted: '#a8a8a5',
  dim: '#7d7d7a',
  pos: '#00b481',
  neg: '#ef4a3c',
  accent: '#f4f4f2',
  warn: '#ffb547',
  grid: T.grid,
  axisText: T.canvasMuted,
  fontText: FAMILY,
  fontNum: NUM_FAMILY,
};

const TOKEN_OF: Partial<Record<keyof TvPalette, string>> = {
  panel: '--bg-panel',
  elevated: '--bg-elevated',
  hover: '--bg-hover',
  control: '--bg-control',
  line: '--line',
  text: '--text',
  muted: '--muted',
  dim: '--dim',
  pos: '--pos',
  neg: '--neg',
  accent: '--accent',
  warn: '--warn',
  fontText: '--font-text',
  fontNum: '--font-num',
};

/** `read` is getComputedStyle(root).getPropertyValue in the browser. */
export function readPalette(read: (cssVar: string) => string): TvPalette {
  const out = { ...FALLBACK_PALETTE };
  for (const [key, cssVar] of Object.entries(TOKEN_OF) as [keyof TvPalette, string][]) {
    let v = '';
    try {
      v = read(cssVar).trim();
    } catch {
      /* keep the fallback */
    }
    if (v) out[key] = v;
  }
  return out;
}

/** #rrggbb (or #rgb) at an alpha. Anything else is returned untouched - the
 *  library accepts rgba() and named colours too. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m || !m[1]) return color;
  let hex = m[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  const n = Number.parseInt(hex, 16);
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Axis font size: the klinecharts chart's AXIS_FONT_SIZE, one of the
 *  terminal's four sizes (10/12/14/20). */
const AXIS_FONT_SIZE = 12;

export function chartOverrides(p: TvPalette): Overrides {
  const candle = (prefix: string): Overrides => ({
    [`${prefix}.upColor`]: p.pos,
    [`${prefix}.downColor`]: p.neg,
    [`${prefix}.borderUpColor`]: p.pos,
    [`${prefix}.borderDownColor`]: p.neg,
    [`${prefix}.wickUpColor`]: p.pos,
    [`${prefix}.wickDownColor`]: p.neg,
    [`${prefix}.drawBorder`]: true,
    [`${prefix}.drawWick`]: true,
  });
  return {
    'paneProperties.backgroundType': 'solid',
    'paneProperties.background': p.panel,
    'paneProperties.vertGridProperties.color': p.grid,
    'paneProperties.horzGridProperties.color': p.grid,
    'paneProperties.crossHairProperties.color': p.dim,
    'paneProperties.separatorColor': p.grid,
    'paneProperties.legendProperties.showBackground': false,
    'scalesProperties.textColor': p.axisText,
    'scalesProperties.lineColor': p.grid,
    'scalesProperties.fontSize': AXIS_FONT_SIZE,
    ...candle('mainSeriesProperties.candleStyle'),
    ...candle('mainSeriesProperties.hollowCandleStyle'),
    ...candle('mainSeriesProperties.haStyle'),
    'mainSeriesProperties.barStyle.upColor': p.pos,
    'mainSeriesProperties.barStyle.downColor': p.neg,
    'mainSeriesProperties.lineStyle.color': p.text,
    'mainSeriesProperties.areaStyle.linecolor': p.text,
    'mainSeriesProperties.areaStyle.color1': withAlpha(p.text, 0.16),
    'mainSeriesProperties.areaStyle.color2': withAlpha(p.text, 0.01),
    // The last-price rule stays on and follows the bar's direction, as the
    // klinecharts chart's does. The "Last" header toggle flips it.
    'mainSeriesProperties.showPriceLine': true,
  };
}

export function studiesOverrides(p: TvPalette): Overrides {
  return {
    'volume.volume.color.0': withAlpha(p.neg, 0.5),
    'volume.volume.color.1': withAlpha(p.pos, 0.5),
  };
}

/**
 * Toolbar and popup colours. Active is WHITE text, not the cyan accent: the
 * klinecharts toolbar deliberately marks the selected timeframe in --text
 * (see chart.css), and the two charts should read as one app. A pressed
 * toggle takes the --bg-control fill, like the Mark/Oracle segment.
 */
export function cssProperties(p: TvPalette): Record<string, string> {
  return {
    '--tv-color-platform-background': p.panel,
    '--tv-color-pane-background': p.panel,
    '--tv-color-toolbar-button-background-hover': p.hover,
    '--tv-color-toolbar-button-background-expanded': p.elevated,
    '--tv-color-toolbar-button-background-active': p.elevated,
    '--tv-color-toolbar-button-background-active-hover': p.hover,
    '--tv-color-toolbar-button-text': p.muted,
    '--tv-color-toolbar-button-text-hover': p.text,
    '--tv-color-toolbar-button-text-active': p.text,
    '--tv-color-toolbar-button-text-active-hover': p.text,
    '--tv-color-item-active-text': p.text,
    '--tv-color-toolbar-toggle-button-background-active': p.control,
    '--tv-color-toolbar-toggle-button-background-active-hover': p.control,
    '--tv-color-toolbar-divider-background': p.elevated,
    '--tv-color-toolbar-save-layout-loader': p.muted,
    '--tv-color-popup-background': p.elevated,
    '--tv-color-popup-element-text': p.muted,
    '--tv-color-popup-element-text-hover': p.text,
    '--tv-color-popup-element-background-hover': p.hover,
    '--tv-color-popup-element-divider-background': p.control,
    '--tv-color-popup-element-secondary-text': p.dim,
    '--tv-color-popup-element-hint-text': p.dim,
    '--tv-color-popup-element-text-active': p.text,
    '--tv-color-popup-element-background-active': p.control,
    '--tv-color-popup-element-toolbox-text': p.muted,
    '--tv-color-popup-element-toolbox-text-hover': p.text,
    '--tv-color-popup-element-toolbox-text-active-hover': p.text,
    '--tv-color-popup-element-toolbox-background-hover': p.hover,
    '--tv-color-popup-element-toolbox-background-active-hover': p.control,
  };
}

/** The first family in a CSS font stack, unquoted: what `custom_font_family`
 *  and the font-face copy below look for. */
export function primaryFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

/**
 * The app's @font-face rules for the given families, as CSS text.
 *
 * The chart runs in an iframe, and @fontsource's faces are registered on the
 * PARENT document only - without this the iframe falls back to system fonts.
 * The rules are copied verbatim with every relative url() made absolute
 * against its stylesheet, so they work in dev (Vite-served files) and in a
 * build (hashed /assets/ files) alike. Cross-origin sheets throw on cssRules
 * and are skipped.
 */
export function collectFontFaceCss(
  sheets: Iterable<{ href: string | null; cssRules: ArrayLike<{ cssText: string; type?: number; style?: { getPropertyValue(p: string): string } }> }>,
  families: readonly string[],
  baseHref: string,
): string {
  const want = new Set(families.map((f) => f.toLowerCase()));
  const out: string[] = [];
  for (const sheet of sheets) {
    let rules: ArrayLike<{ cssText: string; type?: number; style?: { getPropertyValue(p: string): string } }>;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const sheetBase = sheet.href ?? baseHref;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (!r || !r.cssText.startsWith('@font-face')) continue;
      const fam = primaryFamily(r.style?.getPropertyValue('font-family') ?? '');
      if (!want.has(fam.toLowerCase())) continue;
      out.push(
        r.cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (all, q: string, u: string) => {
          if (/^(data:|blob:|https?:|\/\/)/i.test(u)) return all;
          try {
            return `url(${q}${new URL(u, sheetBase).href}${q})`;
          } catch {
            return all;
          }
        }),
      );
    }
  }
  return out.join('\n');
}
