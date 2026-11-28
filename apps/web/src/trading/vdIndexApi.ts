/**
 * Published indexes from the server (apps/server/src/routes/vdIndexes.ts, rules in @sign/indexes/claim): everyone's to
 * read, a wallet's own to publish, update or take down with one free signature (EIP-712, never a transaction). One
 * shared list per page load, so the board, the browse page and an index page agree and ask the server once.
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  INDEX_ACTION_TTL_MS, INDEX_PUBLISH_STATEMENT, INDEX_UNPUBLISH_STATEMENT, indexProblem, indexProblemText, indexTypedData, legsText,
  tidyDescription, tidyName, type IndexAction, type PublishedIndex,
} from '@sign/indexes/claim';
import { getChainId, signTypedData, type Eip1193Provider } from '../wallet';
import { bpFromLegs, legsFromBp, type VdIndex } from './vdIndexes';
import { base64, type Picture } from './indexPicture';

const TIMEOUT_MS = 15_000;

/**
 * Publishing is built but hidden (owner 2026-11-28: "Make it possible to just create an index, later publish it. Hide
 * that feature for now"). Off: no publish or take-down anywhere, no published list read, nothing about publishing in
 * the text; an index is made and kept in this browser. The server routes stay as they are. Turn on here.
 */
export const INDEX_PUBLISHING = false;

export class IndexApiError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  const body = (await r.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!r.ok || body.ok === false) throw new IndexApiError(body.error || `The index service answered ${r.status}.`, r.status);
  return body;
}

export const fromPublished = (p: PublishedIndex): VdIndex => ({
  id: p.id, name: p.name, line: p.description, legs: legsFromBp(p.legs), kind: 'published',
  owner: p.owner.toLowerCase(), ownerName: p.ownerName, createdAt: p.createdAt, updatedAt: p.updatedAt, image: p.image ?? null,
});

// --- the shared list --------------------------------------------------------------------------------

interface ListState { list: VdIndex[] | null; error: string | null; at: number }
let state: ListState = { list: null, error: null, at: 0 };
let asking: Promise<void> | null = null;
const subs = new Set<() => void>();
const set = (s: Partial<ListState>) => { state = { ...state, ...s }; for (const f of [...subs]) f(); };

/** Read the published list again (after a publish, or a minute on). */
export function refreshPublished(force = false): Promise<void> {
  if (asking) return asking;
  if (!force && state.list && Date.now() - state.at < 60_000) return Promise.resolve();
  asking = json<{ indexes: PublishedIndex[] }>('/api/vs/indexes?limit=200')
    .then((b) => set({ list: (b.indexes ?? []).map(fromPublished), error: null, at: Date.now() }))
    .catch((e: Error) => set({ error: e.message, at: Date.now() }))
    .finally(() => { asking = null; });
  return asking;
}

/** Every published index, newest first; null until read. */
export function usePublished(): { list: VdIndex[] | null; error: string | null } {
  const s = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state, () => state);
  useEffect(() => { if (INDEX_PUBLISHING) void refreshPublished(); }, []);
  return INDEX_PUBLISHING ? { list: s.list, error: s.error } : { list: [], error: null };
}

/** One published index (from the shared list when it is there). */
export async function readPublished(id: string): Promise<VdIndex | null> {
  const hit = state.list?.find((x) => x.id === id);
  if (hit) return hit;
  try {
    const b = await json<{ index: PublishedIndex }>(`/api/vs/indexes/${encodeURIComponent(id)}`);
    return b.index ? fromPublished(b.index) : null;
  } catch (e) {
    if ((e as IndexApiError).status === 404) return null;
    throw e;
  }
}

// --- publishing -------------------------------------------------------------------------------------

const nonce = (): string => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

/** The page's form of an index made ready to sign: tidied text, whole basis points. Throws the rules' words. */
export function publishable(ix: Pick<VdIndex, 'name' | 'line' | 'legs'>): { name: string; description: string; legs: Array<{ fundId: string; bp: number }> } {
  const out = { name: tidyName(ix.name), description: tidyDescription(ix.line), legs: bpFromLegs(ix.legs) };
  const p = indexProblem(out);
  if (p) throw new IndexApiError(indexProblemText(p));
  return out;
}

async function signed(provider: Eip1193Provider, address: string, id: string, ix: Pick<VdIndex, 'name' | 'line' | 'legs'>, statement: string, image: string): Promise<IndexAction> {
  const chainId = await getChainId(provider).catch(() => 1);
  const t = Date.now();
  const body = statement === INDEX_PUBLISH_STATEMENT ? publishable(ix) : { name: ix.name, description: ix.line, legs: bpFromLegs(ix.legs) };
  const fields: Omit<IndexAction, 'signature'> = {
    owner: address.toLowerCase(), id, name: body.name, description: body.description, legs: legsText(body.legs), image,
    statement, nonce: nonce(), issuedAt: String(t), expiresAt: String(t + INDEX_ACTION_TTL_MS - 30_000), chainId,
  };
  const signature = await signTypedData(provider, address, indexTypedData(fields));
  return { ...fields, signature };
}

/**
 * Publish a new index ('' id) or update one of the wallet's own: one free signature. `picture`: the picture made by
 * indexPicture.ts (its hash is signed, its bytes go along), the hash alone to keep the one it has, or null for none.
 */
export async function publishIndex(provider: Eip1193Provider, address: string, id: string, ix: Pick<VdIndex, 'name' | 'line' | 'legs'>, picture: Picture | { hash: string } | null = null): Promise<VdIndex> {
  const action = await signed(provider, address, id, ix, INDEX_PUBLISH_STATEMENT, picture?.hash ?? '');
  const bytes = picture && 'bytes' in picture ? base64(picture.bytes) : undefined;
  const b = await json<{ index: PublishedIndex }>('/api/vs/indexes/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bytes ? { action, image: bytes } : { action }) });
  const out = fromPublished(b.index);
  set({ list: [out, ...(state.list ?? []).filter((x) => x.id !== out.id)] });
  void refreshPublished(true);
  return out;
}

/** Take one of the wallet's published indexes down: one free signature. Nothing is deleted on the server. */
export async function unpublishIndex(provider: Eip1193Provider, address: string, ix: VdIndex): Promise<void> {
  const action = await signed(provider, address, ix.id, ix, INDEX_UNPUBLISH_STATEMENT, ix.image ?? '');
  await json<{ ok: boolean }>('/api/vs/indexes/unpublish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
  set({ list: (state.list ?? []).filter((x) => x.id !== ix.id) });
  void refreshPublished(true);
}
