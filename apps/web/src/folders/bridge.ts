/**
 * The seam between the knowledge folders (apps/web/src/folders/) and what puts
 * things into them or opens what they hold: the chart's "Export to folder" and
 * "Open chart", the News widget's "Save to folder".
 *
 * Dependency-free on purpose (type imports only): the chart can build against
 * this file before the folders UI is merged, and the folders UI works before
 * the chart registers anything. Who owns what:
 *
 *   - the CHART (apps/web/src/chart/) builds a ChartSnapshot from the chart on
 *     screen (with the user's toggles: the position, the execution arrows),
 *     calls saveToFolder with it, and registers how a snapshot is opened again
 *     (registerChartOpener) - and, if it has one, a live preview
 *     (registerChartPreview);
 *   - the FOLDERS (apps/web/src/folders/) register the save handler (the folder
 *     picker, the wallet sign-in), store the snapshot as it is, and call
 *     openChartSnapshot when the user opens a chart item.
 *
 * The snapshot is stored as the chart hands it over; the server only checks
 * its shape (v, engine, symbol, interval) and its size (FOLDER_LIMITS on the
 * server, 256 KB). A field the chart adds later rides along untouched; a
 * change that old snapshots cannot be read with is a new `v`.
 */
import type { ComponentType } from 'react';
import type { StoredDrawing } from '../chart/drawingStore';
import type { IndicatorSpec } from '../chart/indicators';

/** Everything needed to open the same chart again - not a picture of it. */
export interface ChartSnapshot {
  v: 1;
  engine: 'perps' | 'spot';
  /** The market as the app names it (BTC-USD). */
  symbol: string;
  /** The timeframe (chart/intervals.ts: 1m … 1M). */
  interval: string;
  /** Which price the candles show; 'latest' when absent. */
  priceSource?: 'latest' | 'mark' | 'index';
  /** The stretch on screen when it was taken (bar times, ms), so it opens there. */
  range?: { from: number; to: number };
  /** The market's drawings (drawingStore.ts), as kept per market. */
  drawings: StoredDrawing[];
  /** The studies (indicators.ts), in their panes. */
  indicators: IndicatorSpec[];
  /** What the user chose to include when exporting. */
  include: { position: boolean; executions: boolean };
  /** The position at the time, frozen; only with include.position. */
  position?: { side: 'long' | 'short'; size: string; entry: string; liquidation?: string; mark?: string } | null;
  /** The fills drawn as execution arrows, frozen; only with include.executions. At most 500. */
  executions?: Array<{ time: number; side: 'buy' | 'sell'; price: string; size: string }>;
  /** When it was taken (ms). */
  at: number;
}

/** A news story as the News widget shows it (the server's NewsItem, trimmed). */
export interface SavedNews {
  id: string;
  title: string;
  /** The story's own page; http(s) only. */
  href: string;
  /** Publish time (ms); 0 when unknown. */
  time: number;
  author: string | null;
  symbols: string[];
  summary?: string | null;
  /** A post on X: the title is its text. */
  post?: boolean;
}

/** What can be handed to a folder from outside the folders UI. */
export type FolderDraft =
  | {
      kind: 'chart';
      /** The item's name in the folder; the user can change it in the picker. */
      title: string;
      data: ChartSnapshot;
      /** A small picture for the folder's card (klinecharts getConvertPictureUrl): data:image/png or
       *  data:image/jpeg, at most 200 KB decoded. Optional: without it the card shows the market. */
      thumb?: string;
    }
  | { kind: 'news'; title: string; data: SavedNews };

/** Where a draft went. */
export interface SavedTo {
  folderId: string;
  itemId: string;
}

type SaveHandler = (draft: FolderDraft) => Promise<SavedTo | null>;

let saveHandler: SaveHandler | null = null;
let chartOpener: ((s: ChartSnapshot) => void) | null = null;
let chartPreview: ComponentType<{ snapshot: ChartSnapshot; height: number }> | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

/**
 * Put something into a folder: opens the folder picker (and asks the wallet to
 * sign in to its folders when it has not). Resolves with where it went, or null
 * when the user cancelled or folders are not available here. Never throws.
 */
export async function saveToFolder(draft: FolderDraft): Promise<SavedTo | null> {
  if (!saveHandler) return null;
  try {
    return await saveHandler(draft);
  } catch {
    return null;
  }
}

/** Whether saveToFolder can do anything - a button that offers it shows only then. */
export const foldersAvailable = (): boolean => saveHandler !== null;

/** Open a stored snapshot on the chart. False when no chart has registered how. */
export function openChartSnapshot(s: ChartSnapshot): boolean {
  if (!chartOpener) return false;
  chartOpener(s);
  return true;
}

export const chartOpenerRegistered = (): boolean => chartOpener !== null;

/** The live preview the chart registered, if any. */
export const chartPreviewComponent = (): ComponentType<{ snapshot: ChartSnapshot; height: number }> | null => chartPreview;

/** The folders UI: what saveToFolder runs. Returns the unregister. */
export function registerSaveHandler(h: SaveHandler): () => void {
  saveHandler = h;
  changed();
  return () => {
    if (saveHandler === h) saveHandler = null;
    changed();
  };
}

/** The chart: how a snapshot is opened again (switch market and interval, restore its drawings and studies). */
export function registerChartOpener(open: (s: ChartSnapshot) => void): () => void {
  chartOpener = open;
  changed();
  return () => {
    if (chartOpener === open) chartOpener = null;
    changed();
  };
}

/** The chart, optionally: an interactive preview of a snapshot inside the folder view. */
export function registerChartPreview(c: ComponentType<{ snapshot: ChartSnapshot; height: number }>): () => void {
  chartPreview = c;
  changed();
  return () => {
    if (chartPreview === c) chartPreview = null;
    changed();
  };
}

/** Called whenever a registration changes (for a useSyncExternalStore). */
export function onBridgeChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
