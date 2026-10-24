/**
 * KNOWLEDGE - the wallet's research, a page of its own (/knowledge).
 *
 *   left    the wallet's folders (up to its limit), each with its items in
 *           their order; every saved post on X in one place; a search over
 *           titles and excerpts; New: a doc, a sheet, a board, a post by its
 *           link, files
 *   right   the open item (ItemView.tsx), or the folder's items as cards, or
 *           every saved post as a wall (tweets.tsx)
 *
 * Items are reordered by dragging them in the tree and moved by dropping them
 * on another folder (each item's right-click menu does the same from the
 * keyboard). Files, links, text and posts dropped on a folder - or on the
 * rail's Knowledge button from anywhere in the app (folders/QuickDrop.tsx) -
 * are saved into it; a link to a post on X pasted on the page is saved as one.
 * Every change is the server's to accept (folders/state.ts): a refusal is shown
 * as the sentence the server gave.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { FolderSummary, ItemKind, ItemSummary, JsonKind } from '@sign/folders/types.js';
import { findTweetUrl } from '@sign/folders/tweetUrl.js';
import { MENU_ICONS, TabMenu, menuAt, type TabMenuItem } from '../dashboard/tabExtras';
import { useConfirm } from '../components/Modal';
import { openConnectDialog } from '../components/account/connect';
import { notify } from '../toast';
import { foldersApi } from '../folders/api';
import { FolderGlyph } from '../folders/FoldersHost';
import { NameInput, mb, saveBlob } from '../folders/ui';
import { DRAG_ITEM, canKeep, emptyBoard, emptyDoc, emptySheet, readDrop, saveDropped, saveTweet } from '../folders/quick';
import {
  change,
  clearError,
  createFolder,
  deleteFolder,
  deleteItem,
  ensureList,
  eraseEverything,
  foldersState,
  moveItem,
  orderFolders,
  putSummary,
  renameFolder,
  selectFolder,
  selectItem,
  selectView,
  signInToFolders,
  signOutOfFolders,
  useFolders,
} from '../folders/state';
import { ItemView } from './ItemView';
import { AddTweetDialog, TweetsWall } from './tweets';
import { KindIcon, KIND_LABEL, itemLine, useFileUrl, when } from './views';
import '../folders/folders.css';
import './knowledge.css';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.md,application/pdf,image/png,image/jpeg,image/webp,image/gif,text/plain,text/csv,text/markdown';
const OPEN_KEY = 'kn.open';

const readOpen = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};

export function KnowledgePage(_props: { address: string | null }) {
  const s = useFolders();
  const { confirm, dialog } = useConfirm();
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: TabMenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(readOpen);
  const [drag, setDrag] = useState<{ id: string | null; over: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [addPost, setAddPost] = useState<{ url: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ensureList();
  }, [s.token]);

  const list = s.list;
  const limits = list?.limits;
  const folder = list?.folders.find((f) => f.id === s.folderId) ?? null;
  const item = list?.folders.flatMap((f) => f.items).find((i) => i.id === s.itemId) ?? null;
  const posts = useMemo(() => (list?.folders ?? []).flatMap((f) => f.items.filter((i) => i.kind === 'tweet')), [list]);
  const full = (f: FolderSummary | null) => !f || (!!limits && f.items.length >= limits.itemsPerFolder);

  const toggleOpen = (id: string, to?: boolean) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (to ?? !next.has(id)) next.add(id);
      else next.delete(id);
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
      } catch {
        /* a private window: the tree forgets, nothing else */
      }
      return next;
    });

  // The open folder's items are shown in the tree.
  useEffect(() => {
    if (s.folderId && !open.has(s.folderId)) toggleOpen(s.folderId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.folderId]);

  /* -------------------------------------------------------------- making ----- */

  /** The folder new things go into: the open one, else the first with room. */
  const target = (): FolderSummary | null => (!full(folder) ? folder : list?.folders.find((f) => !full(f)) ?? null);

  const make = async (kind: Extract<JsonKind, 'doc' | 'sheet' | 'board'>) => {
    const f = target();
    if (!f) return void notify('warn', list?.folders.length ? 'Every folder is full. Make room in one first.' : 'Make a folder first.');
    const data = kind === 'doc' ? emptyDoc() : kind === 'sheet' ? emptySheet() : emptyBoard();
    const title = `Untitled ${KIND_LABEL[kind].toLowerCase()}`;
    const it = await change((t) => foldersApi.createItem(t, { folderId: f.id, kind, title, data }), (r) => void putSummary(r));
    if (it) {
      selectFolder(f.id);
      selectItem(it.id);
    }
  };

  const upload = async (files: File[], into?: FolderSummary | null) => {
    const f = into ?? target();
    if (!f) return void notify('warn', 'Make a folder first.');
    const tooBig = files.filter((x) => limits && x.size > limits.fileBytes);
    if (tooBig.length) notify('warn', `${tooBig.map((x) => x.name).join(', ')}: a file can be at most ${mb(limits!.fileBytes)}.`);
    const r = await saveDropped({ kind: 'files', files }, f.id, (name, share) => setBusy(`Uploading ${name} · ${Math.round(share * 100)}%`));
    setBusy(null);
    if (r) notify('ok', `${r.said} to ${f.name}`);
  };

  const newMenu = (e: ReactMouseEvent) =>
    setMenu({
      at: menuAt(e),
      items: [
        { label: 'Doc', icon: <KindIcon kind="doc" size={13} />, onClick: () => void make('doc') },
        { label: 'Sheet', icon: <KindIcon kind="sheet" size={13} />, onClick: () => void make('sheet') },
        { label: 'Board', icon: <KindIcon kind="board" size={13} />, onClick: () => void make('board') },
        { label: 'Post from X (its link)', icon: <KindIcon kind="tweet" size={13} />, onClick: () => setAddPost({ url: '' }) },
        { label: 'Upload files', icon: <KindIcon kind="file" size={13} />, onClick: () => fileInput.current?.click() },
      ],
    });

  // A link to a post on X pasted on the page (not into an editor or a field) is saved as one.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (document.querySelector('.modal-backdrop')) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length && !s.itemId) {
        e.preventDefault();
        void upload(files);
        return;
      }
      const t = e.clipboardData?.getData('text/plain') ?? '';
      const ref = findTweetUrl(t);
      if (!ref || !foldersState().token) return;
      e.preventDefault();
      setAddPost({ url: ref.url });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  /* --------------------------------------------------------------- menus ----- */

  const folderMenu = (e: ReactMouseEvent, f: FolderSummary, i: number) => {
    e.preventDefault();
    const all = list!.folders;
    const ids = all.map((x) => x.id);
    const swap = (to: number) => {
      const next = [...ids];
      next.splice(i, 1);
      next.splice(to, 0, f.id);
      void orderFolders(next);
    };
    setMenu({
      at: menuAt(e),
      items: [
        { label: 'Rename', icon: MENU_ICONS.rename, onClick: () => setRenaming(f.id) },
        { label: 'Move up', icon: MENU_ICONS.up, disabled: i === 0, onClick: () => swap(i - 1) },
        { label: 'Move down', icon: MENU_ICONS.down, disabled: i === all.length - 1, onClick: () => swap(i + 1) },
        { label: 'Delete folder', icon: MENU_ICONS.remove, danger: true, onClick: () => void askDeleteFolder(f) },
      ],
    });
  };

  const itemMenu = (e: ReactMouseEvent, it: ItemSummary) => {
    e.preventDefault();
    const f = list!.folders.find((x) => x.id === it.folderId)!;
    const i = f.items.findIndex((x) => x.id === it.id);
    const others = list!.folders.filter((x) => x.id !== it.folderId);
    setMenu({
      at: menuAt(e),
      items: [
        { label: 'Open', icon: MENU_ICONS.open, onClick: () => openItem(it.id) },
        { label: 'Rename', icon: MENU_ICONS.rename, onClick: () => { openItem(it.id); setRenaming(it.id); } },
        { label: 'Move up', icon: MENU_ICONS.up, disabled: i === 0, onClick: () => void moveItem(it.id, f.id, i - 1) },
        { label: 'Move down', icon: MENU_ICONS.down, disabled: i === f.items.length - 1, onClick: () => void moveItem(it.id, f.id, i + 1) },
        ...others.map((o) => ({ label: `Move to ${o.name}`, icon: MENU_ICONS.moveTo, disabled: full(o), onClick: () => void moveItem(it.id, o.id, o.items.length) })),
        ...(it.kind === 'file' ? [{ label: 'Download', icon: MENU_ICONS.download, onClick: () => void downloadItem(it) }] : []),
        { label: 'Delete', icon: MENU_ICONS.remove, danger: true, onClick: () => void askDeleteItem(it) },
      ],
    });
  };

  const accountMenu = (e: ReactMouseEvent) =>
    setMenu({
      at: menuAt(e),
      items: [
        { label: 'Sign out on this browser', icon: MENU_ICONS.signOut, onClick: signOutOfFolders },
        { label: 'Delete everything…', icon: MENU_ICONS.remove, danger: true, onClick: () => void askErase() },
      ],
    });

  const askDeleteFolder = async (f: FolderSummary) => {
    const ok = await confirm({
      title: `Delete ${f.name}?`,
      body: <p className="fx-note">{f.items.length ? `The folder and the ${f.items.length === 1 ? 'item' : `${f.items.length} items`} in it are deleted for good.` : 'The folder is empty.'}</p>,
      confirmLabel: 'Delete folder',
      danger: true,
    });
    if (ok) await deleteFolder(f.id);
  };

  const askDeleteItem = async (it: ItemSummary) => {
    const ok = await confirm({ title: `Delete ${it.title}?`, body: <p className="fx-note">{it.kind === 'doc' || it.kind === 'board' ? 'It is deleted for good, with the images in it.' : 'It is deleted for good.'}</p>, confirmLabel: 'Delete', danger: true });
    if (ok) await deleteItem(it.id);
  };

  const askErase = async () => {
    const ok = await confirm({
      title: 'Delete everything in your folders?',
      body: (
        <p className="fx-note">
          Every folder, doc, sheet, board, saved post, chart, story and file this wallet keeps is deleted from our server at once, and every browser signed in to these folders is signed out. A
          nightly copy of the text keeps it for up to seven more days; files are not copied.
        </p>
      ),
      requireAck: 'I understand this cannot be undone.',
      confirmLabel: 'Delete everything',
      danger: true,
      size: 'md',
    });
    if (ok) await eraseEverything();
  };

  async function downloadItem(it: ItemSummary) {
    await change(async (t) => saveBlob(await foldersApi.file(t, it.id), it.meta.fileName ?? it.title));
  }

  const openItem = (id: string) => {
    const it = list?.folders.flatMap((f) => f.items).find((x) => x.id === id);
    if (!it) return void notify('warn', 'That item is not in your folders any more.');
    selectFolder(it.folderId);
    selectItem(id);
  };

  /* ---------------------------------------------------------------- drag ----- */

  const dropInto = async (e: ReactDragEvent, f: FolderSummary, index?: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag(null);
    const d = readDrop(e.dataTransfer);
    if (!d) return;
    if (d.kind === 'item') {
      const at = f.items.findIndex((x) => x.id === d.id);
      if (at >= 0 && index === undefined) return;
      void moveItem(d.id, f.id, index ?? f.items.length);
      return;
    }
    setBusy(d.kind === 'files' ? 'Uploading…' : d.kind === 'text' && findTweetUrl(d.text) ? 'Reading the post…' : 'Saving…');
    const r = await saveDropped(d, f.id, (name, share) => setBusy(`Uploading ${name} · ${Math.round(share * 100)}%`));
    setBusy(null);
    if (r) notify('ok', `${r.said} to ${f.name}`);
  };

  const overProps = (key: string, onDrop: (e: ReactDragEvent) => void) => ({
    onDragOver: (e: ReactDragEvent) => {
      if (!canKeep(Array.from(e.dataTransfer.types))) return;
      e.preventDefault();
      if (drag?.over !== key) setDrag({ id: drag?.id ?? null, over: key });
    },
    onDragLeave: (e: ReactDragEvent) => {
      if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null) && drag?.over === key) setDrag({ id: drag.id, over: null });
    },
    onDrop,
  });

  /* -------------------------------------------------------------- render ----- */

  const q = query.trim().toLowerCase();
  const matches = (it: ItemSummary) => !q || it.title.toLowerCase().includes(q) || (it.meta.excerpt ?? '').toLowerCase().includes(q) || (it.meta.tags ?? []).some((t) => t.includes(q.replace(/^#/, '')));

  let side: ReactNode = null;
  let main: ReactNode;
  if (!s.owner) {
    main = (
      <Gate title="Your research, private to your wallet" line="Docs, sheets and boards, posts from X, charts with their drawings, news and files - in up to three folders that only your wallet opens.">
        <button type="button" className="fx-cta kn-gate__cta" onClick={() => openConnectDialog()}>Connect wallet</button>
      </Gate>
    );
  } else if (!s.token) {
    main = (
      <Gate title="Open your knowledge folders" line="Sign in once on this browser. Only this wallet can open its folders.">
        <button type="button" className="fx-cta kn-gate__cta" disabled={s.signing} onClick={() => void signInToFolders()}>
          {s.signing ? 'Waiting for the wallet…' : 'Sign in with your wallet'}
        </button>
        <p className="kn-gate__fine">A free signature, never a transaction.</p>
        {s.error && <p className="fx-note fx-note--err" role="alert">{s.error}</p>}
      </Gate>
    );
  } else if (!list) {
    main = <p className="fx-wait kn-wait"><span className="fx-spin" aria-hidden="true" />Loading your folders…</p>;
  } else {
    side = (
      <aside className="kn__side" aria-label="Your folders">
        <header className="kn__head">
          <b className="kn__title">Knowledge</b>
          <Usage used={list.usage.bytes} max={list.limits.walletBytes} />
          <button type="button" className="kf__iconbtn" aria-label="Folder options" title="Options" onClick={accountMenu}>{MENU_ICONS.more}</button>
        </header>
        <div className="kn__tools">
          <button type="button" className="fx-cta kn__new" onClick={newMenu} disabled={!list.folders.length}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            New
          </button>
          <label className="kn__search">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.3" /><path d="m10.3 10.3 3 3" /></svg>
            <input value={query} placeholder="Search" aria-label="Search your folders" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
          </label>
        </div>
        <nav className="kn__tree">
          <button type="button" className={`kn__row kn__row--posts${s.view === 'posts' && !s.itemId ? ' is-on' : ''}`} onClick={() => selectView('posts')}>
            <KindIcon kind="tweet" />
            <span className="kn__rname">Saved posts</span>
            <span className="kn__rcount">{posts.length}</span>
          </button>
          <span className="kn__sub">Folders · {list.folders.length} of {limits!.folders}</span>
          <ul className="kn__folders">
            {list.folders.map((f, i) => {
              const shown = f.items.filter(matches);
              const isOpen = open.has(f.id) || !!q;
              return (
                <li key={f.id}>
                  {renaming === f.id ? (
                    <NameInput initial={f.name} max={limits!.nameChars} label="Folder name" onDone={(name) => { setRenaming(null); if (name && name !== f.name) void renameFolder(f.id, name); }} />
                  ) : (
                    <div className={`kn__row kn__row--folder${f.id === s.folderId && s.view === 'folder' && !s.itemId ? ' is-on' : ''}${drag?.over === f.id ? ' is-over' : ''}`} {...overProps(f.id, (e) => void dropInto(e, f))}>
                      <button type="button" className={`kn__twisty${isOpen ? ' is-open' : ''}`} aria-label={isOpen ? 'Fold' : 'Unfold'} aria-expanded={isOpen} onClick={() => toggleOpen(f.id)}>
                        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                      <button type="button" className="kn__rmain" onClick={() => { selectFolder(f.id); toggleOpen(f.id, true); }} onDoubleClick={() => setRenaming(f.id)} onContextMenu={(e) => folderMenu(e, f, i)}>
                        <FolderGlyph size={15} />
                        <span className="kn__rname">{f.name}</span>
                        <span className="kn__rcount">{f.items.length}</span>
                      </button>
                    </div>
                  )}
                  {isOpen && (
                    <ol className="kn__items" onDragEnd={() => setDrag(null)}>
                      {shown.map((it) => (
                        <li key={it.id}>
                          <button
                            type="button"
                            draggable
                            className={`kn__row kn__row--item${it.id === s.itemId ? ' is-on' : ''}${drag?.id === it.id ? ' is-dragging' : ''}${drag?.over === `i:${it.id}` ? ' is-before' : ''}`}
                            onClick={() => openItem(it.id)}
                            onContextMenu={(e) => itemMenu(e, it)}
                            onDragStart={(e) => {
                              e.dataTransfer.setData(DRAG_ITEM, it.id);
                              e.dataTransfer.setData('text/plain', it.title);
                              e.dataTransfer.effectAllowed = 'copyMove';
                              setDrag({ id: it.id, over: null });
                            }}
                            {...overProps(`i:${it.id}`, (e) => void dropInto(e, f, f.items.indexOf(it)))}
                          >
                            <KindIcon item={it} size={13} />
                            <span className="kn__rname">{it.title}</span>
                          </button>
                        </li>
                      ))}
                      {f.items.length === 0 && <li className="kn__empty">Empty - drop anything here</li>}
                      {q && f.items.length > 0 && shown.length === 0 && <li className="kn__empty">Nothing matches</li>}
                    </ol>
                  )}
                </li>
              );
            })}
            {list.folders.length < limits!.folders && (
              <li>
                {creating ? (
                  <NameInput initial="" max={limits!.nameChars} label="New folder's name" placeholder="Folder name" onDone={(name) => { setCreating(false); if (name) void createFolder(name); }} />
                ) : (
                  <button type="button" className="kn__row kn__row--new" onClick={() => setCreating(true)}>
                    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                    <span className="kn__rname">New folder</span>
                  </button>
                )}
              </li>
            )}
          </ul>
        </nav>
        {busy && <p className="kn__busy" role="status"><span className="fx-spin" aria-hidden="true" />{busy}</p>}
        <p className="kn__tip">Drop files, links or posts on a folder - or on the Knowledge button in the rail, from any page.</p>
      </aside>
    );
    if (item) {
      main = <ItemView key={item.id} summary={item} rename={renaming === item.id} onRenamed={() => setRenaming(null)} onMenu={(e) => itemMenu(e, item)} onBack={() => selectItem(null)} onOpenItem={openItem} />;
    } else if (s.view === 'posts') {
      main = <TweetsWall posts={posts} onOpen={openItem} onMenu={itemMenu} onAdd={() => setAddPost({ url: '' })} />;
    } else if (folder) {
      main = <FolderCards folder={folder} limits={limits!} onOpen={openItem} onMenu={itemMenu} onNew={make} onAddPost={() => setAddPost({ url: '' })} onUpload={() => fileInput.current?.click()} onDrop={(e) => void dropInto(e, folder)} />;
    } else {
      main = (
        <Gate title="Your first folder" line={`A market, a thesis, a strategy: up to ${limits!.folders} folders, each with up to ${limits!.itemsPerFolder} docs, sheets, boards, posts, charts, stories and files.`}>
          <button type="button" className="fx-cta kn-gate__cta" onClick={() => setCreating(true)}>New folder</button>
        </Gate>
      );
    }
  }

  return (
    <div className={`kn${side ? '' : ' kn--gate'}${item || s.view === 'posts' ? ' has-main' : ''}`}>
      {side}
      <main className="kn__main">
        {s.error && (
          <p className="kn__error" role="alert">
            <span>{s.error}</span>
            <button type="button" className="kf__iconbtn" aria-label="Dismiss" onClick={clearError}>{MENU_ICONS.close}</button>
          </p>
        )}
        {main}
      </main>
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept={ACCEPT}
        onChange={(e) => {
          if (e.target.files?.length) void upload(Array.from(e.target.files));
          e.target.value = '';
        }}
      />
      {addPost && (
        <AddTweetDialog
          initialUrl={addPost.url}
          folders={list?.folders ?? []}
          limits={limits ?? null}
          defaultFolder={target()?.id ?? null}
          onClose={() => setAddPost(null)}
          onSave={async (url, folderId, extra) => {
            const r = await saveTweet(url, folderId, extra);
            if (r?.id) {
              notify('ok', r.said);
              openItem(r.id);
              setAddPost(null);
            }
            return !!r;
          }}
        />
      )}
      {menu && <TabMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog}
    </div>
  );
}

function Gate({ title, line, children }: { title: string; line: string; children: ReactNode }) {
  const kinds: ItemKind[] = ['doc', 'sheet', 'board', 'tweet', 'chart', 'news', 'file'];
  return (
    <div className="kn-gate">
      <span className="kn-gate__ic" aria-hidden="true"><FolderGlyph size={26} /></span>
      <b className="kn-gate__t">{title}</b>
      <p className="kn-gate__l">{line}</p>
      <ul className="kn-gate__kinds" aria-label="What a folder holds">
        {kinds.map((k) => (
          <li key={k}><KindIcon kind={k} size={12} />{k === 'file' ? 'PDFs & images' : k === 'tweet' ? 'Posts from X' : k === 'news' ? 'News' : `${KIND_LABEL[k]}s`}</li>
        ))}
      </ul>
      {children}
    </div>
  );
}

function Usage({ used, max }: { used: number; max: number }) {
  const pct = Math.min(100, (used / max) * 100);
  return (
    <span className="kn__usage" title={`${mb(used)} of ${mb(max)} used`}>
      <span className="kf__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} className={pct > 90 ? 'is-high' : ''} /></span>
      <span className="kn__ut">{mb(used)}</span>
    </span>
  );
}

/** A folder's items as cards, with what can be added to it. */
function FolderCards({ folder, limits, onOpen, onMenu, onNew, onAddPost, onUpload, onDrop }: {
  folder: FolderSummary;
  limits: { itemsPerFolder: number };
  onOpen: (id: string) => void;
  onMenu: (e: ReactMouseEvent, it: ItemSummary) => void;
  onNew: (kind: 'doc' | 'sheet' | 'board') => void;
  onAddPost: () => void;
  onUpload: () => void;
  onDrop: (e: ReactDragEvent) => void;
}) {
  const [dropping, setDropping] = useState(false);
  const full = folder.items.length >= limits.itemsPerFolder;
  return (
    <section
      className={`kn-folder${dropping ? ' is-dropping' : ''}`}
      onDragOver={(e) => {
        if (!canKeep(Array.from(e.dataTransfer.types)) || full) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        onDrop(e);
      }}
    >
      <header className="kn-folder__head">
        <div>
          <h1 className="kn-folder__name">{folder.name}</h1>
          <span className="kn-folder__count">{folder.items.length} of {limits.itemsPerFolder} items</span>
        </div>
      </header>
      <div className="kn-folder__make" role="group" aria-label="Add to this folder">
        {(['doc', 'sheet', 'board'] as const).map((k) => (
          <button key={k} type="button" className="kn-make" disabled={full} onClick={() => onNew(k)}>
            <KindIcon kind={k} size={18} />
            <span><b>{KIND_LABEL[k]}</b><small>{k === 'doc' ? 'Write it up' : k === 'sheet' ? 'Numbers, formulas' : 'Map it out'}</small></span>
          </button>
        ))}
        <button type="button" className="kn-make" disabled={full} onClick={onAddPost}>
          <KindIcon kind="tweet" size={18} />
          <span><b>Post</b><small>A link from X</small></span>
        </button>
        <button type="button" className="kn-make" disabled={full} onClick={onUpload}>
          <KindIcon kind="file" size={18} />
          <span><b>Files</b><small>PDF, images, text</small></span>
        </button>
      </div>
      {folder.items.length > 0 ? (
        <div className="kn-cards">
          {folder.items.map((it) => (
            <Card key={it.id} it={it} onOpen={() => onOpen(it.id)} onMenu={(e) => onMenu(e, it)} />
          ))}
        </div>
      ) : (
        <p className="kn-folder__hint">Empty. Make a doc, a sheet or a board, drop files or links here, save a chart from its menu or a story from the News widget.</p>
      )}
      {dropping && <div className="kn-drop" aria-hidden="true">Drop to save into {folder.name}</div>}
    </section>
  );
}

function Card({ it, onOpen, onMenu }: { it: ItemSummary; onOpen: () => void; onMenu: (e: ReactMouseEvent) => void }) {
  const picture = it.kind === 'chart' ? (it.meta.thumb ? it.id : null) : it.kind === 'file' && it.meta.fileType && /png|jpeg|webp|gif/.test(it.meta.fileType) ? it.id : null;
  const url = useFileUrl(picture, it.kind === 'chart');
  return (
    <button
      type="button"
      className={`kn-card kn-card--${it.kind}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_ITEM, it.id);
        e.dataTransfer.setData('text/plain', it.title);
      }}
      onClick={onOpen}
      onContextMenu={onMenu}
    >
      {picture ? (
        <span className="kn-card__pic">{url ? <img src={url} alt="" /> : null}</span>
      ) : (
        <span className="kn-card__kind"><KindIcon item={it} size={16} /></span>
      )}
      <span className="kn-card__t">{it.title}</span>
      {(it.kind === 'doc' || it.kind === 'tweet') && it.meta.excerpt && <span className="kn-card__x">{it.meta.excerpt}</span>}
      <span className="kn-card__l">{it.kind === 'doc' ? `Edited ${when(it.updatedAt)}` : itemLine(it)}</span>
    </button>
  );
}
