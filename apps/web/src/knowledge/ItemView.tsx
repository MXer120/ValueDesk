/**
 * One item, open on the Knowledge page: its header - the kind, the title
 * (renamed in place), the folder it is in, how saving goes, its menu - and
 * the item itself:
 *
 *   doc     the writer (doc/DocEditor.tsx)
 *   sheet   the spreadsheet (sheet/SheetEditor.tsx)
 *   board   the canvas (board/BoardEditor.tsx)
 *   tweet   the post with the user's note and tags (tweets.tsx)
 *   chart, news, file   as they were saved (views.tsx)
 *
 * The editors are their own chunks: the page opens without them, and only the
 * one an item needs is fetched.
 */
import { Suspense, useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { BoardData, DocData, FolderItem, ItemSummary, SavedNewsData, SheetData, TweetData } from '@sign/folders/types.js';
import { MENU_ICONS } from '../dashboard/tabExtras';
import { foldersApi } from '../folders/api';
import { STATUS_LABEL, type SaveStatus } from '../folders/autosave';
import { NameInput } from '../folders/ui';
import { change, foldersState, putSummary, useFolders } from '../folders/state';
import type { ChartSnapshot } from '../folders/bridge';
import { ChartView, FileView, KindIcon, KIND_LABEL, NewsView } from './views';
import { TweetView } from './tweets';
import { lazyChunk } from '../lazyPage';

const DocEditor = lazyChunk(() => import('./doc/DocEditor'));
const SheetEditor = lazyChunk(() => import('./sheet/SheetEditor'));
const BoardEditor = lazyChunk(() => import('./board/BoardEditor'));

const Wait = () => <p className="fx-wait kn-wait"><span className="fx-spin" aria-hidden="true" />Loading…</p>;

export function ItemView({ summary, rename: renameAsked, onRenamed, onMenu, onBack, onOpenItem }: {
  summary: ItemSummary;
  /** The item's menu asked for a rename. */
  rename?: boolean;
  onRenamed?: () => void;
  onMenu: (e: ReactMouseEvent) => void;
  onBack: () => void;
  onOpenItem: (id: string) => void;
}) {
  const s = useFolders();
  const [item, setItem] = useState<FolderItem | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [save, setSave] = useState<{ status: SaveStatus; message: string | null }>({ status: 'saved', message: null });
  const limits = s.list?.limits;
  const folder = s.list?.folders.find((f) => f.id === summary.folderId);

  // Files have nothing to load here (their bytes come in the view); everything else is read once per opening.
  useEffect(() => {
    let live = true;
    setItem(null);
    setFailed(null);
    setSave({ status: 'saved', message: null });
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

  useEffect(() => {
    if (renameAsked) setRenaming(true);
  }, [renameAsked]);

  const onStatus = useCallback((status: SaveStatus, message: string | null) => setSave({ status, message }), []);

  const rename = async (title: string | null) => {
    setRenaming(false);
    onRenamed?.();
    if (!title || title === summary.title) return;
    await change((t) => foldersApi.updateItem(t, { id: summary.id, title }), (r) => void putSummary(r));
  };

  const limit = limits?.jsonBytes[summary.kind === 'file' ? 'doc' : summary.kind] ?? 512 * 1024;
  const common = item ? { item, limitBytes: limit, onStatus, onOpenItem } : null;
  let body: ReactNode;
  if (failed) body = <p className="fx-note fx-note--err kn-pad">{failed}</p>;
  else if (summary.kind === 'file') body = <div className="kn-pad"><FileView summary={summary} /></div>;
  else if (!item || !common) body = <Wait />;
  else if (item.kind === 'doc') body = <Suspense fallback={<Wait />}><DocEditor {...common} data={item.data as DocData} /></Suspense>;
  else if (item.kind === 'sheet') body = <Suspense fallback={<Wait />}><SheetEditor {...common} data={item.data as SheetData} /></Suspense>;
  else if (item.kind === 'board') body = <Suspense fallback={<Wait />}><BoardEditor {...common} data={item.data as BoardData} /></Suspense>;
  else if (item.kind === 'tweet') body = <TweetView {...common} data={item.data as TweetData} />;
  else if (item.kind === 'news') body = <div className="kn-pad"><NewsView news={item.data as SavedNewsData} /></div>;
  else if (item.kind === 'chart') body = <div className="kn-pad"><ChartView summary={summary} snapshot={item.data as unknown as ChartSnapshot} /></div>;

  const shownStatus = summary.kind === 'doc' || summary.kind === 'sheet' || summary.kind === 'board' || summary.kind === 'tweet';
  return (
    <article className={`kn-item kn-item--${summary.kind}`}>
      <header className="kn-item__head">
        <button type="button" className="kf__iconbtn kn-item__back" aria-label="Back to the folder" title="Back" onClick={onBack}>
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
        </button>
        <KindIcon item={summary} />
        <div className="kn-item__titles">
          {renaming ? (
            <NameInput initial={summary.title} max={limits?.titleChars ?? 120} label="Title" onDone={(t) => void rename(t)} />
          ) : (
            <h1 className="kn-item__title" title="Click to rename" onClick={() => setRenaming(true)}>{summary.title}</h1>
          )}
          <span className="kn-item__where">{KIND_LABEL[summary.kind]}{folder ? ` · ${folder.name}` : ''}</span>
        </div>
        {shownStatus && <span className={`kn-save is-${save.status}`} title={save.message ?? undefined}>{STATUS_LABEL[save.status]}</span>}
        <button type="button" className="kf__iconbtn" aria-label="Item options" title="Options" onClick={onMenu}>{MENU_ICONS.more}</button>
      </header>
      <div className="kn-item__body">{body}</div>
    </article>
  );
}
