/**
 * The trade page's terminals, for the icon rail (SideBar.tsx).
 *
 * The dashboard owns the saved slots (Dashboard.tsx); while it is mounted it
 * publishes them here and takes the rail's requests (switch, add). On any other
 * page the rail reads and writes the same localStorage record itself, and the
 * dashboard opens on the chosen terminal when the trade page comes back.
 */
import { useSyncExternalStore } from 'react';
import { activateSlot, addEmptySlot, loadDashboard, saveDashboard, seedTerminals, terminalsOf, type SavedDashboard, type TerminalView } from './storage';
import type { DashboardConfig } from './types';

export type { TerminalView };

export interface TerminalsSnapshot {
  list: TerminalView[];
  active: string | null;
}

interface Handler {
  activate: (id: string) => void;
  add: () => void;
}

let snap: TerminalsSnapshot | null = null;
let handler: Handler | null = null;
const subs = new Set<() => void>();

const same = (a: TerminalsSnapshot | null, b: TerminalsSnapshot) =>
  !!a && a.active === b.active && a.list.length === b.list.length
  && a.list.every((t, i) => t.id === b.list[i]!.id && t.name === b.list[i]!.name && t.icon === b.list[i]!.icon);

/** The dashboard's current terminals; listeners re-render on a change. */
export function publishTerminals(next: TerminalsSnapshot): void {
  if (same(snap, next)) return;
  snap = next;
  subs.forEach((f) => f());
}

export const snapshotOf = (s: SavedDashboard): TerminalsSnapshot => ({ list: terminalsOf(s), active: s.activeSlot ?? null });

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
  const next = activateSlot(stored(config), id);
  saveDashboard(config, next);
  publishTerminals(snapshotOf(next));
}

/** A new, empty terminal, made the one on screen (the dashboard opens edit mode for it). */
export function addTerminal(config: DashboardConfig): void {
  if (handler) return handler.add();
  const next = addEmptySlot(stored(config));
  saveDashboard(config, next);
  publishTerminals(snapshotOf(next));
}
