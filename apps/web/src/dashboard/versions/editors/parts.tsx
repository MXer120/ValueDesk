/**
 * Parts the three editor versions share: a layout's thumbnail (the same sketches the original's cards draw), the
 * Preview button's press-and-hold, the widget search with its groups, a layout's menu and the delete that counts
 * down before it can be pressed. Built on the app's own pieces: Sketch (sketches.tsx), the tab menu (tabExtras.tsx),
 * the widget catalogue (widgetCatalog.ts) and the Bots kit's controls.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { PREVIEW_HOLD_MS, type ThumbBlock } from '../../editPlace';
import type { EditThumb, EditWidget, PreviewGesture } from '../../EditMode';
import { Sketch } from '../../sketches';
import { MENU_ICONS, TabMenu, menuAt } from '../../tabExtras';
import { WIDGET_FACES, WIDGET_GROUPS, faceFor, matchesWidget, type WidgetGroup } from '../../widgetCatalog';

/** A layout drawn small: each panel its sketch, in its place. */
export function Thumb({ blocks, cols, className, style }: { blocks: readonly ThumbBlock[]; cols: number; className?: string; style?: CSSProperties }) {
  const rows = Math.max(1, blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0));
  return (
    <span className={`ed-thumb${className ? ` ${className}` : ''}`} style={style} aria-hidden="true">
      {blocks.map((b) => (
        <span
          key={b.i}
          className="ed-thumb__b"
          style={{ left: `${(b.x / cols) * 100}%`, top: `${(b.y / rows) * 100}%`, width: `${(b.w / cols) * 100}%`, height: `${(b.h / rows) * 100}%` }}
        >
          <Sketch id={b.i} />
        </span>
      ))}
    </span>
  );
}

/**
 * The stage that fits the page's panels (`.dash`) into `room` (window px): its scale and the move of `.app`, which
 * is what the transform is on. Measured whatever transform is on now: the panels' offset inside `.app` is read off
 * the two boxes as drawn and divided back by the scale they are drawn at. `lift` < 2 leans the page up in its room.
 */
export function stageFor(room: { left: number; top: number; right: number; bottom: number }, lift = 2.4): { scale: number; x: number; y: number } | null {
  const app = document.querySelector<HTMLElement>('.shell > .app');
  const dash = app?.querySelector<HTMLElement>('.dash');
  if (!app || !dash || app.offsetWidth < 8) return null;
  const a = app.getBoundingClientRect();
  const d = dash.getBoundingClientRect();
  const now = a.width / app.offsetWidth || 1;
  const dx = (d.left - a.left) / now;
  const dy = (d.top - a.top) / now;
  const w = dash.offsetWidth;
  const h = dash.offsetHeight;
  const roomW = room.right - room.left;
  const roomH = room.bottom - room.top;
  const scale = Math.min(roomW / w, roomH / h, 1);
  // The untransformed box of `.app`: its layout position (a transform does not move offsetLeft / offsetTop).
  let left = 0;
  let top = 0;
  for (let el: HTMLElement | null = app; el; el = el.offsetParent as HTMLElement | null) { left += el.offsetLeft; top += el.offsetTop; }
  const x = room.left + (roomW - w * scale) / 2 - left - dx * scale;
  const y = room.top + Math.max(0, (roomH - h * scale) / lift) - top - dy * scale;
  return { scale: Math.round(scale * 1000) / 1000, x: Math.round(x), y: Math.round(y) };
}

/** One widget's sketch at a card's size. */
export function WidgetSketch({ id, className }: { id: string; className?: string }) {
  return <span className={`ed-wsketch${className ? ` ${className}` : ''}`} aria-hidden="true"><Sketch id={id} /></span>;
}

/**
 * Preview: a short press latches it (the page at full size until pressed again or `\`), a press held past
 * PREVIEW_HOLD_MS shows it only while held - the original editor's gesture (EditMode.tsx), as handlers to spread.
 */
export function usePreviewPress(onPreview: (g: PreviewGesture) => void) {
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const armed = useRef(false);
  const fromPointer = useRef(false);
  const clear = () => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; } };
  const finish = () => {
    if (!armed.current) return;
    armed.current = false;
    clear();
    if (held.current) { held.current = false; onPreview('hold-end'); } else onPreview('toggle');
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const blur = () => finishRef.current();
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('blur', blur); clear(); };
  }, []);
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      if (armed.current) finish();
      fromPointer.current = true;
      armed.current = true;
      held.current = false;
      e.currentTarget.setPointerCapture(e.pointerId);
      clear();
      timer.current = window.setTimeout(() => {
        if (!armed.current) return;
        held.current = true;
        onPreview('hold-start');
      }, PREVIEW_HOLD_MS);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => { if (e.button === 0) finish(); },
    onPointerCancel: () => finish(),
    onClick: () => {
      if (fromPointer.current) { fromPointer.current = false; return; }
      onPreview('toggle');
    },
  };
}

/** `/` focuses a search field while `on` (captured first: elsewhere on the page `/` opens the market search). */
export function useSlashFocus(ref: RefObject<HTMLInputElement>, on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => {
      const a = document.activeElement;
      const typing = a instanceof HTMLElement && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || typing) return;
      e.preventDefault();
      e.stopPropagation();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [ref, on]);
}

export type GroupPick = 'All' | WidgetGroup;
export const GROUP_PICKS: GroupPick[] = ['All', ...WIDGET_GROUPS];

/** The widgets that match the search (name, line or group), in the catalogue's groups and order. */
export function useWidgetGroups(widgets: readonly EditWidget[], q: string, group: GroupPick = 'All') {
  return useMemo(() => {
    const order = new Map(WIDGET_FACES.map((f, i) => [f.id, i]));
    const groupOf = (w: EditWidget): WidgetGroup => faceFor(w.id)?.group ?? w.group ?? 'Tools';
    const found = widgets.filter((w) => matchesWidget(q, w.name, w.blurb, groupOf(w)) && (group === 'All' || groupOf(w) === group));
    return WIDGET_GROUPS
      .map((g) => ({ group: g, items: found.filter((w) => groupOf(w) === g).sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999)) }))
      .filter((g) => g.items.length > 0);
  }, [widgets, q, group]);
}

/** A layout's right-click / ⋯ menu: open it, hide or show it in the sidebar, delete it (asked first). */
export function LayoutMenu({ at, thumb, thumbs, onOpen, onSetOff, onDelete, onClose }: {
  at: { x: number; y: number };
  thumb: EditThumb;
  thumbs: readonly EditThumb[];
  onOpen: () => void;
  onSetOff: (off: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const onRail = thumbs.filter((t) => !t.off).length;
  return (
    <TabMenu
      at={at}
      onClose={onClose}
      items={[
        { label: 'Open layout', icon: MENU_ICONS.open, onClick: onOpen },
        thumb.off
          ? { label: 'Show in sidebar', icon: MENU_ICONS.show, onClick: () => onSetOff(false) }
          : { label: 'Hide from sidebar', icon: MENU_ICONS.hide, disabled: onRail <= 1, onClick: () => onSetOff(true) },
        { label: 'Delete layout…', icon: MENU_ICONS.remove, danger: true, onClick: onDelete },
      ]}
    />
  );
}
export { menuAt };
export const menuAtButton = (e: ReactMouseEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4 };
};

/** Delete, only once three seconds have shown what is about to go (the original editor's rule). */
export function ConfirmDelete({ name, onCancel, onConfirm, className }: { name: string; onCancel: () => void; onConfirm: () => void; className?: string }) {
  const [left, setLeft] = useState(3);
  useEffect(() => {
    if (left <= 0) return;
    const t = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [left]);
  return (
    <div className={`ed-confirm${className ? ` ${className}` : ''}`} role="alertdialog" aria-label={`Delete ${name}`}>
      <p>Delete <b>{name}</b>? It stays in History to restore.</p>
      <div>
        <button type="button" className="tf-btn is-quiet is-sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="tf-btn is-danger is-sm" disabled={left > 0} onClick={onConfirm}>{left > 0 ? `Delete ${left}` : 'Delete'}</button>
      </div>
    </div>
  );
}

/** The kit's icons plus the editor's own: the eye (preview) and the fill corners. */
export const EyeIcon = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
    <path d="M1.2 8S3.7 3.5 8 3.5 14.8 8 14.8 8 12.3 12.5 8 12.5 1.2 8 1.2 8z" /><circle cx="8" cy="8" r="1.9" />
  </svg>
);
export const FillIcon = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" />
  </svg>
);
export const UndoIcon = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5.5 3.5 2.5 6.5l3 3" /><path d="M2.8 6.5H10a3.5 3.5 0 0 1 0 7H7" />
  </svg>
);
export const MoreIcon = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="currentColor"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
);
export const Caret = ({ size = 12 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/** A history entry's line (storage.ts historyLabel, "Edited, 3 min ago") as why and when. */
export function splitBlurb(blurb: string): [string, string] {
  const at = blurb.indexOf(', ');
  return at < 0 ? [blurb, ''] : [blurb.slice(0, at), blurb.slice(at + 2)];
}
