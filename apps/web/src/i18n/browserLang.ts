/**
 * The language a visitor who never chose one reads (phone pass, 2026-11-18): the first of the browser's own
 * languages that the app has, in the browser's order - so a Brazilian phone (pt-BR) opens in Portuguese and a
 * Moroccan one (ar-MA, fr-MA) in French, and a browser that lists English first stays English. It is not stored:
 * the language menu stays the visitor's explicit choice (store.ts).
 *
 * Matching: the exact code first (zh-TW), then the base language (pt-BR -> pt, fr-MA -> fr), with Chinese read by
 * its script or region (zh-Hant, zh-HK, zh-MO -> zh-TW; zh, zh-Hans, zh-SG -> zh-CN). The same rule runs in the
 * build's route-preload script (tools/route-preload.mjs), so the landing page's text is preloaded for it too.
 */

/** One browser language tag as one of `codes`, or null. */
export function matchLanguage(tag: string, codes: Iterable<string>): string | null {
  const have = new Map<string, string>();
  for (const c of codes) have.set(c.toLowerCase(), c);
  const t = String(tag ?? '').trim().replace(/_/g, '-').toLowerCase();
  if (!t) return null;
  const exact = have.get(t);
  if (exact) return exact;
  const [base, ...rest] = t.split('-');
  if (base === 'zh') {
    const traditional = rest.some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo');
    return have.get(traditional ? 'zh-tw' : 'zh-cn') ?? null;
  }
  return (base && have.get(base)) || null;
}

/** The first of the browser's languages (`prefs`, its order) the app has, or null when it has none of them. */
export function pickLanguage(prefs: readonly string[], codes: Iterable<string>): string | null {
  const list = [...codes];
  for (const tag of prefs) {
    const hit = matchLanguage(tag, list);
    if (hit) return hit;
  }
  return null;
}

/** Test seam: the browser's languages, most wanted first. */
export const browserLang = {
  languages: (): readonly string[] => {
    try {
      const n = globalThis.navigator;
      if (!n) return [];
      if (Array.isArray(n.languages) && n.languages.length) return n.languages;
      return n.language ? [n.language] : [];
    } catch {
      return [];
    }
  },
};
