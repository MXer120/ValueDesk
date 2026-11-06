/**
 * Puts a catalogue on the page by changing the text of what React rendered, in place (owner 2026-11-06).
 * It runs only while a language other than English is chosen: an English visitor has no observer, no
 * catalogue and no cost.
 *
 * WHY HERE AND NOT t() AT 5,000 CALL SITES: this also reaches labels held in tables, messages from the
 * engines and whatever a later feature adds, with no edit to any of those files; a string it does not know
 * stays English instead of breaking. Only a text node's data or an attribute changes, never the tree, which
 * is why React is unaffected (it compares its own props, not the DOM). When React writes new English to a
 * node, the observer translates that.
 *
 * Left alone: anything under [data-no-i18n] (legal documents and what a signature refers to), code,
 * editable content, and text with no words in it (prices, times).
 */
import { createMatcher, hasWords, type Catalogue } from './match';

const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'] as const;
const SKIP = 'script, style, code, pre, textarea, [contenteditable=""], [contenteditable="true"], [data-no-i18n]';

/** Every piece of English shown with no translation, when asked for (e2e/ui/themeAudit.ts --lang). */
declare global {
  interface Window { __vsI18nMissing?: Set<string> }
}

let observer: MutationObserver | null = null;
/** Only noting what has no translation, changing nothing (the audit: its scenes find buttons by their English names). */
let dry = false;
let translate: ((text: string) => string | null) | null = null;
const texts = new Map<Text, { en: string; shown: string }>();
const attrs = new WeakMap<Element, Map<string, { en: string; shown: string }>>();
const touched = new Set<Element>();

const note = (en: string) => {
  const core = en.trim();
  if (core && hasWords(core)) window.__vsI18nMissing?.add(core);
};

function doText(node: Text): void {
  if (!translate) return;
  const was = texts.get(node);
  if (was && node.data === was.shown) return; // our own write coming back
  const en = node.data;
  const parent = node.parentElement;
  if (!hasWords(en) || !parent) {
    if (was) texts.delete(node);
    return;
  }
  const to = translate(en);
  if (to === null) {
    if (was) texts.delete(node);
    if (!parent.closest(SKIP)) note(en);
    return;
  }
  if (dry || parent.closest(SKIP)) return;
  texts.set(node, { en, shown: to });
  if (to !== en) node.data = to;
}

function doAttr(el: Element, name: string): void {
  if (!translate) return;
  const value = el.getAttribute(name);
  const held = attrs.get(el);
  const was = held?.get(name);
  if (value === null || was?.shown === value) return;
  if (!hasWords(value)) return;
  const to = translate(value);
  if (to === null) {
    if (!el.closest(SKIP)) note(value);
    return;
  }
  if (dry || el.closest(SKIP)) return;
  const map = held ?? new Map<string, { en: string; shown: string }>();
  map.set(name, { en: value, shown: to });
  attrs.set(el, map);
  touched.add(el);
  if (to !== value) el.setAttribute(name, to);
}

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    doText(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) doText(n as Text);
  const el = root as Element;
  if (root.nodeType === Node.ELEMENT_NODE) for (const a of ATTRS) if (el.hasAttribute(a)) doAttr(el, a);
  const parent = root as ParentNode;
  for (const a of ATTRS) parent.querySelectorAll(`[${a}]`).forEach((e) => doAttr(e, a));
}

/** Show this catalogue from now on; null goes back to the English everything was written in. */
export function applyCatalogue(catalogue: Catalogue | null, onlyNote = false): void {
  dry = onlyNote;
  observer?.disconnect();
  observer = null;
  for (const [node, t] of texts) if (node.data === t.shown) node.data = t.en;
  texts.clear();
  for (const el of touched) {
    attrs.get(el)?.forEach((t, name) => { if (el.getAttribute(name) === t.shown) el.setAttribute(name, t.en); });
    attrs.delete(el);
  }
  touched.clear();
  translate = null;
  if (!catalogue) return;

  translate = createMatcher(catalogue);
  walk(document.documentElement);
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') doText(r.target as Text);
      else if (r.type === 'attributes') doAttr(r.target as Element, r.attributeName!);
      else r.addedNodes.forEach(walk);
    }
    // Nodes React removed: forget them, so the map does not grow with every price tick's row.
    if (texts.size > 20_000) for (const node of texts.keys()) if (!node.isConnected) texts.delete(node);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
}
