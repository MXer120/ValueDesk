/**
 * The chosen language: kept in this browser, its catalogue fetched only when it is not English.
 * A catalogue that fails to load leaves the page in English and the choice as it was, so nothing
 * half-translates.
 */
import { useSyncExternalStore } from 'react';
import { LANGUAGES, READY } from './languages';
import type { Catalogue } from './match';

const KEY = 'vs.lang';
export const FALLBACK = 'en';

let current = FALLBACK;
const listeners = new Set<() => void>();
const say = () => listeners.forEach((f) => f());

/**
 * The first of the browser's languages we have a catalogue for (2026-11-14): the page turns the browser's own
 * translation off (index.html, it broke React), so a visitor who read us through it starts in their language
 * here instead. 'pt-BR' is 'pt'; Chinese goes by script or region (Hant, TW, HK, MO = Traditional).
 */
export function browserLanguage(langs: readonly string[]): string | null {
  for (const raw of langs) {
    const tag = raw.trim();
    if (!tag) continue;
    if (READY.has(tag)) return tag;
    const [primary, ...rest] = tag.toLowerCase().split('-');
    if (primary === 'zh') {
      const traditional = rest.some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo');
      const code = traditional ? 'zh-TW' : 'zh-CN';
      if (READY.has(code)) return code;
      continue;
    }
    if (primary && READY.has(primary)) return primary;
  }
  return null;
}

function stored(): string {
  try {
    const v = localStorage.getItem(KEY);
    if (v) return READY.has(v) ? v : FALLBACK;
  } catch {
    return FALLBACK;
  }
  /* Nothing picked here yet: the browser's language, not kept, so a later change of it is followed. */
  try {
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
    return browserLanguage(langs) ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
}

async function put(code: string): Promise<boolean> {
  /* The translating code is its own small chunk: an English visitor never downloads it. */
  if (code === FALLBACK) {
    if (current !== FALLBACK) (await import('./dom')).applyCatalogue(null);
  } else {
    const res = await fetch(`/i18n/${encodeURIComponent(code)}.json`);
    if (!res.ok) return false;
    const catalogue = (await res.json()) as Catalogue;
    (await import('./dom')).applyCatalogue(catalogue);
  }
  current = code;
  document.documentElement.lang = code;
  say();
  return true;
}

/** Pick a language. Resolves false when its catalogue could not be read. */
export async function setLanguage(code: string): Promise<boolean> {
  if (code === current || !READY.has(code)) return code === current;
  const ok = await put(code).catch(() => false);
  if (ok) {
    try {
      localStorage.setItem(KEY, code);
    } catch {
      /* private mode: this page only */
    }
  }
  return ok;
}

/** At start, before React renders: the stored language, if it is not English. */
export function bootLanguage(): void {
  /* e2e/ui/themeAudit.ts --lang: the page stays English, and what the catalogue lacks is listed. */
  if (import.meta.env?.DEV && window.__vsI18nMissing) {
    const audit = localStorage.getItem('vs.lang.audit');
    if (audit) {
      void fetch(`/i18n/${audit}.json`).then((r) => r.json()).then(async (c: Catalogue) => (await import('./dom')).applyCatalogue(c, true));
      return;
    }
  }
  const code = stored();
  if (code !== FALLBACK) void put(code).catch(() => {});
}

export const currentLanguage = (): string => current;
export const languageName = (code: string): string => LANGUAGES.find((l) => l.code === code)?.name ?? code;

export function useLanguage(): string {
  return useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f); }, currentLanguage);
}
