/**
 * THE CATALOGUES, SPLIT BY THE CODE THAT SHOWS THEM (phone pass, 2026-11-18).
 *
 * A language's whole catalogue (public/i18n/<code>.json) is ~640 KB of JSON; a visitor in German downloaded all of it
 * before the first page could read in German, whichever page that was. In a build, each chunk of the app gets the part
 * of every catalogue its own modules write (the files tools/i18n-extract.mjs found each string in), emitted as
 * dist/i18n/<code>/<id>.json, and the chunk ends with one statement naming that part:
 *
 *   (globalThis.__vsI18n ||= []).push("<id>");
 *
 * src/i18n/store.ts reads those names: a part is fetched when its chunk has run, so a page's text arrives with the
 * page's code and not before. The entry chunk's part also holds every string no bundled file writes (extra.json, the
 * server's messages, keys a catalogue still has): what can appear on any page is in the part every page loads.
 *
 * <id> is a hash of the part's English keys and their translations, so a part's URL changes whenever what it holds
 * does. The whole catalogues stay in public/i18n for the dev
 * server, the language audit, and as the fallback when a part cannot be read (an old tab after a deploy).
 *
 * The entry chunk's part is the shell's text: tools/route-preload.mjs preloads that very file for every landing page
 * (no copy of it in each page's landing file: it was 11 copies per language, ~28 MB of a 71 MB dist/i18n), and merges
 * only a page's own parts into that page's landing file.
 *
 * Vendor chunks write none of our text and get no part and no statement. The statement is appended, so nothing
 * before it moves and the chunk's source map stays right.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectStrings } from './i18n-extract.mjs';

const norm = (id) => id.split('?')[0].replace(/\\/g, '/').toLowerCase();

/** The chunk's statement: pure, so a test can hold the runtime to it. */
export const partStatement = (id) => `\n;(globalThis.__vsI18n||(globalThis.__vsI18n=[])).push(${JSON.stringify(id)});\n`;

export function i18nParts({ webRoot }) {
  let byFile = null; // file -> strings it writes
  let unplaced = null; // strings no bundled file writes, filled at the entry chunk
  const parts = new Map(); // id -> sorted English keys
  let catalogues = null;
  return {
    name: 'valuedesk:i18n-parts',
    /** For tools/route-preload.mjs: each part's English keys, and the catalogues, to build a landing page's file. */
    api: { parts, catalogues: () => catalogues },
    apply: 'build',
    config() {
      return { define: { __VS_I18N_PARTS__: 'true' } };
    },
    buildStart() {
      const { where } = collectStrings();
      byFile = new Map();
      for (const [text, files] of where) for (const f of files) {
        const k = norm(f);
        const list = byFile.get(k) ?? [];
        list.push(text);
        byFile.set(k, list);
      }
      const dir = join(webRoot, 'public/i18n');
      catalogues = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, f), 'utf8'))]));
    },
    renderChunk(code, chunk) {
      const keys = new Set();
      for (const id of chunk.moduleIds) for (const t of byFile.get(norm(id)) ?? []) keys.add(t);
      if (chunk.isEntry) {
        if (!unplaced) {
          const bundled = new Set([...this.getModuleIds()].map(norm));
          const placed = new Set();
          for (const [f, list] of byFile) if (bundled.has(f)) list.forEach((t) => placed.add(t));
          unplaced = new Set();
          for (const c of Object.values(catalogues)) for (const k of Object.keys(c)) if (!placed.has(k)) unplaced.add(k);
        }
        unplaced.forEach((t) => keys.add(t));
      }
      if (!keys.size) return null;
      const sorted = [...keys].sort();
      // The translations too: a corrected word gives the part a new name, never a stale cached file.
      const h = createHash('sha256').update(sorted.join('\n'));
      for (const code of Object.keys(catalogues).sort()) for (const k of sorted) h.update(`\n${code}\u0000${catalogues[code][k] ?? ''}`);
      const id = h.digest('base64url').slice(0, 10);
      parts.set(id, sorted);
      return { code: code + partStatement(id), map: null };
    },
    generateBundle() {
      for (const [id, keys] of parts) {
        for (const [code, cat] of Object.entries(catalogues)) {
          const out = {};
          for (const k of keys) if (cat[k]) out[k] = cat[k];
          this.emitFile({ type: 'asset', fileName: `i18n/${code}/${id}.json`, source: JSON.stringify(out) });
        }
      }
    },
  };
}
