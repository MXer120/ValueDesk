/**
 * DOCK - the layout edited in place, at full size (localhost version of the editor, versions/store.ts).
 *
 * Nothing is scaled: what you arrange is the page as you will use it. Each panel carries a head while you edit -
 * a grip to move it, its name and size in columns x rows, its own x - and its corner resizes it. Everything else is
 * one dock at the foot of the window: the layout you are in, Add widget, Undo, Fill, Preview, Remove mode and Done.
 * Add widget opens a drawer of every widget with its sketch, search and group chips: drag one onto the page (the
 * drawer gets out of the way) or click to drop it in the first free place. The layout chip opens your layouts,
 * the presets and the history in one popover. Drag a panel onto the dock to take it off.
 *
 * A phone (sm / xs, where the arrangement is fixed) gets the same dock as a bar and the drawer and layouts as
 * sheets: which widgets are on the page and which layout is used, a tap each.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, IconButton, Segmented, StatusPill } from '../../../components/bots/kit/kit';
import type { EditorProps } from './types';
import {
  Caret, ConfirmDelete, EyeIcon, FillIcon, GROUP_PICKS, LayoutMenu, MoreIcon, Thumb, UndoIcon, WidgetSketch, menuAt, menuAtButton,
  splitBlurb, usePreviewPress, useSlashFocus, useWidgetGroups, type GroupPick,
} from './parts';

type Pop = null | 'widgets' | 'layouts';
type LayoutTab = 'mine' | 'presets' | 'history';

export function EditDock(p: EditorProps) {
  const { onStage, phone } = p;
  useEffect(() => { onStage({ scale: 1, x: 0, y: 0 }); }, [onStage]);

  const [pop, setPop] = useState<Pop>(null);
  const [tab, setTab] = useState<LayoutTab>('mine');
  // The icon rail's "All previous layouts": the layouts popover, on History.
  useEffect(() => {
    if (p.rail !== 'layouts') return;
    setPop('layouts');
    setTab('history');
  }, [p.rail]);
  const toggle = (which: Exclude<Pop, null>) => setPop((cur) => (cur === which ? null : which));
  const close = () => { setPop(null); if (p.rail === 'layouts') p.onRail('widgets'); };

  const [q, setQ] = useState('');
  const [group, setGroup] = useState<GroupPick>('All');
  const find = useRef<HTMLInputElement>(null);
  useSlashFocus(find, pop === 'widgets');
  const groups = useWidgetGroups(p.widgets, q, group);
  const firstFree = groups.flatMap((g) => g.items).find((w) => !w.present);
  const onPage = p.widgets.filter((w) => w.present).length;

  const [menu, setMenu] = useState<{ at: { x: number; y: number }; id: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const preview = usePreviewPress(p.onPreview);
  const active = p.thumbs.find((t) => t.active);
  const dragging = !!p.ghost && !p.overDelete;
  // Esc closes a popover before it leaves edit mode (Dashboard takes the next one).
  useEffect(() => {
    if (!pop) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (q && document.activeElement === find.current) setQ('');
      else close();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  const widgetCard = (w: (typeof groups)[number]['items'][number]) => (
    <div
      key={w.id}
      role="listitem"
      tabIndex={w.present ? -1 : 0}
      className={`ed-dk-card${w.present ? ' is-present' : ''}`}
      aria-label={w.present ? `${w.name}, on the page` : `${w.name}: drag onto the page, or press Enter to add it`}
      onPointerDown={w.present || phone ? undefined : (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        p.onWidgetPointerDown(w.id, w.name, e.clientX, e.clientY);
      }}
      onClick={phone && !w.present ? () => p.onWidgetAdd(w.id) : undefined}
      onKeyDown={w.present ? undefined : (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        p.onWidgetAdd(w.id);
      }}
    >
      <WidgetSketch id={w.id} />
      <span className="ed-dk-card__t">
        <b>{w.name}</b>
        {w.blurb && <small>{w.blurb}</small>}
      </span>
      {w.present ? (
        <span className="ed-dk-card__on">
          <StatusPill tone="positive" size="sm" dot>On page</StatusPill>
          <button type="button" className="ed-linkbtn" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); p.onRemove(w.id); }}>Remove</button>
        </span>
      ) : (
        <span className="ed-dk-card__add" aria-hidden="true"><Icon name="plus" size={14} /></span>
      )}
    </div>
  );

  const drawer = pop === 'widgets' && (
    <section className={`ed-dk-pop ed-dk-drawer${dragging ? ' is-ghosting' : ''}`} aria-label="Add a widget">
      <header className="ed-dk-pop__head">
        <div className="ed-dk-pop__title">
          <b>Add a widget</b>
          <span>{onPage} on the page · {p.widgets.length - onPage} to add</span>
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
            }}
          />
          {!phone && <kbd aria-hidden="true">/</kbd>}
        </label>
        <IconButton icon="x" label="Close" onClick={close} />
      </header>
      <Segmented label="Widget group" size="sm" className="ed-dk-groups" value={group} onChange={setGroup} options={GROUP_PICKS.map((g) => ({ value: g, label: g }))} />
      <div className="ed-dk-pop__scroll">
        {groups.map(({ group: g, items }) => (
          <section key={g} className="ed-dk-group">
            {group === 'All' && <p className="ed-eyebrow">{g}</p>}
            <div className="ed-dk-grid" role="list">{items.map(widgetCard)}</div>
          </section>
        ))}
        {groups.length === 0 && (
          <p className="ed-none">No widget matches “{q.trim()}”. <button type="button" className="ed-linkbtn" onClick={() => { setQ(''); setGroup('All'); find.current?.focus(); }}>Clear search</button></p>
        )}
      </div>
      {!phone && <p className="ed-dk-pop__foot">Drag a card onto the page to place it, or click it to drop it in the first free spot.</p>}
    </section>
  );

  const layouts = pop === 'layouts' && (
    <section className="ed-dk-pop ed-dk-layouts" aria-label="Layouts">
      <header className="ed-dk-pop__head">
        <Segmented
          label="Layouts"
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'mine', label: 'My layouts', count: p.thumbs.length },
            { value: 'presets', label: 'Presets' },
            { value: 'history', label: 'History', count: p.history.length },
          ]}
        />
        <IconButton icon="x" label="Close" onClick={close} />
      </header>
      <div className="ed-dk-pop__scroll">
        {tab === 'mine' && (
          <div className="ed-dk-lgrid">
            {p.thumbs.map((t) => (
              <div key={t.id} className={`ed-dk-lcard${t.active ? ' is-active' : ''}${t.off ? ' is-off' : ''}`}>
                <button type="button" className="ed-dk-lcard__open" aria-pressed={t.active} onClick={() => p.onSwitch(t.id)} onContextMenu={(e) => { e.preventDefault(); setMenu({ at: menuAt(e), id: t.id }); }}>
                  <Thumb blocks={t.blocks} cols={p.cols} />
                  <span className="ed-dk-lcard__t">
                    <b>{t.name}</b>
                    {t.active ? <StatusPill tone="positive" size="sm" dot>Editing</StatusPill> : t.off ? <StatusPill size="sm">Hidden</StatusPill> : <StatusPill size="sm">In sidebar</StatusPill>}
                  </span>
                </button>
                <button type="button" className="ed-dk-lcard__more" aria-label={`${t.name}: options`} onClick={(e) => setMenu({ at: menuAtButton(e), id: t.id })}><MoreIcon /></button>
                {confirm === t.id && <ConfirmDelete name={t.name} onCancel={() => setConfirm(null)} onConfirm={() => { p.onDeleteSlot(t.id); setConfirm(null); }} />}
              </div>
            ))}
            <button type="button" className="ed-dk-lnew" onClick={p.onAddSlot}>
              <Icon name="plus" size={18} />
              <span>New layout</span>
              <small>An empty page to build</small>
            </button>
          </div>
        )}
        {tab === 'presets' && (
          <div className="ed-dk-lgrid">
            {p.presets.map((ps) => (
              <button key={ps.id} type="button" className={`ed-dk-lcard ed-dk-lcard__open${ps.active ? ' is-active' : ''}`} aria-pressed={ps.active} onClick={() => p.onApplyPreset(ps.id)}>
                <Thumb blocks={ps.blocks} cols={p.cols} />
                <span className="ed-dk-lcard__t"><b>{ps.title}</b>{ps.active && <StatusPill tone="positive" size="sm" icon="check">In use</StatusPill>}</span>
                <small className="ed-dk-lcard__d">{ps.blurb}</small>
              </button>
            ))}
            {p.presets.length === 0 && <p className="ed-none">No presets for this page.</p>}
          </div>
        )}
        {tab === 'history' && (
          p.history.length > 0 ? (
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
          ) : (
            <p className="ed-none">Layouts you delete, reset, replace or edit are kept here, to restore.</p>
          )
        )}
      </div>
      {tab === 'presets' && <p className="ed-dk-pop__foot">A preset replaces <b>{active?.name ?? 'this layout'}</b>; what it replaces goes to History.</p>}
      {tab === 'history' && p.history.length > 0 && <p className="ed-dk-pop__foot">A restored layout opens as a layout of its own beside the others.</p>}
    </section>
  );

  return createPortal(
    <div className={`dash-edit-root ed-root ed-dock-root tf${phone ? ' is-phone' : ''}${p.quiet ? ' is-quiet' : ''}`}>
      {pop && <div className="ed-dk-scrim" onClick={close} aria-hidden="true" />}
      {drawer}
      {layouts}

      <div className={`ed-dk-bar${p.overDelete ? ' is-remove' : ''}${p.trash ? ' is-trash' : ''}`} role="toolbar" aria-label="Layout edit" onContextMenu={(e) => e.preventDefault()}>
        {p.overDelete ? (
          <span className="ed-dk-bar__remove"><Icon name="trash" size={16} />Release to take it off the page</span>
        ) : p.trash ? (
          <>
            <span className="ed-dk-bar__remove"><Icon name="trash" size={16} />Click a widget on the page to take it off</span>
            <Button size="sm" variant="secondary" onClick={() => p.onTrash(false)}>Done removing<kbd>Esc</kbd></Button>
          </>
        ) : (
          <>
            <button type="button" className={`ed-dk-chip${pop === 'layouts' ? ' is-open' : ''}`} aria-expanded={pop === 'layouts'} onClick={() => { setTab('mine'); toggle('layouts'); }}>
              <span className="ed-dk-chip__k">Layout</span>
              <b>{p.layoutName}</b>
              <Caret />
            </button>
            <Button size="sm" variant="primary" icon="plus" aria-expanded={pop === 'widgets'} onClick={() => toggle('widgets')}>Add<span className="ed-wide">&nbsp;widget</span></Button>
            <i className="ed-rule" aria-hidden="true" />
            <button type="button" className="ed-dk-tool" onClick={p.onUndo} title="Undo (Ctrl Z)" aria-keyshortcuts="Control+Z"><UndoIcon /><span>Undo</span></button>
            {!phone && <button type="button" className="ed-dk-tool" onClick={p.onFill} title="Grow panels into the empty space"><FillIcon /><span>Fill</span></button>}
            {!phone && (
              <button type="button" className={`ed-dk-tool${p.sticky ? ' is-on' : ''}`} aria-pressed={p.sticky} aria-keyshortcuts="\" title="Preview (\\): press, or hold" {...preview}>
                <EyeIcon /><span>Preview</span>
              </button>
            )}
            <button type="button" className="ed-dk-tool" onClick={() => p.onTrash(true)} title="Remove widgets by clicking them"><Icon name="trash" size={16} /><span>Remove</span></button>
            <i className="ed-rule" aria-hidden="true" />
            <Button size="sm" variant="go" icon="check" onClick={p.onDone} aria-keyshortcuts="Escape">Done{!phone && <kbd>Esc</kbd>}</Button>
          </>
        )}
      </div>

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
            onDelete={() => setConfirm(t.id)}
            onClose={() => setMenu(null)}
          />
        );
      })()}

      {p.ghost && <div className={`ed-ghost${p.overDelete ? ' is-remove' : ''}`} style={{ left: p.ghost.x, top: p.ghost.y }} role="presentation">{p.ghost.name}</div>}
      {p.undoTip && (
        <div key={p.undoTip.n} className="ed-toast ed-dk-toast" role="status">
          <span>{p.undoTip.text}</span>
          <button type="button" className="tf-btn is-secondary is-sm" onClick={p.onUndo}>Undo</button>
        </div>
      )}
    </div>,
    document.body,
  );
}
