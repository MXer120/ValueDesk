/**
 * Chart layouts, drawings and templates in localStorage - TradingView's
 * `save_load_adapter`.
 *
 * Drawings live inside the chart layout's `content`, which the library
 * serialises itself; we store the string it hands us and give it back
 * unchanged. Auto-save (TvChart.tsx) writes the same layout id over and over,
 * so this does not grow per edit.
 *
 * EVERY storage access is guarded. localStorage throws in private windows, with
 * blocked site data, and on quota; a layout the size of a busy chart can hit
 * that. A read failure is answered as "nothing saved", a write failure as a
 * rejected promise the library reports in its own UI - never a throw that
 * escapes into the chart.
 *
 * Browser-local by design: nothing here leaves the machine, and a second
 * device starts empty. The server-side route (the library's REST storage) is
 * described in docs/TRADINGVIEW.md for when that matters.
 */
import type {
  ChartData,
  ChartMetaInfo,
  ChartTemplate,
  ChartTemplateContent,
  IExternalSaveLoadAdapter,
  StudyTemplateData,
  StudyTemplateMetaInfo,
} from './types';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const STORAGE_PREFIX = 'vs.tv.';
const K = {
  charts: `${STORAGE_PREFIX}charts`,
  studyTemplates: `${STORAGE_PREFIX}studyTemplates`,
  drawingTemplates: `${STORAGE_PREFIX}drawingTemplates`,
  chartTemplates: `${STORAGE_PREFIX}chartTemplates`,
} as const;

interface StoredChart extends ChartMetaInfo {
  content: string;
}

/** An in-memory stand-in, for when the real storage cannot even be touched. */
export function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

/** window.localStorage when it is usable, otherwise a memory store. Even the
 *  property READ can throw (SecurityError with site data blocked). */
export function safeLocalStorage(): StorageLike {
  try {
    const s = globalThis.localStorage;
    if (s) {
      const probe = `${STORAGE_PREFIX}probe`;
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    }
  } catch {
    /* fall through */
  }
  return memoryStorage();
}

export interface SaveLoadOptions {
  now?: () => number;
  newId?: () => string;
}

export function createSaveLoadAdapter(storage: StorageLike, opts: SaveLoadOptions = {}): IExternalSaveLoadAdapter {
  const now = opts.now ?? (() => Date.now());
  const newId =
    opts.newId ?? (() => `${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

  function read<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
    try {
      const raw = storage.getItem(key);
      if (raw === null) return fallback;
      const v: unknown = JSON.parse(raw);
      return valid(v) ? v : fallback;
    } catch {
      return fallback;
    }
  }

  /** Rejects instead of throwing, so the library's own error path runs. */
  function write(key: string, value: unknown): Promise<void> {
    try {
      storage.setItem(key, JSON.stringify(value));
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  const charts = (): StoredChart[] =>
    read(K.charts, [] as unknown[], isArray).filter(
      (c): c is StoredChart =>
        isRecord(c) &&
        (typeof c.id === 'string' || typeof c.id === 'number') &&
        typeof c.content === 'string',
    );
  const studyTemplates = (): StudyTemplateData[] =>
    read(K.studyTemplates, [] as unknown[], isArray).filter(
      (t): t is StudyTemplateData => isRecord(t) && typeof t.name === 'string' && typeof t.content === 'string',
    );
  const drawingTemplates = (): Record<string, Record<string, string>> =>
    read(K.drawingTemplates, {} as Record<string, unknown>, isRecord) as Record<string, Record<string, string>>;
  const chartTemplates = (): Record<string, ChartTemplateContent> =>
    read(K.chartTemplates, {} as Record<string, unknown>, isRecord) as Record<string, ChartTemplateContent>;

  const missing = (what: string) => Promise.reject(new Error(`${what} not found`));

  return {
    getAllCharts() {
      return Promise.resolve(
        charts().map(({ id, name, symbol, resolution, timestamp }) => ({ id, name, symbol, resolution, timestamp })),
      );
    },
    removeChart(id) {
      return write(K.charts, charts().filter((c) => String(c.id) !== String(id)));
    },
    saveChart(data: ChartData) {
      const list = charts();
      const id = data.id ?? newId();
      const entry: StoredChart = {
        id,
        name: data.name,
        symbol: data.symbol,
        resolution: data.resolution,
        timestamp: Math.floor(now() / 1000),
        content: data.content,
      };
      const i = list.findIndex((c) => String(c.id) === String(id));
      if (i >= 0) list[i] = entry;
      else list.push(entry);
      return write(K.charts, list).then(() => id);
    },
    getChartContent(id) {
      const c = charts().find((x) => String(x.id) === String(id));
      return c ? Promise.resolve(c.content) : missing(`chart ${id}`);
    },

    getAllStudyTemplates() {
      return Promise.resolve(studyTemplates().map(({ name }): StudyTemplateMetaInfo => ({ name })));
    },
    removeStudyTemplate(info) {
      return write(K.studyTemplates, studyTemplates().filter((t) => t.name !== info.name));
    },
    saveStudyTemplate(data) {
      const list = studyTemplates().filter((t) => t.name !== data.name);
      list.push({ name: data.name, content: data.content });
      return write(K.studyTemplates, list);
    },
    getStudyTemplateContent(info) {
      const t = studyTemplates().find((x) => x.name === info.name);
      return t ? Promise.resolve(t.content) : missing(`study template ${info.name}`);
    },

    getDrawingTemplates(toolName) {
      const byTool = drawingTemplates()[toolName];
      return Promise.resolve(isRecord(byTool) ? Object.keys(byTool) : []);
    },
    loadDrawingTemplate(toolName, templateName) {
      const v = drawingTemplates()[toolName]?.[templateName];
      return typeof v === 'string' ? Promise.resolve(v) : missing(`drawing template ${templateName}`);
    },
    removeDrawingTemplate(toolName, templateName) {
      const all = drawingTemplates();
      const byTool = { ...(all[toolName] ?? {}) };
      delete byTool[templateName];
      return write(K.drawingTemplates, { ...all, [toolName]: byTool });
    },
    saveDrawingTemplate(toolName, templateName, content) {
      const all = drawingTemplates();
      return write(K.drawingTemplates, { ...all, [toolName]: { ...(all[toolName] ?? {}), [templateName]: content } });
    },

    getAllChartTemplates() {
      return Promise.resolve(Object.keys(chartTemplates()));
    },
    getChartTemplateContent(templateName): Promise<ChartTemplate> {
      const content = chartTemplates()[templateName];
      return content ? Promise.resolve({ content }) : missing(`chart template ${templateName}`);
    },
    saveChartTemplate(newName, theme) {
      return write(K.chartTemplates, { ...chartTemplates(), [newName]: theme });
    },
    removeChartTemplate(templateName) {
      const all = chartTemplates();
      delete all[templateName];
      return write(K.chartTemplates, all);
    },
  };
}
