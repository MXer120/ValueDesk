/**
 * One folder item, open: its title (renamed in place), then what it is -
 *
 *   note    the rich-text editor (NoteEditor.tsx), saved as you type
 *   table   the grid (TableEditor.tsx), saved as you type
 *   chart   the snapshot: market, timeframe, what it holds, its picture or the
 *           chart's own live preview, and Open chart (bridge.ts openChartSnapshot)
 *   news    the story as it was saved, with its link
 *   file    an image shown, a text file read, a PDF opened in the browser's own
 *           viewer in a new tab - always from bytes fetched with the wallet's
 *           token and typed by this page, never a link to the server
 */
import { useEffect, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { FolderItem, ItemKind, ItemSummary, NoteData, SavedNewsData, TableData } from '@sign/folders/types.js';
import { FILE_TYPES, isImageType } from '@sign/folders/types.js';
import { MENU_ICONS } from '../dashboard/tabExtras';
import { CoinIcon } from '../components/CoinIcon';
import { chartOpenerRegistered, chartPreviewComponent, onBridgeChange, openChartSnapshot, type ChartSnapshot } from './bridge';
import { foldersApi } from './api';
import { NameInput, mb, saveBlob } from './ui';
import { NoteEditor } from './NoteEditor';
import { TableEditor } from './TableEditor';
import { change, closeFolders, foldersState, putSummary, useFolders } from './state';

const KIND_PATH: Record<ItemKind, ReactNode> = {
  note: <><path d="M4.5 2.5h5l2.5 2.5v8a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" /><path d="M6 7.5h4M6 10h4" /></>,
  table: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M2.5 9.8h11M6.5 3v10" /></>,
  chart: <><path d="M3 13.5h10.5" /><path d="M4.5 10.5 7 7.5l2 2 3.5-4.5" /><circle cx="12.5" cy="5" r=".6" /></>,
  news: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M5 6h6M5 8.5h6M5 11h3.5" /></>,
  file: <><path d="M4.5 2.5h4.8l2.7 2.7v8.3a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" /><path d="M9.3 2.5v2.7H12" /></>,
};
const IMAGE_PATH = <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1.1" /><path d="m3 12 3.5-3.5 2.5 2.5 1.8-1.8L13.5 12" /></>;

export function KindIcon({ kind, item }: { kind?: ItemKind; item?: ItemSummary }) {
  const k = item?.kind ?? kind ?? 'note';
  const img = item?.kind === 'file' && isImageType(item.meta.fileType);
  return (
    <span className={`kf-kind kf-kind--${k}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {img ? IMAGE_PATH : KIND_PATH[k]}
      </svg>
    </span>
  );
}

const when = (t: number): string => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

/** The second line of an item in the list: what it is, briefly. */
export function itemLine(it: ItemSummary): string {
  const m = it.meta;
  switch (it.kind) {
    case 'chart':
      return [m.symbol, m.interval, m.engine === 'spot' ? 'Spot' : 'Perps'].filter(Boolean).join(' · ');
    case 'news':
      return [m.author, m.time ? when(m.time) : null].filter(Boolean).join(' · ') || 'News';
    case 'table':
      return `${m.rows ?? 0} rows · ${m.cols ?? 0} columns`;
    case 'file':
      return `${m.fileType ? FILE_TYPES[m.fileType].label : 'File'} · ${mb(it.bytes)}`;
    default:
      return m.excerpt || `Edited ${when(it.updatedAt)}`;
  }
}

export function ItemPane({ summary, renaming, onRenamed, onMenu, onBack }: {
  summary: ItemSummary;
  renaming: boolean;
  onRenamed: () => void;
  onMenu: (e: ReactMouseEvent) => void;
  onBack: () => void;
}) {
  const s = useFolders();
  const [item, setItem] = useState<FolderItem | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const limits = s.list?.limits;

  // Files have nothing to load here (their bytes come below); everything else is read once.
  useEffect(() => {
    let live = true;
    if (summary.kind === 'file') return;
    void change((t) => foldersApi.item(t, summary.id)).then((r) => {
      if (!live) return;
      if (r) setItem(r);
      else setFailed(foldersState().error ?? 'This item could not be loaded.');
    });
    return () => {
      live = false;
    };
    // The summary's rev changes with every save of ours; the item is read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.id]);

  const rename = async (title: string | null) => {
    setEditingTitle(false);
    onRenamed();
    if (!title || title === summary.title) return;
    await change((t) => foldersApi.updateItem(t, { id: summary.id, title }), (r) => void putSummary(r));
  };

  let body: ReactNode;
  if (failed) body = <p className="fx-note fx-note--err">{failed}</p>;
  else if (summary.kind === 'file') body = <FileView summary={summary} />;
  else if (!item) body = <p className="fx-wait"><span className="fx-spin" aria-hidden="true" />Loading…</p>;
  else if (item.kind === 'note') body = <NoteEditor item={item} data={item.data as NoteData} />;
  else if (item.kind === 'table') body = <TableEditor item={item} data={item.data as TableData} />;
  else if (item.kind === 'news') body = <NewsView news={item.data as SavedNewsData} />;
  else if (item.kind === 'chart') body = <ChartView summary={summary} snapshot={item.data as unknown as ChartSnapshot} />;

  return (
    <article className={`kf-pane kf-pane--${summary.kind}`}>
      <header className="kf-pane__head">
        <button type="button" className="kf__iconbtn kf-pane__back" aria-label="Back to the folder" title="Back" onClick={onBack}>
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
        </button>
        <KindIcon item={summary} />
        {renaming || editingTitle ? (
          <NameInput initial={summary.title} max={limits?.titleChars ?? 120} label="Title" onDone={(t) => void rename(t)} />
        ) : (
          <h2 className="kf-pane__title" title="Double-click to rename" onDoubleClick={() => setEditingTitle(true)}>{summary.title}</h2>
        )}
        <button type="button" className="kf__iconbtn" aria-label="Item options" title="Options" onClick={onMenu}>{MENU_ICONS.more}</button>
      </header>
      <div className="kf-pane__body">{body}</div>
    </article>
  );
}

/* --------------------------------------------------------------- chart ----- */

const useBridge = () => useSyncExternalStore(onBridgeChange, () => `${chartOpenerRegistered()}|${chartPreviewComponent() ? 1 : 0}`);

function ChartView({ summary, snapshot }: { summary: ItemSummary; snapshot: ChartSnapshot }) {
  useBridge();
  const Preview = chartPreviewComponent();
  const canOpen = chartOpenerRegistered();
  const thumb = useFileUrl(summary.meta.thumb ? summary.id : null, true);
  const coin = snapshot.symbol.split(/[-/]/)[0] ?? snapshot.symbol;
  const studies = (snapshot.indicators ?? []).filter((i) => i.visible !== false).map((i) => i.name);
  const facts: Array<[string, string]> = [
    ['Market', `${snapshot.symbol} ${snapshot.engine === 'spot' ? 'Spot' : 'Perps'}`],
    ['Timeframe', snapshot.interval],
    ['Drawings', String(snapshot.drawings?.length ?? 0)],
    ['Studies', studies.length ? studies.join(', ') : 'None'],
    ['Position', snapshot.include?.position && snapshot.position ? `${snapshot.position.side === 'long' ? 'Long' : 'Short'} ${snapshot.position.size} @ ${snapshot.position.entry}` : 'Not included'],
    ['Executions', snapshot.include?.executions ? `${snapshot.executions?.length ?? 0} shown` : 'Hidden'],
    ['Taken', new Date(snapshot.at).toLocaleString()],
  ];
  return (
    <div className="kf-chart">
      <div className="kf-chart__stage">
        {Preview ? (
          <Preview snapshot={snapshot} height={320} />
        ) : thumb ? (
          <img className="kf-chart__thumb" src={thumb} alt={`${summary.title}: the chart as it was saved`} />
        ) : (
          <div className="kf-chart__blank"><CoinIcon coin={coin} size={36} /><b>{snapshot.symbol}</b><span>{snapshot.interval}</span></div>
        )}
      </div>
      <dl className="kf-facts">
        {facts.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      <div className="kf-pane__actions">
        <button
          type="button"
          className="fx-cta kf-pane__cta"
          disabled={!canOpen}
          onClick={() => {
            if (openChartSnapshot(snapshot)) closeFolders();
          }}
        >
          Open chart with its drawings
        </button>
        {!canOpen && <p className="fx-note">The trade chart opens snapshots; it is not ready here yet. Open the Trade page, then this again.</p>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- news ----- */

function NewsView({ news }: { news: SavedNewsData }) {
  return (
    <div className="kf-news">
      <p className="kf-news__meta">
        {[news.author, news.time ? new Date(news.time).toLocaleString() : null].filter(Boolean).join(' · ')}
      </p>
      <h3 className={`kf-news__title${news.post ? ' is-post' : ''}`}>{news.title}</h3>
      {news.summary && <p className="kf-news__sum">{news.summary}</p>}
      {news.symbols.length > 0 && (
        <p className="kf-news__coins">
          {news.symbols.map((c) => <span key={c} className="nw__coin"><CoinIcon coin={c} size={13} />{c}</span>)}
        </p>
      )}
      <a className="fx-cta kf-pane__cta kf-news__open" href={news.href} target="_blank" rel="noopener noreferrer">Read the story</a>
    </div>
  );
}

/* ---------------------------------------------------------------- file ----- */

/** A blob URL for an item's bytes (or its thumbnail), fetched with the token; revoked when done. */
function useFileUrl(id: string | null, thumb = false): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    let made: string | null = null;
    void change((t) => foldersApi.file(t, id, thumb)).then((blob) => {
      if (!blob || !live) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [id, thumb]);
  return url;
}

function FileView({ summary }: { summary: ItemSummary }) {
  const type = summary.meta.fileType;
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const image = isImageType(type);
  const url = useFileUrl(image ? summary.id : null);

  useEffect(() => {
    if (type !== 'text') return;
    let live = true;
    void change((t) => foldersApi.file(t, summary.id)).then(async (b) => {
      if (b && live) setText(await b.text());
    });
    return () => {
      live = false;
    };
  }, [summary.id, type]);

  /** A PDF opens in the browser's own viewer, in a tab of its own, from bytes typed as a PDF here. */
  const openPdf = async () => {
    const w = window.open('', '_blank');
    setBusy(true);
    const blob = await change((t) => foldersApi.file(t, summary.id));
    setBusy(false);
    if (!blob) {
      w?.close();
      return;
    }
    const u = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
    if (w) {
      w.opener = null;
      w.location.href = u;
    } else saveBlob(blob, summary.meta.fileName ?? `${summary.title}.pdf`);
    setTimeout(() => URL.revokeObjectURL(u), 120_000);
  };

  const download = async () => {
    const blob = await change((t) => foldersApi.file(t, summary.id));
    if (blob) saveBlob(blob, summary.meta.fileName ?? summary.title);
  };

  return (
    <div className="kf-file">
      {image && (url ? <img className="kf-file__img" src={url} alt={summary.title} /> : <p className="fx-wait"><span className="fx-spin" aria-hidden="true" />Loading…</p>)}
      {type === 'text' && (text === null ? <p className="fx-wait"><span className="fx-spin" aria-hidden="true" />Loading…</p> : <pre className="kf-file__text">{text}</pre>)}
      {type === 'pdf' && (
        <div className="kf-file__pdf">
          <KindIcon item={summary} />
          <b>{summary.meta.fileName ?? summary.title}</b>
          <span>PDF · {mb(summary.bytes)}</span>
        </div>
      )}
      <div className="kf-pane__actions kf-pane__actions--row">
        {type === 'pdf' && (
          <button type="button" className="fx-cta kf-pane__cta" disabled={busy} onClick={() => void openPdf()}>{busy ? 'Opening…' : 'Open PDF'}</button>
        )}
        <button type="button" className="fx-cta fx-cta--ghost kf-pane__cta" onClick={() => void download()}>Download</button>
      </div>
    </div>
  );
}
