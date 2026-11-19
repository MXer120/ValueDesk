/**
 * The chosen language: kept in this browser, its catalogue fetched only when it is not English.
 * A catalogue that fails to load leaves the page in English and the choice as it was, so nothing
 * half-translates.
 *
 * IN PARTS (a build, phone pass 2026-11-18): every chunk of the app names the part of the catalogues its
 * own code writes (tools/i18n-parts.mjs), and only the parts of chunks that have run are fetched - a
 * German visitor on /trade reads the shell's and the trade page's text, not the 640 KB of every page.
 * A chunk that runs later (another page, a dialog) brings its part then. Should a part not be there
 * (a tab left open across a deploy), the whole catalogue is read instead, once. The dev server has no
 * chunks: it reads the whole catalogue, as before.
 */
import { useSyncExternalStore } from 'react';
import { LANGUAGES, READY } from './languages';
import { browserLang, pickLanguage } from './browserLang';
import type { Catalogue } from './match';

const KEY = 'vs.lang';
export const FALLBACK = 'en';

const SPLIT = typeof __VS_I18N_PARTS__ !== 'undefined' && __VS_I18N_PARTS__ === true;

let current = FALLBACK;
/** The language whose entries are being read: `current` once they are in, the next one while they load. */
let want = FALLBACK;
const listeners = new Set<() => void>();
const say = () => listeners.forEach((f) => f());

/** Test seam: how a catalogue file is read, and how the page is changed. */
export const i18nEnv = {
  fetchJson: async (url: string): Promise<Catalogue | null> => {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as Catalogue) : null;
  },
  apply: async (catalogue: Catalogue | null): Promise<void> => (await import('./dom')).applyCatalogue(catalogue),
  split: SPLIT,
};

/** The parts named by chunks that have run, in the order they ran. */
const named: string[] = [];
/** The shown language's entries so far, and which parts they came from. */
let entries: Record<string, string> = {};
const have = new Set<string>();
/** The whole catalogue is in: no part is needed any more. */
let whole = false;
/** Bumped by every change of language: a part that arrives for a language no longer wanted is dropped. */
let generation = 0;
let applyTimer: ReturnType<typeof setTimeout> | null = null;

const partUrl = (code: string, id: string) => `/i18n/${encodeURIComponent(code)}/${encodeURIComponent(id)}.json`;
const wholeUrl = (code: string) => `/i18n/${encodeURIComponent(code)}.json`;

/** The first of the browser's languages the app has, or null (browserLang.ts pickLanguage over the ready catalogues). */
export function browserLanguage(langs: readonly string[]): string | null {
  return pickLanguage(langs, READY);
}

/** The chosen language; a visitor who never chose reads the browser's own when the app has it (browserLang.ts). */
function stored(): string {
  try {
    const v = localStorage.getItem(KEY);
    if (!v) return browserLanguage(browserLang.languages()) ?? FALLBACK;
    return READY.has(v) ? v : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/** Whether the visitor picked a language (the menu), rather than reading the browser's. */
function chose(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return true;
  }
}

/** Several parts in the same moment (a page and its dialogs) change the page once. */
/** Settles once the apply scheduled last has put its entries on the page (i18nWait waits for it). */
let applied: Promise<void> = Promise.resolve();
function scheduleApply(gen: number): void {
  if (applyTimer) return;
  let done!: () => void;
  applied = new Promise<void>((r) => (done = r));
  applyTimer = setTimeout(() => {
    applyTimer = null;
    if (gen === generation && want !== FALLBACK) void i18nEnv.apply({ ...entries }).catch(() => undefined).then(done);
    else done();
  }, 30);
}

async function loadWhole(code: string, gen: number): Promise<boolean> {
  const c = await i18nEnv.fetchJson(wholeUrl(code)).catch(() => null);
  if (!c || gen !== generation) return false;
  entries = { ...c };
  whole = true;
  return true;
}

/** Read these parts of `code` into `entries`; any one missing reads the whole catalogue instead. */
/** Parts on their way, by id (i18nWait waits for a page's). */
const inFlight = new Map<string, Promise<unknown>>();
async function loadParts(code: string, ids: readonly string[], gen: number): Promise<boolean> {
  const wanted = ids.filter((id) => !have.has(id));
  if (whole || wanted.length === 0) return true;
  wanted.forEach((id) => have.add(id));
  const reads = wanted.map((id) => {
    const r = i18nEnv.fetchJson(partUrl(code, id)).catch(() => null);
    inFlight.set(id, r);
    void r.then(() => { if (inFlight.get(id) === r) inFlight.delete(id); });
    return r;
  });
  const got = await Promise.all(reads);
  if (gen !== generation) return false;
  if (got.some((c) => !c)) return loadWhole(code, gen);
  for (const c of got) Object.assign(entries, c);
  return true;
}

/**
 * Which parts belong to which page (assets/route-preload-*.js sets it: path segment -> part ids). App.tsx fetches
 * every other page's code once the first has loaded, so a visit to it is instant; their text is not needed until
 * then. A part that only other pages name waits in `held` until one of them opens (i18nRouteChanged). Without the
 * map (the script did not run) every part is read when named, as it would be anyway.
 */
const held = new Set<string>();
const pageParts = (): Record<string, readonly string[]> | null => {
  const w = (globalThis as { __vsI18nPages?: unknown }).__vsI18nPages;
  return w && typeof w === 'object' ? (w as Record<string, readonly string[]>) : null;
};
const segment = (): string => (globalThis.location?.pathname.split('/')[1] ?? '').toLowerCase();

/** Only other pages' code names this part: it can wait until one of them is opened. */
function otherPagesOnly(id: string): boolean {
  const map = pageParts();
  if (!map) return false;
  let some = false;
  for (const [seg, ids] of Object.entries(map)) {
    if (!ids.includes(id)) continue;
    if (seg === segment() || (seg === '' && segment() === 'trade') || (seg === 'trade' && segment() === '')) return false;
    some = true;
  }
  return some;
}

/**
 * The landing text in two files (assets/route-preload-*.js sets `__vsI18nShell` and `__vsI18nFirst` and preloads
 * both): the shell's parts, one file per language that every page shares, and the landing page's own parts, merged at
 * build time. Their parts count as in from the moment they are asked for, so no chunk asks for them again; a file that
 * cannot be read has its parts read one by one after all.
 */
let firstTried = false;
type TextFile = { f?: unknown; ids?: unknown };
const textFile = (v: unknown): { f: string; ids: string[] } | null => {
  const t = v as TextFile | null | undefined;
  return t && typeof t.f === 'string' && Array.isArray(t.ids) ? { f: t.f, ids: t.ids.filter((x): x is string => typeof x === 'string') } : null;
};
function loadFirst(gen: number): void {
  if (firstTried || !i18nEnv.split || want === FALLBACK || whole) return;
  const g = globalThis as { __vsI18nShell?: unknown; __vsI18nFirst?: unknown };
  const files = [textFile(g.__vsI18nShell), textFile(g.__vsI18nFirst)].filter((t): t is { f: string; ids: string[] } => t !== null);
  if (!files.length) return;
  firstTried = true;
  for (const t of files) loadFile(t, gen);
}
function loadFile(t: { f: string; ids: string[] }, gen: number): void {
  const ids = t.ids.filter((x) => !have.has(x));
  if (!ids.length) return;
  ids.forEach((id) => have.add(id));
  const code = want;
  void i18nEnv.fetchJson(partUrl(code, t.f)).catch(() => null).then((c) => {
    if (gen !== generation) return;
    if (c) {
      Object.assign(entries, c);
      scheduleApply(gen);
      return;
    }
    ids.forEach((id) => have.delete(id));
    const again = named.filter((id) => ids.includes(id) && !otherPagesOnly(id));
    if (again.length) void loadParts(code, again, gen).then((ok) => { if (ok) scheduleApply(gen); });
  });
}

/** A chunk has run and named its part. */
function onNamed(id: unknown): void {
  if (typeof id !== 'string' || named.includes(id)) return;
  named.push(id);
  if (want === FALLBACK || whole) return;
  loadFirst(generation);
  if (otherPagesOnly(id)) { held.add(id); return; }
  const gen = generation;
  void loadParts(want, [id], gen).then((ok) => { if (ok) scheduleApply(gen); });
}

/**
 * A link to a page was touched, hovered or focused (App.tsx usePagePrefetch, the same moment its code is fetched):
 * read the parts held for that page now, so it opens in the language and not in English for a moment.
 */
export function i18nWarmPath(pathname: string): void {
  const map = pageParts();
  if (want === FALLBACK || whole || held.size === 0 || !map) return;
  const seg = (pathname.split('/')[1] ?? '').toLowerCase();
  const ids = map[seg] ?? [];
  const now = [...held].filter((id) => ids.includes(id));
  if (!now.length) return;
  now.forEach((id) => held.delete(id));
  const gen = generation;
  void loadParts(want, now, gen).then((ok) => { if (ok) scheduleApply(gen); });
}

/** How long a navigation waits for its page's text before it opens anyway (in English where it is missing). */
export const I18N_WAIT_MS = 1500;

/**
 * Opening `pathname` (App.tsx, a tap or Back): its text, in a language read in parts. Starts reading the parts held
 * for that page and resolves once they are on the page - so it does not open in English for a round trip - or after
 * I18N_WAIT_MS at the latest, so a lost part never holds a page. Null when there is nothing to wait for (English,
 * the whole catalogue, or every part already in).
 */
export function i18nWait(pathname: string): Promise<void> | null {
  const map = pageParts();
  if (want === FALLBACK || whole || !map) return null;
  i18nWarmPath(pathname);
  const seg = (pathname.split('/')[1] ?? '').toLowerCase();
  const waits = (map[seg] ?? []).map((id) => inFlight.get(id)).filter((p): p is Promise<unknown> => !!p);
  if (!waits.length) return null;
  return Promise.race([
    Promise.all(waits).then(() => new Promise<void>((r) => setTimeout(r, 0))).then(() => applied),
    new Promise<void>((r) => setTimeout(r, I18N_WAIT_MS)),
  ]);
}

/** The page on screen changed (App.tsx): read the parts held for it. */
export function i18nRouteChanged(): void {
  if (want === FALLBACK || whole || held.size === 0) return;
  const now = [...held].filter((id) => !otherPagesOnly(id));
  if (!now.length) return;
  now.forEach((id) => held.delete(id));
  const gen = generation;
  void loadParts(want, now, gen).then((ok) => { if (ok) scheduleApply(gen); });
}

/** Take the names chunks left before this module was ready, and every one from now on. */
export function listenForParts(): void {
  const g = globalThis as { __vsI18n?: unknown };
  const early = Array.isArray(g.__vsI18n) ? (g.__vsI18n as unknown[]) : [];
  g.__vsI18n = { push: (...ids: unknown[]) => { ids.forEach(onNamed); return named.length; } };
  early.forEach(onNamed);
}

async function put(code: string): Promise<boolean> {
  /* The translating code is its own small chunk: an English visitor never downloads it. */
  const gen = ++generation;
  want = code;
  if (code === FALLBACK) {
    if (current !== FALLBACK) await i18nEnv.apply(null);
  } else {
    entries = {};
    have.clear();
    whole = false;
    held.clear();
    const now = named.filter((id) => { if (otherPagesOnly(id)) { held.add(id); return false; } return true; });
    const ok = i18nEnv.split && named.length > 0 ? await loadParts(code, now, gen) : !i18nEnv.split ? await loadWhole(code, gen) : true;
    if (!ok || gen !== generation) {
      if (gen === generation) {
        /* The language on the page stays, and so must its entries for the parts still to come. */
        want = current;
        entries = {};
        have.clear();
        whole = false;
        held.clear();
        const back = named.filter((id) => { if (otherPagesOnly(id)) { held.add(id); return false; } return true; });
        if (current !== FALLBACK) void (i18nEnv.split ? loadParts(current, back, gen) : loadWhole(current, gen)).then((ok2) => { if (ok2) scheduleApply(gen); });
      }
      return false;
    }
    /* In a build before any chunk has named its part (the entry names its own as it finishes): the
       language is chosen now, its text applied as the parts come in. */
    if (Object.keys(entries).length > 0 || !i18nEnv.split) await i18nEnv.apply({ ...entries });
  }
  current = code;
  document.documentElement.lang = code;
  say();
  return true;
}

/** Pick a language. Resolves false when its catalogue could not be read. */
export async function setLanguage(code: string): Promise<boolean> {
  if (code === current || !READY.has(code)) {
    /* The language the browser gave, picked in the menu: from now on it is the visitor's choice. */
    if (code === current && !chose()) remember(code);
    return code === current;
  }
  const ok = await put(code).catch(() => false);
  if (ok) remember(code);
  return ok;
}

function remember(code: string): void {
  try {
    localStorage.setItem(KEY, code);
  } catch {
    /* private mode: this page only */
  }
}

/** At start, before React renders: the stored language, if it is not English. */
export function bootLanguage(): void {
  if (i18nEnv.split) listenForParts();
  /* e2e/ui/themeAudit.ts --lang: the page stays English, and what the catalogue lacks is listed. */
  if (import.meta.env?.DEV && window.__vsI18nMissing) {
    const audit = localStorage.getItem('vs.lang.audit');
    if (audit) {
      void fetch(`/i18n/${audit}.json`).then((r) => r.json()).then(async (c: Catalogue) => (await import('./dom')).applyCatalogue(c, true));
      return;
    }
  }
  const code = stored();
  if (code !== FALLBACK) {
    /* Set before the first part arrives, so that part is read for this language. */
    current = code;
    want = code;
    document.documentElement.lang = code;
    const gen = ++generation;
    if (!i18nEnv.split) {
      void loadWhole(code, gen).then((ok) => { if (ok) void i18nEnv.apply({ ...entries }); else if (gen === generation) { current = want = FALLBACK; document.documentElement.lang = FALLBACK; } }).catch(() => {});
    } else {
      loadFirst(gen);
    }
    if (i18nEnv.split && named.length) {
      const now = named.filter((id) => { if (otherPagesOnly(id)) { held.add(id); return false; } return true; });
      void loadParts(code, now, gen).then((ok) => { if (ok) scheduleApply(gen); });
    }
  }
}

export const currentLanguage = (): string => current;
export const languageName = (code: string): string => LANGUAGES.find((l) => l.code === code)?.name ?? code;

export function useLanguage(): string {
  return useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f); }, currentLanguage);
}

/** Tests only: back to a fresh page. */
export function resetI18nForTest(): void {
  current = want = FALLBACK;
  named.length = 0;
  held.clear();
  firstTried = false;
  entries = {};
  have.clear();
  whole = false;
  generation++;
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = null;
}
