/**
 * The legal texts as data: Impressum, privacy policy, terms of use.
 *
 * DATA, NOT MARKUP, so that a build can read every word without a browser and
 * refuse to ship a draft (`legalPlaceholders`, `assertLegalPagesComplete`,
 * tools/check-legal.ts). LegalPage.tsx renders it.
 *
 * FOR THE OWNER, filling the drafts in (impressum.ts, privacy.ts, terms.ts):
 *   - Everything still to decide or fill in is marked `[[OWNER: what goes here]]`.
 *     Replace the whole marker, brackets included. Delete a section that does
 *     not apply rather than leaving its marker.
 *   - While any marker is left on a page, that page says "Draft - not yet
 *     legally reviewed", and a production build fails (tools/check-legal.ts).
 *   - Inline text understands three things only:
 *       [label](href)   a link: /impressum, /privacy, /terms stay in the app;
 *                       https://... and mailto:... open as normal links
 *       **text**        emphasis
 *       [[OWNER: ...]]  a placeholder (shown highlighted while it is there)
 */
import { LEGAL_PAGES, type LegalPage } from '../router';

export type Block =
  /** A paragraph. */
  | { p: string }
  /** A bulleted list. */
  | { ul: string[] }
  /** Lines with no bullets and no gap between them - an address. */
  | { lines: string[] };

export interface LegalSection {
  title: string;
  /** Only where it differs from the document's (the German summary of the privacy policy). */
  lang?: 'de' | 'en';
  blocks: Block[];
}

export interface LegalDoc {
  page: LegalPage;
  title: string;
  lang: 'de' | 'en';
  /** "Last updated" / "Stand". */
  updated: string;
  /** Before the first heading. */
  intro?: Block[];
  sections: LegalSection[];
}

/** Every placeholder; tolerant of spacing and case, and of a marker someone half-edited (no closing brackets). */
const MARKER = /\[\[\s*OWNER\b[\s\S]*?(?:\]\]|$)/gi;
/** The marker as the renderer splits it out of a line. */
export const MARKER_INLINE = /\[\[\s*OWNER\b[\s\S]*?\]\]/i;

/** The placeholders left in any value (a string, a block, a whole document). */
export function placeholdersIn(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(MARKER)) out.push(m[0]);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return out;
}

/** A page is a draft while it holds a placeholder. */
export const isDraft = (doc: LegalDoc): boolean => placeholdersIn(doc).length > 0;

export interface LeftPlaceholder {
  page: LegalPage;
  /** The section's title, or "intro" / "updated". */
  where: string;
  marker: string;
}

/** Every placeholder left in the given documents, with where it sits. */
export function placeholdersOf(docs: Record<LegalPage, LegalDoc>): LeftPlaceholder[] {
  const out: LeftPlaceholder[] = [];
  for (const page of LEGAL_PAGES) {
    const d = docs[page];
    const add = (where: string, v: unknown) => {
      for (const marker of placeholdersIn(v)) out.push({ page, where, marker });
    };
    add('title', d.title);
    add('intro', d.intro ?? []);
    for (const s of d.sections) add(s.title.replace(MARKER, '').trim() || 'untitled section', s);
    add('updated', d.updated);
  }
  return out;
}

/** The error a build fails with: one line per placeholder. Empty string when there is none. */
export function placeholderReport(left: LeftPlaceholder[]): string {
  if (!left.length) return '';
  const lines = left.map((l) => `  ${l.page} / ${l.where}: ${l.marker}`);
  return `The legal pages still hold ${left.length} placeholder(s) - a public build cannot ship them.\n`
    + `Fill them in under apps/web/src/legal/ (see model.ts):\n${lines.join('\n')}`;
}
