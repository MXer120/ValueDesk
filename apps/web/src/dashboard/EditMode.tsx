/**
 * Edit-mode chrome around the scaled dashboard. Saved layouts sit in a
 * horizontal strip along the bottom. Preview, Fill, and Done sit on the left.
 * The panel palette and the remove target stay on the right. The dashboard
 * underneath is the live grid, not a picture of it.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { PREVIEW_HOLD_MS, type ThumbBlock } from './editPlace';
import { Sketch } from './sketches';
import { MENU_ICONS, TabMenu, menuAt } from './tabExtras';
import { WIDGET_FACES, WIDGET_GROUPS, faceFor, type WidgetGroup } from './widgetCatalog';
import './editMode.css';

export interface EditThumb {
  id: string;
  /** What the rail calls it. */
  name: string;
  /** Taken off the icon rail. */
  off: boolean;
  active: boolean;
  blocks: ThumbBlock[];
}

export interface EditWidget {
  id: string;
  name: string;
  /** Already on the canvas. Dragging it must not create a second copy. */
  present: boolean;
  group?: WidgetGroup;
}

export type PreviewGesture = 'hold-start' | 'hold-end' | 'toggle';

const Plus = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
    <path d="M9 3.5v11M3.5 9h11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const Eye = () => (
  <svg className="dash-edit-bar__ico" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <path d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="7" cy="7" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

const FillMark = () => (
  <svg className="dash-edit-bar__ico" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <path d="M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Check = () => (
  <svg className="dash-edit-bar__ico" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <path d="M2.5 7.5 5.5 10.5 11.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Card({
  cols, blocks, active, title, blurb, onClick, onContextMenu,
}: {
  cols: number;
  blocks: ThumbBlock[];
  active: boolean;
  title: string;
  blurb: string;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
}) {
  const rows = Math.max(1, blocks.reduce((max, b) => Math.max(max, b.y + b.h), 0));
  return (
    <button
      type="button"
      className={`dash-edit-card${active ? ' is-active' : ''}`}
      aria-pressed={active}
      aria-label={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="dash-edit-card__screen" aria-hidden="true">
        {blocks.map((b) => (
          <span
            key={b.i}
            className="dash-edit-card__block"
            style={{
              left: `${(b.x / cols) * 100}%`,
              top: `${(b.y / rows) * 100}%`,
              width: `${(b.w / cols) * 100}%`,
              height: `${(b.h / rows) * 100}%`,
            }}
          >
            <Sketch id={b.i} />
          </span>
        ))}
      </span>
      <span className="dash-edit-card__title">{title}</span>
      <span className="dash-edit-card__blurb">{blurb}</span>
    </button>
  );
}

function DeleteConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const [left, setLeft] = useState(3);
  useEffect(() => {
    if (left <= 0) return;
    const t = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [left]);
  return (
    <div className="dash-edit-confirm" role="dialog" aria-label="Delete layout">
      <p>Delete this layout?</p>
      <div>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" disabled={left > 0} onClick={onConfirm}>{left > 0 ? `Delete ${left}` : 'Delete'}</button>
      </div>
    </div>
  );
}

export interface EditPreset {
  id: string;
  title: string;
  blurb: string;
  active: boolean;
  blocks: ThumbBlock[];
}

export function EditMode({
  thumbs, presets = [], history = [], rail: railIn, onRail, cols, widgets, quiet, sticky, overDelete, ghost,
  onSwitch, onAddSlot, onDeleteSlot, onSetOff, onRestore, onApplyPreset, onDone, onFill, onPreview, onWidgetPointerDown,
}: {
  thumbs: EditThumb[];
  presets?: EditPreset[];
  /** Earlier layouts, newest first: restored as a terminal of their own. */
  history?: EditPreset[];
  /** The right rail's tab, when the caller holds it (the icon rail opens Layouts). */
  rail?: 'widgets' | 'layouts';
  onRail?: (rail: 'widgets' | 'layouts') => void;
  /** Take a layout off the icon rail, or put it back. */
  onSetOff?: (id: string, off: boolean) => void;
  onRestore?: (entryId: string) => void;
  cols: number;
  widgets: EditWidget[];
  /** Side windows nearly hidden (hold-preview or latched preview). */
  quiet: boolean;
  sticky: boolean;
  overDelete: boolean;
  ghost: { name: string; x: number; y: number } | null;
  onSwitch: (id: string) => void;
  onAddSlot: () => void;
  onDeleteSlot?: (id: string) => void;
  onApplyPreset?: (id: string) => void;
  onDone: () => void;
  onFill: () => void;
  onPreview: (gesture: PreviewGesture) => void;
  onWidgetPointerDown: (id: string, name: string, x: number, y: number) => void;
}) {
  const holdTimer = useRef<number | null>(null);
  const held = useRef(false);
  const armed = useRef(false);
  const fromPointer = useRef(false);

  const clearTimer = () => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  const finishPointer = () => {
    if (!armed.current) return;
    armed.current = false;
    clearTimer();
    if (held.current) {
      held.current = false;
      onPreview('hold-end');
    } else {
      onPreview('toggle');
    }
  };

  const finishRef = useRef(finishPointer);
  finishRef.current = finishPointer;
  useEffect(() => {
    const onBlur = () => finishRef.current();
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    };
  }, []);

  const side = quiet ? ' is-quiet' : '';
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // A layout card's right-click menu: open it, or delete it (which still asks first).
  const [slotMenu, setSlotMenu] = useState<{ at: { x: number; y: number }; id: string } | null>(null);
  const [railOwn, setRailOwn] = useState<'widgets' | 'layouts'>('widgets');
  const rail = railIn ?? railOwn;
  const setRail = (r: 'widgets' | 'layouts') => { setRailOwn(r); onRail?.(r); };
  const menuThumb = slotMenu ? thumbs.find((t) => t.id === slotMenu.id) : undefined;
  const onRailCount = thumbs.filter((t) => !t.off).length;
  const faceOrder = new Map(WIDGET_FACES.map((face, index) => [face.id, index]));
  const widgetGroups = WIDGET_GROUPS
    .map((group) => ({
      group,
      items: widgets
        .filter((w) => (faceFor(w.id)?.group ?? w.group ?? 'Tools') === group)
        .sort((a, b) => (faceOrder.get(a.id) ?? 999) - (faceOrder.get(b.id) ?? 999)),
    }))
    .filter((g) => g.items.length > 0);

  return createPortal(
    <div className="dash-edit-root">
      <div className={`dash-edit-dock${side}`}>
      <aside className="dash-edit-slots" aria-label="Layouts" onContextMenu={(e) => e.preventDefault()}>
        <div className="dash-edit-slots__list">
          {thumbs.map((thumb) => (
            <div key={thumb.id} className={`dash-edit-slot${thumb.off ? ' is-off' : ''}`}>
              <Card
                cols={cols}
                blocks={thumb.blocks}
                active={thumb.active}
                title={thumb.name}
                blurb={thumb.off ? 'Hidden from the sidebar. Right-click for options.' : 'Right-click for options.'}
                onClick={() => onSwitch(thumb.id)}
                onContextMenu={(e) => setSlotMenu({ at: menuAt(e), id: thumb.id })}
              />
              {confirmId === thumb.id && onDeleteSlot && (
                <DeleteConfirm
                  onCancel={() => setConfirmId(null)}
                  onConfirm={() => { onDeleteSlot(thumb.id); setConfirmId(null); }}
                />
              )}
            </div>
          ))}
        </div>
        <button type="button" className="dash-edit-plus" aria-label="Add empty layout" onClick={onAddSlot}>
          <Plus />
          <span>New layout</span>
        </button>
        {slotMenu && (
          <TabMenu
            at={slotMenu.at}
            onClose={() => setSlotMenu(null)}
            items={[
              { label: 'Open layout', icon: MENU_ICONS.open, onClick: () => onSwitch(slotMenu.id) },
              ...(onSetOff && menuThumb ? [menuThumb.off
                ? { label: 'Show in sidebar', icon: MENU_ICONS.show, onClick: () => onSetOff(slotMenu.id, false) }
                : { label: 'Hide from sidebar', icon: MENU_ICONS.hide, disabled: onRailCount <= 1, onClick: () => onSetOff(slotMenu.id, true) }] : []),
              { label: 'Delete layout…', icon: MENU_ICONS.remove, danger: true, disabled: !onDeleteSlot, onClick: () => setConfirmId(slotMenu.id) },
            ]}
          />
        )}
      </aside>
      <div className="dash-edit-bar" role="toolbar" aria-label="Layout edit" onContextMenu={(e) => e.preventDefault()}>
        <button
          type="button"
          className="dash-edit-bar__btn"
          aria-pressed={sticky}
          aria-keyshortcuts="\\"
          title="Preview (\)"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            if (armed.current) finishPointer();
            fromPointer.current = true;
            armed.current = true;
            held.current = false;
            e.currentTarget.setPointerCapture(e.pointerId);
            clearTimer();
            holdTimer.current = window.setTimeout(() => {
              if (!armed.current) return;
              held.current = true;
              onPreview('hold-start');
            }, PREVIEW_HOLD_MS);
          }}
          onPointerUp={(e) => { if (e.button === 0) finishPointer(); }}
          onPointerCancel={finishPointer}
          onClick={() => {
            if (fromPointer.current) {
              fromPointer.current = false;
              return;
            }
            onPreview('toggle');
          }}
        >
          <Eye />
          <span>Preview</span>
          <kbd>\</kbd>
        </button>
        <button type="button" className="dash-edit-bar__btn" onClick={onFill}>
          <FillMark />
          <span>Fill</span>
        </button>
        <button type="button" className="dash-edit-bar__btn" aria-keyshortcuts="Escape" title="Done (Esc)" onClick={onDone}>
          <Check />
          <span>Done</span>
          <kbd>Esc</kbd>
        </button>
      </div>
      </div>

      <aside className={`dash-edit-side dash-edit-palette${side}`} aria-label="Widgets" onContextMenu={(e) => e.preventDefault()}>
        <div className="dash-edit-switch" role="group" aria-label="Widget rail">
          <button type="button" className={rail === 'widgets' ? 'is-on' : ''} aria-pressed={rail === 'widgets'} onClick={() => setRail('widgets')}>Widgets</button>
          <button type="button" className={rail === 'layouts' ? 'is-on' : ''} aria-pressed={rail === 'layouts'} onClick={() => setRail('layouts')}>Layouts</button>
        </div>
        {rail === 'layouts' ? (
          <div className="dash-edit-palette__list">
            {/* First: the rail's "All previous layouts" lands here, and a restore is what it came for. */}
            {onRestore && (
              <section className="dash-edit-palette__group">
                <p>Previous layouts</p>
                {history.length > 0 ? (
                  <div className="dash-edit-palette__grid">
                    {history.map((h) => (
                      <Card
                        key={h.id}
                        cols={cols}
                        blocks={h.blocks}
                        active={false}
                        title={`Restore ${h.title}`}
                        blurb={h.blurb}
                        onClick={() => onRestore(h.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="dash-edit-palette__empty">Layouts you delete, reset, replace or edit are kept here, to restore.</p>
                )}
              </section>
            )}
            <section className="dash-edit-palette__group">
              <p>Presets</p>
              <div className="dash-edit-palette__grid">
                {presets.map((preset) => (
                  <Card
                    key={preset.id}
                    cols={cols}
                    blocks={preset.blocks}
                    active={preset.active}
                    title={preset.title}
                    blurb={preset.blurb}
                    onClick={() => onApplyPreset?.(preset.id)}
                  />
                ))}
              </div>
              {presets.length === 0 && <p className="dash-edit-palette__empty">No presets for this page.</p>}
            </section>
          </div>
        ) : (
        <div className="dash-edit-palette__list">
          {widgetGroups.map(({ group, items }) => (
            <section key={group} className="dash-edit-palette__group">
              <p>{group}</p>
              <div className="dash-edit-palette__grid" role="list">
                {items.map((w) => (
                  <div
                    key={w.id}
                    role="listitem"
                    className={`dash-edit-wcard${w.present ? ' is-present' : ''}`}
                    aria-disabled={w.present || undefined}
                    onPointerDown={w.present ? undefined : (e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      onWidgetPointerDown(w.id, w.name, e.clientX, e.clientY);
                    }}
                  >
                    <span className="dash-edit-card__screen" aria-hidden="true">
                      <Sketch id={w.id} />
                    </span>
                    <span className="dash-edit-wcard__row">
                      <span className="dash-edit-widget__name">{w.name}</span>
                      {w.present && <span className="dash-edit-widget__mark">Added</span>}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
        )}
        {rail === 'widgets' && (
        <div className={`dash-edit-delete${overDelete ? ' is-over' : ''}`} aria-label="Remove widget">
          Drop a widget here to remove it
        </div>
        )}
      </aside>

      {ghost && (
        <div className="dash-edit-ghost" style={{ left: ghost.x, top: ghost.y }} role="presentation">
          {ghost.name}
        </div>
      )}
    </div>,
    document.body,
  );
}
