/**
 * Persisted dashboard state: where the user dragged things, per breakpoint.
 *
 * Everything here is defensive. localStorage is user-writable, survives across
 * deploys, and is shared with whatever a previous version of this app wrote
 * into it. A malformed record must degrade to "use the configured defaults",
 * never to a crash and never to a panel positioned at NaN - on a trading screen
 * a layout that fails to render is a layout that hides a position.
 */
import type { BreakpointName, DashboardConfig, PanelPlacement, TerminalSeed } from './types';
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
  /** What the rail calls it ("Trade", "News"); unnamed slots are "Layout N". */
  name?: string;
  icon?: string;
  blank?: boolean;
  layouts: Partial<Record<BreakpointName, PanelPlacement[]>>;
  hidden?: string[];
  shown?: string[];
  /** Taken off the icon rail (right-click > Hide from sidebar), kept and still in edit mode. */
  off?: boolean;
}

/** Why a layout went into the history. */
export type HistoryWhy = 'deleted' | 'reset' | 'preset' | 'edited';

/**
 * A layout as it was before it was deleted, reset, replaced by a preset or changed in edit
 * mode: restored as a terminal of its own (right-click on the rail, or edit mode's Layouts tab).
 */
export interface HistoryEntry {
  id: string;
  at: number;
  why: HistoryWhy;
  slot: LayoutSlot;
}

/** Kept at most, newest first. */
export const HISTORY_MAX = 20;

const WHY_TEXT: Record<HistoryWhy, string> = { deleted: 'Deleted', reset: 'Before a reset', preset: 'Before a preset', edited: 'Before an edit' };

/** "Deleted 3 h ago": why and when a layout went into the history. */
export function historyLabel(why: HistoryWhy, at: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  const ago = m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  return `${WHY_TEXT[why]}, ${ago}`;
}

export interface SavedDashboard {
  /** Must match DashboardConfig.version or the record is discarded. */
  v: number;
  /** Only breakpoints the user has actually touched appear here.
   *  This is the ACTIVE slot, mirrored so a reader that does not know about
   *  `slots` still opens the arrangement the user last had on screen. */
  layouts: Partial<Record<BreakpointName, PanelPlacement[]>>;
  /** Drag/resize disabled - so a mis-click on a header cannot move a panel. Locked by default. */
  locked?: boolean;
  /** Set on every save since panels became locked by default: an older record's `locked`
   *  was the old unlocked default, so it opens locked once. */
  lockV?: number;
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
  /** Terminal seeds already added once (DashboardConfig.terminals), so a deleted one stays deleted. */
  seeded?: string[];
  /** Earlier layouts, newest first (HISTORY_MAX). */
  history?: HistoryEntry[];
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

const readSlot = (item: unknown): LayoutSlot | null => {
  if (typeof item !== 'object' || item === null) return null;
  const rec = item as Record<string, unknown>;
  const id = rec['id'];
  if (typeof id !== 'string' || id === '') return null;
  return {
    id,
    ...(typeof rec['name'] === 'string' && rec['name'].trim() ? { name: rec['name'].trim().slice(0, 40) } : {}),
    ...(typeof rec['icon'] === 'string' && rec['icon'] ? { icon: rec['icon'] } : {}),
    ...(rec['blank'] === true ? { blank: true } : {}),
    ...(rec['off'] === true ? { off: true } : {}),
    layouts: readLayouts(rec['layouts']),
    hidden: idList(rec['hidden']),
    shown: idList(rec['shown']),
  };
};

const readSlots = (raw: unknown): LayoutSlot[] | null => {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const slots: LayoutSlot[] = [];
  for (const item of raw) {
    const slot = readSlot(item);
    if (!slot || seen.has(slot.id)) continue;
    seen.add(slot.id);
    slots.push(slot);
  }
  return slots.length ? slots : null;
};

const WHYS: readonly HistoryWhy[] = ['deleted', 'reset', 'preset', 'edited'];

const readHistory = (raw: unknown): HistoryEntry[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const slot = readSlot(rec['slot']);
    const id = rec['id'];
    const at = rec['at'];
    if (!slot || typeof id !== 'string' || !id || seen.has(id) || !Number.isFinite(at)) continue;
    seen.add(id);
    out.push({ id, at: at as number, why: WHYS.includes(rec['why'] as HistoryWhy) ? rec['why'] as HistoryWhy : 'edited', slot });
    if (out.length >= HISTORY_MAX) break;
  }
  return out;
};

const LOCK_V = 1;

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
    const seeded = idList(rec.seeded);
    const history = readHistory(rec.history);
    const extra = { ...(seeded.length ? { seeded } : {}), ...(history.length ? { history } : {}) };
    if (!parsedSlots) {
      return { v: config.version, layouts, locked: rec.lockV === LOCK_V ? rec.locked === true : true, hidden, shown, ...extra };
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
      locked: rec.lockV === LOCK_V ? rec.locked === true : true,
      hidden,
      shown,
      slots,
      ...(activeSlot ? { activeSlot } : {}),
      ...extra,
    };
  } catch {
    return null;
  }
}

const seedSlot = (s: TerminalSeed): LayoutSlot => ({
  id: s.id,
  name: s.name,
  ...(s.icon ? { icon: s.icon } : {}),
  ...(s.blank ? { blank: true } : {}),
  layouts: s.layouts ?? {},
  hidden: s.hidden ?? [],
  shown: s.shown ?? [],
});

/**
 * The dashboard's shipped terminals, added to a saved record once each. With no
 * slots yet the first seed takes the arrangement on screen (it stays the
 * default and stays active) and the others follow it; with slots, the first
 * unnamed one takes the default's name and every seed not added before is
 * appended. `seeded` remembers which, so a deleted terminal stays deleted.
 * A shipped terminal still exactly as an earlier design of it moves to the
 * current one (upgradeSeeded).
 */
export function seedTerminals(state: SavedDashboard, seeds: readonly TerminalSeed[]): SavedDashboard {
  return upgradeSeeded(seedFresh(state, seeds), seeds);
}

/**
 * The panels off the canvas: the ones the user hid, and the `defaultHidden` ones until the user has an opinion
 * (`shown` holds the ids explicitly switched ON). A `blank` canvas is an allow-list: only ids in `shown` are on it,
 * including ones the registry would otherwise show by default. Dashboard.tsx renders by it; TradeDashboard.tsx reads
 * it before the first render, to wait for the code of the widgets that render then.
 */
export function hiddenPanelIds(
  s: { hidden?: readonly string[]; shown?: readonly string[]; blank?: boolean },
  panels: readonly { id: string; defaultHidden?: boolean }[],
): Set<string> {
  const set = new Set(s.hidden ?? []);
  const shown = new Set(s.shown ?? []);
  for (const p of panels) {
    if (s.blank) {
      if (shown.has(p.id)) set.delete(p.id);
      else set.add(p.id);
    } else if (p.defaultHidden && !shown.has(p.id)) {
      set.add(p.id);
    }
  }
  return set;
}

/** A placement list as data that compares: id, place and size, in id order. */
const placed = (l: readonly PanelPlacement[] | undefined) => JSON.stringify([...(l ?? [])].map((p) => [p.i, p.x, p.y, p.w, p.h]).sort());
const sameSet = (a: readonly string[] | undefined, b: readonly string[] | undefined) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

/**
 * A shipped terminal its owner never changed - still panel for panel and cell
 * for cell one of its seed's earlier designs (TerminalSeed.was) - takes the
 * seed's current design. Anything they moved, sized, added or took out stays
 * theirs. The record comes back unchanged (the same object) when nothing moves.
 */
function upgradeSeeded(state: SavedDashboard, seeds: readonly TerminalSeed[]): SavedDashboard {
  if (!state.slots?.length || !seeds.some((t) => t.was?.length)) return state;
  let changed = false;
  const slots = state.slots.map((slot) => {
    const seed = seeds.find((t) => t.id === slot.id);
    if (!seed?.was?.length) return slot;
    // The canvas on screen is the top-level copy.
    const view = slot.id === state.activeSlot ? { layouts: state.layouts, shown: state.shown } : { layouts: slot.layouts, shown: slot.shown };
    const old = seed.was.find((w) => sameSet(w.shown, view.shown)
      && (Object.keys(w.layouts) as BreakpointName[]).every((bp) => placed(w.layouts[bp]) === placed(view.layouts[bp])));
    if (!old) return slot;
    changed = true;
    return { ...slot, layouts: { ...view.layouts, ...seed.layouts }, shown: seed.shown ?? [], hidden: seed.hidden ?? [] };
  });
  if (!changed) return state;
  const active = slots.find((x) => x.id === state.activeSlot);
  return active ? { ...state, slots, layouts: active.layouts, shown: active.shown, hidden: active.hidden } : { ...state, slots };
}

function seedFresh(state: SavedDashboard, seeds: readonly TerminalSeed[]): SavedDashboard {
  if (!seeds.length) return state;
  const seeded = new Set(state.seeded ?? []);
  const fresh = seeds.filter((s) => !seeded.has(s.id));
  if (!fresh.length) return state;
  const [first, ...rest] = seeds;
  if (!first) return state;
  if (!state.slots?.length) {
    const primary: LayoutSlot = { ...seedSlot(first), blank: false, layouts: state.layouts, hidden: state.hidden ?? [], shown: state.shown ?? [] };
    if (!first.blank) delete primary.blank;
    return {
      ...state,
      slots: [primary, ...rest.filter((s) => !seeded.has(s.id)).map(seedSlot)],
      activeSlot: first.id,
      seeded: [...new Set([...seeded, ...seeds.map((s) => s.id)])],
    };
  }
  let slots = [...state.slots];
  for (const s of fresh) {
    seeded.add(s.id);
    if (s === first) {
      const i = slots.findIndex((x) => !x.name);
      if (i >= 0 && !slots.some((x) => x.id === s.id)) slots[i] = { ...slots[i]!, name: s.name, ...(s.icon ? { icon: s.icon } : {}) };
      continue;
    }
    if (!slots.some((x) => x.id === s.id)) slots = [...slots, seedSlot(s)];
  }
  return { ...state, slots, seeded: [...seeded] };
}

/** What "Reset layout" resets: sizes and places only, or the widgets too. */
export type ResetMode = 'sizes' | 'all';

/**
 * The canvas on screen back to its own original: a shipped terminal to its seed
 * (News to the News layout), any other to the designed default. `sizes` keeps
 * which panels it shows; `all` takes those back too. Unlocks the grid.
 */
export function resetSlot(stateIn: SavedDashboard, seeds: readonly TerminalSeed[], mode: ResetMode, now = Date.now()): SavedDashboard {
  // The canvas on screen is the top-level copy; its slot is brought up to it first.
  const state = remember(mirrorIntoActiveSlot(stateIn), stateIn.activeSlot, 'reset', now);
  const seed = seeds.find((t) => t.id === state.activeSlot);
  const layouts = seed?.layouts ?? {};
  if (!state.slots?.length) {
    return mode === 'all'
      ? { v: state.v, layouts: {}, locked: false, ...(state.seeded ? { seeded: state.seeded } : {}) }
      : { ...state, layouts: {}, locked: false };
  }
  const slots = state.slots.map((s) => {
    if (s.id !== state.activeSlot) return s;
    if (mode === 'sizes') return { ...s, layouts };
    const next: LayoutSlot = { ...s, layouts, hidden: seed?.hidden ?? [], shown: seed?.shown ?? [] };
    if (seed?.blank) next.blank = true;
    else delete next.blank;
    return next;
  });
  const active = slots.find((s) => s.id === state.activeSlot);
  return {
    ...state,
    locked: false,
    slots,
    layouts: active?.layouts ?? {},
    hidden: active?.hidden ?? [],
    shown: active?.shown ?? [],
  };
}

export interface TerminalView {
  id: string;
  name: string;
  icon: string | null;
}

/** A slot's name as the rail and edit mode show it: unnamed ones are "Layout N" (N its place). */
export const slotName = (state: SavedDashboard, s: LayoutSlot): string => s.name ?? `Layout ${(state.slots ?? []).findIndex((x) => x.id === s.id) + 1}`;

/** The canvases as the rail lists them: the hidden ones are not on it. */
export function terminalsOf(state: SavedDashboard): TerminalView[] {
  return (state.slots ?? []).filter((s) => !s.off).map((s) => ({ id: s.id, name: slotName(state, s), icon: s.icon ?? null }));
}

/** The canvases taken off the rail. */
export function hiddenTerminalsOf(state: SavedDashboard): TerminalView[] {
  return (state.slots ?? []).filter((s) => s.off).map((s) => ({ id: s.id, name: slotName(state, s), icon: s.icon ?? null }));
}

/** A slot as data that compares (what it shows and where): unchanged layouts are not remembered twice. */
const slotKey = (s: LayoutSlot) => JSON.stringify([s.blank === true, s.layouts, [...(s.hidden ?? [])].sort(), [...(s.shown ?? [])].sort()]);

/**
 * Slot `id` as it is now, put first in the history (`why` it left). A layout the same as the
 * newest entry of that slot is not added again; past HISTORY_MAX the oldest goes.
 */
export function remember(state: SavedDashboard, id: string | undefined, why: HistoryWhy, now = Date.now()): SavedDashboard {
  const mirrored = mirrorIntoActiveSlot(state);
  const slot = mirrored.slots?.find((s) => s.id === id);
  if (!slot) return state;
  const snap: LayoutSlot = { ...slot, name: slotName(mirrored, slot) };
  delete snap.off;
  const history = mirrored.history ?? [];
  const last = history.find((h) => h.slot.id === slot.id);
  if (last && slotKey(last.slot) === slotKey(snap)) {
    return why === 'deleted' && last.why !== 'deleted' ? { ...mirrored, history: history.map((h) => (h === last ? { ...h, at: now, why } : h)) } : mirrored;
  }
  const entry: HistoryEntry = { id: `h${now.toString(36)}-${slot.id}`, at: now, why, slot: snap };
  return { ...mirrored, history: [entry, ...history.filter((h) => h.id !== entry.id)].slice(0, HISTORY_MAX) };
}

/**
 * Every slot that edit mode changed since `before` (the slots when it opened), its earlier
 * layout in the history. Slots added or deleted in edit mode are not "changed".
 */
export function rememberEdits(state: SavedDashboard, before: readonly LayoutSlot[], now = Date.now()): SavedDashboard {
  const mirrored = mirrorIntoActiveSlot(state);
  let next = mirrored;
  for (const old of before) {
    const cur = mirrored.slots?.find((s) => s.id === old.id);
    if (!cur || slotKey(cur) === slotKey(old)) continue;
    // Its earlier layout, under the slot's id and name: remember() snapshots the slot as it is.
    const was = { ...next, slots: next.slots?.map((s) => (s.id === old.id ? { ...old, name: cur.name ?? old.name } : s)), activeSlot: undefined };
    const withOld = remember(was, old.id, 'edited', now);
    next = { ...next, history: withOld.history };
  }
  return next;
}

/** Take a canvas off the rail, or put it back. The last one on the rail stays; one on screen hands over. */
export function setSlotOff(state: SavedDashboard, id: string, off: boolean): SavedDashboard {
  const slots = state.slots ?? [];
  if (!slots.some((s) => s.id === id)) return state;
  if (off && slots.filter((s) => !s.off && s.id !== id).length === 0) return state;
  const next = mirrorIntoActiveSlot({
    ...state,
    slots: slots.map((s) => {
      if (s.id !== id) return s;
      const t = { ...s };
      if (off) t.off = true;
      else delete t.off;
      return t;
    }),
  });
  if (!off || state.activeSlot !== id) return next;
  return activateSlot(next, (next.slots ?? []).find((s) => !s.off)!.id);
}

/** A remembered layout back as a terminal of its own (on the rail and on screen); it leaves the history. */
export function restoreFromHistory(state: SavedDashboard, entryId: string): SavedDashboard {
  const entry = state.history?.find((h) => h.id === entryId);
  if (!entry) return state;
  const base = mirrorIntoActiveSlot(state);
  const slots = base.slots ?? [];
  const id = slots.some((s) => s.id === entry.slot.id) ? freshSlotId(slots) : entry.slot.id;
  const slot: LayoutSlot = { ...entry.slot, id };
  delete slot.off;
  const history = (base.history ?? []).filter((h) => h.id !== entryId);
  if (!slots.length) {
    // A record without slots (only the designed layout): it gets the slot that was on screen, and this one.
    const primary: LayoutSlot = { id: 'primary', layouts: base.layouts, hidden: base.hidden ?? [], shown: base.shown ?? [] };
    return activateSlot({ ...base, slots: [primary, { ...slot, id: id === 'primary' ? 'restored' : id }], activeSlot: 'primary', history }, id === 'primary' ? 'restored' : id);
  }
  return activateSlot({ ...base, slots: [...slots, slot], history }, id);
}

export function saveDashboard(config: DashboardConfig, state: SavedDashboard): void {
  try {
    localStorage.setItem(keyFor(config.id), JSON.stringify({ ...state, v: config.version, lockV: LOCK_V }));
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

/**
 * Drop one canvas; it goes into the history, restorable. The last one resets the page to the
 * designed layout. One on screen hands over to the first canvas still on the rail.
 */
export function removeSlot(stateIn: SavedDashboard, id: string, now = Date.now()): SavedDashboard {
  const state = remember(stateIn, id, 'deleted', now);
  const slots = (state.slots ?? []).filter((s) => s.id !== id);
  if (slots.length === 0) {
    return { ...state, slots: undefined, activeSlot: undefined, layouts: {}, hidden: [], shown: [] };
  }
  // The rail must keep one: if only hidden canvases are left, the first comes back on.
  const visible: LayoutSlot[] = slots.some((s) => !s.off) ? slots : slots.map((s, i) => {
    if (i > 0) return s;
    const on = { ...s };
    delete on.off;
    return on;
  });
  const next = { ...state, slots: visible };
  if (state.activeSlot !== id) return next;
  return activateSlot(next, visible.find((s) => !s.off)!.id);
}

/** Append a blank canvas and switch to it. Persisted on the same record. */
export function addEmptySlot(state: SavedDashboard): SavedDashboard {
  const base = mirrorIntoActiveSlot(ensureEditSlots(state));
  const slots = base.slots ?? [];
  const slot: LayoutSlot = { id: freshSlotId(slots), blank: true, layouts: {}, hidden: [], shown: [] };
  return activateSlot({ ...base, slots: [...slots, slot] }, slot.id);
}
