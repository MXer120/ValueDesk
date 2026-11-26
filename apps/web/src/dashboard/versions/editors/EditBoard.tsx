/**
 * BOARD - every layout on one board first, then one edited (localhost version of the editor, versions/store.ts).
 *
 * Opening the editor shows your layouts as large drawings: which one is on screen, which are in the sidebar and
 * which hidden, how many widgets each holds. Edit opens one; Open only switches to it; the menu hides, shows or
 * deletes (asked first). Under them, the presets to start from and the history to restore from - so the question
 * "which layout, and from what" is answered before any panel moves.
 *
 * Edit puts the page on the left at most of its size with a slim bar over it (back to the board, the layout's
 * name, Undo, Fill, Preview, Remove, Done) and a tray of widgets on the right: what is on the page with its x, and
 * every other widget to drag in or click. Esc goes back to the board; on the board, Esc is Done.
 *
 * A phone shows the board as a list, and editing as the page with the tray in a sheet.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, IconButton, StatusPill } from '../../../components/bots/kit/kit';
import type { EditorProps } from './types';
import {
  Caret, ConfirmDelete, EyeIcon, FillIcon, LayoutMenu, MoreIcon, Thumb, UndoIcon, WidgetSketch, menuAt, menuAtButton, splitBlurb,
  stageFor, usePreviewPress, useSlashFocus, useWidgetGroups,
} from './parts';

const TRAY_W = 320;
const BAR_H = 56;

function tierName(bp: EditorProps['bp']): string {
  return bp === 'lg' ? 'wide screens' : bp === 'md' ? 'two-column screens' : bp === 'sm' ? 'tablets' : 'phones';
}

export function EditBoard(p: EditorProps) {
  const { phone, onStage } = p;
  const [mode, setMode] = useState<'board' | 'canvas'>('board');
  /** The icon rail's width (the shell's .side): the bar over the page starts after it. */
  const [railW, setRailW] = useState(0);
  const histRef = useRef<HTMLElement>(null);
  // The icon rail's "All previous layouts": the board, at its history.
  useEffect(() => {
    if (p.rail !== 'layouts') return;
    setMode('board');
    requestAnimationFrame(() => histRef.current?.scrollIntoView({ block: 'start' }));
    p.onRail('widgets');
  }, [p.rail]); // eslint-disable-line react-hooks/exhaustive-deps

  // The page: under the board as it is; while editing, on the left under the bar, beside the tray.
  useLayoutEffect(() => {
    if (phone || mode === 'board') { onStage({ scale: 1, x: 0, y: 0 }); return; }
    const place = () => {
      const nav = document.querySelector<HTMLElement>('.navbar')?.getBoundingClientRect().bottom ?? 56;
      // Clear of the icon rail on the left (the shell's .side), when there is one.
      const rail = document.querySelector<HTMLElement>('.shell > .side')?.getBoundingClientRect().right ?? 0;
      setRailW(Math.max(0, Math.round(rail)));
      const s = stageFor({ left: Math.max(20, rail + 20), right: window.innerWidth - TRAY_W - 20, top: nav + BAR_H + 16, bottom: window.innerHeight - 20 }, 6);
      if (s) onStage(s);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [onStage, phone, mode]);

  // While editing, Esc goes back to the board (Dashboard's Esc, which ends edit mode, then applies on the board).
  useEffect(() => {
    if (mode !== 'canvas') return;
    const key = (e: KeyboardEvent) => {
      const a = document.activeElement;
      const typing = a instanceof HTMLElement && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
      if (e.key !== 'Escape' || p.trash || typing || document.querySelector('.menu-popup')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setMode('board');
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [mode, p.trash]);

  const [menu, setMenu] = useState<{ at: { x: number; y: number }; id: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [tray, setTray] = useState(false);
  const find = useRef<HTMLInputElement>(null);
  useSlashFocus(find, mode === 'canvas' && !phone);
  const groups = useWidgetGroups(p.widgets.filter((w) => !w.present), q);
  const firstFree = groups.flatMap((g) => g.items)[0];
  const preview = usePreviewPress(p.onPreview);
  const active = p.thumbs.find((t) => t.active);
  const onRail = p.thumbs.filter((t) => !t.off).length;
  const edit = (id: string) => { p.onSwitch(id); setMode('canvas'); };

  const board = mode === 'board' && (
    <div className="ed-bd" role="dialog" aria-label="Layouts">
      <div className="ed-bd__in">
        <header className="ed-bd__head">
          <div>
            <h2>Layouts</h2>
            <p>{p.thumbs.length} {p.thumbs.length === 1 ? 'layout' : 'layouts'} · {onRail} in the sidebar · arranged for {tierName(p.bp)}</p>
          </div>
          <div className="ed-bd__acts">
            <Button size="md" variant="secondary" icon="plus" onClick={p.onAddSlot}>New layout</Button>
            <Button size="md" variant="go" icon="check" onClick={p.onDone}>Done{!phone && <kbd>Esc</kbd>}</Button>
          </div>
        </header>

        <div className="ed-bd__grid">
          {p.thumbs.map((t) => (
            <article key={t.id} className={`ed-bd-card${t.active ? ' is-active' : ''}${t.off ? ' is-off' : ''}`} onContextMenu={(e) => { e.preventDefault(); setMenu({ at: menuAt(e), id: t.id }); }}>
              <button type="button" className="ed-bd-card__shot" aria-label={`Edit ${t.name}`} onClick={() => edit(t.id)}>
                <Thumb blocks={t.blocks} cols={p.cols} />
                <span className="ed-bd-card__cta" aria-hidden="true"><Icon name="grid" size={14} />Edit layout</span>
              </button>
              <div className="ed-bd-card__meta">
                <div className="ed-bd-card__t">
                  <b>{t.name}</b>
                  <span className="ed-bd-card__pills">
                    {t.active && <StatusPill size="sm" tone="positive" dot>On screen</StatusPill>}
                    {t.off ? <StatusPill size="sm">Hidden</StatusPill> : <StatusPill size="sm">In sidebar</StatusPill>}
                    <span className="ed-bd-card__n">{t.blocks.length} {t.blocks.length === 1 ? 'widget' : 'widgets'}</span>
                  </span>
                </div>
                <div className="ed-bd-card__acts">
                  {!t.active && <Button size="sm" variant="quiet" onClick={() => p.onSwitch(t.id)}>Open</Button>}
                  <Button size="sm" variant="primary" onClick={() => edit(t.id)}>Edit</Button>
                  <button type="button" className="tf-btn is-quiet is-sm is-icon" aria-label={`${t.name}: options`} title="Options" onClick={(e) => setMenu({ at: menuAtButton(e), id: t.id })}><MoreIcon /></button>
                </div>
              </div>
              {confirm === t.id && <ConfirmDelete name={t.name} onCancel={() => setConfirm(null)} onConfirm={() => { p.onDeleteSlot(t.id); setConfirm(null); }} />}
            </article>
          ))}
          <button type="button" className="ed-bd-new" onClick={p.onAddSlot}>
            <span className="ed-bd-new__ic"><Icon name="plus" size={18} /></span>
            <b>New layout</b>
            <small>An empty page, built from the widgets you pick</small>
          </button>
        </div>

        {p.presets.length > 0 && (
          <section className="ed-bd__sec">
            <header><h3>Start from a preset</h3><p>Replaces <b>{active?.name ?? 'the layout on screen'}</b>; what it replaces goes to History.</p></header>
            <div className="ed-bd__presets">
              {p.presets.map((ps) => (
                <button key={ps.id} type="button" className={`ed-bd-preset${ps.active ? ' is-on' : ''}`} aria-pressed={ps.active} onClick={() => p.onApplyPreset(ps.id)}>
                  <Thumb blocks={ps.blocks} cols={p.cols} />
                  <span><b>{ps.title}</b>{ps.active && <StatusPill size="sm" tone="positive" icon="check">In use</StatusPill>}</span>
                  <small>{ps.blurb}</small>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="ed-bd__sec" ref={histRef}>
          <header><h3>History</h3><p>Layouts you delete, reset, replace or edit, newest first. A restore opens as a layout of its own.</p></header>
          {p.history.length > 0 ? (
            <ul className="ed-hist ed-bd__hist">
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
            <p className="ed-none">Nothing yet.</p>
          )}
        </section>
      </div>
    </div>
  );

  const trayRow = (w: (typeof groups)[number]['items'][number]) => (
    <div
      key={w.id}
      role="listitem"
      tabIndex={0}
      className="ed-bd-row"
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
      <span className="ed-bd-row__t"><b>{w.name}</b><small>{w.blurb}</small></span>
      <span className="ed-bd-row__add" aria-hidden="true"><Icon name="plus" size={13} /></span>
    </div>
  );

  const canvas = mode === 'canvas' && (
    <>
      <header className="ed-bd-bar" role="toolbar" aria-label="Layout edit" onContextMenu={(e) => e.preventDefault()}>
        <button type="button" className="ed-bd-back" onClick={() => setMode('board')}>
          <Icon name="arrowLeft" size={15} /><span>All layouts</span>
        </button>
        <i className="ed-rule" aria-hidden="true" />
        <div className="ed-bd-bar__name"><b>{p.layoutName}</b><small>{p.pagePanels.length} widgets</small></div>
        <div className="ed-bd-bar__tools">
          <button type="button" className="ed-bd-tool is-icon" title="Undo (Ctrl Z)" aria-label="Undo" onClick={p.onUndo}><UndoIcon /></button>
          {!phone && <button type="button" className="ed-bd-tool" title="Grow panels into the empty space" onClick={p.onFill}><FillIcon /><span>Fill</span></button>}
          {!phone && <button type="button" className={`ed-bd-tool${p.sticky ? ' is-on' : ''}`} aria-pressed={p.sticky} title="Preview (\): press, or hold" {...preview}><EyeIcon /><span>Preview</span></button>}
          <button type="button" className={`ed-bd-tool${p.trash ? ' is-danger' : ''}`} aria-pressed={p.trash} title="Remove widgets by clicking them" onClick={() => p.onTrash(!p.trash)}><Icon name="trash" size={15} />{!phone && <span>{p.trash ? 'Removing' : 'Remove'}</span>}</button>
          <Button size="sm" variant="go" icon="check" onClick={p.onDone}>Done</Button>
        </div>
      </header>
      <aside className={`ed-bd-tray${phone ? ' is-sheet' : ''}${phone && tray ? ' is-open' : ''}`} aria-label="Widgets" onContextMenu={(e) => e.preventDefault()}>
        <div className="ed-bd-tray__head">
          <b>Widgets</b>
          {phone && <IconButton icon="x" label="Close" onClick={() => setTray(false)} />}
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
        <div className="ed-bd-tray__scroll">
          {!q && (
            <section>
              <p className="ed-eyebrow">On {p.layoutName} <span className="ed-count">{p.pagePanels.length}</span></p>
              <ul className="ed-bd-on">
                {p.pagePanels.map((pp) => (
                  <li key={pp.id} className={p.selected === pp.id ? 'is-on' : undefined}>
                    <button type="button" className="ed-bd-on__pick" onClick={() => p.onSelect(p.selected === pp.id ? null : pp.id)}>
                      <WidgetSketch id={pp.id} />
                      <span>{pp.name}</span>
                    </button>
                    <button type="button" className="ed-bd-on__x" aria-label={`Remove ${pp.name}`} title="Take it off the page" onClick={() => p.onRemove(pp.id)}><Icon name="x" size={12} /></button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {groups.map(({ group, items }) => (
            <section key={group}>
              <p className="ed-eyebrow">{group}</p>
              <div role="list" className="ed-bd-rows">{items.map(trayRow)}</div>
            </section>
          ))}
          {groups.length === 0 && <p className="ed-none">{q ? <>No widget to add matches “{q.trim()}”.</> : 'Every widget is on the page.'}</p>}
        </div>
        {!phone && <p className="ed-bd-tray__foot">Drag a widget onto the page, or click it in. Drag a panel here to take it off.</p>}
      </aside>
      {phone && (
        <button type="button" className="ed-bd-traybtn" onClick={() => setTray(true)}>
          <Icon name="layers" size={16} />
          <span>Widgets</span>
          <span className="ed-count">{p.pagePanels.length}</span>
          <Caret />
        </button>
      )}
      {p.overDelete && <div className="ed-bd-banner" role="status"><Icon name="trash" size={14} />Release to take it off the page</div>}
      {p.trash && !p.overDelete && <div className="ed-bd-banner" role="status"><Icon name="trash" size={14} />Click a widget on the page to take it off · Esc to stop</div>}
    </>
  );

  return createPortal(
    <div className={`dash-edit-root ed-root ed-board-root tf is-${mode}${phone ? ' is-phone' : ''}${p.quiet ? ' is-quiet' : ''}`} style={{ ['--ed-rail' as string]: `${railW}px` }}>
      {board}
      {canvas}
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
        <div key={p.undoTip.n} className="ed-toast ed-bd-toast" role="status">
          <span>{p.undoTip.text}</span>
          <button type="button" className="tf-btn is-secondary is-sm" onClick={p.onUndo}>Undo</button>
        </div>
      )}
    </div>,
    document.body,
  );
}
