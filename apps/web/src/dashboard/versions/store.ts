/**
 * Versions of the trade page and of its layout editor, for the owner to choose between on localhost (2026-11-26:
 * "localhost only with multiple versions and the switch ... Do not delete the original keep it in the switch").
 *
 * A DEV-only choice kept in this browser (VersionSwitch.tsx). A build always answers 'original': nothing here can
 * reach a visitor, and every version's styles and code load only in DEV (devVersions.ts).
 *
 * Every version draws the same panels from the same saved layouts (storage.ts) and places orders through the same
 * ticket (OrderEntry.tsx): what a version changes is how the page looks and flows, never what is signed or sent.
 */
import { useSyncExternalStore } from 'react';

export type PageVersion = 'original' | 'deck' | 'pulse';
export type EditorVersion = 'original' | 'dock';

export const PAGE_VERSIONS: ReadonlyArray<{ id: PageVersion; name: string; line: string }> = [
  { id: 'original', name: 'Original', line: 'Today\'s trade page' },
  { id: 'deck', name: 'Deck', line: 'The cards: the ticket down the whole left column, each field named over its value; phone: book and ticket side by side' },
  { id: 'pulse', name: 'Pulse', line: 'The focus: the chart on the page, ticket and book in one rail card; phone: sticky Long / Short' },
];

export const EDITOR_VERSIONS: ReadonlyArray<{ id: EditorVersion; name: string; line: string }> = [
  { id: 'original', name: 'Original', line: 'Today\'s editor' },
  { id: 'dock', name: 'Dock', line: 'Edit in place at full size, one dock at the bottom' },
];

const DEV = import.meta.env.DEV;
const PAGE_KEY = 'vs.dev.trade.page';
const EDITOR_KEY = 'vs.dev.trade.editor';

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
 * A browser that never chose opens in the version a DEV server was started with (VITE_DEV_TRADE_PAGE /
 * VITE_DEV_TRADE_EDITOR): how the UI specs (e2e/ui), whose every browser starts empty, run against a version.
 */
function started<T extends string>(v: string | undefined, ok: ReadonlyArray<{ id: T }>): T | null {
  return DEV && ok.some((o) => o.id === v) ? (v as T) : null;
}

let page: PageVersion = read(PAGE_KEY, PAGE_VERSIONS, started(import.meta.env.VITE_DEV_TRADE_PAGE, PAGE_VERSIONS) ?? 'original');
let editor: EditorVersion = read(EDITOR_KEY, EDITOR_VERSIONS, started(import.meta.env.VITE_DEV_TRADE_EDITOR, EDITOR_VERSIONS) ?? 'original');
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

export function setEditorVersion(v: EditorVersion): void {
  if (!DEV || v === editor) return;
  editor = v;
  try { localStorage.setItem(EDITOR_KEY, v); } catch { /* this tab only */ }
  emit();
}

export const pageVersion = (): PageVersion => page;
export const editorVersion = (): EditorVersion => editor;

export function usePageVersion(): PageVersion {
  return useSyncExternalStore(subscribe, pageVersion, () => 'original' as const);
}

export function useEditorVersion(): EditorVersion {
  return useSyncExternalStore(subscribe, editorVersion, () => 'original' as const);
}
