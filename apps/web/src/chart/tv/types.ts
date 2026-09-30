/**
 * Minimal local declarations for the TradingView Advanced Charts API surface
 * this integration touches, and nothing else.
 *
 * WHY LOCAL: the official typings (`charting_library.d.ts`,
 * `datafeed-api.d.ts`) ship inside the licensed library, which we do not have
 * yet and which may not be redistributed. These are written from the public
 * docs at tradingview.com/charting-library-docs so the integration typechecks
 * today. On the day the files arrive the official ones can replace these; the
 * names below match them one for one, so the swap is an import-path change
 * (see docs/TRADINGVIEW.md, "Official typings").
 *
 * Deliberately loose where the library is loose (`overrides` are string-keyed
 * records) and narrow where we depend on the shape (the datafeed contract).
 */

/** A TradingView resolution: '1', '60', '1D', '1W', '1M', ... Branded in the
 *  official typings; a plain string here. */
export type ResolutionString = string;

export type EntityId = string;

// --- datafeed (JS API) --------------------------------------------------------

export interface Exchange {
  value: string;
  name: string;
  desc: string;
}

export interface DatafeedSymbolType {
  name: string;
  value: string;
}

export interface DatafeedConfiguration {
  exchanges?: Exchange[];
  supported_resolutions?: ResolutionString[];
  supports_marks?: boolean;
  supports_timescale_marks?: boolean;
  supports_time?: boolean;
  symbols_types?: DatafeedSymbolType[];
  currency_codes?: string[];
}

export interface SearchSymbolResultItem {
  symbol: string;
  full_name: string;
  description: string;
  exchange: string;
  ticker?: string;
  type: string;
}

export interface LibrarySymbolInfo {
  name: string;
  ticker?: string;
  full_name?: string;
  description: string;
  type: string;
  session: string;
  exchange: string;
  listed_exchange: string;
  timezone: string;
  format: 'price' | 'volume';
  pricescale: number;
  minmov: number;
  minmove2?: number;
  fractional?: boolean;
  has_intraday?: boolean;
  has_weekly_and_monthly?: boolean;
  has_empty_bars?: boolean;
  supported_resolutions?: ResolutionString[];
  intraday_multipliers?: string[];
  daily_multipliers?: string[];
  weekly_multipliers?: string[];
  monthly_multipliers?: string[];
  volume_precision?: number;
  data_status?: 'streaming' | 'endofday' | 'delayed_streaming';
  visible_plots_set?: 'ohlcv' | 'ohlc' | 'c';
  currency_code?: string;
}

export interface Bar {
  /** Milliseconds since epoch, UTC, bar OPEN time. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface PeriodParams {
  /** Unix SECONDS, leftmost bar, inclusive. */
  from: number;
  /** Unix SECONDS, rightmost bar, EXCLUSIVE. */
  to: number;
  /** Bars wanted; takes priority over `from`. Absent on very old builds. */
  countBack: number;
  firstDataRequest: boolean;
}

export interface HistoryMetadata {
  /** No data in the range AND nothing older: stops further history requests. */
  noData?: boolean;
  nextTime?: number | null;
}

export type OnReadyCallback = (config: DatafeedConfiguration) => void;
export type SearchSymbolsCallback = (items: SearchSymbolResultItem[]) => void;
export type ResolveCallback = (symbolInfo: LibrarySymbolInfo) => void;
export type HistoryCallback = (bars: Bar[], meta?: HistoryMetadata) => void;
export type SubscribeBarsCallback = (bar: Bar) => void;
export type DatafeedErrorCallback = (reason: string) => void;

export interface IBasicDataFeed {
  onReady(callback: OnReadyCallback): void;
  searchSymbols(userInput: string, exchange: string, symbolType: string, onResult: SearchSymbolsCallback): void;
  resolveSymbol(
    symbolName: string,
    onResolve: ResolveCallback,
    onError: DatafeedErrorCallback,
    extension?: unknown,
  ): void;
  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: DatafeedErrorCallback,
  ): void;
  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
    onResetCacheNeeded: () => void,
  ): void;
  unsubscribeBars(listenerGuid: string): void;
}

// --- save / load --------------------------------------------------------------

export interface ChartMetaInfo {
  id: string | number;
  name: string;
  symbol: string;
  resolution: ResolutionString;
  /** Unix SECONDS. */
  timestamp: number;
}

export interface ChartData {
  id?: string | number;
  name: string;
  symbol: string;
  resolution: ResolutionString;
  content: string;
}

export interface StudyTemplateMetaInfo {
  name: string;
}

export interface StudyTemplateData {
  name: string;
  content: string;
}

/** Opaque to us: the library produces it and reads it back. */
export type ChartTemplateContent = Record<string, unknown>;

export interface ChartTemplate {
  content?: ChartTemplateContent;
}

export interface IExternalSaveLoadAdapter {
  getAllCharts(): Promise<ChartMetaInfo[]>;
  removeChart(id: string | number): Promise<void>;
  saveChart(chartData: ChartData): Promise<string | number>;
  getChartContent(chartId: string | number): Promise<string>;
  getAllStudyTemplates(): Promise<StudyTemplateMetaInfo[]>;
  removeStudyTemplate(info: StudyTemplateMetaInfo): Promise<void>;
  saveStudyTemplate(data: StudyTemplateData): Promise<void>;
  getStudyTemplateContent(info: StudyTemplateMetaInfo): Promise<string>;
  getDrawingTemplates(toolName: string): Promise<string[]>;
  loadDrawingTemplate(toolName: string, templateName: string): Promise<string>;
  removeDrawingTemplate(toolName: string, templateName: string): Promise<void>;
  saveDrawingTemplate(toolName: string, templateName: string, content: string): Promise<void>;
  getAllChartTemplates(): Promise<string[]>;
  getChartTemplateContent(templateName: string): Promise<ChartTemplate>;
  saveChartTemplate(newName: string, theme: ChartTemplateContent): Promise<void>;
  removeChartTemplate(templateName: string): Promise<void>;
}

// --- widget -------------------------------------------------------------------

export type Overrides = Record<string, string | number | boolean>;

export interface ChartingLibraryWidgetOptions {
  container: HTMLElement | string;
  library_path: string;
  datafeed: IBasicDataFeed;
  symbol: string;
  interval: ResolutionString;
  locale: string;
  timezone?: string;
  theme?: 'dark' | 'light';
  autosize?: boolean;
  fullscreen?: boolean;
  disabled_features?: string[];
  enabled_features?: string[];
  overrides?: Overrides;
  studies_overrides?: Overrides;
  custom_css_url?: string;
  custom_font_family?: string;
  loading_screen?: { backgroundColor?: string; foregroundColor?: string };
  toolbar_bg?: string;
  save_load_adapter?: IExternalSaveLoadAdapter;
  auto_save_delay?: number;
  load_last_chart?: boolean;
  favorites?: { intervals?: ResolutionString[]; chartTypes?: string[] };
}

export interface ShapePoint {
  /** Unix SECONDS. */
  time: number;
  price?: number;
}

export interface CreateMultipointShapeOptions {
  shape: string;
  text?: string;
  lock?: boolean;
  disableSelection?: boolean;
  disableSave?: boolean;
  disableUndo?: boolean;
  showInObjectsTree?: boolean;
  zOrder?: 'top' | 'bottom';
  overrides?: Overrides;
}

/** A point as the library reports it back: both fields present. */
export interface PricedPoint {
  time: number;
  price: number;
}

/** A drawing on the chart (the free drawings API). */
export interface ILineDataSourceApi {
  setPoints(points: ShapePoint[]): void;
  getPoints(): PricedPoint[];
  /** Partial update of the drawing's properties, e.g. `{ text }`. */
  setProperties?(properties: Record<string, unknown>): void;
  getProperties?(): Record<string, unknown>;
  /** false = locked against the user's edits. */
  setUserEditEnabled?(enabled: boolean): void;
  isUserEditEnabled?(): boolean;
  setSelectionEnabled?(enabled: boolean): void;
  bringToFront?(): void;
}

/** The second argument of the widget's `drawing_event`. */
export type DrawingEventType =
  | 'click'
  | 'move'
  | 'remove'
  | 'hide'
  | 'show'
  | 'create'
  | 'properties_changed'
  | 'points_changed';

export interface ISubscription<TArgs extends unknown[]> {
  subscribe(obj: object | null, member: (...args: TArgs) => void, singleshot?: boolean): void;
  unsubscribe(obj: object | null, member: (...args: TArgs) => void): void;
}

export interface IChartWidgetApi {
  setSymbol(symbol: string): Promise<void> | void;
  setResolution(resolution: ResolutionString): Promise<boolean | void> | void;
  resolution(): ResolutionString;
  onIntervalChanged(): ISubscription<[ResolutionString, unknown]>;
  /** A string on older builds, a LibrarySymbolInfo on current ones. */
  symbol?(): unknown;
  onSymbolChanged?(): ISubscription<[unknown]>;
  /** Drops cached bars and re-requests history (after onResetCacheNeeded). */
  resetData?(): void;
  /** Promise<EntityId> on current builds, EntityId | null on older ones. */
  createMultipointShape(
    points: ShapePoint[],
    options: CreateMultipointShapeOptions,
  ): Promise<EntityId> | EntityId | null;
  removeEntity(id: EntityId): void;
  getShapeById(id: EntityId): ILineDataSourceApi | null;
}

export interface CreateTradingViewStyledButtonOptions {
  align: 'left' | 'right';
  useTradingViewStyle: true;
  text: string;
  title?: string;
  onClick?: () => void;
}

export interface CreateHTMLButtonOptions {
  align?: 'left' | 'right';
  useTradingViewStyle?: false;
}

export interface IChartingLibraryWidget {
  onChartReady(callback: () => void): void;
  headerReady(): Promise<void>;
  remove(): void;
  activeChart(): IChartWidgetApi;
  applyOverrides(overrides: Overrides): void;
  createButton(options?: CreateHTMLButtonOptions | CreateTradingViewStyledButtonOptions): HTMLElement | undefined;
  setCSSCustomProperty?(name: string, value: string): void;
  subscribe(event: string, callback: (...args: unknown[]) => void): void;
  unsubscribe(event: string, callback: (...args: unknown[]) => void): void;
  saveChartToServer(
    onComplete?: () => void,
    onFail?: () => void,
    options?: { defaultChartName?: string },
  ): void;
}

export interface TradingViewGlobal {
  widget: new (options: ChartingLibraryWidgetOptions) => IChartingLibraryWidget;
  version?: () => string;
}
