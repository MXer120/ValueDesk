/**
 * "Send feedback about this" (right-click, FeedbackMenu.tsx): the element under
 * the pointer, described for a developer - and only described, never its data.
 *
 *   path    a CSS-ish path of up to six ancestors: tag, a short id, its first
 *           two class names ("main.st > ul.st-list > li.st-svc")
 *   role    its ARIA role, or what its tag means (button, link, input)
 *   label   what it is called: its aria-label, title, or its first words -
 *           with every address, key, long number or amount taken out
 *           (@sign/ops/scrub), at most 80 characters; never an input's value
 *   panel   the dashboard panel or the page part it sits in
 *
 * The visitor sees all of it as a chip in the form and can remove it.
 */
import { scrubText } from '@sign/ops/scrub.js';

/** What the description reads of an element (the DOM's Element has it all; tests pass less). */
export interface ElementLike {
  tagName: string;
  id?: string;
  classList?: ArrayLike<string> & Iterable<string>;
  parentElement: ElementLike | null;
  getAttribute(name: string): string | null;
  textContent?: string | null;
}

export interface ElementInfo {
  path: string;
  role: string | null;
  label: string | null;
  panel: string | null;
}

const TAG_ROLE: Record<string, string> = { a: 'link', button: 'button', input: 'input', select: 'select', textarea: 'textbox', img: 'image', canvas: 'canvas', svg: 'graphic', th: 'column header', td: 'cell', h1: 'heading', h2: 'heading', h3: 'heading', li: 'list item' };
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);

/** A class name a developer would recognise; generated or state-only ones are left out. */
const usefulClass = (c: string): boolean => /^[a-z][\w-]{0,40}$/i.test(c) && !/^(is|has)-/.test(c) && !/[0-9a-f]{6,}/i.test(c);

function step(el: ElementLike): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id && /^[a-z][\w-]{0,30}$/i.test(el.id) && !/\d{3,}/.test(el.id) ? `#${el.id}` : '';
  const classes = [...(el.classList ?? [])].filter(usefulClass).slice(0, 2).map((c) => `.${c}`).join('');
  return `${tag}${id}${classes}`;
}

/** Words, cut to `max` and scrubbed: no address, key, long number or amount. */
export function cleanLabel(raw: string | null | undefined, max = 80): string | null {
  if (!raw) return null;
  let s = raw.replace(/\s+/g, ' ').trim();
  // Amounts and balances: any figure with a decimal part or of three digits and more.
  // Any of the number formats' group marks (",", ".", "'", "’", space, no-break space).
  s = s.replace(/[-+]?[$€£]?\d[\d,.'’  ]*\d|\b\d{3,}\b/g, '#');
  s = scrubText(s, max);
  return s || null;
}

export function describeElement(target: ElementLike, route: string): ElementInfo & { route: string } {
  const parts: string[] = [];
  let panel: string | null = null;
  for (let el: ElementLike | null = target, n = 0; el && n < 12; el = el.parentElement, n++) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    if (parts.length < 6) parts.unshift(step(el));
    if (!panel) {
      const p = el.getAttribute('data-panel') ?? el.getAttribute('aria-label') ?? null;
      if (p && el !== target && /^[\w .:#&-]{1,40}$/.test(p) && (el.getAttribute('data-panel') || tag === 'section' || tag === 'aside' || tag === 'nav' || el.getAttribute('role') === 'dialog')) panel = p;
    }
  }
  const tag = target.tagName.toLowerCase();
  const role = target.getAttribute('role') ?? TAG_ROLE[tag] ?? null;
  // An input's value is what someone typed: only its name for it.
  const named = target.getAttribute('aria-label') ?? target.getAttribute('title') ?? (FIELD_TAGS.has(tag) ? target.getAttribute('placeholder') : null);
  const label = cleanLabel(named ?? (FIELD_TAGS.has(tag) ? null : target.textContent?.slice(0, 400)));
  return { path: parts.join(' > ') || tag, role, label, panel, route };
}

/** The chip's words: "Button “Buy” in Order entry". */
export function elementSummary(e: ElementInfo): string {
  const what = e.role ? e.role.charAt(0).toUpperCase() + e.role.slice(1) : 'Element';
  return `${what}${e.label ? ` “${e.label}”` : ''}${e.panel ? ` in ${e.panel}` : ''}`;
}
