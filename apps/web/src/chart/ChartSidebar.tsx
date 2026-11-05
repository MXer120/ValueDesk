/**
 * The chart's right sidebar, TradingView's object tree: what is on this
 * market's chart and how it stacks.
 *
 *   On the chart  the position line, order lines, the account's executions
 *                 and news (this coin's, the macro ones, or none) - each on or
 *                 off, saying why when it has nothing to show.
 *   Drawings      every drawing on this market, the front one first: a click
 *                 selects it (its style bar opens), Ctrl / ⌘ + click picks
 *                 several (as Ctrl / ⌘ + drag does on the chart), the eye hides it, the lock
 *                 pins it, the arrows bring it forward or send it back a layer,
 *                 a drag moves it anywhere in the stack; the bin deletes it.
 *   Indicators    each study with its eye, settings and remove.
 *   Download snapshot  the chart as it is, as a .json file (snapshot.ts).
 *
 * Toggled from the chart toolbar; it remembers whether it was open.
 */
import { useState, type DragEvent } from 'react';
import { MENU_ICONS } from '../dashboard/tabExtras';
import { CoinIcon } from '../components/CoinIcon';
import { CHART_ICONS, NEWS_ICONS } from './chartIcons';
import type { ChartShow, NewsScope } from './chartMarks';

export interface SidebarDrawing {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  locked: boolean;
}

export interface SidebarIndicator {
  id: string;
  label: string;
  visible: boolean;
}

export interface ChartSidebarProps {
  symbol: string;
  /** The coin as the news names it (BTC), or '' when there is none. */
  coin: string;
  /** Front first. */
  drawings: SidebarDrawing[];
  /** The drawing whose bar is open, or the group picked together. */
  selectedIds: readonly string[];
  indicators: SidebarIndicator[];
  show: ChartShow;
  /** Why a layer has nothing to show (no wallet, spot), by layer. */
  why: Partial<Record<keyof ChartShow, string>>;
  onShow: (patch: Partial<ChartShow>) => void;
  /** add: Ctrl / ⌘ + click - adds the drawing to the group, or drops it. */
  onSelect: (id: string, add: boolean) => void;
  onToggle: (id: string) => void;
  onLock: (id: string) => void;
  onDelete: (id: string) => void;
  /** Move a drawing to this place in the front-first list. */
  onMove: (id: string, to: number) => void;
  onIndicatorToggle: (id: string) => void;
  onIndicatorSettings: (id: string) => void;
  onIndicatorRemove: (id: string) => void;
  onSave: () => void;
  onClose: () => void;
}

function Switch({ label, on, onChange, note }: { label: string; on: boolean; onChange: (on: boolean) => void; note?: string }) {
  return (
    <label className={`kc-side-switch${on ? '' : ' is-off'}`}>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="kc-side-switch__text">
        {label}
        {note && <span className="kc-side-note">{note}</span>}
      </span>
    </label>
  );
}

export function ChartSidebar(p: ChartSidebarProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const scopes: Array<[NewsScope, string, JSX.Element]> = [
    ['coin', p.coin || 'Coin', p.coin ? <CoinIcon coin={p.coin} size={14} /> : NEWS_ICONS.news],
    ['macro', 'Macro', NEWS_ICONS.macro],
    ['all', 'All', CHART_ICONS.news],
  ];

  const overRow = (e: DragEvent, i: number) => {
    if (!dragId) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
  };
  const drop = () => {
    if (dragId && dropAt !== null) {
      const from = p.drawings.findIndex((d) => d.id === dragId);
      // Dropping below itself counts the row it leaves.
      const to = dropAt > from ? dropAt - 1 : dropAt;
      if (from >= 0 && to !== from) p.onMove(dragId, to);
    }
    setDragId(null);
    setDropAt(null);
  };

  return (
    <aside className="kc-side" aria-label="Chart objects" onKeyDown={(e) => e.stopPropagation()}>
      <header className="kc-side-head">
        <span className="kc-side-title">Objects</span>
        <span className="kc-side-sym">{p.symbol}</span>
        <button type="button" className="kc-side-x" aria-label="Close the object list" title="Close" onClick={p.onClose}>
          {MENU_ICONS.close}
        </button>
      </header>

      <div className="kc-side-body">
        <section className="kc-side-sec" aria-label="On the chart">
          <h3 className="kc-side-h">On the chart</h3>
          <Switch label="Position line" on={p.show.position} note={p.why.position} onChange={(position) => p.onShow({ position })} />
          <Switch label="Order lines" on={p.show.orders} note={p.why.orders} onChange={(orders) => p.onShow({ orders })} />
          <Switch label="Executions" on={p.show.executions} note={p.why.executions} onChange={(executions) => p.onShow({ executions })} />
          <Switch label="News" on={p.show.news} note={p.why.news} onChange={(news) => p.onShow({ news })} />
          <div className={`kc-side-news${p.show.news ? '' : ' is-off'}`}>
            <span className="kc-side-news__label">From</span>
            <span className="kc-side-seg" role="radiogroup" aria-label="Whose news">
              {scopes.map(([id, label, icon]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={p.show.newsScope === id}
                  className={p.show.newsScope === id ? 'on' : ''}
                  disabled={id === 'coin' && !p.coin}
                  title={id === 'coin' ? `${p.coin || 'This coin'} news only` : id === 'macro' ? 'Macro and economy' : 'All of crypto'}
                  onClick={() => p.onShow({ newsScope: id, news: true })}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </span>
          </div>
        </section>

        <section className="kc-side-sec" aria-label="Drawings">
          <h3 className="kc-side-h">
            Drawings <span className="kc-side-count">{p.drawings.length}</span>
          </h3>
          {p.drawings.length === 0 ? (
            <p className="kc-side-empty">Nothing drawn on {p.symbol} yet.</p>
          ) : (
            <ol className="kc-side-list" onDragLeave={(e) => e.currentTarget === e.target && setDropAt(null)}>
              {p.drawings.map((d, i) => (
                <li
                  key={d.id}
                  className={[
                    'kc-side-row',
                    p.selectedIds.includes(d.id) ? 'is-sel' : '',
                    d.visible ? '' : 'is-off',
                    d.id === dragId ? 'is-drag' : '',
                    dropAt === i ? 'drop-above' : '',
                    dropAt === i + 1 && i === p.drawings.length - 1 ? 'drop-below' : '',
                  ].filter(Boolean).join(' ')}
                  draggable
                  onDragStart={(e) => {
                    setDragId(d.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', d.id);
                  }}
                  onDragOver={(e) => overRow(e, i)}
                  onDrop={(e) => {
                    e.preventDefault();
                    drop();
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropAt(null);
                  }}
                >
                  <span className="kc-side-grip" aria-hidden title="Drag to restack">{CHART_ICONS.grip}</span>
                  <span className="kc-side-dot" style={{ background: d.color }} aria-hidden />
                  <button type="button" className="kc-side-name" onClick={(e) => p.onSelect(d.id, e.ctrlKey || e.metaKey)} title="Select (Ctrl / ⌘ + click: several)">
                    {d.label}
                  </button>
                  <span className="kc-side-ctl">
                    <button type="button" className="kc-side-more" aria-label={`Bring ${d.label} forward`} title="Bring forward" disabled={i === 0} onClick={() => p.onMove(d.id, i - 1)}>
                      {MENU_ICONS.up}
                    </button>
                    <button type="button" className="kc-side-more" aria-label={`Send ${d.label} back`} title="Send back" disabled={i === p.drawings.length - 1} onClick={() => p.onMove(d.id, i + 1)}>
                      {MENU_ICONS.down}
                    </button>
                    <button type="button" className="kc-side-more kc-side-del" aria-label={`Delete ${d.label}`} title="Delete" onClick={() => p.onDelete(d.id)}>
                      {MENU_ICONS.remove}
                    </button>
                    <button type="button" aria-label={d.locked ? `Unlock ${d.label}` : `Lock ${d.label}`} title={d.locked ? 'Unlock' : 'Lock'} aria-pressed={d.locked} className={d.locked ? 'on' : ''} onClick={() => p.onLock(d.id)}>
                      {d.locked ? MENU_ICONS.lock : MENU_ICONS.unlock}
                    </button>
                    <button type="button" aria-label={d.visible ? `Hide ${d.label}` : `Show ${d.label}`} title={d.visible ? 'Hide' : 'Show'} aria-pressed={!d.visible} onClick={() => p.onToggle(d.id)}>
                      {d.visible ? MENU_ICONS.show : MENU_ICONS.hide}
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {p.drawings.length > 1 && <p className="kc-side-tip">Ctrl / ⌘ + drag on the chart picks every drawing in an area - then style, lock, hide or delete them together.</p>}
        </section>

        <section className="kc-side-sec" aria-label="Indicators">
          <h3 className="kc-side-h">
            Indicators <span className="kc-side-count">{p.indicators.length}</span>
          </h3>
          {p.indicators.length === 0 ? (
            <p className="kc-side-empty">No indicators.</p>
          ) : (
            <ul className="kc-side-list">
              {p.indicators.map((ind) => (
                <li key={ind.id} className={`kc-side-row${ind.visible ? '' : ' is-off'}`}>
                  <button type="button" className="kc-side-name" onClick={() => p.onIndicatorSettings(ind.id)} title="Settings">
                    {ind.label}
                  </button>
                  <span className="kc-side-ctl">
                    <button type="button" className="kc-side-more" aria-label={`${ind.label} settings`} title="Settings" onClick={() => p.onIndicatorSettings(ind.id)}>
                      {MENU_ICONS.settings}
                    </button>
                    <button type="button" className="kc-side-more kc-side-del" aria-label={`Remove ${ind.label}`} title="Remove" onClick={() => p.onIndicatorRemove(ind.id)}>
                      {MENU_ICONS.remove}
                    </button>
                    <button type="button" aria-label={ind.visible ? `Hide ${ind.label}` : `Show ${ind.label}`} title={ind.visible ? 'Hide' : 'Show'} aria-pressed={!ind.visible} onClick={() => p.onIndicatorToggle(ind.id)}>
                      {ind.visible ? MENU_ICONS.show : MENU_ICONS.hide}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="kc-side-foot">
        <button type="button" className="kc-side-save" onClick={p.onSave} title="Download the chart as it is - range, drawings, indicators, and your position and fills if you choose - as a .json file">
          {MENU_ICONS.download}
          Download snapshot
        </button>
      </footer>
    </aside>
  );
}
