/**
 * The widget constructor options, as a pure function so the parts that are
 * rules rather than taste - the attribution, the symbol-search lock - are
 * pinned by a unit test instead of by memory.
 */
import { QUICK_INTERVALS } from '../intervals';
import { SUPPORTED_RESOLUTIONS, TIMEZONE, resolutionForInterval } from './datafeedCore';
import { chartOverrides, studiesOverrides, type TvPalette } from './theme';
import { getNumSeps } from '../../numStyle';
import type {
  ChartingLibraryWidgetOptions,
  IBasicDataFeed,
  IExternalSaveLoadAdapter,
  ResolutionString,
} from './types';

/**
 * LICENCE: the TradingView logo on the chart is the attribution the free
 * Advanced Charts licence requires. `widget_logo` is the feature that draws
 * it. It must never be disabled - buildWidgetOptions strips it from any
 * disabled list it is handed, and options.test.ts fails if it ever is.
 */
export const ATTRIBUTION_FEATURES = ['widget_logo'] as const;

export interface WidgetOptionInput {
  container: HTMLElement;
  libraryPath: string;
  datafeed: IBasicDataFeed;
  ticker: string;
  interval: ResolutionString;
  palette: TvPalette;
  customCssUrl?: string;
  saveLoad?: IExternalSaveLoadAdapter;
  /** Only when the host can follow a symbol picked INSIDE the chart. Without
   *  that, the chart's own search would let it drift off the app's symbol
   *  while the book, ticket and positions stay on the old one. */
  allowSymbolSearch: boolean;
  extraDisabled?: string[];
}

/** The klinecharts toolbar's quick timeframes, as TradingView favourites. */
export const FAVORITE_RESOLUTIONS: ResolutionString[] = QUICK_INTERVALS.map((i) => resolutionForInterval(i)).filter(
  (r): r is ResolutionString => r !== undefined,
);

/** A saved resolution, if it is still one we serve; else the default. */
export function pickInterval(saved: string | null | undefined, fallback: ResolutionString = '1'): ResolutionString {
  return saved && SUPPORTED_RESOLUTIONS.includes(saved) ? saved : fallback;
}

export function buildWidgetOptions(a: WidgetOptionInput): ChartingLibraryWidgetOptions {
  const disabled = [
    ...(a.allowSymbolSearch ? [] : ['header_symbol_search', 'symbol_search_hot_key']),
    ...(a.extraDisabled ?? []),
  ].filter((f) => !(ATTRIBUTION_FEATURES as readonly string[]).includes(f));

  return {
    container: a.container,
    library_path: a.libraryPath,
    datafeed: a.datafeed,
    symbol: a.ticker,
    interval: a.interval,
    locale: 'en',
    // UTC, like the klinecharts chart's footer clock and every timestamp the
    // gateway speaks. The user can still change it in the chart's settings.
    timezone: TIMEZONE,
    theme: 'dark',
    autosize: true,
    disabled_features: disabled,
    enabled_features: ['study_templates', 'side_toolbar_in_fullscreen_mode', 'header_in_fullscreen_mode'],
    overrides: chartOverrides(a.palette),
    studies_overrides: studiesOverrides(a.palette),
    ...(a.customCssUrl ? { custom_css_url: a.customCssUrl } : {}),
    // Numbers on the canvas use the numeral face, as on the klinecharts chart.
    custom_font_family: a.palette.fontNum,
    // The app's number format (Settings). Read once, at widget creation: the
    // library has no API to change it on a live widget, so a switch shows on
    // the next chart the app builds (symbol/layout change, reload).
    numeric_formatting: { decimal_sign: getNumSeps().decimal, grouping_separator: getNumSeps().group },
    loading_screen: { backgroundColor: a.palette.panel, foregroundColor: a.palette.muted },
    toolbar_bg: a.palette.panel,
    favorites: { intervals: FAVORITE_RESOLUTIONS },
    ...(a.saveLoad
      ? { save_load_adapter: a.saveLoad, auto_save_delay: 5, load_last_chart: true }
      : {}),
  };
}
