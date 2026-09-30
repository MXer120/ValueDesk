/**
 * Saved withdrawal addresses - "contacts" the user names.
 *
 * Kept in this browser only (localStorage), never sent anywhere, and shared by
 * every wallet connected here: a friend's address is the same whoever sends to
 * it. An EVM address is one contact on every EVM chain (and ValueChain); every
 * other address is its own kind (trading/addresses.ts). Other tabs see changes
 * through the storage event.
 *
 * A contact's LOOK - the platform or coin its logo shows, and the chain its
 * small badge shows - is worked out from its name and address
 * (addrbook/detect.ts); what the user picks by hand is stored here and wins.
 */
import { useSyncExternalStore } from 'react';
import { ADDRESS_KIND_LABEL, addressKinds, addressProblem, type AddressKind } from '../../trading/addresses';

export type ContactKind = AddressKind;

/** The user's own choice for a contact's logo and chain badge: undefined = work it out, null = none. */
export interface ContactLook {
  /** An exchange / wallet / protocol id (addrbook catalog). */
  platform?: string | null;
  /** A coin ticker, the logo when there is no platform. */
  coin?: string | null;
  /** A chain id (addrbook catalog): the badge. */
  chain?: string | null;
}

export interface Contact {
  id: string;
  name: string;
  address: string;
  kind: ContactKind;
  addedAt: number;
  /** Starred: listed first in the address book. */
  favorite?: boolean;
  /** Last picked or sent to. */
  usedAt?: number;
  /**
   * Where it sits in "Recent": set when added or used, null once the user
   * cleared it from Recent (it stays saved). Missing on contacts saved before
   * this existed - those read usedAt, then addedAt.
   */
  recentAt?: number | null;
  /** Logo and chain the user picked (see ContactLook). */
  look?: ContactLook;
  /** XRP / Stellar: the memo (destination tag) the receiving exchange credits by. */
  memo?: string;
}

const KEY = 'vs.contacts.v1';
const listeners = new Set<() => void>();
let cached: Contact[] | null = null;
const EMPTY: Contact[] = [];

const isContact = (c: unknown): c is Contact => {
  const x = c as Contact;
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.address === 'string' && x.kind in ADDRESS_KIND_LABEL;
};

function read(): Contact[] {
  if (cached) return cached;
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    cached = Array.isArray(list) ? list.filter(isContact) : EMPTY;
  } catch {
    cached = EMPTY;
  }
  return cached;
}

function write(list: Contact[]): void {
  cached = list;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode: kept for this page only */
  }
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    cached = null;
    for (const l of listeners) l();
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Every saved contact, newest first. */
export function useContacts(): Contact[] {
  return useSyncExternalStore(subscribe, read, read);
}

/** What kind of (valid) address this is, or null. A legacy "3…" is Bitcoin first (Litecoin used the same form). */
export function addressKind(addr: string): ContactKind | null {
  return addressKinds(addr)[0] ?? null;
}

/** Hex and bech32 addresses compare case-insensitively; base58/base64 ones are case-sensitive. */
export const sameAddress = (a: string, b: string): boolean => {
  const x = a.trim();
  const y = b.trim();
  const caseless = /^0x[0-9a-f]+$/i.test(x) || /^(bc1|ltc1|addr1)/i.test(x);
  return caseless ? x.toLowerCase() === y.toLowerCase() : x === y;
};

export function contactFor(address: string): Contact | undefined {
  const a = address.trim();
  return a ? read().find((c) => sameAddress(c.address, a)) : undefined;
}

/** Why this cannot be saved, or null. */
export function contactProblem(name: string, address: string): string | null {
  if (!name.trim()) return 'Give the contact a name.';
  if (name.trim().length > 40) return 'Keep the name under 40 characters.';
  const a = address.trim();
  if (!a) return 'Enter the address.';
  if (addressKind(a)) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return addressProblem('evm', a) === 'zero' ? 'That is the zero address.' : 'This address fails its checksum - it was probably mistyped.';
  return 'Enter a valid address (EVM, Solana, Bitcoin, Tron, XRP, TON, …).';
}

/** Save (or rename, when the address is already saved), with its look and memo if given. */
export function saveContact(name: string, address: string, extra: { look?: ContactLook; memo?: string } = {}): Contact {
  const look = extra.look;
  const memo = extra.memo?.trim() || undefined;
  const bad = contactProblem(name, address);
  if (bad) throw new RangeError(bad);
  const list = read();
  const existing = list.find((c) => sameAddress(c.address, address));
  if (existing) {
    const updated = { ...existing, name: name.trim(), ...(look ? { look } : {}), ...(extra.memo !== undefined ? { memo } : {}) };
    write(list.map((c) => (c.id === existing.id ? updated : c)));
    return updated;
  }
  const now = Date.now();
  const c: Contact = {
    id: `c${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim(),
    address: address.trim(),
    kind: addressKind(address)!,
    addedAt: now,
    recentAt: now,
    ...(look ? { look } : {}),
    ...(memo ? { memo } : {}),
  };
  write([c, ...list]);
  return c;
}

export function renameContact(id: string, name: string): void {
  if (!name.trim()) throw new RangeError('Give the contact a name.');
  write(read().map((c) => (c.id === id ? { ...c, name: name.trim() } : c)));
}

/** Edit a saved contact: its name, the logo / chain picked for it, its memo. */
export function updateContact(id: string, patch: { name?: string; look?: ContactLook; memo?: string }): void {
  if (patch.name !== undefined && !patch.name.trim()) throw new RangeError('Give the contact a name.');
  write(read().map((c) => (c.id === id ? {
    ...c,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.look !== undefined ? { look: patch.look } : {}),
    ...(patch.memo !== undefined ? { memo: patch.memo.trim() || undefined } : {}),
  } : c)));
}

export function toggleFavorite(id: string): void {
  write(read().map((c) => (c.id === id ? { ...c, favorite: !c.favorite } : c)));
}

/** The contact at this address (if any) was just used: it moves up in "Recent". */
export function markUsed(address: string): void {
  const hit = contactFor(address);
  if (!hit) return;
  const now = Date.now();
  write(read().map((c) => (c.id === hit.id ? { ...c, usedAt: now, recentAt: now } : c)));
}

/** When it was last added or used, or null when cleared from Recent. */
export const recentOf = (c: Contact): number | null => (c.recentAt === undefined ? c.usedAt ?? c.addedAt : c.recentAt);

/** Take these contacts out of "Recent" (they stay saved, and return when used again). */
export function clearRecent(ids: readonly string[]): void {
  const drop = new Set(ids);
  write(read().map((c) => (drop.has(c.id) ? { ...c, recentAt: null } : c)));
}

/** "Recent": most recent first, favourites (listed above it) and cleared ones left out. */
export function recentContacts(list: readonly Contact[], limit = 10): Contact[] {
  return list
    .filter((c) => !c.favorite && recentOf(c) !== null)
    .sort((a, b) => recentOf(b)! - recentOf(a)!)
    .slice(0, limit);
}

/** A-Z, one group per first letter that has contacts ("#" for names not starting with a letter). */
export function groupByLetter(list: readonly Contact[]): Array<{ letter: string; contacts: Contact[] }> {
  const groups = new Map<string, Contact[]>();
  for (const c of sortContacts(list, 'name')) {
    const first = c.name.trim().charAt(0).toLocaleUpperCase();
    const letter = /\p{L}/u.test(first) ? first : '#';
    groups.set(letter, [...(groups.get(letter) ?? []), c]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)))
    .map(([letter, contacts]) => ({ letter, contacts }));
}

export type ContactSort = 'recent' | 'name';

/** Most recently used (or added) first, or A-Z by name. */
export function sortContacts(list: readonly Contact[], by: ContactSort): Contact[] {
  return by === 'name'
    ? [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    : [...list].sort((a, b) => (recentOf(b) ?? 0) - (recentOf(a) ?? 0));
}

export function removeContact(id: string): void {
  write(read().filter((c) => c.id !== id));
}

/** For tests. */
export const _resetContacts = (): void => {
  cached = null;
};
