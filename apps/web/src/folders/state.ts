/**
 * The knowledge folders' state in this tab: whose folders are shown (the
 * connected wallet), its token, the list as the server last answered it, and
 * what is selected on the Knowledge page. One store, read with useFolders()
 * from the page, the rail's quick drop and the save sheet alike.
 *
 * Every change goes to the server first and the list on screen is the server's
 * answer to it - so a limit the server refuses (a fourth folder, a full folder,
 * the storage quota) is shown as its own sentence and nothing changes here.
 */
import { useSyncExternalStore } from 'react';
import type { FoldersList, ItemSummary } from '@sign/folders/types.js';
import type { Eip1193Provider } from '../wallet';
import { openTab } from '../router';
import { FoldersApiError, foldersApi, forgetToken, heldToken, signIn } from './api';

/** What the Knowledge page shows when no item is open: a folder's items, or every saved post. */
export type FoldersView = 'folder' | 'posts';

export interface FoldersState {
  /** The connected wallet, lowercase; null without one. */
  owner: string | null;
  token: string | null;
  list: FoldersList | null;
  loading: boolean;
  /** A wallet signature is being asked for. */
  signing: boolean;
  error: string | null;
  folderId: string | null;
  itemId: string | null;
  view: FoldersView;
}

let state: FoldersState = { owner: null, token: null, list: null, loading: false, signing: false, error: null, folderId: null, itemId: null, view: 'folder' };
let provider: Eip1193Provider | null = null;
const subs = new Set<() => void>();

function set(patch: Partial<FoldersState>): void {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

export const foldersState = (): FoldersState => state;

export function useFolders(): FoldersState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
    () => state,
  );
}

/** The selection kept valid against a new list: the same folder and item when they still exist. */
function settle(list: FoldersList, prefer?: { folderId?: string | null; itemId?: string | null }): Partial<FoldersState> {
  const folderId = [prefer?.folderId, state.folderId].find((id) => id && list.folders.some((f) => f.id === id)) ?? list.folders[0]?.id ?? null;
  const items = list.folders.find((f) => f.id === folderId)?.items ?? [];
  const itemId = [prefer?.itemId, state.itemId].find((id) => id && items.some((i) => i.id === id)) ?? null;
  return { list, folderId, itemId, error: null };
}

/** App.tsx's wallet, handed over by FoldersHost on every change. */
export function bindWallet(address: string | null, p: Eip1193Provider | null): void {
  provider = p;
  const owner = address ? address.toLowerCase() : null;
  if (owner === state.owner) return;
  set({ owner, token: heldToken(owner), list: null, folderId: null, itemId: null, error: null });
}

/** The list, once: what the page, the quick drop and the save sheet call when they show. */
export function ensureList(): void {
  if (state.token && !state.list && !state.loading) void refresh();
}

/** The Knowledge page, on a folder or an item when given. */
export function openFolders(at?: { folderId?: string; itemId?: string | null; view?: FoldersView }): void {
  set({
    ...(at?.folderId ? { folderId: at.folderId } : {}),
    ...(at?.itemId !== undefined ? { itemId: at.itemId } : {}),
    ...(at?.view ? { view: at.view } : at?.itemId || at?.folderId ? { view: 'folder' as const } : {}),
  });
  openTab('knowledge');
  if (state.token && (!state.list || at)) void refresh();
}

export const selectFolder = (folderId: string): void => set({ folderId, itemId: null, view: 'folder' });
export const selectItem = (itemId: string | null): void => set({ itemId });
export const selectView = (view: FoldersView): void => set({ view, itemId: null });

/** Ask the wallet for its one signature, then load the folders. */
export async function signInToFolders(): Promise<boolean> {
  if (!state.owner) return false;
  if (!provider) {
    set({ error: 'Connect your wallet again to sign in to your folders.' });
    return false;
  }
  set({ signing: true, error: null });
  try {
    const token = await signIn(provider, state.owner);
    set({ token, signing: false });
    await refresh();
    return true;
  } catch (e) {
    set({ signing: false, error: messageOf(e, 'The wallet did not sign.') });
    return false;
  }
}

export function signOutOfFolders(): void {
  forgetToken(state.owner);
  set({ token: null, list: null, folderId: null, itemId: null });
}

export async function refresh(): Promise<void> {
  const t = state.token;
  if (!t) return;
  set({ loading: true });
  try {
    const list = await foldersApi.list(t);
    set({ ...settle(list), loading: false });
  } catch (e) {
    fail(e);
    set({ loading: false });
  }
}

/** A refusal or an error, shown in the view; a lapsed token sends the wallet back to sign-in. */
function fail(e: unknown): void {
  if (e instanceof FoldersApiError && e.status === 401) {
    forgetToken(state.owner);
    set({ token: null, list: null, error: 'Your sign-in to the folders ended. Sign in again.' });
    return;
  }
  set({ error: messageOf(e, 'That did not work. Try again.') });
}

function messageOf(e: unknown, fallback: string): string {
  if (e instanceof FoldersApiError) return e.message;
  const m = e instanceof Error ? e.message : '';
  return /reject|denied|cancel/i.test(m) ? 'You cancelled the signature.' : m || fallback;
}

export const clearError = (): void => set({ error: null });

/**
 * Run one change against the server with the wallet's token. Returns the
 * call's answer, or null when it was refused (the reason is in `error`).
 */
export async function change<T>(fn: (token: string) => Promise<T>, after?: (r: T) => Partial<FoldersState> | void): Promise<T | null> {
  const t = state.token;
  if (!t) {
    set({ error: 'Sign in to your folders first.' });
    return null;
  }
  try {
    const r = await fn(t);
    const patch = after?.(r);
    if (patch) set(patch);
    set({ error: null });
    return r;
  } catch (e) {
    fail(e);
    return null;
  }
}

/* -------------------------------------------------------------- changes ----- */

const withList = (prefer?: { folderId?: string | null; itemId?: string | null }) => (list: FoldersList) => settle(list, prefer);

export const createFolder = (name: string) =>
  change((t) => foldersApi.createFolder(t, name), (r) => settle(r, { folderId: r.folder.id, itemId: null }));
export const renameFolder = (id: string, name: string) => change((t) => foldersApi.renameFolder(t, id, name), withList());
export const deleteFolder = (id: string) => change((t) => foldersApi.deleteFolder(t, id), withList());
export const orderFolders = (ids: string[]) => change((t) => foldersApi.orderFolders(t, ids), withList());
export const moveItem = (id: string, folderId: string, index: number) => change((t) => foldersApi.moveItem(t, { id, folderId, index }), withList());
export const deleteItem = (id: string) => change((t) => foldersApi.deleteItem(t, id), withList({ itemId: state.itemId === id ? null : state.itemId }));

/** A new item's or a changed item's summary into the list on screen, without asking for the whole list again. */
export function putSummary(item: ItemSummary, select = false): void {
  const list = state.list;
  if (!list) return;
  const folders = list.folders.map((f) => {
    if (f.id !== item.folderId) return f;
    const at = f.items.findIndex((i) => i.id === item.id);
    const items = at >= 0 ? f.items.map((i) => (i.id === item.id ? item : i)) : [...f.items, item];
    return { ...f, items };
  });
  const before = list.folders.flatMap((f) => f.items).find((i) => i.id === item.id)?.bytes ?? 0;
  const added = list.folders.some((f) => f.items.some((i) => i.id === item.id)) ? 0 : 1;
  set({
    list: { ...list, folders, usage: { ...list.usage, bytes: list.usage.bytes - before + item.bytes, items: list.usage.items + added } },
    ...(select ? { folderId: item.folderId, itemId: item.id } : {}),
  });
}

export async function eraseEverything(): Promise<boolean> {
  const r = await change((t) => foldersApi.erase(t));
  if (!r) return false;
  forgetToken(state.owner);
  set({ token: null, list: null, folderId: null, itemId: null });
  return true;
}
