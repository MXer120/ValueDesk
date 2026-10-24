/**
 * Saving a note or a table as it is edited: a short pause after the last
 * change, one save at a time, each naming the revision it was based on - so a
 * change made in another tab is never overwritten unseen (the server answers
 * 409 and the editor offers to load that version or keep this one).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FolderItem } from '@sign/folders/types.js';
import { FoldersApiError, foldersApi } from './api';
import { foldersState, putSummary } from './state';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'too-large';

const PAUSE_MS = 900;

export function useAutosave<T>(item: FolderItem, read: () => T, limitBytes: number) {
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [message, setMessage] = useState<string | null>(null);
  const rev = useRef(item.rev);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const dirty = useRef(false);
  const force = useRef(false);

  const save = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    chain.current = chain.current.then(async () => {
      if (!dirty.current) return;
      const token = foldersState().token;
      if (!token) return;
      const data = read();
      if (new Blob([JSON.stringify(data)]).size > limitBytes) {
        setStatus('too-large');
        setMessage(`This is over the ${Math.round(limitBytes / 1024)} KB a ${item.kind} can hold; it is not saved until it is shorter.`);
        return;
      }
      dirty.current = false;
      setStatus('saving');
      try {
        const r = await foldersApi.updateItem(token, { id: item.id, data, ...(force.current ? {} : { rev: rev.current }) });
        force.current = false;
        rev.current = r.rev;
        putSummary(r);
        setMessage(null);
        setStatus(dirty.current ? 'dirty' : 'saved');
      } catch (e) {
        dirty.current = true;
        if (e instanceof FoldersApiError && e.code === 'conflict') setStatus('conflict');
        else setStatus('error');
        setMessage(e instanceof Error ? e.message : 'Not saved.');
      }
    });
    return chain.current;
  }, [item.id, item.kind, limitBytes, read]);

  /** Call on every edit. */
  const touched = useCallback(() => {
    dirty.current = true;
    setStatus((s) => (s === 'conflict' ? s : 'dirty'));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), PAUSE_MS);
  }, [save]);

  /** After a conflict: save this version over the other. */
  const keepMine = useCallback(() => {
    force.current = true;
    dirty.current = true;
    void save();
  }, [save]);

  /** After a conflict: the version on the server, with its revision. */
  const loadTheirs = useCallback(async (): Promise<FolderItem | null> => {
    const token = foldersState().token;
    if (!token) return null;
    const fresh = await foldersApi.item(token, item.id).catch(() => null);
    if (!fresh) return null;
    rev.current = fresh.rev;
    dirty.current = false;
    setStatus('saved');
    setMessage(null);
    return fresh;
  }, [item.id]);

  // Leaving the item (or closing the folders) saves what is pending.
  useEffect(
    () => () => {
      if (dirty.current) void save();
    },
    [save],
  );

  return { status, message, touched, save, keepMine, loadTheirs };
}

export const STATUS_LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  dirty: 'Editing…',
  saving: 'Saving…',
  error: 'Not saved',
  conflict: 'Changed elsewhere',
  'too-large': 'Too long to save',
};
