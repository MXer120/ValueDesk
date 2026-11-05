/**
 * What an indicator on the chart IS, independent of the klinecharts instance
 * drawing it: its name, its inputs, its colours, whether it is shown and how
 * tall its pane is. Chart.tsx keeps a list of these in localStorage, mounts
 * them on every new chart instance, and rewrites the list whenever the user
 * hides, moves, removes or reconfigures one - so a reload, a remount or a
 * chart rebuilt after a failed start comes back with the same studies.
 *
 * The default is VOLUME AND NOTHING ELSE, with no moving averages on it: the
 * reference charts (SoDEX, TradingView) open with a plain volume pane, and the
 * three MA lines klinecharts puts on its VOL by default were the "VOL(5,10,20)
 * MA5/MA10/MA20" clutter that once got volume switched off altogether.
 */
import type { DeepPartial, IndicatorStyle, SmoothLineStyle } from 'klinecharts';
import { T } from './theme';
import { isLight, onTheme } from '../theme';

export interface IndicatorLineSpec {
  color?: string;
  size?: number;
  /** Hidden lines are drawn transparent (klinecharts has no per-line switch). */
  hidden?: boolean;
}

export interface IndicatorSpec {
  /** klinecharts indicator name, verbatim ('VOL', 'MA', 'MACD'…). */
  name: string;
  /** Inputs. Absent means the library's defaults. */
  calcParams?: number[];
  /** Per-line overrides, in the order of the indicator's line figures. */
  lines?: IndicatorLineSpec[];
  /** Bar colours, for the indicators that draw bars (VOL, MACD, AO). */
  up?: string;
  down?: string;
  visible: boolean;
  /** Pane height in px; only meaningful for indicators with a pane. */
  height?: number;
  /** Which price the study is computed from (Close unless set). */
  source?: PriceSource;
  /**
   * Which pane it is drawn in: 'main' (over the candles) or a group key that
   * studies sharing one pane have in common. Absent means the study's own
   * home - over the candles for a price study, a pane of its own otherwise.
   */
  pane?: string;
}

export const STORAGE_KEY = 'chart.indicators.v1';

export const DEFAULT_INDICATORS: IndicatorSpec[] = [{ name: 'VOL', calcParams: [], visible: true }];

/** Line colours the library falls back to - the theme's warm ramp. */
export const LINE_COLORS = [T.line1, T.line2, T.line3, T.line4, T.line5];
onTheme(() => { LINE_COLORS.splice(0, LINE_COLORS.length, T.line1, T.line2, T.line3, T.line4, T.line5); });

/** Bar colours, the candle colours at 60% (theme.ts POS_FILL / NEG_FILL). */
export let BAR_UP = isLight() ? 'rgba(0, 112, 80, 0.55)' : 'rgba(0, 180, 129, 0.6)';
export let BAR_DOWN = isLight() ? 'rgba(185, 42, 30, 0.55)' : 'rgba(239, 74, 60, 0.6)';
onTheme(() => {
  BAR_UP = isLight() ? 'rgba(0, 112, 80, 0.55)' : 'rgba(0, 180, 129, 0.6)';
  BAR_DOWN = isLight() ? 'rgba(185, 42, 30, 0.55)' : 'rgba(239, 74, 60, 0.6)';
});

/** Colours offered in the settings dialog, before the free picker. */
export const SWATCHES = [
  '#ffb547', '#e08a5a', '#ef4a3c', '#f06292', '#c08bd8', '#7e9cf0',
  '#4fc3c8', '#00b481', '#a5c95a', '#fffeef', '#c6b6ba', '#807678',
];

/** The prices a study can be computed from, TradingView's set. */
export const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'] as const;
export type PriceSource = (typeof SOURCES)[number];

export const SOURCE_LABEL: Record<PriceSource, string> = {
  close: 'Close',
  open: 'Open',
  high: 'High',
  low: 'Low',
  hl2: '(H + L) / 2',
  hlc3: '(H + L + C) / 3',
  ohlc4: '(O + H + L + C) / 4',
};

const isSource = (v: unknown): v is PriceSource => typeof v === 'string' && (SOURCES as readonly string[]).includes(v);

/**
 * The bars a study computes from, with `close` replaced by the chosen source.
 *
 * The built-in studies read `close` (MA, EMA, BOLL, RSI, MACD…), so putting
 * the source in that one field is what makes "MA of the highs" an MA of the
 * highs without rewriting the library's arithmetic. The other fields are left
 * as they are; Close hands the list back untouched.
 */
export function withSource<T extends { open: number; high: number; low: number; close: number }>(
  bars: T[],
  source: PriceSource | undefined,
): T[] {
  if (!source || source === 'close') return bars;
  return bars.map((b) => {
    const close =
      source === 'open' ? b.open
      : source === 'high' ? b.high
      : source === 'low' ? b.low
      : source === 'hl2' ? (b.high + b.low) / 2
      : source === 'hlc3' ? (b.high + b.low + b.close) / 3
      : (b.open + b.high + b.low + b.close) / 4;
    return { ...b, close };
  });
}

interface ParamInfo {
  /** Full name, the way TradingView titles the study. */
  title: string;
  /** Label for each input; ignored when `list` is set. */
  params: string[];
  /** The inputs are a list of lengths the user may add to or remove from
   *  (MA 5 10 30 60, RSI 6 12 24). Each becomes its own line. */
  list?: { label: string; max: number; min: number };
  /** The study reads one price, so the user may pick which (`SOURCES`). */
  source?: true;
  /** What the Indicators menu shows beside the title (default: the library's name). */
  short?: string;
}

/** Every built-in klinecharts 10.0.2 indicator, with names for its inputs. */
export const INDICATOR_INFO: Record<string, ParamInfo> = {
  VOL: { title: 'Volume', params: [], list: { label: 'MA length', max: 4, min: 0 } },
  MA: { title: 'Moving average', params: [], list: { label: 'Length', max: 6, min: 1 }, source: true },
  EMA: { title: 'Exponential moving average', params: [], list: { label: 'Length', max: 6, min: 1 }, source: true },
  SMA: { title: 'Smoothed moving average', params: ['Length', 'Weight'], source: true },
  BOLL: { title: 'Bollinger bands', params: ['Length', 'Std dev'], source: true },
  SAR: { title: 'Parabolic SAR', params: ['Start (%)', 'Step (%)', 'Maximum (%)'] },
  BBI: { title: 'Bull and bear index', params: ['Length 1', 'Length 2', 'Length 3', 'Length 4'], source: true },
  AVP: { title: 'Average price', params: [] },
  MACD: { title: 'MACD', params: ['Fast length', 'Slow length', 'Signal smoothing'], source: true },
  KDJ: { title: 'KDJ', params: ['Length', 'K smoothing', 'D smoothing'] },
  RSI: { title: 'Relative strength index', params: [], list: { label: 'Length', max: 4, min: 1 }, source: true },
  WR: { title: 'Williams %R', params: [], list: { label: 'Length', max: 4, min: 1 } },
  BIAS: { title: 'Bias', params: [], list: { label: 'Length', max: 4, min: 1 }, source: true },
  CCI: { title: 'Commodity channel index', params: ['Length'] },
  DMI: { title: 'Directional movement index', params: ['Length', 'ADX smoothing'] },
  OBV: { title: 'On-balance volume', params: ['MA length'] },
  PVT: { title: 'Price volume trend', params: [] },
  VR: { title: 'Volume ratio', params: ['Length', 'MA length'] },
  PSY: { title: 'Psychological line', params: ['Length', 'MA length'] },
  ROC: { title: 'Rate of change', params: ['Length', 'MA length'], source: true },
  MTM: { title: 'Momentum', params: ['Length', 'MA length'], source: true },
  EMV: { title: 'Ease of movement', params: ['Length', 'MA length'] },
  TRIX: { title: 'Triple exponential average', params: ['Length', 'MA length'], source: true },
  DMA: { title: 'Difference of moving averages', params: ['Short length', 'Long length', 'MA length'] },
  BRAR: { title: 'BRAR', params: ['Length'] },
  CR: { title: 'CR energy', params: ['Length', 'MA 1', 'MA 2', 'MA 3', 'MA 4'] },
  AO: { title: 'Awesome oscillator', params: ['Fast length', 'Slow length'] },
  // Ours: the liquidation heatmap's layers (chart/liqIndicators.tsx).
  VS_LIQHEAT: { title: 'Liquidation heatmap', params: [], short: 'LIQ HEAT' },
  VS_LIQMAP: { title: 'Liquidation map', params: [], short: 'LIQ MAP' },
};

export const indicatorTitle = (name: string): string => INDICATOR_INFO[name]?.title ?? name;
export const indicatorShort = (name: string): string => INDICATOR_INFO[name]?.short ?? name;

/** The legend's short name: "Volume", "MA 5 10 30", "MACD 12 26 9". */
export function legendName(name: string, calcParams: readonly unknown[], source?: PriceSource): string {
  // Ours carry no library short name worth showing: their title ("Liquidation map").
  const base = name === 'VOL' ? 'Volume' : name.startsWith('VS_') ? indicatorTitle(name) : name;
  const params = calcParams.filter((p) => typeof p === 'number' || typeof p === 'string');
  const parts = [base, ...params.map(String)];
  if (source && source !== 'close') parts.push(source);
  return parts.join(' ');
}

/** Most lines any built-in study draws (MA with six lengths). */
export const MAX_LINES = 6;

/**
 * klinecharts styles for a spec, over the theme's defaults.
 *
 * Every entry is a COMPLETE style object: the library takes an indicator's
 * `lines` / `bars` arrays in place of the chart-wide ones rather than merging
 * them field by field, so a partial entry would draw with no dash pattern or
 * border settings at all.
 */
export function stylesFor(spec: IndicatorSpec, lineCount = MAX_LINES): DeepPartial<IndicatorStyle> {
  const lines: SmoothLineStyle[] = [];
  const n = Math.max(lineCount, spec.lines?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const o = spec.lines?.[i];
    lines.push({
      style: 'solid',
      smooth: false,
      dashedValue: [2, 2],
      color: o?.hidden ? 'rgba(0, 0, 0, 0)' : (o?.color ?? LINE_COLORS[i % LINE_COLORS.length]!),
      size: o?.size ?? 1,
    });
  }
  const up = spec.up ?? BAR_UP;
  const down = spec.down ?? BAR_DOWN;
  return {
    lines,
    bars: [
      {
        style: 'fill',
        borderStyle: 'solid',
        borderSize: 1,
        borderDashedValue: [2, 2],
        upColor: up,
        downColor: down,
        noChangeColor: up,
      },
    ],
    ohlc: { upColor: up, downColor: down, noChangeColor: up },
  };
}

/** A stored list that came back from localStorage, with anything malformed
 *  dropped rather than handed to the library. */
export function sanitizeSpecs(raw: unknown, known: ReadonlySet<string> | null): IndicatorSpec[] {
  if (!Array.isArray(raw)) return DEFAULT_INDICATORS;
  const out: IndicatorSpec[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const s = r as Partial<IndicatorSpec>;
    if (typeof s.name !== 'string' || seen.has(s.name)) continue;
    if (known && !known.has(s.name)) continue;
    seen.add(s.name);
    out.push({
      name: s.name,
      visible: s.visible !== false,
      ...(Array.isArray(s.calcParams) && s.calcParams.every((p) => typeof p === 'number' && Number.isFinite(p))
        ? { calcParams: s.calcParams }
        : {}),
      ...(Array.isArray(s.lines) ? { lines: s.lines.filter((l) => l && typeof l === 'object') } : {}),
      ...(typeof s.up === 'string' ? { up: s.up } : {}),
      ...(typeof s.down === 'string' ? { down: s.down } : {}),
      ...(typeof s.height === 'number' && s.height > 0 ? { height: s.height } : {}),
      ...(isSource(s.source) ? { source: s.source } : {}),
      ...(typeof s.pane === 'string' && s.pane ? { pane: s.pane } : {}),
    });
  }
  return out;
}
