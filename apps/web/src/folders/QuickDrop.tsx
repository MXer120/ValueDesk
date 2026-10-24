/**
 * The rail's Knowledge button, and its quick drop.
 *
 * A click opens the Knowledge page. Dragging something onto the button - a
 * file, a link or a post on X out of another tab, selected text, a story out
 * of the News widget, an item out of the page's own tree - opens a small
 * panel right beside it with the wallet's folders: dropping on one saves it
 * there (quick.ts says what each thing becomes); dropping on the button itself
 * saves into the folder last used. A right-click opens the same panel without
 * a drag, to type a note or paste a link into a folder.
 *
 * Signed out, the panel asks for the wallet (and keeps what was dropped until
 * a folder is picked).
 */
import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { openConnectDialog } from '../components/account/connect';
import { notify } from '../toast';
import { FOLDER_ICON } from './icons';
import { canKeep, readDrop, saveDropped, saveText, type Dropped } from './quick';
import { createFolder, ensureList, foldersState, openFolders, signInToFolders, useFolders } from './state';

type Mode = 'drag' | 'type';

const describe = (d: Dropped): string =>
  d.kind === 'files' ? (d.files.length === 1 ? d.files[0]!.name : `${d.files.length} files`) : d.kind === 'news' ? d.news.title : d.kind === 'item' ? 'an item' : d.text;

export function KnowledgeRailButton({ current, onOpen, children }: { current: boolean; onOpen: () => void; children: ReactNode }) {
  const s = useFolders();
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [over, setOver] = useState<string | 'button' | 'new' | null>(null);
  const [pending, setPending] = useState<Dropped | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'busy' | 'err' } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [text, setText] = useState('');
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    setMode(null);
    setOver(null);
    setPending(null);
    setStatus(null);
    setText('');
  }, []);

  const open = (m: Mode) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    ensureList();
    setMode((cur) => cur ?? m);
  };

  // Escape and a click outside close it; so does a drag that ends anywhere else.
  useEffect(() => {
    if (!mode) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const end = () => {
      if (mode === 'drag' && !pending && !status) close();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', down);
    window.addEventListener('dragend', end);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('dragend', end);
    };
  }, [mode, pending, status, close]);

  const folders = s.list?.folders ?? [];
  const limits = s.list?.limits;
  const full = (n: number) => !!limits && n >= limits.itemsPerFolder;
  const lastUsed = (): string | null => {
    const f = folders.find((x) => x.id === (target ?? s.folderId) && !full(x.items.length)) ?? folders.find((x) => !full(x.items.length));
    return f?.id ?? null;
  };

  const save = async (d: Dropped, folderId: string | 'new') => {
    setStatus({ text: d.kind === 'files' ? 'Uploading…' : d.kind === 'text' && /x\.com|twitter\.com/i.test(d.text) ? 'Reading the post…' : 'Saving…', tone: 'busy' });
    let id = folderId;
    if (id === 'new') {
      const r = await createFolder('Inbox');
      if (!r) return setStatus({ text: foldersState().error ?? 'The folder could not be made.', tone: 'err' });
      id = r.folder.id;
    }
    const r = await saveDropped(d, id, (name, share) => setStatus({ text: `Uploading ${name} · ${Math.round(share * 100)}%`, tone: 'busy' }));
    if (!r) return setStatus({ text: foldersState().error ?? 'That could not be saved.', tone: 'err' });
    const name = foldersState().list?.folders.find((f) => f.id === id)?.name ?? 'your folder';
    setTarget(id);
    setPending(null);
    setStatus({ text: `${r.said} · ${name}`, tone: 'ok' });
    notify('ok', `${r.said} to ${name}`);
    closeTimer.current = setTimeout(close, 1600);
  };

  /** The drop's data, read now (it cannot be read later); without folders yet, kept until one is picked. */
  const dropOn = (e: ReactDragEvent, where: string | 'button' | 'new') => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    const d = readDrop(e.dataTransfer);
    if (!d) return;
    const folderId = where === 'button' ? lastUsed() : where;
    if (!s.token || !folderId) {
      setPending(d);
      setMode('drag');
      if (!folderId && s.token) setStatus({ text: 'Pick a folder for it', tone: 'busy' });
      return;
    }
    void save(d, folderId);
  };

  const dragProps = (where: string | 'button' | 'new') => ({
    onDragEnter: (e: ReactDragEvent) => {
      if (!canKeep(Array.from(e.dataTransfer.types))) return;
      e.preventDefault();
      open('drag');
      setOver(where);
    },
    onDragOver: (e: ReactDragEvent) => {
      if (!canKeep(Array.from(e.dataTransfer.types))) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = Array.from(e.dataTransfer.types).includes('application/x-vd-folder-item') ? 'move' : 'copy';
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      if (over !== where) setOver(where);
    },
    onDragLeave: (e: ReactDragEvent) => {
      const to = e.relatedTarget as Node | null;
      if (to && (panel.current?.contains(to) || btn.current?.contains(to))) return;
      setOver(null);
      // Leaving both the button and the panel: gone, unless something waits for a folder.
      leaveTimer.current = setTimeout(() => {
        if (!pending && !status) close();
      }, 350);
    },
    onDrop: (e: ReactDragEvent) => dropOn(e, where),
  });

  const submitText = async () => {
    const t = text.trim();
    const folderId = lastUsed();
    if (!t || !folderId) return;
    setStatus({ text: /x\.com|twitter\.com/i.test(t) ? 'Reading the post…' : 'Saving…', tone: 'busy' });
    const r = await saveText(t, folderId);
    if (!r) return setStatus({ text: foldersState().error ?? 'That could not be saved.', tone: 'err' });
    const name = foldersState().list?.folders.find((f) => f.id === folderId)?.name ?? 'your folder';
    setText('');
    setStatus({ text: `${r.said} · ${name}`, tone: 'ok' });
    notify('ok', `${r.said} to ${name}`);
  };

  const rect = btn.current?.getBoundingClientRect();
  const top = rect ? Math.max(8, Math.min(rect.top - 6, window.innerHeight - 360)) : 120;
  const chosen = lastUsed();

  let body: ReactNode;
  if (!s.owner) {
    body = (
      <div className="kq__gate">
        <p>Your knowledge folders belong to your wallet.</p>
        <button type="button" className="fx-cta" onClick={() => openConnectDialog()}>Connect wallet</button>
      </div>
    );
  } else if (!s.token) {
    body = (
      <div className="kq__gate">
        <p>Sign in once on this browser to save into your folders - a free signature, never a transaction.</p>
        <button type="button" className="fx-cta" disabled={s.signing} onClick={() => void signInToFolders()}>{s.signing ? 'Waiting for the wallet…' : 'Sign in with your wallet'}</button>
        {s.error && <p className="kq__err" role="alert">{s.error}</p>}
      </div>
    );
  } else if (!s.list) {
    body = <p className="fx-wait kq__wait"><span className="fx-spin" aria-hidden="true" />Loading your folders…</p>;
  } else {
    body = (
      <>
        <ul className="kq__folders">
          {folders.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className={`kq__folder${over === f.id ? ' is-over' : ''}${mode === 'type' && chosen === f.id ? ' is-on' : ''}`}
                disabled={full(f.items.length)}
                onClick={() => (pending ? void save(pending, f.id) : setTarget(f.id))}
                {...dragProps(f.id)}
              >
                <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><FOLDER_ICON /></svg>
                <span className="kq__name">{f.name}</span>
                <span className="kq__count">{full(f.items.length) ? 'Full' : f.items.length}</span>
              </button>
            </li>
          ))}
          {limits && folders.length < limits.folders && (
            <li>
              <button type="button" className={`kq__folder kq__folder--new${over === 'new' ? ' is-over' : ''}`} onClick={() => (pending ? void save(pending, 'new') : void createFolder('Inbox'))} {...dragProps('new')}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                <span className="kq__name">{folders.length ? 'New folder' : 'Make a folder (Inbox)'}</span>
              </button>
            </li>
          )}
        </ul>
        {pending && <p className="kq__pending">Waiting for a folder: <b>{describe(pending).slice(0, 80)}</b></p>}
        <form
          className="kq__type"
          onSubmit={(e) => {
            e.preventDefault();
            void submitText();
          }}
        >
          <textarea
            className="kq__input"
            rows={2}
            value={text}
            placeholder={chosen ? `A note, a link or a post on X → ${folders.find((f) => f.id === chosen)?.name}` : 'Make a folder first'}
            disabled={!chosen}
            autoFocus={mode === 'type'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submitText();
              }
            }}
          />
        </form>
      </>
    );
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`side__btn${current ? ' is-raised' : ''}${over === 'button' ? ' is-dropping' : ''}`}
        aria-label="Knowledge (drop things here to save them; right-click for a quick note)"
        title="Knowledge · drop anything here to save it · right-click for a quick note"
        aria-current={current ? 'page' : undefined}
        onClick={() => {
          close();
          onOpen();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (mode) close();
          else open('type');
        }}
        {...dragProps('button')}
      >
        <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {children}
        </svg>
      </button>
      {mode &&
        createPortal(
          <div ref={panel} className="kq" role="dialog" aria-label="Save to your knowledge folders" style={{ top, left: (rect?.right ?? 60) + 10 }} onDragOver={(e) => canKeep(Array.from(e.dataTransfer.types)) && e.preventDefault()} onDrop={(e) => e.preventDefault()}>
            <header className="kq__head">
              <b>Save to Knowledge</b>
              <button type="button" className="kq__open" onClick={() => { close(); openFolders(); }}>Open</button>
            </header>
            {body}
            {status && <p className={`kq__status is-${status.tone}`} role="status">{status.tone === 'busy' && <span className="fx-spin" aria-hidden="true" />}{status.text}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
