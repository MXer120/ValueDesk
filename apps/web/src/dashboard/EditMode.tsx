/**
 * Edit-mode chrome around the scaled dashboard. Saved layouts sit in a
 * horizontal strip along the bottom. Preview, Fill, and Done sit on the left.
 * The panel palette (with its search) and the remove target stay on the right:
 * drag a card onto the page, or a panel off it; the trash button turns on a
 * mode where a click on a panel removes it. The dashboard underneath is the
 * live grid, not a picture of it.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { PREVIEW_HOLD_MS, type ThumbBlock } from './editPlace';
import { Sketch } from './sketches';
import { MENU_ICONS, TabMenu, menuAt } from './tabExtras';
import { WIDGET_FACES, WIDGET_GROUPS, faceFor, matchesWidget, type WidgetGroup } from './widgetCatalog';
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
  /** What it shows, for the search. */
  blurb?: string;
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

const Trash = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 4.5h10M6.5 4.5V3.3c0-.5.3-.8.8-.8h1.4c.5 0 .8.3.8.8v1.2M4.5 4.5l.6 8c.1.6.5 1 1.1 1h3.6c.6 0 1-.4 1.1-1l.6-8M6.8 7v4M9.2 7v4" />
  </svg>
);

const Find = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
    <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
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
  trash = false, onTrash, undoTip = null, onUndo, onWidgetAdd,
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
  /** Trash mode: a click on a panel removes it. */
  trash?: boolean;
  onTrash?: (on: boolean) => void;
  /** The last add or removal, with an Undo (Ctrl+Z); `n` restarts the toast. */
  undoTip?: { text: string; n: number } | null;
  onUndo?: () => void;
  /** A card clicked or chosen with Enter: added under the layout. */
  onWidgetAdd?: (id: string) => void;
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
  const [q, setQ] = useState('');
  const findRef = useRef<HTMLInputElement>(null);
  const found = widgets.filter((w) => matchesWidget(q, w.name, w.blurb, faceFor(w.id)?.group ?? w.group));
  const widgetGroups = WIDGET_GROUPS
    .map((group) => ({
      group,
      items: found
        .filter((w) => (faceFor(w.id)?.group ?? w.group ?? 'Tools') === group)
        .sort((a, b) => (faceOrder.get(a.id) ?? 999) - (faceOrder.get(b.id) ?? 999)),
    }))
    .filter((g) => g.items.length > 0);
  const firstFree = widgetGroups.flatMap((g) => g.items).find((w) => !w.present);
  // `/` finds a widget. Captured first: elsewhere on the page `/` opens the symbol search (App.tsx).
  useEffect(() => {
    if (rail !== 'widgets') return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || typing) return;
      e.preventDefault();
      e.stopPropagation();
      findRef.current?.focus();
      findRef.current?.select();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rail]);

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
        <>
        <label className="tabside__find dash-edit-find">
          <Find />
          <input
            ref={findRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search widgets"
            aria-label="Search widgets by name or what they show"
            aria-keyshortcuts="/"
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (q) setQ('');
                else e.currentTarget.blur();
              } else if (e.key === 'Enter' && firstFree && onWidgetAdd) {
                e.preventDefault();
                onWidgetAdd(firstFree.id);
              }
            }}
          />
          <kbd aria-hidden="true">/</kbd>
        </label>
        <div className="dash-edit-palette__list">
          {widgetGroups.map(({ group, items }) => (
            <section key={group} className="dash-edit-palette__group">
              <p>{group}</p>
              <div className="dash-edit-palette__grid" role="list">
                {items.map((w) => (
                  <div
                    key={w.id}
                    role="listitem"
                    tabIndex={w.present ? -1 : 0}
                    className={`dash-edit-wcard${w.present ? ' is-present' : ''}`}
                    aria-disabled={w.present || undefined}
                    aria-label={w.present ? `${w.name}, on the page` : `${w.name}: drag onto the page, or press Enter to add it`}
                    title={w.blurb}
                    onPointerDown={w.present ? undefined : (e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      onWidgetPointerDown(w.id, w.name, e.clientX, e.clientY);
                    }}
                    onKeyDown={w.present || !onWidgetAdd ? undefined : (e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      onWidgetAdd(w.id);
                    }}
                  >
                    <span className="dash-edit-card__screen" aria-hidden="true">
                      <Sketch id={w.id} />
                    </span>
                    <span className="dash-edit-wcard__row">
                      <span className="dash-edit-widget__name">{w.name}</span>
                      {w.present && <span className="dash-edit-widget__mark">Added</span>}
                    </span>
                    {w.blurb && <span className="dash-edit-wcard__blurb">{w.blurb}</span>}
                  </div>
                ))}
              </div>
            </section>
          ))}
          {widgetGroups.length === 0 && (
            <p className="dash-edit-palette__empty dash-edit-palette__none">
              No widget matches “{q.trim()}”.{' '}
              <button type="button" className="dash-edit-linkbtn" onClick={() => { setQ(''); findRef.current?.focus(); }}>Clear search</button>
            </p>
          )}
        </div>
        </>
        )}
        {rail === 'widgets' && (
        <button
          type="button"
          className={`dash-edit-delete${overDelete ? ' is-over' : ''}${trash ? ' is-on' : ''}`}
          aria-pressed={trash}
          title={trash ? 'Stop removing (Esc)' : 'Remove widgets: click one on the page, or drag one here'}
          onClick={() => onTrash?.(!trash)}
        >
          <Trash />
          <span>
            {overDelete ? 'Release to remove' : trash ? 'Click a widget on the page to remove it' : 'Remove widgets'}
            <small>{trash ? 'Click here or press Esc when done' : 'Click, then pick widgets · or drag one here'}</small>
          </span>
        </button>
        )}
      </aside>

      {ghost && (
        <div className={`dash-edit-ghost${overDelete ? ' is-remove' : ''}`} style={{ left: ghost.x, top: ghost.y }} role="presentation">
          {ghost.name}
        </div>
      )}
      {undoTip && onUndo && (
        <div key={undoTip.n} className="dash-edit-toast" role="status">
          <span>{undoTip.text}</span>
          <button type="button" onClick={onUndo} aria-keyshortcuts="Control+Z">Undo</button>
          <kbd>Ctrl Z</kbd>
        </div>
      )}
    </div>,
    document.body,
  );
}
