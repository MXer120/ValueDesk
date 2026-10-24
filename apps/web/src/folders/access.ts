/**
 * Whether Knowledge (the knowledge folders: the page, the rail's quick drop,
 * "Save to folder" in the chart and News) is on in this browser.
 *
 * OFF BY DEFAULT, for everyone (the owner, 2026-10-24: "do not load per
 * default ... fully disabled, only through the dev panel I want to be able to
 * activate it"). The Dev panel's switch turns it on in this browser, and even
 * then only while the owner's wallet is connected. Off, nothing of it shows and
 * none of its code is fetched (App.tsx keeps the page out of the prefetch).
 *
 * The server holds the same rule for real (apps/server/src/folders/limits.ts
 * FOLDERS_OWNER, FOLDERS_WALLETS): another wallet cannot sign in to the folders
 * whatever this browser shows.
 */
import { useSyncExternalStore } from 'react';

export const KNOWLEDGE_OWNER = '0x04fb8f9d0d8cd5495aa47e81ca9804cdf32a277d';
const KEY = 'vd.knowledge';
const EVENT = 'vd-knowledge';

/** The Dev panel's switch, in this browser. */
export function knowledgeSwitch(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setKnowledgeSwitch(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* private window: stays off */
  }
  window.dispatchEvent(new Event(EVENT));
}

export const isKnowledgeOwner = (address: string | null | undefined): boolean => !!address && address.toLowerCase() === KNOWLEDGE_OWNER;

/** On: the switch is on and the owner's wallet is the one connected. */
export const knowledgeOn = (address: string | null | undefined): boolean => knowledgeSwitch() && isKnowledgeOwner(address);

/**
 * The same at boot, before React: the wallet App.tsx remembers (`ot.address`),
 * so a reload on /knowledge fetches the page's code only when it will show.
 */
export function knowledgeOnAtBoot(): boolean {
  try {
    const raw = localStorage.getItem('ot.address');
    return knowledgeOn(raw ? (JSON.parse(raw) as string | null) : null);
  } catch {
    return false;
  }
}

const subscribe = (f: () => void) => {
  window.addEventListener(EVENT, f);
  window.addEventListener('storage', f);
  return () => {
    window.removeEventListener(EVENT, f);
    window.removeEventListener('storage', f);
  };
};

export function useKnowledgeSwitch(): boolean {
  return useSyncExternalStore(subscribe, knowledgeSwitch, () => false);
}

export function useKnowledge(address: string | null): boolean {
  return useKnowledgeSwitch() && isKnowledgeOwner(address);
}
