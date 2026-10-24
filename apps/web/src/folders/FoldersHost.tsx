/**
 * The knowledge folders in the app shell (App.tsx mounts this once): it hands
 * the connected wallet to the folders' state, answers saveToFolder (bridge.ts)
 * with the save sheet - pick a folder or make one, sign in when needed - and
 * shows the folders view while it is open (the rail's folder button, or the
 * navbar's below 761px).
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import type { FolderSummary } from '@sign/folders/types.js';
import { Modal } from '../components/Modal';
import { openConnectDialog } from '../components/account/connect';
import { notify } from '../toast';
import type { Eip1193Provider } from '../wallet';
import { registerSaveHandler, type FolderDraft, type SavedTo } from './bridge';
import { foldersApi } from './api';
import './folders.css';
import { bindWallet, createFolder, foldersState, openFolders, putSummary, refresh, signInToFolders, useFolders } from './state';

const FoldersView = lazy(() => import('./FoldersView'));

interface Pending {
  draft: FolderDraft;
  resolve: (r: SavedTo | null) => void;
}

export function FoldersHost({ address, provider }: { address: string | null; provider: Eip1193Provider | null }) {
  const s = useFolders();
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => bindWallet(address, provider), [address, provider]);
  useEffect(
    () =>
      registerSaveHandler(
        (draft) =>
          new Promise<SavedTo | null>((resolve) => {
            setPending((cur) => {
              cur?.resolve(null);
              return { draft, resolve };
            });
          }),
      ),
    [],
  );
  return (
    <>
      {s.open && (
        <Suspense fallback={null}>
          <FoldersView />
        </Suspense>
      )}
      {pending && (
        <SaveSheet
          draft={pending.draft}
          onDone={(r) => {
            pending.resolve(r);
            setPending(null);
          }}
        />
      )}
    </>
  );
}

const KIND_LABEL: Record<FolderDraft['kind'], string> = { chart: 'chart', news: 'story' };

/** Where a chart or a news story goes: one of the wallet's folders, or a new one. */
function SaveSheet({ draft, onDone }: { draft: FolderDraft; onDone: (r: SavedTo | null) => void }) {
  const s = useFolders();
  const [title, setTitle] = useState(draft.title);
  const [target, setTarget] = useState<string | 'new' | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = s.list;
  const limits = list?.limits;

  useEffect(() => {
    if (s.token && !s.list && !s.loading) void refresh();
  }, [s.token, s.list, s.loading]);

  // The folder on screen in the folders view first, else the first with room.
  const folders = list?.folders ?? [];
  const full = (f: FolderSummary) => !!limits && f.items.length >= limits.itemsPerFolder;
  const canNew = !!limits && folders.length < limits.folders;
  const chosen = target ?? (folders.find((f) => f.id === s.folderId && !full(f)) ?? folders.find((f) => !full(f)))?.id ?? (canNew ? 'new' : null);

  const save = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      let folderId = chosen;
      if (chosen === 'new') {
        const r = await createFolder(newName.trim() || defaultFolderName(draft));
        if (!r) throw new Error(foldersState().error ?? 'The folder could not be made.');
        folderId = r.folder.id;
      }
      const token = foldersState().token;
      if (!token) throw new Error('Sign in to your folders first.');
      const item = await foldersApi.createItem(token, {
        folderId,
        kind: draft.kind,
        title: title.trim() || draft.title,
        data: draft.data,
        ...(draft.kind === 'chart' && draft.thumb ? { thumb: draft.thumb } : {}),
      });
      putSummary(item);
      const name = foldersState().list?.folders.find((f) => f.id === folderId)?.name ?? 'your folder';
      // The chart says "Saved <title> to the folder" itself (Chart.tsx exportChart): one toast, not two.
      if (draft.kind !== 'chart') notify('ok', `Saved to ${name}`);
      onDone({ folderId, itemId: item.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not save.');
      setBusy(false);
    }
  };

  const body = !s.owner ? (
    <div className="kf-save__gate">
      <p className="fx-note">Folders belong to a wallet. Connect one to keep this {KIND_LABEL[draft.kind]} in a folder.</p>
      <button type="button" className="fx-cta" onClick={() => openConnectDialog()}>Connect wallet</button>
    </div>
  ) : !s.token ? (
    <div className="kf-save__gate">
      <p className="fx-note">Your folders are private to your wallet. Sign in once on this browser - a free signature, never a transaction.</p>
      <button type="button" className="fx-cta" disabled={s.signing} onClick={() => void signInToFolders()}>
        {s.signing ? 'Waiting for the wallet…' : 'Sign in with your wallet'}
      </button>
      {s.error && <p className="fx-note fx-note--err" role="alert">{s.error}</p>}
    </div>
  ) : !list ? (
    <p className="fx-wait"><span className="fx-spin" aria-hidden="true" />Loading your folders…</p>
  ) : (
    <div className="kf-save">
      <label className="kf-save__label" htmlFor="kf-save-title">Name</label>
      <input id="kf-save-title" className="fx-input" value={title} maxLength={limits?.titleChars ?? 120} onChange={(e) => setTitle(e.target.value)} />
      <span className="kf-save__label" id="kf-save-where">Folder</span>
      <div className="kf-save__folders" role="radiogroup" aria-labelledby="kf-save-where">
        {folders.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={chosen === f.id}
            className={`kf-save__folder${chosen === f.id ? ' is-on' : ''}`}
            disabled={full(f)}
            onClick={() => setTarget(f.id)}
          >
            <FolderGlyph />
            <span className="kf-save__fname">{f.name}</span>
            <span className="kf-save__count">{full(f) ? 'Full' : `${f.items.length} of ${limits?.itemsPerFolder}`}</span>
          </button>
        ))}
        {canNew && (
          <div className={`kf-save__folder kf-save__new${chosen === 'new' ? ' is-on' : ''}`} role="radio" aria-checked={chosen === 'new'} tabIndex={-1} onClick={() => setTarget('new')}>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            <input
              className="kf-save__newname"
              value={newName}
              placeholder={folders.length ? 'New folder' : defaultFolderName(draft)}
              maxLength={limits?.nameChars ?? 60}
              aria-label="New folder's name"
              onFocus={() => setTarget('new')}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
        )}
      </div>
      {!chosen && <p className="fx-note fx-note--warn">Every folder is full. Make room in one first.</p>}
      {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
    </div>
  );

  return (
    <Modal
      open
      className="fx kf-save-sheet"
      title={draft.kind === 'chart' ? 'Save chart to a folder' : 'Save story to a folder'}
      onClose={() => onDone(null)}
      footer={
        s.token && list ? (
          <div className="fx-review__actions">
            <button type="button" className="fx-cta fx-cta--ghost" onClick={() => onDone(null)}>Cancel</button>
            <button type="button" className="fx-cta" disabled={!chosen || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        ) : undefined
      }
    >
      {body}
      {s.token && list && (
        <button type="button" className="fx-link kf-save__open" onClick={() => { onDone(null); openFolders(); }}>
          Open your folders
        </button>
      )}
    </Modal>
  );
}

const defaultFolderName = (d: FolderDraft): string => (d.kind === 'chart' ? 'Charts' : 'News');

export const FolderGlyph = ({ size = 15 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 4.5c0-.6.4-1 1-1h3l1.4 1.5h4.6c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1z" />
  </svg>
);
