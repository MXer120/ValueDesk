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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useLatched } from '../components/motion';
import { GridLayout, verticalCompactor, type Layout } from 'react-grid-layout';
import { createScaledStrategy } from 'react-grid-layout/core';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './dashboard.css';

import { Guarded } from '../components/ErrorBoundary';
import { EditMode, type PreviewGesture } from './EditMode';
import { cellAt, clearColumnSpan, DRAG_COMMIT_PX, fillGaps, placementAt, slotBlocks, upsertPlacement } from './editPlace';
import { LayoutMenu } from './LayoutMenu';
import { PanelChrome } from './Panel';
import { breakpointFor, resolveLayout, samePlacements, toPlacements } from './resolve';
import {
  activateSlot, addEmptySlot, clearDashboard, ensureEditSlots, loadDashboard, mirrorIntoActiveSlot, removeSlot,
  saveDashboard, seedTerminals, type SavedDashboard,
} from './storage';
import { publishTerminals, registerTerminals, snapshotOf } from './terminals';
import { SeamLayer } from './SeamLayer';
import type { SeamBox } from './seams';
import { TRADE_PRESETS } from './presets';
import { faceFor } from './widgetCatalog';
import type { DashboardConfig, PanelDefinition } from './types';

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

export function Dashboard<C>({ config, panels, context, className, onNotificationSettings }: DashboardProps<C>) {
  const [scrollRef, box] = useBox();
  const [saved, setSaved] = useState<SavedDashboard>(() => {
    const base = loadDashboard(config) ?? { v: config.version, layouts: {}, locked: false };
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
  const hiddenSet = useMemo(() => {
    const set = new Set(saved.hidden ?? []);
    const shown = new Set(saved.shown ?? []);
    for (const p of panels) {
      if (activeBlank) {
        if (shown.has(p.id)) set.delete(p.id);
        else set.add(p.id);
      } else if (p.defaultHidden && !shown.has(p.id)) {
        set.add(p.id);
      }
    }
    return set;
  }, [saved.hidden, saved.shown, panels, activeBlank]);
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

  const layout = useMemo(
    () => resolveLayout(visible, config.layouts[bp], savedForBp, metrics.cols, {
      rowHeight,
      margin: metrics.margin,
    }),
    // visibleKey stands in for `visible`, which is a fresh array every render.
    // `rowHeight` IS a dependency: `minPx` floors are converted into rows with
    // it, so a layout resolved against the fallback row height would keep a
    // pixel minimum that no longer matches the grid once the real one is
    // measured - which is how the order book stayed below its own floor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleKey, config, bp, savedForBp, metrics.cols, rowHeight, metrics.margin],
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

  const reset = useCallback(() => {
    dirty.current = false;
    setSaved((prev) => {
      if (!prev.slots?.length) {
        clearDashboard(config);
        return { v: config.version, layouts: {}, locked: false };
      }
      const slots = prev.slots.map((s) =>
        s.id === prev.activeSlot ? { ...s, blank: false, layouts: {}, hidden: [], shown: [] } : s,
      );
      const next: SavedDashboard = {
        ...prev, locked: false, layouts: {}, hidden: [], shown: [], slots,
      };
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
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
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
      setMenuAt({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('contextmenu', onMenu);
    return () => window.removeEventListener('contextmenu', onMenu);
  }, [scrollRef]);

  /*
   * Edit mode scales `.app` (navbar excluded) and floats the slot / palette
   * chrome beside it. The grid keeps the unscaled measurement, so this is not
   * a breakpoint change. `\` walks normal -> edit -> latched preview -> edit.
   * Escape leaves. A hold on Preview is momentary; a short press latches.
   */
  const [editing, setEditing] = useState(false);
  const [sticky, setSticky] = useState(false);
  const [holding, setHolding] = useState(false);
  const [ghost, setGhost] = useState<{ name: string; x: number; y: number } | null>(null);
  const [overDelete, setOverDelete] = useState(false);
  const [overPage, setOverPage] = useState(false);
  const previewing = holding || sticky;
  const arrange = editing && !previewing;

  const enterEdit = useCallback(() => {
    setHolding(false);
    setSticky(false);
    setEditing(true);
    setSaved((prev) => {
      const next = ensureEditSlots(prev);
      if (next === prev) return prev;
      saveDashboard(config, next);
      return next;
    });
  }, [config]);

  const onPreview = useCallback((gesture: PreviewGesture) => {
    if (gesture === 'hold-start') setHolding(true);
    else if (gesture === 'hold-end') { setHolding(false); setSticky(false); }
    else setSticky((s) => !s);
  }, []);

  const endEdit = useCallback(() => {
    setEditing(false);
    setSticky(false);
    setHolding(false);
  }, []);

  /* The icon rail's terminals (terminals.ts): this dashboard says which canvases
     it has and which is on screen, and switches or adds one when asked. */
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
    });
  }, [config]);

  useLayoutEffect(() => {
    const shell = scrollRef.current?.closest('.shell');
    if (!(shell instanceof HTMLElement)) return;
    shell.classList.toggle('is-dash-edit', editing);
    shell.classList.toggle('is-dash-preview', editing && previewing);
    return () => {
      shell.classList.remove('is-dash-edit', 'is-dash-preview');
    };
  }, [editing, previewing, scrollRef]);

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
        endEdit();
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
  }, [editing, sticky, holding, menuAt, enterEdit, endEdit]);

  const dragRef = useRef<{ kind: 'add' | 'move'; id: string; name: string; sx: number; sy: number } | null>(null);
  const liveRef = useRef({
    saved, layout, bp, metrics, rowHeight, hiddenSet, panels, persist,
  });
  liveRef.current = { saved, layout, bp, metrics, rowHeight, hiddenSet, panels, persist };

  const startDrag = (kind: 'add' | 'move', id: string, name: string, x: number, y: number) => {
    if (kind === 'add' && !hiddenSet.has(id)) return;
    dragRef.current = { kind, id, name, sx: x, sy: y };
    setGhost({ name, x, y });
    setOverDelete(false);
    setOverPage(false);
  };

  useEffect(() => {
    const hideId = (id: string) => {
      const live = liveRef.current;
      const hidden = new Set(live.saved.hidden ?? []);
      const shown = new Set(live.saved.shown ?? []);
      hidden.add(id);
      shown.delete(id);
      live.persist({ ...live.saved, hidden: [...hidden], shown: [...shown] });
    };
    const dropAt = (id: string, clientX: number, clientY: number, reveal: boolean) => {
      const live = liveRef.current;
      const grid = scrollRef.current?.querySelector('.dash-grid');
      if (!(grid instanceof HTMLElement)) return;
      const panel = live.panels.find((p) => p.id === id);
      if (!panel) return;
      const shownNow = live.layout.find((item) => item.i === id);
      const designed = config.layouts[live.bp].find((p) => p.i === id);
      const w = shownNow?.w ?? designed?.w ?? Math.min(live.metrics.cols, Math.max(panel.minW ?? 8, 12));
      const h = shownNow?.h ?? designed?.h ?? Math.max(panel.minH ?? 6, 10);
      const placed = placementAt(
        id,
        cellAt(clientX, clientY, grid, live.metrics.cols, live.rowHeight, live.metrics.margin, live.metrics.containerPadding),
        w,
        h,
        live.metrics.cols,
      );
      const base = live.saved.layouts[live.bp] ?? toPlacements(live.layout);
      const hidden = new Set(live.saved.hidden ?? []);
      const shown = new Set(live.saved.shown ?? []);
      if (reveal) {
        hidden.delete(id);
        shown.add(id);
      }
      live.persist({
        ...live.saved,
        hidden: [...hidden],
        shown: [...shown],
        layouts: { ...live.saved.layouts, [live.bp]: upsertPlacement(base, placed) },
      });
    };
    const end = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setGhost(null);
      setOverDelete(false);
      setOverPage(false);
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const onDelete = !!hit?.closest('.dash-edit-delete');
      const onPage = !!hit?.closest('.dash-scroll');
      if (d.kind === 'move' && onDelete) {
        hideId(d.id);
        return;
      }
      if (!onPage) return;
      if (d.kind === 'add') {
        if (!liveRef.current.hiddenSet.has(d.id)) return;
        dropAt(d.id, e.clientX, e.clientY, true);
        return;
      }
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_COMMIT_PX) return;
      dropAt(d.id, e.clientX, e.clientY, false);
    };
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setGhost({ name: d.name, x: e.clientX, y: e.clientY });
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const nextDel = !!hit?.closest('.dash-edit-delete');
      const nextPage = !nextDel && !!hit?.closest('.dash-scroll');
      setOverDelete((v) => (v === nextDel ? v : nextDel));
      setOverPage((v) => (v === nextPage ? v : nextPage));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [config, scrollRef]);

  useEffect(() => {
    if (arrange) return;
    if (!dragRef.current) return;
    dragRef.current = null;
    setGhost(null);
    setOverDelete(false);
    setOverPage(false);
  }, [arrange]);

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
      enabled: !locked && !previewing,
      // Drags start ONLY on panel chrome: the hover-revealed strip along a
      // panel's top edge, and the empty space in a tab bar. Without this,
      // selecting a price in the order book or scrubbing the chart crosshair
      // would drag the panel.
      handle: '.dash-panel__handle',
      // ...but a tab bar is also full of controls, and `label` is in the list
      // because the bottom bar's market filter is a checkbox inside one.
      cancel: '.dash-nodrag, button, input, select, textarea, label, a',
    }),
    [locked, previewing],
  );

  const resizeConfig = useMemo(
    () => ({ enabled: !locked && !previewing, handles: ['se'] as const }),
    [locked, previewing],
  );

  const hasSaved = Object.keys(saved.layouts).length > 0 || activeBlank;

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
  const seamsOn = !locked && !editing && (bp === 'lg' || bp === 'md');
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
    <div className={`dash${locked ? ' is-locked' : ''}${arrange ? ' is-arrange' : ''}${overPage && ghost ? ' is-drop' : ''}${swap ? ' is-switching' : ''}${seaming ? ' is-seaming' : ''}${className ? ` ${className}` : ''}`}>
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
            layout={layout}
            gridConfig={gridConfig}
            dragConfig={dragConfig}
            resizeConfig={resizeConfig}
            onLayoutChange={onLayoutChange}
            onDragStop={markDirty}
            onResizeStop={markDirty}
            compactor={verticalCompactor}
            positionStrategy={arrange ? createScaledStrategy(0.64) : undefined}
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
                  ].filter(Boolean).join(' ')}
                  role="group"
                  aria-label={name}
                  data-panel={panel.id}
                >
                  <PanelChrome scroll={panel.scroll} pad={panel.pad}>
                    {/* Per panel, so one bad API response cannot blank the
                        terminal - the same rule the standalone pages follow. */}
                    <Guarded name={name}>{panel.render(context, bp)}</Guarded>
                  </PanelChrome>
                </div>
              );
            })}
          </GridLayout>
        )}
        {box.width > 0 && seamsOn && (
          <SeamLayer
            items={seamItems}
            grid={{ cols: metrics.cols, width: box.width, rowHeight, margin: metrics.margin, padding: metrics.containerPadding }}
            onMove={onSeamMove}
            onDrag={setSeaming}
          />
        )}
      </div>

      {menuFx.value && (
        <LayoutMenu
          at={menuFx.value}
          closing={menuFx.closing}
          onExit={menuFx.onExit}
          locked={locked}
          onToggleLock={toggleLock}
          panels={eligible.map((p) => ({
            id: p.id,
            name: typeof p.title === 'function' ? p.title(context) : p.title,
          }))}
          hidden={hiddenSet}
          onTogglePanel={toggleHidden}
          onReset={reset}
          hasSaved={hasSaved}
          onEditLayout={enterEdit}
          onNotificationSettings={onNotificationSettings}
          onClose={() => setMenuAt(null)}
        />
      )}

      {editing && saved.slots && saved.slots.length > 0 && (
        <EditMode
          thumbs={(saved.slots ?? []).map((slot) => ({
            id: slot.id,
            active: slot.id === saved.activeSlot,
            blocks: slot.id === saved.activeSlot
              ? layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
              : slotBlocks(eligible, config.layouts[bp], slot, bp, metrics.cols, rowHeight, metrics.margin),
          }))}
          cols={metrics.cols}
          widgets={eligible.map((p) => ({
            id: p.id,
            name: faceFor(p.id)?.name ?? (typeof p.title === 'function' ? p.title(context) : p.title),
            present: !hiddenSet.has(p.id),
          }))}
          quiet={previewing}
          sticky={sticky}
          overDelete={overDelete}
          ghost={ghost}
          onSwitch={(id) => {
            setSaved((prev) => {
              const next = activateSlot(prev, id);
              if (next === prev) return prev;
              saveDashboard(config, next);
              return next;
            });
          }}
          onAddSlot={() => {
            setSaved((prev) => {
              const next = addEmptySlot(prev);
              saveDashboard(config, next);
              return next;
            });
          }}
          onDeleteSlot={(id) => {
            setSaved((prev) => {
              const next = removeSlot(prev, id);
              saveDashboard(config, next);
              return next;
            });
          }}
          presets={config.id === 'trade' ? TRADE_PRESETS.map((preset) => ({
            id: preset.id,
            title: preset.title,
            blurb: preset.blurb,
            active: preset.id === 'default'
              ? !(saved.layouts.lg?.length) && !activeBlank
              : !!preset.layouts.lg && JSON.stringify(saved.layouts.lg ?? []) === JSON.stringify(preset.layouts.lg),
            blocks: (preset.layouts.lg ?? config.layouts.lg).map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
          })) : []}
          onApplyPreset={(id) => {
            const preset = TRADE_PRESETS.find((p) => p.id === id);
            if (!preset) return;
            setSaved((prev) => {
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
          }}
          onDone={endEdit}
          onFill={() => {
            const grid = scrollRef.current?.querySelector('.dash-grid');
            if (!(grid instanceof HTMLElement)) return;
            const rect = grid.getBoundingClientRect();
            const obstacles = ['.dash-edit-palette'].flatMap((sel) => {
              const el = document.querySelector(sel);
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
          }}
          onPreview={onPreview}
          onWidgetPointerDown={startDrag.bind(null, 'add')}
        />
      )}
    </div>
  );
}

/**
 * Re-exported so a consumer can react to the same breakpoint the grid is using
 * (e.g. to collapse a panel's own controls) without duplicating the maths.
 */
export { breakpointFor };
