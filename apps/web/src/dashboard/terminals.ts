/**
 * The trade page's terminals, for the icon rail (SideBar.tsx).
 *
 * The dashboard owns the saved slots (Dashboard.tsx); while it is mounted it
 * publishes them here and takes the rail's requests (switch, add, hide, delete,
 * restore). On any other page the rail reads and writes the same localStorage
 * record itself, and the dashboard opens on the chosen terminal when the trade
 * page comes back.
 */
import { useSyncExternalStore } from 'react';
import {
  activateSlot, addEmptySlot, hiddenTerminalsOf, loadDashboard, removeSlot, restoreFromHistory, saveDashboard, seedTerminals,
  setSlotOff, terminalsOf, type HistoryWhy, type SavedDashboard, type TerminalView,
} from './storage';
import type { DashboardConfig } from './types';

export type { TerminalView };

/** A remembered layout as the rail offers it back. */
export interface HistoryView {
  id: string;
  name: string;
  at: number;
  why: HistoryWhy;
}

export interface TerminalsSnapshot {
  /** On the rail. */
  list: TerminalView[];
  active: string | null;
  /** Taken off the rail (Hide from sidebar). */
  hidden: TerminalView[];
  /** Earlier layouts, newest first. */
  history: HistoryView[];
}

interface Handler {
  activate: (id: string) => void;
  add: () => void;
  /** Off the rail (true) or back on it. */
  setOff: (id: string, off: boolean) => void;
  remove: (id: string) => void;
  restore: (entryId: string) => void;
  /** Edit mode, on its Layouts tab. */
  openLayouts: () => void;
}

let snap: TerminalsSnapshot | null = null;
let handler: Handler | null = null;
let layoutsAsked = false;
const subs = new Set<() => void>();

const sameViews = (a: readonly TerminalView[], b: readonly TerminalView[]) =>
  a.length === b.length && a.every((t, i) => t.id === b[i]!.id && t.name === b[i]!.name && t.icon === b[i]!.icon);

const same = (a: TerminalsSnapshot | null, b: TerminalsSnapshot) =>
  !!a && a.active === b.active && sameViews(a.list, b.list) && sameViews(a.hidden, b.hidden)
  && a.history.length === b.history.length && a.history.every((h, i) => h.id === b.history[i]!.id);

/** The dashboard's current terminals; listeners re-render on a change. */
export function publishTerminals(next: TerminalsSnapshot): void {
  if (same(snap, next)) return;
  snap = next;
  subs.forEach((f) => f());
}

export const snapshotOf = (s: SavedDashboard): TerminalsSnapshot => ({
  list: terminalsOf(s),
  active: s.activeSlot ?? null,
  hidden: hiddenTerminalsOf(s),
  history: (s.history ?? []).map((h) => ({ id: h.id, name: h.slot.name ?? 'Layout', at: h.at, why: h.why })),
});

/** The mounted dashboard takes the rail's requests; returns the unregister. */
export function registerTerminals(h: Handler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

function stored(config: DashboardConfig): SavedDashboard {
  const base = loadDashboard(config) ?? { v: config.version, layouts: {}, locked: true };
  return seedTerminals(base, config.terminals ?? []);
}

/** Without a mounted dashboard: the change on the stored record, published to the rail. */
function offline(config: DashboardConfig, change: (s: SavedDashboard) => SavedDashboard): void {
  const next = change(stored(config));
  saveDashboard(config, next);
  publishTerminals(snapshotOf(next));
}

export function useTerminals(config: DashboardConfig): TerminalsSnapshot {
  return useSyncExternalStore(
    (on) => {
      subs.add(on);
      return () => subs.delete(on);
    },
    () => snap ?? (snap = snapshotOf(stored(config))),
  );
}

/** Put terminal `id` on screen (now, or when the trade page next opens). */
export function activateTerminal(config: DashboardConfig, id: string): void {
  if (handler) return handler.activate(id);
  offline(config, (s) => activateSlot(s, id));
}

/** A new, empty terminal, made the one on screen (the dashboard opens edit mode for it). */
export function addTerminal(config: DashboardConfig): void {
  if (handler) return handler.add();
  offline(config, addEmptySlot);
}

/** Take terminal `id` off the rail (kept, and still in edit mode), or put it back. */
export function setTerminalOff(config: DashboardConfig, id: string, off: boolean): void {
  if (handler) return handler.setOff(id, off);
  offline(config, (s) => setSlotOff(s, id, off));
}

/** Delete terminal `id`: its layout goes into the history, restorable. */
export function removeTerminal(config: DashboardConfig, id: string): void {
  if (handler) return handler.remove(id);
  offline(config, (s) => removeSlot(s, id));
}

/** A remembered layout back on the rail, on screen. */
export function restoreTerminal(config: DashboardConfig, entryId: string): void {
  if (handler) return handler.restore(entryId);
  offline(config, (s) => restoreFromHistory(s, entryId));
}

/** Edit mode on its Layouts tab: now, or once the trade page is open (takeLayoutsAsk). */
export function openLayouts(): void {
  if (handler) return handler.openLayouts();
  layoutsAsked = true;
}

/** The dashboard, on mounting: was edit mode's Layouts tab asked for while it was away? */
export function takeLayoutsAsk(): boolean {
  const asked = layoutsAsked;
  layoutsAsked = false;
  return asked;
}
