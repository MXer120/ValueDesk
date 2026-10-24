/**
 * The knowledge folders view: a glass drawer that slides out of the rail, over
 * the page (dimmed and slightly blurred behind it, like the widget sidebar).
 *
 *   left   the wallet's folders (up to its limit), then the open folder's
 *          items in their order, and what can be added: a note, a table, a
 *          file (a chart or a story is saved from the chart or the News widget)
 *   right  the item that is open - edited in place - or, with none, the
 *          folder's items as cards
 *
 * Items are reordered by dragging them in the list and moved by dropping them
 * on another folder; the same is in each item's right-click menu (Move up,
 * Move down, Move to …) for the keyboard. A file dropped on the drawer is
 * uploaded into the open folder. Every change is the server's to accept
 * (state.ts); a refusal is shown as the sentence the server gave.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { FolderSummary, ItemSummary } from '@sign/folders/types.js';
import { FILE_TYPES } from '@sign/folders/types.js';
import { MENU_ICONS, TabMenu, menuAt, type TabMenuItem } from '../dashboard/tabExtras';
import { useConfirm } from '../components/Modal';
import { openConnectDialog } from '../components/account/connect';
import { foldersApi } from './api';
import { FolderGlyph } from './FoldersHost';
import { NameInput, mb, saveBlob } from './ui';
import { ItemPane, KindIcon, itemLine } from './ItemPane';
import { emptyTable } from './table';
import { EMPTY_NOTE } from './note';
import {
  change,
  clearError,
  closeFolders,
  createFolder,
  deleteFolder,
  deleteItem,
  eraseEverything,
  moveItem,
  orderFolders,
  putSummary,
  renameFolder,
  selectFolder,
  selectItem,
  signInToFolders,
  signOutOfFolders,
  useFolders,
} from './state';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.md,application/pdf,image/png,image/jpeg,image/webp,image/gif,text/plain,text/csv,text/markdown';

export default function FoldersView() {
  const s = useFolders();
  const ref = useRef<HTMLElement>(null);
  const { confirm, dialog } = useConfirm();
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: TabMenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState<{ name: string; share: number } | null>(null);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || menu || document.querySelector('.modal-backdrop, .vs-confirm')) return;
      closeFolders();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [menu]);

  const list = s.list;
  const limits = list?.limits;
  const folder = list?.folders.find((f) => f.id === s.folderId) ?? null;
  const item = folder?.items.find((i) => i.id === s.itemId) ?? null;
  const folderFull = !!folder && !!limits && folder.items.length >= limits.itemsPerFolder;

  /* ------------------------------------------------------------ adding ----- */

  const addNote = () =>
    folder &&
    change(
      (t) => foldersApi.createItem(t, { folderId: folder.id, kind: 'note', title: 'Untitled note', data: EMPTY_NOTE }),
      (it) => void putSummary(it, true),
    );
  const addTable = () =>
    folder &&
    change(
      (t) => foldersApi.createItem(t, { folderId: folder.id, kind: 'table', title: 'Untitled table', data: emptyTable() }),
      (it) => void putSummary(it, true),
    );

  const upload = async (files: FileList | File[]) => {
    if (!folder || !limits) return;
    for (const f of Array.from(files)) {
      if (f.size > limits.fileBytes) {
        await confirm({ title: 'Too large for a folder', body: <p className="fx-note">{f.name} is {mb(f.size)}. A file can be at most {mb(limits.fileBytes)}.</p>, confirmLabel: 'OK' });
        continue;
      }
      setUploading({ name: f.name, share: 0 });
      const it = await change(
        (t) => foldersApi.upload(t, { folderId: folder.id, file: f, name: f.name }, (share) => setUploading({ name: f.name, share })),
        (r) => void putSummary(r, true),
      );
      setUploading(null);
      if (!it) break;
    }
  };

  /* ----------------------------------------------------------- menus ----- */

  const folderMenu = (e: ReactMouseEvent, f: FolderSummary, i: number) => {
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

  const itemMenu = (e: ReactMouseEvent, it: ItemSummary, i: number) => {
    const f = list!.folders.find((x) => x.id === it.folderId)!;
    const others = list!.folders.filter((x) => x.id !== it.folderId);
    setMenu({
      at: menuAt(e),
      items: [
        { label: 'Open', icon: MENU_ICONS.open, onClick: () => selectItem(it.id) },
        { label: 'Rename', icon: MENU_ICONS.rename, onClick: () => { selectItem(it.id); setRenaming(it.id); } },
        { label: 'Move up', icon: MENU_ICONS.up, disabled: i === 0, onClick: () => void moveItem(it.id, f.id, i - 1) },
        { label: 'Move down', icon: MENU_ICONS.down, disabled: i === f.items.length - 1, onClick: () => void moveItem(it.id, f.id, i + 1) },
        ...others.map((o) => ({
          label: `Move to ${o.name}`,
          icon: MENU_ICONS.moveTo,
          disabled: !!limits && o.items.length >= limits.itemsPerFolder,
          onClick: () => void moveItem(it.id, o.id, o.items.length),
        })),
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
    const ok = await confirm({ title: `Delete ${it.title}?`, body: <p className="fx-note">It is deleted for good.</p>, confirmLabel: 'Delete', danger: true });
    if (ok) await deleteItem(it.id);
  };

  const askErase = async () => {
    const ok = await confirm({
      title: 'Delete everything in your folders?',
      body: (
        <p className="fx-note">
          Every folder, note, table, chart, story and file this wallet keeps is deleted from our server at once, and every browser signed in to these folders is signed out. A
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

  /* ------------------------------------------------------------- drag ----- */

  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const dragStart = (e: DragEvent, it: ItemSummary) => {
    e.dataTransfer.setData('application/x-vd-folder-item', it.id);
    e.dataTransfer.effectAllowed = 'move';
    setDrag({ id: it.id, over: null });
  };
  const dropOnItem = (e: DragEvent, target: ItemSummary, index: number) => {
    const id = e.dataTransfer.getData('application/x-vd-folder-item');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    setDrag(null);
    if (id !== target.id) void moveItem(id, target.folderId, index);
  };
  const dropOnFolder = (e: DragEvent, f: FolderSummary) => {
    const id = e.dataTransfer.getData('application/x-vd-folder-item');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    setDrag(null);
    void moveItem(id, f.id, f.items.length);
  };
  const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  /* ----------------------------------------------------------- render ----- */

  let content: ReactNode;
  if (!s.owner) {
    content = (
      <Gate title="Connect a wallet" line="Your folders belong to your wallet: up to three, for your notes, tables, charts, news and files.">
        <button type="button" className="fx-cta kf-gate__cta" onClick={() => openConnectDialog()}>Connect wallet</button>
      </Gate>
    );
  } else if (!s.token) {
    content = (
      <Gate title="Your research, private to your wallet" line="Keep charts with their drawings, notes, tables, saved news and PDFs in up to three folders. Sign in once on this browser.">
        <button type="button" className="fx-cta kf-gate__cta" disabled={s.signing} onClick={() => void signInToFolders()}>
          {s.signing ? 'Waiting for the wallet…' : 'Sign in with your wallet'}
        </button>
        <p className="kf-gate__fine">A free signature, never a transaction. Only this wallet can open its folders.</p>
      </Gate>
    );
  } else if (!list) {
    content = <p className="fx-wait kf-wait"><span className="fx-spin" aria-hidden="true" />Loading your folders…</p>;
  } else {
    content = (
      <div className={`kf__cols${item ? ' has-item' : ''}`}>
        <nav className="kf__nav" aria-label="Folders">
          <ul className="kf__folders">
            {list.folders.map((f, i) => (
              <li key={f.id}>
                {renaming === f.id ? (
                  <NameInput
                    initial={f.name}
                    max={limits!.nameChars}
                    label="Folder name"
                    onDone={(name) => {
                      setRenaming(null);
                      if (name && name !== f.name) void renameFolder(f.id, name);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className={`kf__folder${f.id === s.folderId ? ' is-on' : ''}${drag?.over === f.id ? ' is-over' : ''}`}
                    aria-current={f.id === s.folderId ? 'true' : undefined}
                    onClick={() => selectFolder(f.id)}
                    onDoubleClick={() => setRenaming(f.id)}
                    onContextMenu={(e) => folderMenu(e, f, i)}
                    onDragOver={(e) => {
                      if (!drag || f.id === s.folderId) return;
                      e.preventDefault();
                      if (drag.over !== f.id) setDrag({ ...drag, over: f.id });
                    }}
                    onDragLeave={() => drag?.over === f.id && setDrag({ ...drag, over: null })}
                    onDrop={(e) => dropOnFolder(e, f)}
                  >
                    <FolderGlyph size={16} />
                    <span className="kf__fname">{f.name}</span>
                    <span className="kf__fcount">{f.items.length}</span>
                  </button>
                )}
              </li>
            ))}
            {list.folders.length < limits!.folders && (
              <li>
                {creating ? (
                  <NameInput
                    initial=""
                    max={limits!.nameChars}
                    label="New folder's name"
                    placeholder="Folder name"
                    onDone={(name) => {
                      setCreating(false);
                      if (name) void createFolder(name);
                    }}
                  />
                ) : (
                  <button type="button" className="kf__folder kf__folder--new" onClick={() => setCreating(true)}>
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                    <span>New folder</span>
                    <span className="kf__fcount">{list.folders.length}/{limits!.folders}</span>
                  </button>
                )}
              </li>
            )}
          </ul>

          {folder ? (
            <>
              <div className="kf__sub">
                <span>{folder.items.length} of {limits!.itemsPerFolder} items</span>
              </div>
              <ol className="kf__items" onDragEnd={() => setDrag(null)}>
                {folder.items.map((it, i) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      draggable
                      className={`kf__item${it.id === s.itemId ? ' is-on' : ''}${drag?.id === it.id ? ' is-dragging' : ''}`}
                      aria-current={it.id === s.itemId ? 'true' : undefined}
                      onClick={() => selectItem(it.id)}
                      onContextMenu={(e) => itemMenu(e, it, i)}
                      onDragStart={(e) => dragStart(e, it)}
                      onDragOver={(e) => drag && e.preventDefault()}
                      onDrop={(e) => dropOnItem(e, it, i)}
                    >
                      <KindIcon item={it} />
                      <span className="kf__ibody">
                        <span className="kf__ititle">{it.title}</span>
                        <span className="kf__iline">{itemLine(it)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              {folder.items.length === 0 && <p className="kf__hint">Empty. Add a note, a table or a file - or save a chart or a story into it.</p>}
              <div className="kf__add" role="group" aria-label="Add to this folder">
                <button type="button" className="kf__addbtn" disabled={folderFull} onClick={() => void addNote()}>
                  <KindIcon kind="note" /> Note
                </button>
                <button type="button" className="kf__addbtn" disabled={folderFull} onClick={() => void addTable()}>
                  <KindIcon kind="table" /> Table
                </button>
                <button type="button" className="kf__addbtn" disabled={folderFull || !!uploading} onClick={() => fileInput.current?.click()}>
                  <KindIcon kind="file" /> {uploading ? `Uploading ${Math.round(uploading.share * 100)}%` : 'File'}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  multiple
                  accept={ACCEPT}
                  onChange={(e) => {
                    if (e.target.files?.length) void upload(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>
            </>
          ) : (
            <p className="kf__hint">Make a folder for your research - a market, a thesis, a strategy.</p>
          )}
        </nav>

        <main
          className={`kf__main${dropping ? ' is-dropping' : ''}`}
          onDragOver={(e) => {
            if (!isFileDrag(e) || !folder || folderFull) return;
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
          }}
          onDrop={(e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            setDropping(false);
            if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
          }}
        >
          {item ? (
            <ItemPane
              key={item.id}
              summary={item}
              renaming={renaming === item.id}
              onRenamed={() => setRenaming(null)}
              onMenu={(e) => itemMenu(e, item, folder!.items.indexOf(item))}
              onBack={() => selectItem(null)}
            />
          ) : folder ? (
            <FolderCards folder={folder} onMenu={itemMenu} />
          ) : (
            <div className="kf-gate kf-gate--inline">
              <span className="kf-gate__ic" aria-hidden="true"><FolderGlyph size={26} /></span>
              <b className="kf-gate__t">Your first folder</b>
              <p className="kf-gate__l">A market, a thesis, a strategy: up to {limits!.folders} folders, each with up to {limits!.itemsPerFolder} charts, notes, tables, stories and files.</p>
              <button type="button" className="fx-cta kf-gate__cta" onClick={() => setCreating(true)}>New folder</button>
            </div>
          )}
          {dropping && <div className="kf__drop" aria-hidden="true">Drop to add to {folder?.name}</div>}
        </main>
      </div>
    );
  }

  return createPortal(
    <div className="kf-root">
      <div className="kf-scrim" aria-hidden="true" onPointerDown={() => closeFolders()} />
      <section ref={ref} className="kf" role="dialog" aria-modal="false" aria-label="Knowledge folders">
        <header className="kf__head">
          <span className="kf__title">
            <FolderGlyph size={17} />
            <b>Knowledge folders</b>
          </span>
          {list && <Usage used={list.usage.bytes} max={list.limits.walletBytes} />}
          <span className="kf__headacts">
            {s.token && (
              <button type="button" className="kf__iconbtn" aria-label="Folder options" title="Options" onClick={accountMenu} onContextMenu={accountMenu}>
                {MENU_ICONS.more}
              </button>
            )}
            <button type="button" className="tabside__close" aria-label="Close" title="Close (Esc)" onClick={() => closeFolders()}>
              <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          </span>
        </header>
        {s.error && (
          <p className="kf__error" role="alert">
            <span>{s.error}</span>
            <button type="button" className="kf__iconbtn" aria-label="Dismiss" onClick={clearError}>{MENU_ICONS.close}</button>
          </p>
        )}
        {content}
      </section>
      {menu && <TabMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog}
    </div>,
    document.body,
  );

  async function downloadItem(it: ItemSummary) {
    await change(async (t) => {
      const blob = await foldersApi.file(t, it.id);
      saveBlob(blob, it.meta.fileName ?? it.title);
    });
  }
}

function Gate({ title, line, children }: { title: string; line: string; children: ReactNode }) {
  return (
    <div className="kf-gate">
      <span className="kf-gate__ic" aria-hidden="true"><FolderGlyph size={26} /></span>
      <b className="kf-gate__t">{title}</b>
      <p className="kf-gate__l">{line}</p>
      <ul className="kf-gate__kinds" aria-label="What a folder holds">
        {(['chart', 'note', 'table', 'news', 'file'] as const).map((k) => (
          <li key={k}><KindIcon kind={k} />{k === 'file' ? 'PDFs & images' : k === 'news' ? 'News' : `${k[0]!.toUpperCase()}${k.slice(1)}s`}</li>
        ))}
      </ul>
      {children}
    </div>
  );
}

function Usage({ used, max }: { used: number; max: number }) {
  const pct = Math.min(100, (used / max) * 100);
  return (
    <span className="kf__usage" title={`${mb(used)} of ${mb(max)} used`}>
      <span className="kf__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} className={pct > 90 ? 'is-high' : ''} /></span>
      <span className="kf__ut">{mb(used)} of {mb(max)}</span>
    </span>
  );
}

/** A folder's items as cards, when none is open. */
function FolderCards({ folder, onMenu }: { folder: FolderSummary; onMenu: (e: ReactMouseEvent, it: ItemSummary, i: number) => void }) {
  const kinds = useMemo(() => {
    const n: Record<string, number> = {};
    for (const it of folder.items) n[it.kind] = (n[it.kind] ?? 0) + 1;
    return n;
  }, [folder.items]);
  return (
    <div className="kf-cards">
      <header className="kf-cards__head">
        <b>{folder.name}</b>
        <span>{Object.entries(kinds).map(([k, n]) => `${n} ${k === 'news' ? (n === 1 ? 'story' : 'stories') : n === 1 ? k : `${k}s`}`).join(' · ') || 'Nothing in it yet'}</span>
      </header>
      <div className="kf-cards__grid">
        {folder.items.map((it, i) => (
          <button key={it.id} type="button" className="kf-card" onClick={() => selectItem(it.id)} onContextMenu={(e) => onMenu(e, it, i)}>
            <span className="kf-card__kind"><KindIcon item={it} /></span>
            <span className="kf-card__t">{it.title}</span>
            <span className="kf-card__l">{itemLine(it)}</span>
          </button>
        ))}
      </div>
      {folder.items.length === 0 && (
        <p className="kf__hint kf__hint--big">
          Save a chart with its drawings from the chart's menu, a story from the News widget, or add a note, a table or a file ({Object.values(FILE_TYPES).map((t) => t.label.replace(' image', '')).join(', ')}).
        </p>
      )}
    </div>
  );
}
