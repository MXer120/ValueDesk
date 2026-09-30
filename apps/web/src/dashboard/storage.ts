/**
 * Persisted dashboard state: where the user dragged things, per breakpoint.
 *
 * Everything here is defensive. localStorage is user-writable, survives across
 * deploys, and is shared with whatever a previous version of this app wrote
 * into it. A malformed record must degrade to "use the configured defaults",
 * never to a crash and never to a panel positioned at NaN - on a trading screen
 * a layout that fails to render is a layout that hides a position.
 */
import type { BreakpointName, DashboardConfig, PanelPlacement } from './types';
import { BREAKPOINT_ORDER } from './types';

const KEY_PREFIX = 'ot.dashboard.';

/**
 * One saved canvas. Several of these live on a dashboard record so edit mode
 * can switch arrangements without a second localStorage key.
 *
 * `blank` is a canvas with nothing on it until a widget is dropped. It is not
 * the same as an empty `layouts` object: that one still shows the designed
 * defaults. A blank canvas stays empty across registry additions because
 * visibility is an allow-list (`shown`), not "whatever the defaults are today".
 */
export interface LayoutSlot {
  id: string;
  blank?: boolean;
  layouts: Partial<Record<BreakpointName, PanelPlacement[]>>;
  hidden?: string[];
  shown?: string[];
}

export interface SavedDashboard {
  /** Must match DashboardConfig.version or the record is discarded. */
  v: number;
  /** Only breakpoints the user has actually touched appear here.
   *  This is the ACTIVE slot, mirrored so a reader that does not know about
   *  `slots` still opens the arrangement the user last had on screen. */
  layouts: Partial<Record<BreakpointName, PanelPlacement[]>>;
  /** Drag/resize disabled - so a mis-click on a header cannot move a panel. */
  locked?: boolean;
  /** Panel ids the user has removed from the grid via the layout menu - not
   *  breakpoint-scoped like `layouts`, because a panel a person chose to hide
   *  is a statement about wanting that panel gone, not about one screen size. */
  hidden?: string[];
  /** Ids explicitly switched ON, so a `defaultHidden` panel stays on. */
  shown?: string[];
  /**
   * Every saved canvas, including the active one. Absent on records written
   * before edit mode. Optional on purpose: adding it does not change `v`, so
   * a saved arrangement is not discarded on upgrade.
   */
  slots?: LayoutSlot[];
  /** Which slot is mirrored into `layouts` / `hidden` / `shown`. */
  activeSlot?: string;
}

const keyFor = (id: string): string => `${KEY_PREFIX}${id}`;

const idList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string' && id !== '') : [];

const isFinitePlacement = (v: unknown): v is PanelPlacement => {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p['i'] !== 'string' || p['i'] === '') return false;
  // Number.isFinite, not typeof === 'number': JSON round-trips NaN as null but
  // a hand-edited record can carry anything, and a NaN width propagates into
  // the CSS transform and blanks the panel with no error anywhere.
  return (['x', 'y', 'w', 'h'] as const).every((k) => Number.isFinite(p[k]));
};

const readLayouts = (raw: unknown): SavedDashboard['layouts'] => {
  const layouts: SavedDashboard['layouts'] = {};
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  for (const bp of BREAKPOINT_ORDER) {
    const list = src[bp];
    if (!Array.isArray(list)) continue;
    const clean = list.filter(isFinitePlacement).map((p) => ({
      i: p.i, x: p.x, y: p.y, w: p.w, h: p.h,
    }));
    if (clean.length) layouts[bp] = clean;
  }
  return layouts;
};

const readSlots = (raw: unknown): LayoutSlot[] | null => {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const slots: LayoutSlot[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const id = rec['id'];
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    slots.push({
      id,
      ...(rec['blank'] === true ? { blank: true } : {}),
      layouts: readLayouts(rec['layouts']),
      hidden: idList(rec['hidden']),
      shown: idList(rec['shown']),
    });
  }
  return slots.length ? slots : null;
};

/** Reads saved state, or null if there is none / it is unusable / it is stale. */
export function loadDashboard(config: DashboardConfig): SavedDashboard | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(keyFor(config.id));
  } catch {
    return null; // private mode, storage disabled - defaults are fine
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as Partial<SavedDashboard>;
    // A version bump in layout.ts is the deliberate way to retire old layouts.
    if (rec.v !== config.version) return null;

    // Drop individual bad rows rather than the whole breakpoint: losing one
    // panel's saved position is recoverable (it falls back to the default),
    // losing the entire arrangement is not.
    const layouts = readLayouts(rec.layouts);
    const hidden = idList(rec.hidden);
    // `shown` has to round-trip. Dropping it here turned every default-off
    // panel back off on the next load, and the following save erased the
    // user's choice. Slots mirror the same list, so it has to survive.
    const shown = idList(rec.shown);
    const parsedSlots = readSlots(rec.slots);
    if (!parsedSlots) {
      return { v: config.version, layouts, locked: rec.locked === true, hidden, shown };
    }
    // The top-level fields are the active canvas. Copy them onto that slot so
    // a write that updated the mirror and not the slot (or the other way
    // round) cannot reopen a stale arrangement. Other slots are left alone.
    const activeSlot = parsedSlots.some((s) => s.id === rec.activeSlot)
      ? rec.activeSlot
      : parsedSlots[0]?.id;
    const slots = parsedSlots.map((s) =>
      s.id === activeSlot ? { ...s, layouts, hidden, shown } : s,
    );
    return {
      v: config.version,
      layouts,
      locked: rec.locked === true,
      hidden,
      shown,
      slots,
      ...(activeSlot ? { activeSlot } : {}),
    };
  } catch {
    return null;
  }
}

export function saveDashboard(config: DashboardConfig, state: SavedDashboard): void {
  try {
    localStorage.setItem(keyFor(config.id), JSON.stringify({ ...state, v: config.version }));
  } catch {
    /* quota or private mode; the layout still works for this session */
  }
}

export function clearDashboard(config: DashboardConfig): void {
  try {
    localStorage.removeItem(keyFor(config.id));
  } catch {
    /* nothing to do - the caller resets in-memory state either way */
  }
}

const freshSlotId = (slots: readonly { id: string }[]): string => {
  const used = new Set(slots.map((s) => s.id));
  let n = slots.length + 1;
  let id = `layout-${n}`;
  while (used.has(id)) {
    n += 1;
    id = `layout-${n}`;
  }
  return id;
};

/**
 * Copy the active canvas onto its slot. Top-level `layouts` / `hidden` /
 * `shown` stay the copy the grid reads, so every existing write path keeps
 * working; the slot library is what edit mode switches between.
 */
export function mirrorIntoActiveSlot(state: SavedDashboard): SavedDashboard {
  if (!state.slots || !state.activeSlot) return state;
  let changed = false;
  const slots = state.slots.map((s) => {
    if (s.id !== state.activeSlot) return s;
    if (s.layouts === state.layouts && s.hidden === state.hidden && s.shown === state.shown) return s;
    changed = true;
    return { ...s, layouts: state.layouts, hidden: state.hidden, shown: state.shown };
  });
  return changed ? { ...state, slots } : state;
}

/**
 * Edit mode always has two canvases to show: the one on screen, and one other.
 * Records that predate slots grow them here, in memory, and the caller persists
 * only when this returns a new object. `v` is not touched.
 */
export function ensureEditSlots(state: SavedDashboard): SavedDashboard {
  const slots = state.slots ?? [];
  if (slots.length >= 2) {
    const active = slots.some((s) => s.id === state.activeSlot) ? state.activeSlot : slots[0]?.id;
    if (!active || active === state.activeSlot) return state;
    return activateSlot(state, active);
  }
  if (slots.length === 1) {
    const only = slots[0];
    if (!only) return state;
    const primary: LayoutSlot = {
      ...only,
      layouts: state.layouts,
      hidden: state.hidden,
      shown: state.shown,
    };
    const alt: LayoutSlot = {
      id: freshSlotId([primary]),
      layouts: state.layouts,
      hidden: state.hidden,
      shown: state.shown,
    };
    return { ...state, slots: [primary, alt], activeSlot: primary.id };
  }
  const primary: LayoutSlot = {
    id: 'primary',
    layouts: state.layouts,
    hidden: state.hidden,
    shown: state.shown,
  };
  const alt: LayoutSlot = {
    id: 'alt',
    layouts: state.layouts,
    hidden: state.hidden,
    shown: state.shown,
  };
  return { ...state, slots: [primary, alt], activeSlot: 'primary' };
}

/** Make `id` the canvas on screen. The one leaving keeps whatever it has now. */
export function activateSlot(state: SavedDashboard, id: string): SavedDashboard {
  const mirrored = mirrorIntoActiveSlot(state);
  if (mirrored.activeSlot === id) return mirrored;
  const slot = mirrored.slots?.find((s) => s.id === id);
  if (!slot) return mirrored;
  return {
    ...mirrored,
    activeSlot: id,
    layouts: slot.layouts,
    hidden: slot.hidden ?? [],
    shown: slot.shown ?? [],
  };
}

/** Drop one canvas. The last one resets the page to the designed layout. */
export function removeSlot(state: SavedDashboard, id: string): SavedDashboard {
  const slots = (state.slots ?? []).filter((s) => s.id !== id);
  if (slots.length === 0) {
    return { ...state, slots: undefined, activeSlot: undefined, layouts: {}, hidden: [], shown: [] };
  }
  const next = { ...state, slots };
  if (state.activeSlot !== id) return next;
  return activateSlot(next, slots[0]!.id);
}

/** Append a blank canvas and switch to it. Persisted on the same record. */
export function addEmptySlot(state: SavedDashboard): SavedDashboard {
  const base = mirrorIntoActiveSlot(ensureEditSlots(state));
  const slots = base.slots ?? [];
  const slot: LayoutSlot = { id: freshSlotId(slots), blank: true, layouts: {}, hidden: [], shown: [] };
  return activateSlot({ ...base, slots: [...slots, slot] }, slot.id);
}
