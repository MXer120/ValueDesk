/**
 * STUDIO - a designer's workspace for the layout (localhost version of the editor, versions/store.ts).
 *
 * Your layouts are tabs across the top, the way documents are: click one to edit it, its menu hides or deletes it,
 * + starts an empty one; Presets and History open from the same bar beside Undo, Fill, Preview and Done. The page
 * sits scaled in the middle. On the left, the library: what is on this page (pick one, or take it off) and every
 * widget by group, each a row with its sketch - drag one onto the page or click it in. On the right, the inspector:
 * the picked panel's size in columns and rows with steppers, where it sits, its smallest size and its remove; with
 * nothing picked, the layout itself and the keys that drive the editor.
 *
 * A phone (fixed arrangement) keeps the tabs and moves the library into a sheet.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, IconButton, StatusPill, Switch } from '../../../components/bots/kit/kit';
import type { EditorProps, PagePanel } from './types';
import {
  Caret, ConfirmDelete, EyeIcon, FillIcon, LayoutMenu, MoreIcon, Thumb, UndoIcon, WidgetSketch, menuAt, menuAtButton, splitBlurb,
  stageFor, usePreviewPress, useSlashFocus, useWidgetGroups,
} from './parts';

const SIDE_W = 268;
const BAR_H = 52;
const GAP = 20;

/** The page scaled into the room between the library and the inspector, under the bar. */
function useStudioStage(onStage: EditorProps['onStage'], phone: boolean) {
  useLayoutEffect(() => {
    if (phone) { onStage({ scale: 1, x: 0, y: 0 }); return; }
    const place = () => {
      const nav = document.querySelector<HTMLElement>('.navbar')?.getBoundingClientRect().bottom ?? 56;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const s = stageFor({ left: SIDE_W + GAP, right: vw - SIDE_W - GAP, top: nav + BAR_H + GAP, bottom: vh - GAP });
      if (s) onStage(s);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [onStage, phone]);
}

/** A panel's size on screen in px (the grid's own, unscaled), for the inspector. */
function usePanelPx(id: string | null, key: string): { w: number; h: number } | null {
  const [px, setPx] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    if (!id) { setPx(null); return; }
    const el = document.querySelector<HTMLElement>(`.dash-grid [data-panel="${CSS.escape(id)}"]`);
    setPx(el ? { w: el.offsetWidth, h: el.offsetHeight } : null);
  }, [id, key]);
  return px;
}

function Stepper({ label, unit, value, min, max, onChange }: { label: string; unit: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="ed-st-step" role="group" aria-label={label}>
      <span className="ed-st-step__k">{label}</span>
      <div className="ed-st-step__ctl">
        <button type="button" aria-label={`${label}: one less`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
        <b>{value}<small>{unit}</small></b>
        <button type="button" aria-label={`${label}: one more`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
      </div>
    </div>
  );
}

function tierName(bp: EditorProps['bp']): string {
  return bp === 'lg' ? 'Wide screen' : bp === 'md' ? 'Two columns' : bp === 'sm' ? 'Tablet' : 'Phone';
}

export function EditStudio(p: EditorProps) {
  const { phone } = p;
  useStudioStage(p.onStage, phone);
  const [q, setQ] = useState('');
  const find = useRef<HTMLInputElement>(null);
  useSlashFocus(find, !phone);
  const groups = useWidgetGroups(p.widgets.filter((w) => !w.present), q);
  const firstFree = groups.flatMap((g) => g.items)[0];
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [pop, setPop] = useState<null | 'presets' | 'history'>(null);
  const [sheet, setSheet] = useState(false);
  // The icon rail's "All previous layouts": History, open.
  useEffect(() => { if (p.rail === 'layouts') setPop('history'); }, [p.rail]);
  const closePop = () => { setPop(null); if (p.rail === 'layouts') p.onRail('widgets'); };
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; id: string } | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; x: number } | null>(null);
  const preview = usePreviewPress(p.onPreview);
  const picked = p.pagePanels.find((x) => x.id === p.selected) ?? null;
  const px = usePanelPx(picked?.id ?? null, picked ? `${picked.w}x${picked.h}` : '');
  useEffect(() => {
    if (!pop) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closePop();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  const tabs = (
    <div className="ed-st-tabs" role="tablist" aria-label="Layouts">
      {p.thumbs.map((t) => (
        <div key={t.id} className={`ed-st-tab${t.active ? ' is-on' : ''}${t.off ? ' is-off' : ''}`}>
          <button
            type="button"
            role="tab"
            aria-selected={t.active}
            onClick={() => p.onSwitch(t.id)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ at: menuAt(e), id: t.id }); }}
          >
            {t.off && <span className="ed-st-tab__off" title="Hidden from the sidebar"><Icon name="layers" size={12} /></span>}
            {t.name}
          </button>
          <button type="button" className="ed-st-tab__more" aria-label={`${t.name}: options`} onClick={(e) => { setMenu({ at: menuAtButton(e), id: t.id }); }}><MoreIcon size={14} /></button>
        </div>
      ))}
      <button type="button" className="ed-st-tabadd" aria-label="New layout" title="New layout" onClick={p.onAddSlot}><Icon name="plus" size={15} /></button>
    </div>
  );

  const libRow = (w: (typeof groups)[number]['items'][number]) => (
    <div
      key={w.id}
      role="listitem"
      tabIndex={0}
      className="ed-st-row"
      aria-label={`${w.name}: drag onto the page, or press Enter to add it`}
      title={w.blurb}
      onPointerDown={phone ? undefined : (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        p.onWidgetPointerDown(w.id, w.name, e.clientX, e.clientY);
      }}
      onClick={phone ? () => p.onWidgetAdd(w.id) : undefined}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onWidgetAdd(w.id); } }}
    >
      <WidgetSketch id={w.id} />
      <span className="ed-st-row__t"><b>{w.name}</b><small>{w.blurb}</small></span>
      <span className="ed-st-row__add" aria-hidden="true"><Icon name="plus" size={13} /></span>
    </div>
  );

  const onPageRow = (pp: PagePanel) => (
    <li key={pp.id} className={`ed-st-on${p.selected === pp.id ? ' is-on' : ''}`}>
      <button type="button" className="ed-st-on__pick" aria-pressed={p.selected === pp.id} onClick={() => p.onSelect(p.selected === pp.id ? null : pp.id)}>
        <span className="ed-st-on__dot" aria-hidden="true" />
        <span className="ed-st-on__n">{pp.name}</span>
        <span className="ed-st-on__s">{pp.w} × {pp.h}</span>
      </button>
      <button type="button" className="ed-st-on__x" aria-label={`Remove ${pp.name}`} title="Take it off the page" onClick={() => p.onRemove(pp.id)}><Icon name="x" size={12} /></button>
    </li>
  );

  const library = (
    <aside className={`ed-st-lib${phone ? ' ed-st-sheet' : ''}${phone && sheet ? ' is-open' : ''}`} aria-label="Library" onContextMenu={(e) => e.preventDefault()}>
      <div className="ed-st-lib__head">
        <b>Library</b>
        {phone && <IconButton icon="x" label="Close" onClick={() => setSheet(false)} />}
      </div>
      <label className="ed-find">
        <Icon name="search" size={14} />
        <input
          ref={find}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search widgets"
          aria-label="Search widgets by name or what they show"
          aria-keyshortcuts="/"
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && firstFree) { e.preventDefault(); p.onWidgetAdd(firstFree.id); }
            else if (e.key === 'Escape') { e.stopPropagation(); if (q) setQ(''); else e.currentTarget.blur(); }
          }}
        />
        {!phone && <kbd aria-hidden="true">/</kbd>}
      </label>
      <div className="ed-st-lib__scroll">
        {!q && (
          <section className="ed-st-sec">
            <p className="ed-eyebrow">On this page <span className="ed-count">{p.pagePanels.length}</span></p>
            <ul className="ed-st-onlist">{p.pagePanels.map(onPageRow)}</ul>
          </section>
        )}
        {groups.map(({ group, items }) => {
          const shut = closed.has(group) && !q;
          return (
            <section key={group} className="ed-st-sec">
              <button
                type="button"
                className="ed-st-grp"
                aria-expanded={!shut}
                onClick={() => setClosed((s) => { const n = new Set(s); if (n.has(group)) n.delete(group); else n.add(group); return n; })}
              >
                <Caret />
                <span>{group}</span>
                <span className="ed-count">{items.length}</span>
              </button>
              {!shut && <div role="list" className="ed-st-rows">{items.map(libRow)}</div>}
            </section>
          );
        })}
        {groups.length === 0 && (
          <p className="ed-none">{q ? <>No widget to add matches “{q.trim()}”. <button type="button" className="ed-linkbtn" onClick={() => setQ('')}>Clear</button></> : 'Every widget is on the page.'}</p>
        )}
      </div>
      {!phone && <p className="ed-st-lib__foot">Drag a row onto the page, or click to add it in the first free spot.</p>}
    </aside>
  );

  const inspector = !phone && (
    <aside className="ed-st-insp" aria-label="Inspector" onContextMenu={(e) => e.preventDefault()}>
      {picked ? (
        <>
          <div className="ed-st-insp__head">
            <WidgetSketch id={picked.id} />
            <div className="ed-st-insp__t">
              <b>{picked.name}</b>
              {picked.blurb && <small>{picked.blurb}</small>}
            </div>
            <IconButton icon="x" label="Unpick" onClick={() => p.onSelect(null)} />
          </div>
          <section className="ed-st-card">
            <p className="ed-eyebrow">Size</p>
            <Stepper label="Width" unit="col" value={picked.w} min={picked.minW ?? 1} max={Math.min(picked.maxW ?? p.cols, p.cols - picked.x)} onChange={(v) => p.onResize(picked.id, v, picked.h)} />
            <Stepper label="Height" unit="row" value={picked.h} min={picked.minH ?? 1} max={picked.maxH ?? 999} onChange={(v) => p.onResize(picked.id, picked.w, v)} />
            {px && <p className="ed-st-px">{px.w} × {px.h} px at this window</p>}
          </section>
          <section className="ed-st-card">
            <p className="ed-eyebrow">Place</p>
            <dl className="ed-st-kv">
              <div><dt>Column</dt><dd>{picked.x + 1}–{picked.x + picked.w} of {p.cols}</dd></div>
              <div><dt>Row</dt><dd>{picked.y + 1}–{picked.y + picked.h}</dd></div>
              <div><dt>Smallest</dt><dd>{picked.minW ?? 1} × {picked.minH ?? 1}</dd></div>
            </dl>
            <p className="ed-st-hint">Drag its head on the page to move it; its corner resizes it too.</p>
          </section>
          <Button variant="danger" size="md" icon="trash" className="ed-st-remove" onClick={() => p.onRemove(picked.id)}>Take it off the page<kbd>Del</kbd></Button>
        </>
      ) : (
        <>
          <section className="ed-st-card">
            <p className="ed-eyebrow">Layout</p>
            <b className="ed-st-big">{p.layoutName}</b>
            <dl className="ed-st-kv">
              <div><dt>Widgets</dt><dd>{p.pagePanels.length}</dd></div>
              <div><dt>Grid</dt><dd>{p.cols} columns · {p.rows} rows</dd></div>
              <div><dt>Editing for</dt><dd>{tierName(p.bp)}</dd></div>
            </dl>
          </section>
          <section className="ed-st-card">
            <p className="ed-eyebrow">Pick a panel</p>
            <p className="ed-st-hint">Click a panel on the page or in the library to size it here.</p>
          </section>
          <section className="ed-st-card">
            <Switch checked={p.trash} onChange={p.onTrash} label="Remove by clicking" description="Each click on the page takes a widget off" />
          </section>
          <section className="ed-st-card">
            <p className="ed-eyebrow">Keys</p>
            <ul className="ed-st-keys">
              <li><kbd>\</kbd><span>Preview at full size</span></li>
              <li><kbd>/</kbd><span>Search the library</span></li>
              <li><kbd>Del</kbd><span>Remove the picked panel</span></li>
              <li><kbd>Ctrl Z</kbd><span>Undo</span></li>
              <li><kbd>Esc</kbd><span>Done</span></li>
            </ul>
          </section>
        </>
      )}
    </aside>
  );

  return createPortal(
    <div className={`dash-edit-root ed-root ed-studio-root tf${phone ? ' is-phone' : ''}${p.quiet ? ' is-quiet' : ''}`}>
      <header className="ed-st-bar" role="toolbar" aria-label="Layout edit" onContextMenu={(e) => e.preventDefault()}>
        {tabs}
        <div className="ed-st-bar__tools">
          {!phone && (
            <>
              <button type="button" className={`ed-st-tool${pop === 'presets' ? ' is-on' : ''}`} aria-expanded={pop === 'presets'} onClick={() => setPop(pop === 'presets' ? null : 'presets')}><Icon name="grid" size={15} /><span>Presets</span><Caret /></button>
              <button type="button" className={`ed-st-tool${pop === 'history' ? ' is-on' : ''}`} aria-expanded={pop === 'history'} onClick={() => setPop(pop === 'history' ? null : 'history')}><Icon name="clock" size={15} /><span>History</span>{p.history.length > 0 && <span className="ed-count">{p.history.length}</span>}<Caret /></button>
              <i className="ed-rule" aria-hidden="true" />
            </>
          )}
          <button type="button" className="ed-st-tool is-icon" title="Undo (Ctrl Z)" aria-label="Undo" onClick={p.onUndo}><UndoIcon /></button>
          {!phone && <button type="button" className="ed-st-tool is-icon" title="Fill the empty space" aria-label="Fill" onClick={p.onFill}><FillIcon /></button>}
          {!phone && <button type="button" className={`ed-st-tool${p.sticky ? ' is-on' : ''}`} aria-pressed={p.sticky} title="Preview (\): press, or hold" {...preview}><EyeIcon /><span>Preview</span><kbd>\</kbd></button>}
          <Button size="sm" variant="go" icon="check" onClick={p.onDone}>Done{!phone && <kbd>Esc</kbd>}</Button>
        </div>
      </header>

      {pop && (
        <>
          <div className="ed-st-scrim" onClick={closePop} aria-hidden="true" />
          <section className="ed-st-pop" aria-label={pop === 'presets' ? 'Presets' : 'History'}>
            <header><b>{pop === 'presets' ? 'Presets' : 'History'}</b><small>{pop === 'presets' ? `Replaces ${p.layoutName}; it goes to History.` : 'Earlier layouts, newest first. A restore opens as its own layout.'}</small></header>
            {pop === 'presets' ? (
              <div className="ed-st-pgrid">
                {p.presets.map((ps) => (
                  <button key={ps.id} type="button" className={`ed-st-preset${ps.active ? ' is-on' : ''}`} aria-pressed={ps.active} onClick={() => p.onApplyPreset(ps.id)}>
                    <Thumb blocks={ps.blocks} cols={p.cols} />
                    <span><b>{ps.title}</b>{ps.active && <StatusPill size="sm" tone="positive" icon="check">In use</StatusPill>}</span>
                    <small>{ps.blurb}</small>
                  </button>
                ))}
              </div>
            ) : p.history.length > 0 ? (
              <ul className="ed-hist">
                {p.history.map((h) => {
                  const [why, when] = splitBlurb(h.blurb);
                  return (
                    <li key={h.id}>
                      <Thumb blocks={h.blocks} cols={p.cols} className="ed-hist__thumb" />
                      <span className="ed-hist__t"><b>{h.title}</b><small>{why}{when && <> · {when}</>}</small></span>
                      <Button size="sm" variant="secondary" onClick={() => p.onRestore(h.id)}>Restore</Button>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="ed-none">Layouts you delete, reset, replace or edit are kept here, to restore.</p>}
          </section>
        </>
      )}

      {library}
      {inspector}
      {phone && (
        <div className="ed-st-foot">
          <Button size="md" variant="primary" icon="layers" onClick={() => setSheet(true)}>Library</Button>
          <span className="ed-st-foot__n">{p.pagePanels.length} widgets on {p.layoutName}</span>
        </div>
      )}

      {menu && (() => {
        const t = p.thumbs.find((x) => x.id === menu.id);
        if (!t) return null;
        return (
          <LayoutMenu
            at={menu.at}
            thumb={t}
            thumbs={p.thumbs}
            onOpen={() => p.onSwitch(t.id)}
            onSetOff={(off) => p.onSetOff(t.id, off)}
            onDelete={() => setConfirm({ id: t.id, x: menu.at.x })}
            onClose={() => setMenu(null)}
          />
        );
      })()}
      {confirm && (() => {
        const t = p.thumbs.find((x) => x.id === confirm.id);
        if (!t) return null;
        return (
          <div className="ed-st-confirm" style={{ left: Math.min(confirm.x, window.innerWidth - 300) }}>
            <ConfirmDelete name={t.name} onCancel={() => setConfirm(null)} onConfirm={() => { p.onDeleteSlot(t.id); setConfirm(null); }} />
          </div>
        );
      })()}

      {p.trash && !phone && <div className="ed-st-banner" role="status"><Icon name="trash" size={14} />Click a widget on the page to take it off · <button type="button" className="ed-linkbtn" onClick={() => p.onTrash(false)}>Stop</button></div>}
      {p.overDelete && <div className="ed-st-banner is-remove" role="status"><Icon name="trash" size={14} />Release to take it off the page</div>}
      {p.ghost && <div className={`ed-ghost${p.overDelete ? ' is-remove' : ''}`} style={{ left: p.ghost.x, top: p.ghost.y }} role="presentation">{p.ghost.name}</div>}
      {p.undoTip && (
        <div key={p.undoTip.n} className="ed-toast ed-st-toast" role="status">
          <span>{p.undoTip.text}</span>
          <button type="button" className="tf-btn is-secondary is-sm" onClick={p.onUndo}>Undo</button>
        </div>
      )}
    </div>,
    document.body,
  );
}
