/**
 * Lists every piece of English the web app can put on screen: i18n/en.json, the list each language in
 * public/i18n/ translates (i18n.test.ts holds them to it).
 *
 *   node tools/i18n-extract.mjs            rewrite i18n/en.json
 *   node tools/i18n-extract.mjs --check    exit 1 when en.json is out of date
 *
 * Walks the TypeScript of the app and the engines it shows messages from: JSX text, string props, and any
 * string or template that reads like a sentence or a label. `${x}` in a template becomes {0}. Reaching too
 * far costs a few unused entries: only text that really appears on the page is ever replaced.
 *
 * Not collected: legal documents (data-no-i18n: English stays the binding text), the admin suite, tests.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const require = createRequire(join(web, 'package.json'));
const ts = require('typescript');

const ROOTS = [join(web, 'src'), resolve(web, '../../packages/copy-engine/src'), resolve(web, '../server/src/ops/feedbackAreas.ts')];
const SKIP_DIR = /[\\/](admin|node_modules|e2e)([\\/]|$)/;
/* The legal documents themselves stay English; the gate and switches around them do not. */
const SKIP_FILE = /\.(test|spec|d)\.tsx?$|logoManifest|i18n[\\/]|legal[\\/](terms|privacy|risk|copyTerms|impressum|cookies|licenses|notices|docs|model|jurisdictions)\.|copy-engine[\\/]src[\\/]terms[\\/]/;
/** Props that hold no words for people. */
const NOT_TEXT_PROP = new Set(['className', 'style', 'href', 'src', 'd', 'id', 'key', 'type', 'role', 'name', 'rel', 'target', 'viewBox', 'fill', 'stroke', 'strokeLinecap', 'strokeLinejoin', 'transform', 'lang', 'htmlFor', 'width', 'height', 'value', 'inputMode', 'autoComplete', 'pattern', 'to', 'points', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'x2', 'y1', 'y2', 'clipRule', 'fillRule', 'accept', 'method', 'action', 'dataKey', 'storageKey', 'loading', 'decoding', 'aria-haspopup', 'aria-current', 'aria-live', 'aria-controls', 'aria-labelledby', 'aria-describedby']);
/** Calls whose arguments are never shown. */
const NOT_TEXT_CALL = /^(console\.|log\.|localStorage\.|sessionStorage\.|document\.|window\.|querySelector|closest|addEventListener|removeEventListener|dispatchEvent|CustomEvent|Event|fetch|gwGet|postJson|import|require|matchMedia|useStored|usePolled|lazyPage|getJson|new URL|URLSearchParams|RegExp|setProperty|getPropertyValue|createElement|assert)/;

function files(root) {
  const out = [];
  const go = (p) => {
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIR.test(p)) for (const n of readdirSync(p)) go(join(p, n));
    } else if (/\.tsx?$/.test(p) && !SKIP_FILE.test(p)) out.push(p);
  };
  go(root);
  return out;
}

const ENTITY = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ', rarr: '→', larr: '←', middot: '·', hellip: '…', mdash: '—', ndash: '–', times: '×', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };
/* JSX text keeps its entities in the source; the page shows the character. */
const tidy = (s) => s.replace(/&([a-z]+);/g, (m, n) => ENTITY[n] ?? m).replace(/\s+/g, ' ').trim();

/** Whether a string reads as words for people, not an id, path, class, colour or key. */
export function readsAsText(s) {
  if (s.length < 2 || s.length > 600) return false;
  if (!/\p{L}{2}/u.test(s)) return false;
  if (/^(https?:|mailto:|data:|\/|\.\/|#|var\(|rgb|M\d|m\d)/.test(s)) return false;
  if (/^[a-z0-9_.:\/@-]+$/.test(s)) return false; // ids, keys, classes, event names
  if (/^[A-Za-z0-9_-]*[_.:\/@][A-Za-z0-9_.:\/@-]*$/.test(s)) return false; // BTC-USD_x, a.b.c
  if (/^[a-z][a-zA-Z0-9]*$/.test(s)) return false; // camelCase
  if (/^[A-Z0-9_]{2,}$/.test(s)) return false; // CONSTANTS, tickers
  if (/^0x/.test(s)) return false;
  if (/^[a-z-]+( [a-z-]+)*$/.test(s) && /(^| )[a-z]+-[a-z]+/.test(s)) return false; // class lists
  if (/[{};]\s*$|=>|\bfunction\b|\bimport\b|<\/?[a-z]+>|\$\{/.test(s)) return false;
  if (!/[A-Z]/.test(s) && !/ /.test(s)) return false; // a lone lower-case word is rarely a label here
  return true;
}

const found = new Map(); // text -> first file

function add(text, file, shown = false) {
  const t = tidy(text);
  // `shown`: on the page for certain (JSX text, a word put into a sentence), so a short lower-case word counts.
  const ok = readsAsText(t) || (shown && t.length >= 2 && t.length < 40 && /\p{L}{2}/u.test(t) && !/[{}=<>\[\]]|^[:.&#]|^(https?:|\/|var\()|^\d|[a-z][A-Z]|[_]|^[a-z]+(-[a-z]+)+$/.test(t));
  if (ok && !found.has(t)) found.set(t, relative(web, file).replace(/\\/g, '/'));
}

/** `Hello ${a} and ${b}` -> Hello {0} and {1}; a bare `${a}` has no words of its own. */
function templateKey(node) {
  let out = node.head.text;
  node.templateSpans.forEach((span, i) => { out += `{${i}}${span.literal.text}`; });
  return out;
}

function scan(file) {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node, shown) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isJsxAttribute(node)) {
      if (NOT_TEXT_PROP.has(node.name.getText(src)) || node.name.getText(src).startsWith('data-')) return;
    }
    if (ts.isCallExpression(node) && NOT_TEXT_CALL.test(node.expression.getText(src))) return;
    if (ts.isNewExpression(node) && /^(URL|URLSearchParams|RegExp|Map|Set|CustomEvent|Event|WebSocket)$/.test(node.expression.getText(src))) return;
    if (ts.isPropertyAssignment(node) && /^(className|href|src|id|key|type|d|path|url|icon|method|style)$/.test(node.name.getText(src))) return;
    // Comparisons name values, they do not show them: x === 'Some value'.
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) return;
    if (ts.isJsxText(node)) add(node.text, file, true);
    else if (ts.isStringLiteralLike(node)) add(node.text, file, shown);
    else if (ts.isTemplateExpression(node)) add(templateKey(node), file);
    // Inside `${...}` of a sentence, and in a JSX {...}, a literal is a word of that sentence: {x ? 'made' : 'lost'}.
    const inner = shown || ts.isTemplateSpan(node) || ts.isJsxExpression(node);
    ts.forEachChild(node, (c) => visit(c, inner));
  };
  visit(src, false);
}

for (const root of ROOTS) (statSync(root).isDirectory() ? files(root) : [root]).forEach(scan);
/* The one line around the legal documents, whose folder is otherwise left out. */
found.set('This document is available in English only, and the English text is what counts.', 'src/legal/LegalView.tsx');
/* What the code builds from parts at run time, seen by the audit (e2e/ui/themeAudit.ts --lang), listed by hand. */
for (const s of JSON.parse(readFileSync(join(web, 'i18n/extra.json'), 'utf8'))) if (!found.has(s)) found.set(s, 'i18n/extra.json');

const list = [...found.keys()].sort((a, b) => a.localeCompare(b, 'en'));
const path = join(web, 'i18n/en.json');
const json = `${JSON.stringify(list, null, 0).replace(/","/g, '",\n"')}\n`;

if (process.argv.includes('--check')) {
  let now = '';
  try { now = readFileSync(path, 'utf8'); } catch { /* none yet */ }
  if (now !== json) {
    console.error('i18n/en.json is out of date: run node tools/i18n-extract.mjs');
    process.exit(1);
  }
} else {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json);
  const words = list.reduce((a, s) => a + s.split(/\s+/).length, 0);
  console.log(`${list.length} strings, ${words} words, ${(json.length / 1024).toFixed(0)} KB -> i18n/en.json`);
  if (process.argv.includes('--sources')) writeFileSync(join(web, 'i18n/en.sources.json'), JSON.stringify(Object.fromEntries(found), null, 0));
}
