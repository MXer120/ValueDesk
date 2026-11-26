/**
 * Versions of the trade page, for the owner to choose between on localhost (2026-11-26: "localhost only with multiple
 * versions and the switch ... Do not delete the original keep it in the switch"). The layout editor's versions were
 * removed on the owner's word (2026-11-26: "completely remove 2 & 3 & 4 editor versions"): the editor is the original.
 *
 * A DEV-only choice kept in this browser (VersionSwitch.tsx). A build always answers 'original': nothing here can
 * reach a visitor, and every version's styles and code load only in DEV (devVersions.ts).
 *
 * Every version draws the same panels from the same saved layouts (storage.ts) and places orders through the same
 * ticket (OrderEntry.tsx): what a version changes is how the page looks and flows, never what is signed or sent.
 */
import { useSyncExternalStore } from 'react';

export type PageVersion = 'original' | 'slate' | 'deck' | 'pulse';

export const PAGE_VERSIONS: ReadonlyArray<{ id: PageVersion; name: string; line: string }> = [
  { id: 'original', name: 'Original', line: 'Today\'s trade page' },
  { id: 'slate', name: 'Slate', line: 'The terminal: black and square, monospaced figures, the book a tall ladder' },
  { id: 'deck', name: 'Deck', line: 'The cards: ticket first, big figures, cards 12px apart; phone: book and ticket side by side' },
  { id: 'pulse', name: 'Pulse', line: 'The focus: the chart takes the page, ticket and book in a rail; phone: sticky Long / Short' },
];

const DEV = import.meta.env.DEV;
const PAGE_KEY = 'vs.dev.trade.page';

function read<T extends string>(key: string, ok: ReadonlyArray<{ id: T }>, fallback: T): T {
  if (!DEV) return fallback;
  try {
    const v = localStorage.getItem(key);
    return ok.some((o) => o.id === v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A browser that never chose opens in the version a DEV server was started with (VITE_DEV_TRADE_PAGE): how the UI
 * specs (e2e/ui), whose every browser starts empty, run against a version.
 */
function started<T extends string>(v: string | undefined, ok: ReadonlyArray<{ id: T }>): T | null {
  return DEV && ok.some((o) => o.id === v) ? (v as T) : null;
}

let page: PageVersion = read(PAGE_KEY, PAGE_VERSIONS, started(import.meta.env.VITE_DEV_TRADE_PAGE, PAGE_VERSIONS) ?? 'original');
const subs = new Set<() => void>();
const emit = () => { for (const f of [...subs]) f(); };
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => { subs.delete(f); };
};

export function setPageVersion(v: PageVersion): void {
  if (!DEV || v === page) return;
  page = v;
  try { localStorage.setItem(PAGE_KEY, v); } catch { /* this tab only */ }
  emit();
}

export const pageVersion = (): PageVersion => page;

export function usePageVersion(): PageVersion {
  return useSyncExternalStore(subscribe, pageVersion, () => 'original' as const);
}
