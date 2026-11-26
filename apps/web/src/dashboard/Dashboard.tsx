/**
 * The dashboard shell: a draggable/resizable grid of registered panels.
 *
 * This file knows nothing about trading. It takes a panel registry, a layout
 * config and a context object, and is responsible only for measurement,
 * breakpoints, persistence and chrome. Everything domain-specific lives in
 * registry.tsx / layout.ts, which is the whole point - rearranging the terminal
 * must never mean touching this.
 *
 * A note on react-grid-layout v2: the `WidthProvider` HOC and the flat
 * `draggableHandle` / `isResizable` props from v1 are gone. v2 takes an
 * explicit `width` (the container measures itself) and groups behaviour into
 * `gridConfig` / `dragConfig` / `resizeConfig`. The v1 API still exists under
 * 'react-grid-layout/legacy', but we use the current one.
 */
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useLatched } from '../components/motion';
import { GridLayout, verticalCompactor, type Layout, type LayoutItem, type ResizeHandleAxis } from 'react-grid-layout';
import { createScaledStrategy } from 'react-grid-layout/core';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './dashboard.css';

import { Guarded } from '../components/ErrorBoundary';
import { clearColumnSpan, DRAG_COMMIT_PX, dropPlan, fillGaps, firstFit, pointAt, slotBlocks, upsertPlacement, type DropItem, type DropPlan } from './editPlace';
import { LayoutMenu } from './LayoutMenu';
import { panelSettings } from '../settingsBus';
import { PanelChrome } from './Panel';
import { breakpointFor, resolveLayout, samePlacements, toPlacements } from './resolve';
import {
  activateSlot, addEmptySlot, clearDashboard, ensureEditSlots, loadDashboard, mirrorIntoActiveSlot, remember, rememberEdits, removeSlot,
  hiddenPanelIds, historyLabel, resetSlot, restoreFromHistory, saveDashboard, seedTerminals, setSlotOff, slotName, type LayoutSlot, type ResetMode, type SavedDashboard,
} from './storage';
import { ResetDialog } from './ResetDialog';
import { publishTerminals, registerTerminals, snapshotOf, takeLayoutsAsk } from './terminals';
import { SeamLayer } from './SeamLayer';
import { alignedEdges, splitMove, swapMove, zoneAt, type ArrangeBox, type MoveResult, type Zone } from './arrange';
import type { SeamBox } from './seams';
import { TRADE_PRESETS } from './presets';
import { faceFor } from './widgetCatalog';
import { Sketch } from './sketches';
import type { DashboardConfig, PanelDefinition } from './types';
import { describeElement, type ElementInfo } from '../feedback/element';
import { openFeedback } from '../feedback/FeedbackButton';
import { EditDock } from './dock/EditDock';
import type { EditBaseProps, EditStage, PreviewGesture } from './dock/types';
import { DevArrangeOverlay } from './versions/dev';
import { useDragVersion } from './versions/store';

/**
 * Floor for the derived grid. Without one, a short window (or a browser chrome
 * bar appearing) would compute a 1px row and the whole terminal would collapse
 * into unreadable slivers. Below this we stop shrinking and let the dashboard
 * scroll instead, which is the lesser evil.
 *
 * IT IS A MINIMUM DASHBOARD HEIGHT, NOT A MINIMUM ROW HEIGHT, and that
 * distinction is the whole of this comment. It used to be `MIN_ROW_H = 12`, and
 * a floor on the row means the height at which the terminal gives up fitting
 * depends on how many rows the layout happens to be cut into: `12*N + 4*(N-1)`,
 * which is 764px at 48 rows, 812 at 51 and 1436 at 90. That made the row COUNT
 * in layout.ts - a decision about how finely the bands can be cut - silently
 * also a decision about which laptops get a scrollbar, and it is why that file
 * spent a revision unable to go past 48: 51 rows would have scrolled every
 * 900px screen. Stated as a height, re-cutting the grid cannot move it.
 *
 * 764px is exactly what the old 12px row floor produced at the 48-row grid, so
 * this is not a new threshold - it is the same one, expressed in the unit the
 * decision was always really about. A 900px-tall window (1920x900, 1600x900,
 * 1440x900, all common) gives the grid 808px and still fits; a 1280x800 one
 * gives 708 and scrolls ~56px rather than crushing the symbol header into the
 * price line, which is the right way round.
 */
const MIN_FIT_H = 764;

/** The placeholder a palette drag shows in the grid. */
const DROP_KEY = '__drop__';

export interface DashboardProps<C> {
  config: DashboardConfig;
  /** Declared panels, in registry order. Order here does not affect position. */
  panels: PanelDefinition<C>[];
  /** Passed to every panel's title/render/when function. */
  context: C;
  /**
   * Extra class on the dashboard root. This file stays domain-agnostic, so it is
   * not "the portfolio flag" - it is how a page hangs its own CSS scope on the
   * element that wraps its panels. The portfolio page passes `pf`, which is the
   * ancestor its ~40 `.pf .pf-*` rules match against.
   */
  className?: string;
  /** Forwarded verbatim to the layout menu's "Notification settings" item -
   *  this file stays domain-agnostic (see the header comment) by not knowing
   *  WHAT that item does, only that something outside it might want one. */
  onNotificationSettings?: () => void;
  /** Edit mode opened (its palette is where any widget can be dropped): the trade page loads every widget's code then. */
  onEditing?: () => void;
}

interface Box { width: number; height: number }

/**
 * Measures the element the grid lives in.
 *
 * We need BOTH dimensions: width picks the breakpoint and sizes the columns,
 * height is what `fitRows` divides up. react-grid-layout's own
 * `useContainerWidth` only reports width, so we observe once ourselves rather
 * than run two observers over the same node.
 *
 * The first measurement is taken in a layout effect, before paint, so the grid
 * never renders one frame at the wrong breakpoint - which would otherwise show
 * the stacked phone layout for a frame on every desktop load.
 */
function useBox(): [RefObject<HTMLDivElement>, Box] {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const apply = (width: number, height: number) =>
      setBox((prev) =>
        Math.round(prev.width) === Math.round(width) && Math.round(prev.height) === Math.round(height)
          ? prev
          : { width, height });

    const rect = el.getBoundingClientRect();
    apply(rect.width, rect.height);

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // contentRect, not the border box: it already excludes a scrollbar, and
      // handing the grid a width that includes one makes every panel overflow
      // by exactly the scrollbar's width.
      apply(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, box];
}

export function Dashboard<C>({ config, panels, context, className, onEditing }: DashboardProps<C>) {
  const [scrollRef, box] = useBox();
  const [saved, setSaved] = useState<SavedDashboard>(() => {
    const base = loadDashboard(config) ?? { v: config.version, layouts: {}, locked: true };
    // The shipped terminals (Trade, News) join a record once; written below.
    return config.terminals ? seedTerminals(base, config.terminals) : base;
  });
  const seededOnLoad = useRef(saved);
  useEffect(() => {
    if (config.terminals && seededOnLoad.current.seeded?.length) saveDashboard(config, seededOnLoad.current);
  }, [config]);

  /**
   * Set by a drag/resize gesture and cleared once that gesture has been
   * persisted. react-grid-layout also fires onLayoutChange on mount and
   * whenever compaction moves something, and writing those to storage would
   * freeze the very first visitor onto whatever the defaults were that day -
   * every later edit to layout.ts would be invisible to them.
   */
  const dirty = useRef(false);

  // The breakpoint is resolved BEFORE the visibility filter, because a panel may
  // be hidden by screen size and not only by context - the chart has no column
  // of its own once the terminal is down to two, and rides in the book panel's
  // tab bar there instead.
  const bp = breakpointFor(box.width, config.breakpoints);
  const metrics = config.grid[bp];
  const savedForBp = saved.layouts[bp];

  // Two different questions, both filters on `panels`: `eligible` is "can
  // this screen size show this panel at all" (unaffected by the user's own
  // choices - a panel `when()` excludes at this breakpoint is not offered in
  // the layout menu's checklist, since ticking it back on would do nothing
  // visible). `visible` narrows that further by what the user has actually
  // hidden via the menu. Grid resolution and rendering both want `visible`;
  // the layout menu wants `eligible` plus `hiddenSet` to know which of those
  // are currently ticked.
  /*
   * `defaultHidden` panels start off, but ONLY until the user has an opinion.
   *
   * `saved.shown` records ids explicitly switched ON, so ticking one sticks
   * across reloads without having to write every other panel into `hidden`.
   * A panel the user has ticked is never re-hidden by this default.
   */
  /* A blank slot is an allow-list: only ids in `shown` are on the canvas,
     including ones the registry would otherwise show by default. */
  const activeBlank = saved.slots?.find((s) => s.id === saved.activeSlot)?.blank === true;
  // storage.ts hiddenPanelIds: the same answer TradeDashboard.tsx reads before the first render (which widgets' code to wait for).
  const hiddenSet = useMemo(
    () => hiddenPanelIds({ hidden: saved.hidden, shown: saved.shown, blank: activeBlank }, panels),
    [saved.hidden, saved.shown, panels, activeBlank],
  );
  const eligible = panels.filter((p) => !p.when || p.when(context, bp));
  const visible = eligible.filter((p) => !hiddenSet.has(p.id));
  const visibleKey = visible.map((p) => p.id).join('|');

  /**
   * Derive the row height so the designed arrangement fills the viewport.
   * Guarded on a measured height: at width/height 0 (first paint in a hidden
   * tab, jsdom) we fall back to the configured pixel row height rather than
   * dividing by nothing.
   */
  const rowHeight = useMemo(() => {
    const rows = metrics.fitRows;
    if (!rows || rows < 1 || box.height <= 0) return metrics.rowHeight;
    // The height left for the rows themselves once the gutters between them and
    // the container's own padding are taken out. `fitTo` is the same sum for the
    // smallest dashboard we are willing to fit, so the comparison below is
    // "would this be shorter than MIN_FIT_H?" expressed in row pixels.
    const chrome = metrics.containerPadding[1] * 2 + metrics.margin[1] * (rows - 1);
    const usable = box.height - chrome;
    const fitTo = MIN_FIT_H - chrome;
    // NOT floored. Flooring threw away the remainder of the division, and with
    // fitRows = 50 that is up to 49px - which landed as a dead band of bare
    // page background between the last panel row and the status bar. Measured
    // at 1080p it was 46px, nearly twice the height of the status bar itself,
    // and it was reported independently as "the grid does not reach the
    // footer" by three reviewers.
    //
    // A fractional row height is fine here: react-grid-layout multiplies it by
    // the row index and writes the result into a transform, so sub-pixel values
    // composite correctly rather than accumulating rounding drift the way a
    // floored integer does across 90 rows.
    //
    // Math.max on the USABLE height rather than on the quotient, so the floor
    // stays a statement about the dashboard and not about the row - see
    // MIN_FIT_H. Both are divided by the same `rows`, so this is the same
    // comparison either way; doing it here is what keeps the constant readable.
    //
    // The outer 1px is not a design decision, it is arithmetic safety: a layout
    // cut into so many rows that their gutters alone exceed MIN_FIT_H would make
    // `fitTo` negative, and a negative row height renders every panel inside
    // out. Nothing we ship comes near it (90 rows spend 356px on gutters).
    return Math.max(1, Math.max(fitTo, usable) / rows);
  }, [metrics, box.height]);

  /* A shipped terminal still exactly its design, whose design is worked out from the
     grid (TerminalSeed.fit - the News terminal's 16:9 stream): that worked-out design,
     for this width and row height. Nothing is saved from it until its owner moves a panel. */
  const fitted = useMemo(() => {
    const seed = config.terminals?.find((t) => t.id === saved.activeSlot);
    const fit = seed?.fit?.[bp];
    const designed = seed?.layouts?.[bp];
    if (!fit || !designed || box.width <= 0) return null;
    const key = (l: readonly { i: string; x: number; y: number; w: number; h: number }[] | undefined) =>
      JSON.stringify([...(l ?? [])].map((p) => [p.i, p.x, p.y, p.w, p.h]).sort());
    if (key(savedForBp) !== key(designed)) return null;
    const [mx, my] = metrics.margin;
    const colW = (box.width - metrics.containerPadding[0] * 2 - mx * (metrics.cols - 1)) / metrics.cols;
    return fit({ colW, rowH: rowHeight, margin: [mx, my] });
  }, [config.terminals, saved.activeSlot, bp, savedForBp, box.width, metrics, rowHeight]);

  const layout = useMemo(
    () => resolveLayout(visible, config.layouts[bp], fitted ?? savedForBp, metrics.cols, {
      rowHeight,
      margin: metrics.margin,
    }),
    // visibleKey stands in for `visible`, which is a fresh array every render.
    // `rowHeight` IS a dependency: `minPx` floors are converted into rows with
    // it, so a layout resolved against the fallback row height would keep a
    // pixel minimum that no longer matches the grid once the real one is
    // measured - which is how the order book stayed below its own floor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleKey, config, bp, savedForBp, fitted, metrics.cols, rowHeight, metrics.margin],
  );

  const persist = useCallback(
    (next: SavedDashboard) => {
      const mirrored = mirrorIntoActiveSlot(next);
      setSaved(mirrored);
      saveDashboard(config, mirrored);
    },
    [config],
  );

  const onLayoutChange = useCallback(
    (next: Layout) => {
      if (!dirty.current) return;
      dirty.current = false;
      const placements = toPlacements(next);
      setSaved((prev) => {
        if (samePlacements(prev.layouts[bp], placements)) return prev;
        const updated = mirrorIntoActiveSlot({ ...prev, layouts: { ...prev.layouts, [bp]: placements } });
        saveDashboard(config, updated);
        return updated;
      });
    },
    [bp, config],
  );

  // react-grid-layout calls these synchronously, before the onLayoutChange that
  // results from them - so the flag is already set when the write arrives.
  const markDirty = useCallback(() => { dirty.current = true; }, []);

  /* "Reset layout" asks first (ResetDialog.tsx); the terminal on screen then goes back to
     its own original - News to the News layout - sizes only, or widgets too. */
  const [resetAsk, setResetAsk] = useState(false);
  const reset = useCallback((mode: ResetMode) => {
    dirty.current = false;
    setResetAsk(false);
    setSaved((prev) => {
      const next = resetSlot(prev, config.terminals ?? [], mode);
      if (!next.slots?.length && mode === 'all' && !next.seeded) {
        clearDashboard(config);
        return next;
      }
      saveDashboard(config, next);
      return next;
    });
  }, [config]);

  const locked = saved.locked === true;
  const toggleLock = useCallback(
    () => persist({ ...saved, locked: !locked }),
    [persist, saved, locked],
  );

  const toggleHidden = useCallback(
    (id: string) => {
      const next = new Set(saved.hidden ?? []);
      const shown = new Set(saved.shown ?? []);
      const isDefaultHidden = panels.some((p) => p.id === id && p.defaultHidden);
      const currentlyHidden = hiddenSet.has(id);

      if (currentlyHidden) {
        next.delete(id);
        /* Turning ON a default-off panel has to be RECORDED, or the default
           would switch it straight back off on the next render. A blank canvas
           is an allow-list, so every panel it reveals has to be recorded too. */
        if (isDefaultHidden || activeBlank) shown.add(id);
      } else {
        next.add(id);
        shown.delete(id);
      }
      persist({ ...saved, hidden: [...next], shown: [...shown] });
    },
    [persist, saved, hiddenSet, panels, activeBlank],
  );

  /**
   * A direct, one-click lock toggle lives in TickerBar's chrome (Market.tsx),
   * separate from the settings gear that opens the full LayoutMenu below -
   * same domain-agnostic problem the gear's synthetic contextmenu solves
   * (this file owns `locked`, TickerBar does not and is not necessarily even
   * a descendant of the same panel), so it gets the same answer: a window
   * event bridge instead of threading `locked`/`toggleLock` through the
   * generic `context: C` this file is deliberately kept blind to (see the
   * header comment - rearranging the terminal must never mean touching this).
   *
   * Three events, not one, because a plain "broadcast on change" alone drops
   * a listener that mounts AFTER the broadcast already fired - a panel shown
   * again via the layout menu after being hidden, for instance. `dash:lock`
   * fires on every change (mount included) for listeners already up; `query`
   * lets a late-mounting listener ask for the current value on demand instead
   * of waiting for the next real toggle to find out what it already missed.
   */
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('dash:lock', { detail: { locked } }));
  }, [locked]);
  useEffect(() => {
    const onToggle = () => toggleLock();
    const onQuery = () => window.dispatchEvent(new CustomEvent('dash:lock', { detail: { locked } }));
    /*
     * Open the layout menu from anywhere, by event.
     *
     * The gear used to live inside the coin status bar and faked a `contextmenu`
     * at its own position, which the window listener below picked up. From the
     * NAVBAR that trick dies silently: the listener rejects any point outside
     * `.dash-scroll`'s rect, and the navbar sits above it. So the gear now asks
     * for the menu explicitly, the same way the lock button already asks for a
     * toggle - one convention for both, and no dependence on a class name
     * crossing a module boundary.
     */
    const onMenu = (e: Event) => setMenuAt((e as CustomEvent).detail as { x: number; y: number });
    window.addEventListener('dash:menu', onMenu);
    window.addEventListener('dash:lock:toggle', onToggle);
    window.addEventListener('dash:lock:query', onQuery);
    return () => {
      window.removeEventListener('dash:menu', onMenu);
      window.removeEventListener('dash:lock:toggle', onToggle);
      window.removeEventListener('dash:lock:query', onQuery);
    };
  }, [toggleLock, locked]);

  /**
   * The dashboard's own right-click menu. Same geometry-over-ancestry
   * reasoning as Market.tsx's header stat menu: `.dash-scroll` is what a
   * click has to land inside, not `.closest('.dash-panel')`, so empty grid
   * space (below a short column, in the gutters) opens the same menu a panel
   * does rather than falling through to the browser's own "Inspect"/"Copy".
   *
   * BUBBLE phase, deliberately the opposite of Market.tsx's capture-phase
   * listener: this one is a catch-all fallback and has to run LAST, after
   * any panel with its own specific right-click menu (the chart's
   * place-order-here menu, the header's stat picker) has had first refusal
   * and, if it wants this click, already called `preventDefault()` on it -
   * `e.defaultPrevented` is checked below for exactly that. A capture-phase
   * listener here would fire FIRST and steal every one of those clicks
   * before the panel that actually owns them ever saw the event.
   */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; panel?: string | null; element?: ElementInfo } | null>(null);
  /** The layout menu on screen - kept while it fades out. */
  const menuFx = useLatched(menuAt);
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest('.menu-popup')) return;
      const el = scrollRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) return;
      e.preventDefault();
      // The panel under the pointer, for its own settings in the menu.
      const panel = e.target instanceof Element ? e.target.closest('[data-panel]')?.getAttribute('data-panel') ?? null : null;
      // ...and what was right-clicked, for "Send feedback about this" (feedback/element.ts).
      const element = e.target instanceof Element ? describeElement(e.target, window.location.pathname) : undefined;
      setMenuAt({ x: e.clientX, y: e.clientY, panel, element });
    };
    window.addEventListener('contextmenu', onMenu);
    return () => window.removeEventListener('contextmenu', onMenu);
  }, [scrollRef]);

  /*
   * Edit mode is Dock (dock/EditDock.tsx): the page edited in place at full
   * size, one dock at the foot of the window. `\` walks normal -> edit -> latched preview -> edit.
   * Escape leaves. A hold on Preview is momentary; a short press latches.
   */
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (editing) onEditing?.(); }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sticky, setSticky] = useState(false);
  const [holding, setHolding] = useState(false);
  const [ghost, setGhost] = useState<{ name: string; x: number; y: number } | null>(null);
  const [overDelete, setOverDelete] = useState(false);
  const [overPage, setOverPage] = useState(false);
  const previewing = holding || sticky;
  const arrange = editing && !previewing;

  /* The layout editor: Dock on every dashboard (owner 2026-11-26: "editor, dock new default"). `editorV` names it for
     the page's own classes while it is open (dock.css). */
  const editorV = 'dock';
  const [stage, setStage] = useState<EditStage>({ scale: 1, x: 0, y: 0 });
  const onStage = useCallback((s: EditStage) => setStage((p) => (p.scale === s.scale && p.x === s.x && p.y === s.y ? p : s)), []);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const editScale = stage.scale;
  const scaled = useMemo(() => (editScale === 1 ? undefined : createScaledStrategy(editScale)), [editScale]);

  /* Edit mode's right rail (Widgets / Layouts), and every slot as it was when edit mode opened:
     what Done changed goes into the layout history (storage.ts rememberEdits). */
  const [editRail, setEditRail] = useState<'widgets' | 'layouts'>('widgets');
  const editBefore = useRef<LayoutSlot[] | null>(null);
  const enterEdit = useCallback(() => {
    setHolding(false);
    setSticky(false);
    setEditing(true);
    setSaved((prev) => {
      const next = ensureEditSlots(prev);
      if (!editBefore.current) editBefore.current = mirrorIntoActiveSlot(next).slots ?? [];
      if (next === prev) return prev;
      saveDashboard(config, next);
      return next;
    });
  }, [config]);
  // Settings > Layout: straight into the edit canvas, or the reset's confirmation.
  useEffect(() => {
    const onEdit = () => enterEdit();
    const onReset = () => setResetAsk(true);
    window.addEventListener('dash:edit', onEdit);
    window.addEventListener('dash:reset', onReset);
    return () => {
      window.removeEventListener('dash:edit', onEdit);
      window.removeEventListener('dash:reset', onReset);
    };
  }, [enterEdit]);

  const onPreview = useCallback((gesture: PreviewGesture) => {
    if (gesture === 'hold-start') setHolding(true);
    else if (gesture === 'hold-end') { setHolding(false); setSticky(false); }
    else setSticky((s) => !s);
  }, []);

  const endEdit = useCallback(() => {
    setEditing(false);
    setSticky(false);
    setHolding(false);
    setEditRail('widgets');
    const before = editBefore.current;
    editBefore.current = null;
    if (before) {
      setSaved((prev) => {
        const next = rememberEdits(prev, before);
        if (next.history === prev.history) return prev;
        saveDashboard(config, next);
        return next;
      });
    }
  }, [config]);

  /** A change to the saved record, persisted when it is one. */
  const change = useCallback((f: (prev: SavedDashboard) => SavedDashboard) => {
    setSaved((prev) => {
      const next = f(prev);
      if (next === prev) return prev;
      saveDashboard(config, next);
      return next;
    });
  }, [config]);

  /* The icon rail's terminals (terminals.ts): this dashboard says which canvases
     it has and which is on screen, and switches, adds, hides, deletes or restores one when asked. */
  useEffect(() => {
    if (config.terminals) publishTerminals(snapshotOf(saved));
  }, [config.terminals, saved]);
  useEffect(() => {
    if (!config.terminals) return;
    return registerTerminals({
      activate: (id) => {
        setSaved((prev) => {
          const next = activateSlot(prev, id);
          if (next === prev) return prev;
          saveDashboard(config, next);
          return next;
        });
      },
      add: () => {
        setSaved((prev) => {
          const next = addEmptySlot(prev);
          saveDashboard(config, next);
          return next;
        });
        setEditing(true);
      },
      setOff: (id, off) => change((prev) => setSlotOff(prev, id, off)),
      remove: (id) => change((prev) => removeSlot(prev, id)),
      restore: (entryId) => change((prev) => restoreFromHistory(prev, entryId)),
      openLayouts: () => {
        enterEdit();
        setEditRail('layouts');
      },
    });
  }, [config, change, enterEdit]);
  // Asked for from another page (the rail's "All previous layouts"): open on arriving here.
  useEffect(() => {
    if (config.terminals && takeLayoutsAsk()) {
      enterEdit();
      setEditRail('layouts');
    }
  }, [config.terminals, enterEdit]);

  useLayoutEffect(() => {
    const shell = scrollRef.current?.closest('.shell');
    if (!(shell instanceof HTMLElement)) return;
    shell.classList.toggle('is-dash-edit', editing);
    shell.classList.toggle('is-dash-preview', editing && previewing);
    // A version's editor places the page itself (editors.css reads these).
    const v = editing ? editorV : null;
    shell.classList.toggle('is-edit-v', v !== null);
    if (v) {
      shell.dataset.editV = v;
      shell.style.setProperty('--ed-scale', String(stage.scale));
      shell.style.setProperty('--ed-x', `${stage.x}px`);
      shell.style.setProperty('--ed-y', `${stage.y}px`);
    }
    return () => {
      shell.classList.remove('is-dash-edit', 'is-dash-preview', 'is-edit-v');
      delete shell.dataset.editV;
      shell.style.removeProperty('--ed-scale');
      shell.style.removeProperty('--ed-x');
      shell.style.removeProperty('--ed-y');
    };
  }, [editing, previewing, scrollRef, stage]);


  /* A widget dragged in from the palette. While it is over the page the grid shows
     where and how big it lands (`drop`: a placeholder in the live grid, a split pane
     already at its new size); the drop commits that plan. A press that does not move
     adds it under the layout. */
  const dragRef = useRef<{ id: string; name: string; sx: number; sy: number; moved: boolean } | null>(null);
  const [drop, setDrop] = useState<{ id: string; name: string; plan: DropPlan } | null>(null);
  /* Trash mode: a click on a panel removes it. Removals and adds this edit session
     can be undone, newest first (Ctrl+Z or the toast). */
  const [trash, setTrash] = useState(false);
  const undoRef = useRef<{ slot: string | undefined; before: Pick<SavedDashboard, 'layouts' | 'hidden' | 'shown'> }[]>([]);
  const [undoTip, setUndoTip] = useState<{ text: string; n: number } | null>(null);
  /** A panel dragged off the page: released there, it is removed. */
  const [leaving, setLeaving] = useState<string | null>(null);

  /* How a panel is dragged and resized while arranging (versions/store.ts; localhost only, a build answers
     'original'). swap and split move a panel themselves (below) and resize on the lines between panels (SeamLayer);
     flow keeps the grid's own drag, with every edge to resize and a size read-out. A phone's arrangement is fixed. */
  const dragChoice = useDragVersion();
  const dragV = editing && (bp === 'lg' || bp === 'md') ? dragChoice : 'original';
  const tiles = arrange && !trash && (dragV === 'swap' || dragV === 'split');
  /** swap / split: the panel being moved, the panel under the pointer, the side of it (split) and what a release does. */
  const [move, setMove] = useState<{ id: string; name: string; target: string | null; zone: Zone | null; result: MoveResult | null } | null>(null);
  /** flow: the panel's place as the grid would drop it, while dragged or resized. */
  const [flowBox, setFlowBox] = useState<{ i: string; x: number; y: number; w: number; h: number; resizing: boolean; live: readonly LayoutItem[] } | null>(null);
  const liveRef = useRef({
    saved, layout, bp, metrics, rowHeight, hiddenSet, panels, persist, context,
  });
  liveRef.current = { saved, layout, bp, metrics, rowHeight, hiddenSet, panels, persist, context };

  const panelName = useCallback((id: string): string => {
    const p = liveRef.current.panels.find((x) => x.id === id);
    if (!p) return id;
    return faceFor(id)?.name ?? (typeof p.title === 'function' ? p.title(liveRef.current.context) : p.title);
  }, []);

  /** Persist `next`, keeping what it replaces for Undo. */
  const commitEdit = useCallback((next: SavedDashboard, text: string) => {
    const live = liveRef.current;
    undoRef.current = [
      ...undoRef.current.filter((u) => u.slot === live.saved.activeSlot).slice(-19),
      { slot: live.saved.activeSlot, before: { layouts: live.saved.layouts, hidden: live.saved.hidden, shown: live.saved.shown } },
    ];
    live.persist(next);
    setUndoTip((t) => ({ text, n: (t?.n ?? 0) + 1 }));
  }, []);

  /** What the layout is now, kept for Undo before a change the grid or a seam makes itself. */
  const snapshotUndo = useCallback(() => {
    const live = liveRef.current;
    undoRef.current = [...undoRef.current.slice(-19), { slot: live.saved.activeSlot, before: { layouts: live.saved.layouts, hidden: live.saved.hidden, shown: live.saved.shown } }];
  }, []);

  const removePanel = useCallback((id: string) => {
    const live = liveRef.current;
    if (live.hiddenSet.has(id)) return;
    const hidden = new Set(live.saved.hidden ?? []);
    const shown = new Set(live.saved.shown ?? []);
    hidden.add(id);
    shown.delete(id);
    commitEdit({ ...live.saved, hidden: [...hidden], shown: [...shown] }, `Removed ${panelName(id)}`);
  }, [commitEdit, panelName]);

  const undo = useCallback(() => {
    const live = liveRef.current;
    const stack = undoRef.current.filter((u) => u.slot === live.saved.activeSlot);
    const last = stack.pop();
    undoRef.current = stack;
    if (!last) return;
    live.persist({ ...live.saved, ...last.before });
    setUndoTip(stack.length ? (t) => ({ text: 'Undone', n: (t?.n ?? 0) + 1 }) : null);
  }, []);

  /** A panel's new size in columns and rows, inside its own limits and the grid. */
  const resizePanel = useCallback((id: string, w: number, h: number) => {
    const live = liveRef.current;
    const item = live.layout.find((l) => l.i === id);
    if (!item) return;
    const cols = live.metrics.cols;
    const nw = Math.max(item.minW ?? 1, Math.min(Math.round(w), item.maxW ?? cols, cols - item.x));
    const nh = Math.max(item.minH ?? 1, Math.min(Math.round(h), item.maxH ?? Infinity));
    if (nw === item.w && nh === item.h) return;
    const placements = upsertPlacement(toPlacements(live.layout), { i: id, x: item.x, y: item.y, w: nw, h: nh });
    commitEdit({ ...live.saved, layouts: { ...live.saved.layouts, [live.bp]: placements } }, `Resized ${panelName(id)}`);
  }, [commitEdit, panelName]);

  /** The new panel's size and limits at this breakpoint (its designed placement, else a default). */
  const addSpec = (id: string) => {
    const live = liveRef.current;
    const panel = live.panels.find((p) => p.id === id);
    if (!panel) return null;
    const designed = config.layouts[live.bp].find((p) => p.i === id);
    // Not in the designed layout (a palette widget): a third of the width, a readable height.
    const fallback = { i: id, x: 0, y: 0, w: Math.min(live.metrics.cols, Math.max(panel.minW ?? 8, Math.round(live.metrics.cols / 3))), h: Math.max(panel.minH ?? 6, 18) };
    const item = resolveLayout([panel], [designed ?? fallback], undefined, live.metrics.cols, { rowHeight: live.rowHeight, margin: live.metrics.margin })[0];
    if (!item) return null;
    return { i: id, w: item.w, h: item.h, minW: item.minW, minH: item.minH, maxW: item.maxW, maxH: item.maxH };
  };
  const dropItems = (): DropItem[] => liveRef.current.layout.map((item) => {
    const handles = item.resizeHandles ?? ['se'];
    const resizable = item.isResizable !== false && item.static !== true;
    return {
      i: item.i, x: item.x, y: item.y, w: item.w, h: item.h,
      minW: item.minW, minH: item.minH, maxW: item.maxW, maxH: item.maxH,
      growW: resizable && handles.some((hd) => hd.includes('e') || hd.includes('w')),
      growH: resizable && handles.some((hd) => hd.includes('n') || hd.includes('s')),
      fixed: item.static === true,
    };
  });
  /** Persist a drop plan: the panes it moved or split, and the new one shown. */
  const commitPlan = (id: string, plan: DropPlan, text: string) => {
    const live = liveRef.current;
    let base = live.saved.layouts[live.bp] ?? toPlacements(live.layout);
    for (const p of plan.placements) base = upsertPlacement(base, p);
    const hidden = new Set(live.saved.hidden ?? []);
    const shown = new Set(live.saved.shown ?? []);
    hidden.delete(id);
    shown.add(id);
    commitEdit({ ...live.saved, hidden: [...hidden], shown: [...shown], layouts: { ...live.saved.layouts, [live.bp]: base } }, text);
  };
  /** Click (or Enter) on a palette card: the first free spot it fits, else under the layout. */
  const addBelow = (id: string) => {
    const live = liveRef.current;
    if (!live.hiddenSet.has(id)) return;
    const spec = addSpec(id);
    if (!spec) return;
    const at = firstFit(live.layout, spec.w, spec.h, live.metrics.cols);
    const box = { i: id, x: at.x, y: at.y, w: spec.w, h: spec.h };
    commitPlan(id, { placements: [...toPlacements(live.layout), box], box, target: null }, `Added ${panelName(id)}`);
  };

  const startDrag = (id: string, name: string, x: number, y: number) => {
    if (!hiddenSet.has(id)) return;
    dragRef.current = { id, name, sx: x, sy: y, moved: false };
    setGhost({ name, x, y });
    setOverDelete(false);
    setOverPage(false);
  };

  /** Over the page (the scaled canvas), and not over edit chrome floating above it. */
  const overCanvas = (x: number, y: number): boolean => {
    const el = scrollRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) return false;
    const hit = document.elementFromPoint(x, y);
    return !hit?.closest('.dash-edit-root');
  };

  useEffect(() => {
    let planKey = '';
    const planAt = (d: { id: string }, clientX: number, clientY: number): DropPlan | null => {
      const live = liveRef.current;
      const grid = scrollRef.current?.querySelector('.dash-grid');
      if (!(grid instanceof HTMLElement)) return null;
      const spec = addSpec(d.id);
      if (!spec) return null;
      const at = pointAt(clientX, clientY, grid, live.metrics.cols, live.rowHeight, live.metrics.margin, live.metrics.containerPadding);
      return dropPlan(dropItems(), at, spec, live.metrics.cols);
    };
    const clear = () => {
      planKey = '';
      setDrop(null);
    };
    const end = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setGhost(null);
      setOverDelete(false);
      setOverPage(false);
      clear();
      if (!liveRef.current.hiddenSet.has(d.id)) return;
      if (!d.moved) {
        if (e.type === 'pointerup') addBelow(d.id);
        return;
      }
      if (!overCanvas(e.clientX, e.clientY)) return;
      const plan = planAt(d, e.clientX, e.clientY);
      if (plan) commitPlan(d.id, plan, `Added ${d.name}`);
    };
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_COMMIT_PX) return;
      d.moved = true;
      setGhost({ name: d.name, x: e.clientX, y: e.clientY });
      const onPage = overCanvas(e.clientX, e.clientY);
      setOverPage((v) => (v === onPage ? v : onPage));
      const plan = onPage ? planAt(d, e.clientX, e.clientY) : null;
      const key = plan ? JSON.stringify([plan.box, plan.target]) : '';
      if (key === planKey) return;
      planKey = key;
      setDrop(plan ? { id: d.id, name: d.name, plan } : null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    // The handlers read everything live through liveRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, scrollRef]);

  /* swap / split: a panel moved by its head. The grid's own drag is off (dragConfig); the pointer picks the panel it is
     over on the layout as it was when the drag began - so the preview, drawn in the live grid, never moves the target
     out from under it - and, in split, the side of that panel. Release commits the plan (Undo puts it back); off the
     page, onto the dock, the panel is removed, as with the grid's own drag. Esc drops the move. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !tiles) return;
    const mode = dragV;
    type Live = {
      id: string; name: string; sx: number; sy: number; moved: boolean; base: ArrangeBox[];
      key: string; off: boolean; target: string | null; result: MoveResult | null;
    };
    let m: Live | null = null;
    const clear = () => {
      m = null;
      setMove(null);
      setGhost(null);
      setOverDelete(false);
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !(e.target instanceof Element)) return;
      const head = e.target.closest('.ed-ov');
      if (!head || e.target.closest('.ed-ov__x')) return;
      const id = head.closest('[data-panel]')?.getAttribute('data-panel');
      if (!id) return;
      e.preventDefault();
      const base = dropItems().map((d) => ({ ...d, growW: d.growW !== false, growH: d.growH !== false }));
      m = { id, name: panelName(id), sx: e.clientX, sy: e.clientY, moved: false, base, key: '', off: false, target: null, result: null };
    };
    const onMove = (e: PointerEvent) => {
      const cur = m;
      if (!cur) return;
      if (!cur.moved && Math.hypot(e.clientX - cur.sx, e.clientY - cur.sy) < DRAG_COMMIT_PX) return;
      cur.moved = true;
      const off = !overCanvas(e.clientX, e.clientY);
      cur.off = off;
      setOverDelete((v) => (v === off ? v : off));
      setGhost({ name: off ? `Remove ${cur.name}` : cur.name, x: e.clientX, y: e.clientY });
      let target: string | null = null;
      let zone: Zone | null = null;
      let result: MoveResult | null = null;
      const grid = el.querySelector('.dash-grid');
      if (!off && grid instanceof HTMLElement) {
        const live = liveRef.current;
        const { cols, margin, containerPadding } = live.metrics;
        const at = pointAt(e.clientX, e.clientY, grid, cols, live.rowHeight, margin, containerPadding);
        const t = cur.base.find((b) => b.i !== cur.id && at.x >= b.x && at.x < b.x + b.w && at.y >= b.y && at.y < b.y + b.h);
        const a = cur.base.find((b) => b.i === cur.id);
        if (t && a) {
          target = t.i;
          zone = mode === 'split' ? zoneAt((at.x - t.x) / t.w, (at.y - t.y) / t.h) : 'center';
          const colPx = (grid.offsetWidth - margin[0] * (cols - 1)) / cols + margin[0];
          const tall = a.h * (live.rowHeight + margin[1]) >= a.w * colPx;
          result = mode === 'split' ? splitMove(cur.base, cur.id, t.i, zone, cols, tall) : swapMove(cur.base, cur.id, t.i);
        }
      }
      cur.target = target;
      cur.result = result;
      const key = JSON.stringify([target, zone, off]);
      if (key === cur.key) return;
      cur.key = key;
      setMove({ id: cur.id, name: cur.name, target, zone, result });
    };
    const up = () => {
      const done = m;
      clear();
      if (!done?.moved) return;
      if (done.off) {
        removePanel(done.id);
        return;
      }
      const r = done.result;
      if (!r?.ok) return;
      const live = liveRef.current;
      const text = r.plan.kind === 'swap' && done.target ? `Swapped ${done.name} and ${panelName(done.target)}` : `Moved ${done.name}`;
      commitEdit({ ...live.saved, layouts: { ...live.saved.layouts, [live.bp]: r.plan.placements } }, text);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !m?.moved) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      clear();
    };
    el.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', clear);
    window.addEventListener('keydown', key, true);
    return () => {
      el.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', clear);
      window.removeEventListener('keydown', key, true);
      setMove(null);
    };
    // The handlers read everything live through liveRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles, dragV, scrollRef]);

  useEffect(() => {
    if (arrange) return;
    setTrash(false);
    setLeaving(null);
    if (!dragRef.current) return;
    dragRef.current = null;
    setGhost(null);
    setDrop(null);
    setOverDelete(false);
    setOverPage(false);
  }, [arrange]);
  // Leaving edit mode ends its undo: what Done changed is in the layout history (storage.ts).
  useEffect(() => {
    if (editing) return;
    undoRef.current = [];
    setUndoTip(null);
    setSelected(null);
  }, [editing]);
  // A removed panel cannot stay picked.
  useEffect(() => {
    if (selected && hiddenSet.has(selected)) setSelected(null);
  }, [selected, hiddenSet]);

  /* Dock: a press on a panel picks it (its ring), on bare grid clears it; Delete
     removes the picked one. The press still starts the grid's own drag: nothing is prevented. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !arrange || trash) return;
    const down = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || e.target.closest('.ed-ov__x, .react-resizable-handle')) return;
      setSelected(e.target.closest('[data-panel]')?.getAttribute('data-panel') ?? null);
    };
    const key = (e: KeyboardEvent) => {
      const a = document.activeElement;
      const typing = a instanceof HTMLElement && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
      const id = selectedRef.current;
      if (typing || !id || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
      e.preventDefault();
      setSelected(null);
      removePanel(id);
    };
    el.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => {
      el.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [arrange, trash, scrollRef, removePanel]);
  useEffect(() => {
    if (!undoTip) return;
    const t = window.setTimeout(() => setUndoTip(null), 6000);
    return () => window.clearTimeout(t);
  }, [undoTip]);

  /* A panel dragged by the grid itself: off the page (onto the palette, the remove
     zone or the edge) it is removed on release instead of moved. */
  const pointOf = (e: Event): { x: number; y: number } | null => {
    if ('clientX' in e && typeof (e as MouseEvent).clientX === 'number') return { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY };
    const t = (e as TouchEvent).changedTouches?.[0] ?? (e as TouchEvent).touches?.[0];
    return t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onGridDrag = useCallback((_l: Layout, _o: LayoutItem | null, item: LayoutItem | null, _p: LayoutItem | null, e: Event) => {
    if (!item || !editing) return;
    const pt = pointOf(e);
    if (!pt) return;
    const off = !overCanvas(pt.x, pt.y);
    if (off) setFlowBox(null);
    else showFlow(_p, false, _l);
    setLeaving((v) => (off ? item.i : v === item.i ? null : v));
    setOverDelete((v) => (v === off ? v : off));
    setGhost(off ? { name: `Remove ${panelName(item.i)}`, x: pt.x, y: pt.y } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, panelName]);
  /* flow: the place the grid would drop a dragged or resized panel, for the size read-out and the guide lines. */
  const flowRef = useRef(false);
  flowRef.current = dragV === 'flow';
  const showFlow = (p: LayoutItem | null, resizing: boolean, live: readonly LayoutItem[]) => {
    if (!flowRef.current || !p) return;
    setFlowBox((v) => (v && v.i === p.i && v.x === p.x && v.y === p.y && v.w === p.w && v.h === p.h && v.resizing === resizing ? v : { i: p.i, x: p.x, y: p.y, w: p.w, h: p.h, resizing, live }));
  };
  const onGridResize = useCallback((l: Layout, _o: LayoutItem | null, item: LayoutItem | null, p: LayoutItem | null) => {
    showFlow(p ?? item, true, l);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A resize in edit mode is an edit like any other: Undo puts it back.
  const onGridResizeStart = useCallback(() => {
    if (editing) snapshotUndo();
  }, [editing, snapshotUndo]);
  const onGridResizeStop = useCallback(() => {
    setFlowBox(null);
    markDirty();
  }, [markDirty]);
  const onGridDragStop = useCallback((_l: Layout, _o: LayoutItem | null, item: LayoutItem | null, _p: LayoutItem | null, e: Event) => {
    setFlowBox(null);
    setLeaving(null);
    setOverDelete(false);
    setGhost(null);
    const pt = pointOf(e);
    if (editing && item && pt && !overCanvas(pt.x, pt.y)) {
      removePanel(item.i);
      return;
    }
    if (editing && item && _o && (_o.x !== item.x || _o.y !== item.y)) {
      // A move is an edit like any other: Undo puts it back.
      const live = liveRef.current;
      undoRef.current = [...undoRef.current.slice(-19), { slot: live.saved.activeSlot, before: { layouts: live.saved.layouts, hidden: live.saved.hidden, shown: live.saved.shown } }];
    }
    dirty.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, removePanel]);

  // Trash mode: a press on a panel removes it, and nothing inside it reacts.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !trash || !arrange) return;
    const panelOf = (e: Event) => (e.target instanceof Element ? e.target.closest('[data-panel]')?.getAttribute('data-panel') ?? null : null);
    const block = (e: Event) => {
      if (!panelOf(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const click = (e: MouseEvent) => {
      const id = panelOf(e);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      removePanel(id);
    };
    const types = ['pointerdown', 'mousedown', 'touchstart', 'dblclick'] as const;
    for (const t of types) el.addEventListener(t, block, true);
    el.addEventListener('click', click, true);
    return () => {
      for (const t of types) el.removeEventListener(t, block, true);
      el.removeEventListener('click', click, true);
    };
  }, [trash, arrange, scrollRef, removePanel]);

  useEffect(() => {
    const typing = (): boolean => {
      const el = document.activeElement;
      return el instanceof HTMLElement && (
        el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!editing || typing() || menuAt) return;
        e.preventDefault();
        e.stopPropagation();
        // The first Escape leaves trash mode, the next one edit mode.
        if (trash) setTrash(false);
        else endEdit();
        return;
      }
      if (editing && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing()) {
        e.preventDefault();
        undo();
        return;
      }
      const backslash = e.key === '\\' || e.code === 'Backslash';
      if (!backslash || e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing()) return;
      e.preventDefault();
      e.stopPropagation();
      if (!editing) enterEdit();
      else if (holding) return;
      else if (sticky) setSticky(false);
      else setSticky(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, sticky, holding, menuAt, enterEdit, endEdit, trash, undo]);

  /* The grid as drawn: during a palette drag, the plan's panes and a placeholder
     where the new widget lands. */
  const gridLayout = useMemo<Layout>(() => {
    // flow: every edge a panel may grow on resizes it (resolve.ts gives the corner, or one edge for a strip).
    const flowHandles = (item: LayoutItem): LayoutItem => {
      const hs = item.resizeHandles ?? ['se'];
      if (!hs.length) return item;
      const handles: ResizeHandleAxis[] = hs.includes('se') ? ['e', 'w', 's', 'se', 'sw'] : hs.includes('e') ? ['e', 'w'] : [...hs];
      return { ...item, resizeHandles: handles };
    };
    const base = dragV === 'flow' ? layout.map(flowHandles) : layout;
    // swap / split: the move a release would make, drawn in the live grid while the pointer is on it.
    const plan = move?.result?.ok ? move.result.plan : null;
    if (plan) {
      const to = new Map(plan.placements.map((p) => [p.i, p]));
      return base.map((item) => {
        const p = to.get(item.i);
        return p ? { ...item, x: p.x, y: p.y, w: p.w, h: p.h } : item;
      });
    }
    if (!drop) return base;
    const at = new Map(drop.plan.placements.map((p) => [p.i, p]));
    const items = base.map((item) => {
      const p = at.get(item.i);
      return p ? { ...item, x: p.x, y: p.y, w: p.w, h: p.h } : item;
    });
    const b = drop.plan.box;
    return [...items, { i: DROP_KEY, x: b.x, y: b.y, w: b.w, h: b.h, isDraggable: false, isResizable: false }];
  }, [layout, drop, move, dragV]);

  const gridConfig = useMemo(
    () => ({
      cols: metrics.cols,
      rowHeight,
      margin: metrics.margin,
      containerPadding: metrics.containerPadding,
    }),
    [metrics, rowHeight],
  );

  const dragConfig = useMemo(
    () => ({
      // Edit mode is for arranging: the lock (a guard against a stray drag) holds outside it.
      // swap and split move panels themselves (the effect above).
      enabled: (arrange && !trash && !tiles) || (!editing && !locked),
      // Drags start ONLY on panel chrome: the hover-revealed strip along a
      // panel's top edge, and the empty space in a tab bar. Without this,
      // selecting a price in the order book or scrubbing the chart crosshair
      // would drag the panel.
      handle: '.dash-panel__handle',
      // ...but a tab bar is also full of controls, and `label` is in the list
      // because the bottom bar's market filter is a checkbox inside one.
      cancel: '.dash-nodrag, button, input, select, textarea, label, a',
    }),
    [locked, arrange, editing, trash, tiles],
  );

  // swap and split resize on the lines between panels (SeamLayer) instead of a corner.
  const resizeConfig = useMemo(
    () => ({ enabled: (arrange && !trash && !tiles) || (!editing && !locked), handles: ['se'] as const }),
    [locked, arrange, editing, trash, tiles],
  );

  const hasSaved = Object.keys(saved.layouts).length > 0 || activeBlank;
  const layoutById = useMemo(() => new Map(layout.map((item) => [item.i, item])), [layout]);

  /* The seams between panels (SeamLayer.tsx): each side's resize ability is the
     grid item's own (`resizeHandles`), so a strip that only grows sideways never
     gets a seam that would change its height. */
  const seamItems = useMemo<SeamBox[]>(() => layout.map((item) => {
    const handles = item.resizeHandles ?? ['se'];
    const resizable = item.isResizable !== false && item.static !== true;
    return {
      i: item.i, x: item.x, y: item.y, w: item.w, h: item.h,
      minW: item.minW, minH: item.minH, maxW: item.maxW, maxH: item.maxH,
      growH: resizable && handles.some((hd) => hd.includes('n') || hd.includes('s')),
      growW: resizable && handles.some((hd) => hd.includes('e') || hd.includes('w')),
    };
  }), [layout]);
  const onSeamMove = useCallback((next: SeamBox[]) => {
    const placements = next.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
    setSaved((prev) => {
      if (samePlacements(prev.layouts[bp], placements)) return prev;
      const updated = mirrorIntoActiveSlot({ ...prev, layouts: { ...prev.layouts, [bp]: placements } });
      saveDashboard(config, updated);
      return updated;
    });
  }, [bp, config]);
  // Seams where panels can be resized at all: not locked, not arranging, and not on the
  // two narrow breakpoints, whose arrangement is fixed (responsive.css).
  const seamsOn = (!locked && !editing && (bp === 'lg' || bp === 'md')) || tiles;
  // While a seam is dragged the panels follow it 1:1 (no eased transform).
  const [seaming, setSeaming] = useState(false);

  /*
   * A terminal switch, smoothly: for a moment the panels both canvases have glide
   * to their new place and size, and the ones only the new canvas has fade in
   * (`is-switching`, `is-entering` - styles.css). Measured before paint, so a
   * panel arriving is never drawn at full strength first.
   */
  const [swap, setSwap] = useState<Set<string> | null>(null);
  const lastSlot = useRef(saved.activeSlot);
  const lastVisible = useRef<Set<string>>(new Set(visible.map((p) => p.id)));
  const swapTimer = useRef<number | null>(null);
  useLayoutEffect(() => {
    const now = new Set(visible.map((p) => p.id));
    if (lastSlot.current !== saved.activeSlot) {
      lastSlot.current = saved.activeSlot;
      setSwap(new Set([...now].filter((id) => !lastVisible.current.has(id))));
      if (swapTimer.current !== null) window.clearTimeout(swapTimer.current);
      swapTimer.current = window.setTimeout(() => {
        swapTimer.current = null;
        setSwap(null);
      }, 520);
    }
    lastVisible.current = now;
    // visibleKey stands in for `visible`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.activeSlot, visibleKey]);
  useEffect(() => () => { if (swapTimer.current !== null) window.clearTimeout(swapTimer.current); }, []);

  return (
    <div className={`dash${locked && !arrange ? ' is-locked' : ''}${arrange ? ' is-arrange' : ''}${arrange && trash ? ' is-trash' : ''}${overPage && ghost ? ' is-drop' : ''}${swap ? ' is-switching' : ''}${seaming ? ' is-seaming' : ''}${editing ? ` ed-${editorV}` : ''}${dragV !== 'original' ? ` drag-${dragV}` : ''}${move ? ' is-moving' : ''}${className ? ` ${className}` : ''}`}>
      {/* The hover-revealed "Lock layout"/"Reset layout" text strip that used
          to live here is gone, not renamed - LayoutMenu.tsx now carries both
          actions (plus panel visibility and, when the caller wants one, a
          notification-settings item), reachable by right-clicking any panel
          or the settings icon a caller can put in its own chrome (TickerBar's
          gear icon does exactly this via a synthetic `contextmenu`). Two
          controls doing the same job, one hidden behind a hover nobody was
          told about, was redundant the moment the second one existed. */}

      {/* A panel resized by dragging changes size with no window resize event.
          Nothing here broadcasts that: the chart (klinecharts `resize()`) and
          the order book (rows-that-fit) each observe their OWN container, and
          the panel body is that container, so both re-measure on their own.
          Verified by dragging the book's grip from 20 to 13 rows tall and
          watching its row count follow from 17 to 9. Do not add a redundant
          resize broadcast here. */}
      <div className="dash-scroll" ref={scrollRef}>
        {/* Nothing is rendered until the container has a width: a grid drawn at
            width 0 would resolve to the smallest breakpoint and visibly snap on
            the next frame. */}
        {box.width > 0 && (
          <GridLayout
            className="dash-grid"
            width={box.width}
            layout={gridLayout}
            gridConfig={gridConfig}
            dragConfig={dragConfig}
            resizeConfig={resizeConfig}
            onLayoutChange={onLayoutChange}
            onDrag={onGridDrag}
            onDragStop={onGridDragStop}
            onResizeStart={onGridResizeStart}
            onResize={onGridResize}
            onResizeStop={onGridResizeStop}
            compactor={verticalCompactor}
            positionStrategy={arrange ? scaled : undefined}
          >
            {visible.map((panel) => {
              const name = typeof panel.title === 'function' ? panel.title(context) : panel.title;
              return (
                // No title is painted, so the name has to reach assistive tech
                // some other way: seven unlabelled sibling regions are seven
                // identical entries in a rotor. `role="group"` rather than
                // `region`, which would put all seven in the landmark list and
                // bury the page's real landmarks.
                <div
                  key={panel.id}
                  className={[
                    // Every panel is the same card - fill, 4px radius, no
                    // border. There is no per-panel surface modifier any more;
                    // see dashboard.css.
                    'dash-panel',
                    // A panel that may only be resized horizontally is, by
                    // definition, one whose height is its content's height - a
                    // strip. dashboard.css centres those in whatever height the
                    // row quantisation actually gave them, so the leftover
                    // reads as air rather than as a rendering fault.
                    panel.resize === 'horizontal' ? 'dash-panel--strip' : '',
                    swap?.has(panel.id) ? 'is-entering' : '',
                    leaving === panel.id ? 'is-leaving' : '',
                    move?.id === panel.id ? 'is-moving' : '',
                    move && move.target === panel.id ? (move.result?.ok ? 'is-target' : 'is-refused') : '',
                    drop?.plan.target?.split && drop.plan.target.i === panel.id ? 'is-split' : '',
                    arrange && selected === panel.id ? 'is-picked' : '',
                  ].filter(Boolean).join(' ')}
                  role="group"
                  aria-label={name}
                  data-panel={panel.id}
                >
                  {/* Dock's head on each panel while arranging (dock.css): its name and size, a grip to move it by,
                      and its own remove. */}
                  {arrange && (() => {
                    const at = layoutById.get(panel.id);
                    const label = faceFor(panel.id)?.name ?? name;
                    return (
                      <div className="ed-ov dash-panel__handle">
                        <svg className="ed-ov__grip" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><g fill="currentColor"><circle cx="4" cy="3" r="1" /><circle cx="8" cy="3" r="1" /><circle cx="4" cy="6" r="1" /><circle cx="8" cy="6" r="1" /><circle cx="4" cy="9" r="1" /><circle cx="8" cy="9" r="1" /></g></svg>
                        <span className="ed-ov__name">{label}</span>
                        {at && <span className="ed-ov__size">{at.w} × {at.h}</span>}
                        <button type="button" className="ed-ov__x dash-nodrag" aria-label={`Remove ${label}`} title={`Remove ${label}`} onClick={() => removePanel(panel.id)}>
                          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
                        </button>
                      </div>
                    );
                  })()}
                  <PanelChrome scroll={panel.scroll} pad={panel.pad}>
                    {/* Per panel, so one bad API response cannot blank the
                        terminal - the same rule the standalone pages follow. */}
                    <Guarded name={name}>{panel.render(context, bp)}</Guarded>
                  </PanelChrome>
                </div>
              );
            })}
            {drop && (
              <div key={DROP_KEY} className="dash-drop" aria-hidden="true">
                <span className="dash-drop__screen"><Sketch id={drop.id} /></span>
                <span className="dash-drop__name">{drop.name}</span>
              </div>
            )}
          </GridLayout>
        )}
        {box.width > 0 && seamsOn && (
          <SeamLayer
            items={seamItems}
            grid={{ cols: metrics.cols, width: box.width, rowHeight, margin: metrics.margin, padding: metrics.containerPadding }}
            onMove={onSeamMove}
            onDrag={(on) => {
              // In edit mode a seam drag is an edit like any other: Undo puts it back.
              if (on && editing) snapshotUndo();
              setSeaming(on);
            }}
            labels={tiles ? panelName : undefined}
          />
        )}
        {/* The drag versions' marks (localhost only): where a move lands, why it cannot, the size and the lines it meets. */}
        {box.width > 0 && arrange && dragV !== 'original' && DevArrangeOverlay && (
          <Suspense fallback={null}>
            <DevArrangeOverlay
              mode={dragV}
              grid={{ cols: metrics.cols, width: box.width, rowHeight, margin: metrics.margin, padding: metrics.containerPadding }}
              items={layout}
              move={move}
              flow={flowBox}
              nameOf={panelName}
            />
          </Suspense>
        )}
      </div>

      <ResetDialog
        open={resetAsk}
        name={saved.slots?.find((s) => s.id === saved.activeSlot)?.name ?? null}
        onReset={reset}
        onClose={() => setResetAsk(false)}
      />
      {menuFx.value && (
        <LayoutMenu
          at={menuFx.value}
          closing={menuFx.closing}
          onExit={menuFx.onExit}
          locked={locked}
          onToggleLock={toggleLock}
          onReset={() => setResetAsk(true)}
          hasSaved={hasSaved}
          onEditLayout={enterEdit}
          panelSettings={panelSettings(menuFx.value.panel)}
          onFeedback={() => openFeedback({ element: menuFx.value?.element })}
          onClose={() => setMenuAt(null)}
        />
      )}

      {editing && saved.slots && saved.slots.length > 0 && (() => {
        const editProps: EditBaseProps = {
            rail: editRail,
            onRail: setEditRail,
            history: (saved.history ?? []).map((h) => ({
              id: h.id,
              title: h.slot.name ?? 'Layout',
              blurb: historyLabel(h.why, h.at),
              active: false,
              blocks: slotBlocks(eligible, config.layouts[bp], h.slot, bp, metrics.cols, rowHeight, metrics.margin),
            })),
            onRestore: (entryId) => change((prev) => restoreFromHistory(prev, entryId)),
            onSetOff: (id, off) => change((prev) => setSlotOff(prev, id, off)),
            thumbs: (saved.slots ?? []).map((slot) => ({
              id: slot.id,
              name: slotName(saved, slot),
              off: slot.off === true,
              active: slot.id === saved.activeSlot,
              blocks: slot.id === saved.activeSlot
                ? layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
                : slotBlocks(eligible, config.layouts[bp], slot, bp, metrics.cols, rowHeight, metrics.margin),
            })),
            cols: metrics.cols,
            widgets: eligible.map((p) => ({
              id: p.id,
              name: faceFor(p.id)?.name ?? (typeof p.title === 'function' ? p.title(context) : p.title),
              blurb: faceFor(p.id)?.blurb,
              present: !hiddenSet.has(p.id),
            })),
            quiet: previewing,
            sticky: sticky,
            overDelete: overDelete,
            ghost: ghost,
            trash: trash,
            onTrash: setTrash,
            undoTip: undoTip,
            onUndo: undo,
            onWidgetAdd: addBelow,
            onSwitch: (id) => {
              setSaved((prev) => {
                const next = activateSlot(prev, id);
                if (next === prev) return prev;
                saveDashboard(config, next);
                return next;
              });
            },
            onAddSlot: () => {
              setSaved((prev) => {
                const next = addEmptySlot(prev);
                saveDashboard(config, next);
                return next;
              });
            },
            onDeleteSlot: (id) => {
              setSaved((prev) => {
                const next = removeSlot(prev, id);
                saveDashboard(config, next);
                return next;
              });
            },
            presets: config.id === 'trade' || config.id.startsWith('trade-') ? TRADE_PRESETS.map((preset) => ({
              id: preset.id,
              title: preset.title,
              blurb: preset.blurb,
              active: preset.id === 'default'
                ? !(saved.layouts.lg?.length) && !activeBlank
                : !!preset.layouts.lg && JSON.stringify(saved.layouts.lg ?? []) === JSON.stringify(preset.layouts.lg),
              blocks: (preset.layouts.lg ?? config.layouts.lg).map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
            })) : [],
            onApplyPreset: (id) => {
              const preset = TRADE_PRESETS.find((p) => p.id === id);
              if (!preset) return;
              setSaved((before) => {
                // The layout it replaces stays restorable (edit mode's Layouts tab).
                const prev = remember(before, before.activeSlot, 'preset');
                const layouts = preset.layouts;
                const placed = new Set((layouts.lg ?? []).map((item) => item.i));
                const shown = panels.filter((p) => p.defaultHidden && placed.has(p.id)).map((p) => p.id);
                const slots = prev.slots?.map((s) => (
                  s.id === prev.activeSlot ? { ...s, blank: false, layouts, hidden: [], shown } : s
                ));
                const next = mirrorIntoActiveSlot({ ...prev, layouts, hidden: [], shown, slots });
                saveDashboard(config, next);
                return next;
              });
            },
            onDone: endEdit,
            onFill: () => {
              const grid = scrollRef.current?.querySelector('.dash-grid');
              if (!(grid instanceof HTMLElement)) return;
              const rect = grid.getBoundingClientRect();
              // The original's palette, and whatever a version's editor marks as over the page.
              const obstacles = [...document.querySelectorAll('.dash-edit-palette, [data-edit-obstacle]')].flatMap((el) => {
                if (!(el instanceof HTMLElement)) return [];
                const box = el.getBoundingClientRect();
                if (box.width < 2 || box.height < 2) return [];
                return [{ left: box.left, right: box.right }];
              });
              const span = clearColumnSpan(
                metrics.cols,
                { layoutWidth: grid.offsetWidth, visualLeft: rect.left, visualWidth: rect.width },
                obstacles,
                metrics.margin[0],
                metrics.containerPadding[0],
              );
              if (span.end <= span.start) return;
              const filled = fillGaps(layout.map((item) => {
                const handles = item.resizeHandles ?? ['se'];
                const resizable = item.isResizable !== false;
                return {
                  i: item.i,
                  x: item.x,
                  y: item.y,
                  w: item.w,
                  h: item.h,
                  minW: item.minW,
                  minH: item.minH,
                  maxW: item.maxW,
                  maxH: item.maxH,
                  growW: resizable && handles.some((handle) => handle.includes('e') || handle.includes('w')),
                  growH: resizable && handles.some((handle) => handle.includes('n') || handle.includes('s')),
                  fixed: item.static === true,
                };
              }), span);
              const placements = filled.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
              setSaved((prev) => {
                if (samePlacements(prev.layouts[bp], placements)) return prev;
                const updated = mirrorIntoActiveSlot({ ...prev, layouts: { ...prev.layouts, [bp]: placements } });
                saveDashboard(config, updated);
                return updated;
              });
            },
            onPreview: onPreview,
            onWidgetPointerDown: startDrag,
        };
        const slot = saved.slots.find((s) => s.id === saved.activeSlot);
        return (
            <EditDock
              {...editProps}
              bp={bp}
              phone={bp === 'sm' || bp === 'xs'}
              pagePanels={layout.map((item) => {
                const p = panels.find((x) => x.id === item.i);
                return {
                  id: item.i, x: item.x, y: item.y, w: item.w, h: item.h,
                  minW: item.minW, minH: item.minH, maxW: item.maxW, maxH: item.maxH,
                  name: faceFor(item.i)?.name ?? (p ? (typeof p.title === 'function' ? p.title(context) : p.title) : item.i),
                  blurb: faceFor(item.i)?.blurb,
                };
              })}
              rows={metrics.fitRows ?? layout.reduce((m, it) => Math.max(m, it.y + it.h), 0)}
              layoutName={slot ? slotName(saved, slot) : 'Layout'}
              selected={selected}
              onSelect={setSelected}
              onRemove={removePanel}
              onResize={resizePanel}
              onStage={onStage}
            />
        );
      })()}
    </div>
  );
}

/**
 * Re-exported so a consumer can react to the same breakpoint the grid is using
 * (e.g. to collapse a panel's own controls) without duplicating the maths.
 */
export { breakpointFor };
