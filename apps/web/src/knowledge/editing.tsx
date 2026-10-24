/**
 * What every editor on the Knowledge page shares (doc/, sheet/, board/,
 * tweets.tsx): the props it is given, saving as the user works (autosave.ts,
 * its state reported to the item's header), the bar shown when another tab
 * saved first, and an image attached to the item it is in.
 */
import { useEffect } from 'react';
import type { FolderItem, ItemSummary } from '@sign/folders/types.js';
import { foldersApi } from '../folders/api';
import { useAutosave, type SaveStatus } from '../folders/autosave';
import { change, foldersState, putSummary } from '../folders/state';

export interface EditorProps<T> {
  item: FolderItem;
  data: T;
  /** The most this item's content may be, bytes (the server's limit for its kind). */
  limitBytes: number;
  /** The save state, for the header. */
  onStatus: (status: SaveStatus, message: string | null) => void;
  /** Open another item of the wallet's (a card in a doc or on a board). */
  onOpenItem: (id: string) => void;
}

/** useAutosave, with its state handed to the header as it changes. */
export function useEditorSave<T>(item: FolderItem, read: () => T, limitBytes: number, onStatus: EditorProps<T>['onStatus']) {
  const a = useAutosave(item, read, limitBytes);
  useEffect(() => onStatus(a.status, a.message), [a.status, a.message, onStatus]);
  return a;
}

/** Another tab saved this item first: keep this version, or load that one. */
export function ConflictBar({ status, message, onKeep, onLoad }: { status: SaveStatus; message: string | null; onKeep: () => void; onLoad: () => void }) {
  if (status !== 'conflict' && status !== 'too-large' && status !== 'error') return null;
  return (
    <div className="kn-conflict" role="alert">
      <span>{status === 'conflict' ? 'This was changed in another tab or on another device.' : message}</span>
      {status === 'conflict' && (
        <>
          <button type="button" className="fx-cta fx-cta--ghost kn-conflict__btn" onClick={onLoad}>Load that version</button>
          <button type="button" className="fx-cta kn-conflict__btn" onClick={onKeep}>Keep mine</button>
        </>
      )}
    </div>
  );
}

/** An image into a doc or a board: an attachment of that item (not listed in the folder). */
export async function attachImage(parent: ItemSummary, file: File, onProgress?: (share: number) => void): Promise<ItemSummary | null> {
  const limits = foldersState().list?.limits;
  if (limits && file.size > limits.fileBytes) return null;
  return change((t) => foldersApi.upload(t, { folderId: parent.folderId, parentId: parent.id, file, name: file.name || 'image.png' }, onProgress));
}

/** The summary of an item the wallet keeps, by id (a card in a doc or on a board). */
export function findItem(id: string): ItemSummary | null {
  for (const f of foldersState().list?.folders ?? []) {
    const it = f.items.find((i) => i.id === id);
    if (it) return it;
  }
  return null;
}

export const isImageFile = (f: File): boolean => /^image\/(png|jpeg|webp|gif)$/.test(f.type);

/** The item's summary after a save of ours, into the list (the header's "Saved" and the tree's line). */
export const keepSummary = (it: ItemSummary): void => putSummary(it);
