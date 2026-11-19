/**
 * Which widgets the trade page draws at its first commit, and which are a tap away, read from what this browser
 * stored (lazyWidgets.tsx says why it matters: their code is not in the page's chunk). Pure but for localStorage,
 * so the tests run it on records of their own.
 */
import { hiddenPanelIds, loadDashboard, seedTerminals } from './storage';
import type { DashboardConfig } from './types';

/** A stored JSON value (hooks.ts useStored writes them), or null. */
export function storedJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** The chart card's open tab (tradeTabs.tsx ChartCard) and the account band's extra tabs (tabExtras.tsx). */
export const CHART_TAB_KEY = 'vs.tabs.chart.active';
export const BAND_TABS_KEY = 'vs.tabs.band';

/**
 * The panels and tabs the first render can draw, read the way Dashboard.tsx and tradeTabs.tsx read them: every
 * panel the stored canvas (after the shipped terminals join it, storage.ts seedTerminals) does not hide, and the
 * chart card's open tab. The account band always opens on its own first tab. Breakpoints are not narrowed: a widget
 * panel is on the canvas at every one, and a tab id that is not on screen costs one chunk, never a frame.
 */
export function firstRenderWidgetIds(config: DashboardConfig, panels: readonly { id: string; defaultHidden?: boolean }[]): string[] {
  try {
    const base = loadDashboard(config) ?? { v: config.version, layouts: {}, locked: true };
    const saved = config.terminals ? seedTerminals(base, config.terminals) : base;
    const blank = saved.slots?.find((s) => s.id === saved.activeSlot)?.blank === true;
    const hidden = hiddenPanelIds({ hidden: saved.hidden, shown: saved.shown, blank }, panels);
    const ids = panels.filter((p) => !hidden.has(p.id)).map((p) => p.id);
    const tab = storedJson(CHART_TAB_KEY);
    if (typeof tab === 'string' && tab !== 'main') ids.push(tab);
    return ids;
  } catch {
    return [];
  }
}

/** The widgets added as account tabs: on a phone, the ones a tap away. */
export function bandTabIds(): string[] {
  const band = storedJson(BAND_TABS_KEY);
  return Array.isArray(band) ? band.filter((x): x is string => typeof x === 'string') : [];
}
