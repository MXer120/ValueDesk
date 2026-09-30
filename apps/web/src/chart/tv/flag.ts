/**
 * Build-time switch for the TradingView chart. Vite inlines
 * `import.meta.env.VITE_CHART` at build, so with the flag off this is the
 * constant `false` and nothing TradingView-related runs - not even the probe
 * for the library files.
 */
export const isTradingViewFlag = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().toLowerCase() === 'tradingview';

// `?.` because `import.meta.env` only exists under Vite; unit tests run this
// module under plain Node (tsx), where it is undefined.
export const TV_ENABLED: boolean = isTradingViewFlag(import.meta.env?.VITE_CHART);
