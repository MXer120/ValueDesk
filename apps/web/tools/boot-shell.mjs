/**
 * THE FIRST PIXELS, IN THE BUILT index.html (phone pass, 2026-11-18). Five edits to what Vite writes:
 *
 * 1. theme-boot.js FROM AN IMMUTABLE URL. It is the one script in <head> that holds the first paint (it sets the
 *    theme before anything is drawn: public/theme-boot.js). Served from public/ it had no hash, so it was cached for
 *    an hour: a return visit a day later waited a revalidation round trip (~560 ms on "Slow 4G") before it could
 *    paint, with everything else in the immutable cache. The build serves the same text from
 *    assets/theme-boot-<hash>.js (immutable, like every /assets file; no CSP change: still a file of 'self').
 *    public/theme-boot.js stays, for a page cached from before.
 *
 * 2. THE STYLESHEET AFTER THE STATIC SHELL. index.html opens with a picture of the app (#vs-boot, its own inline
 *    style; src/bootShell.ts). Vite puts the one stylesheet in <head>, where it held every pixel back until its
 *    ~130 KB had arrived. Moved to the end of <body> (id `vs-css`), it holds back only what comes after it: the shell
 *    paints as soon as theme-boot.js has run. The app still never renders unstyled: the module entry runs only once
 *    a parser-inserted stylesheet has loaded (and main.tsx checks: bootShell.ts sheetPending).
 *
 * 3. LAZY STYLESHEETS STILL COME AFTER IT. A chunk with CSS of its own (the legal pages' legal.css, the TradingView
 *    chart's tv.css) has it added by Vite's preload helper, which appends a <link> to <head> - BEFORE a sheet in
 *    <body>, which would flip the cascade between them (styles.css's `.legal-card` rule would beat legal.css's, the
 *    legal card's border and radius would change). The helper appends a stylesheet to <body> instead, after the main
 *    one, exactly where it used to land in the cascade. The build fails if the helper's line is not found.
 *
 * 4. THE PALETTE'S CHUNKS, ANNOUNCED ON A DEVICE WITH A KEYBOARD ONLY. App.tsx holds the first render for the Cmd+K
 *    palette's chunks (a key pressed the moment the page appears must open it) - except on a touch phone, which has
 *    no such key: there they load after the first render. They used to be static modulepreload links for every
 *    device; theme-boot.js now adds them, with App.tsx's own media query, where they are waited for.
 *
 * 5. NO NOTES IN THE SHIPPED PAGE (slimHtml below): the first round trip carries the page, not its documentation.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** App.tsx TOUCH_ONLY: the devices whose first render does not wait for the palette. */
export const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';

/** The theme-boot.js addition: the palette's chunks as modulepreloads, unless this is a touch phone. */
export function palettePreload(files, base = '/') {
  return `;(function(){try{if(window.matchMedia&&window.matchMedia(${JSON.stringify(TOUCH_QUERY)}).matches)return;` +
    `var l=${JSON.stringify(files.map((f) => base + f))},h=document.head,i,e;` +
    `for(i=0;i<l.length;i++){e=document.createElement('link');e.rel='modulepreload';e.crossOrigin='';e.href=l[i];h.appendChild(e);}` +
    `}catch(x){}})();\n`;
}

const SHEET_RE = /\n?[ \t]*<link rel="stylesheet" crossorigin href="([^"]+\.css)">/g;

/** Edit 2: the head's stylesheet link(s) moved to just after #root, the main one as `vs-css`. */
export function moveStylesheet(html) {
  const links = [...html.matchAll(SHEET_RE)];
  if (links.length !== 1) throw new Error(`boot-shell: expected one stylesheet link in index.html, found ${links.length}`);
  if (!html.includes('<div id="vs-boot"')) throw new Error('boot-shell: index.html has no static shell (#vs-boot)');
  const root = '<div id="root"></div>';
  if (!html.includes(root)) throw new Error('boot-shell: index.html has no #root');
  const href = links[0][1];
  return html
    .replace(links[0][0], '')
    .replace(root, `${root}\n    <link rel="stylesheet" crossorigin href="${href}" id="vs-css">`);
}

/**
 * Edit 5: the HTML without its notes. index.html explains itself at length (the CSP, the shell) for whoever edits
 * it; a visitor's first round trip does not need that: comments out, the shell's style and markup without
 * indentation (between its tags only: every container in it is a flex or grid box, or holds blocks, so no space
 * there is drawn).
 */
export function slimHtml(html) {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/(<style id="vs-boot-css">)([\s\S]*?)(<\/style>)/, (_m, a, css, b) => a + css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{};,>])\s*/g, '$1').replace(/;}/g, '}').trim() + b);
  const start = out.indexOf('<div id="vs-boot"');
  const end = out.indexOf('<div id="root"></div>');
  if (start >= 0 && end > start) out = out.slice(0, start) + out.slice(start, end).replace(/>\s+</g, '><').trim() + '\n    ' + out.slice(end);
  return out.replace(/\n\s*\n/g, '\n');
}

/** The line of Vite's preload helper that adds a chunk's <link> (vite/dist/node/chunks/dep-*.js `preload`). */
export const HELPER_LINE = 'document.head.appendChild(link);';
/** Edit 3: a stylesheet goes to <body>, after the main sheet; a modulepreload stays in <head>. */
export const HELPER_FIX = '(isCss && document.body ? document.body : document.head).appendChild(link);';

export function patchPreloadHelper(code) {
  const at = code.indexOf(HELPER_LINE);
  if (at < 0 || code.indexOf(HELPER_LINE, at + 1) >= 0 || !code.includes('const isCss')) {
    throw new Error('boot-shell: Vite\'s preload helper changed - the lazy stylesheets would land before the main one; see tools/boot-shell.mjs');
  }
  return code.replace(HELPER_LINE, HELPER_FIX);
}

/** The chunk files `root` pulls in (itself included). */
function closureOf(byName, root) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const c = byName.get(f);
    if (c && c.type === 'chunk') stack.push(...c.imports);
  }
  return seen;
}

export function bootShell({ webRoot }) {
  let base = '/';
  const bootSource = () => readFileSync(join(webRoot, 'public', 'theme-boot.js'), 'utf8');
  return {
    name: 'valuedesk:boot-shell',
    apply: 'build',
    configResolved(cfg) {
      base = cfg.base;
    },
    transform(code, id) {
      if (id === '\0vite/preload-helper.js') return { code: patchPreloadHelper(code), map: null };
      return null;
    },
    generateBundle: {
      order: 'post',
      handler(_opts, bundle) {
        for (const asset of Object.values(bundle)) {
          if (asset.type !== 'asset' || !asset.fileName.endsWith('.html')) continue;
          let html = String(asset.source);
          if (!html.includes('<script src="/theme-boot.js"></script>')) continue;
          let source = bootSource();
          if (asset.fileName === 'index.html') {
            const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
            const byName = new Map(chunks.map((c) => [c.fileName, c]));
            const entry = chunks.find((c) => c.isEntry);
            const palette = chunks.find((c) => c.isDynamicEntry && /[\\/]palette[\\/]CommandPalette\.tsx$/.test(c.facadeModuleId ?? ''));
            if (entry && palette) {
              const already = closureOf(byName, entry.fileName);
              source += palettePreload([...closureOf(byName, palette.fileName)].filter((f) => !already.has(f)), base);
            }
            html = slimHtml(moveStylesheet(html));
          }
          const fileName = `assets/theme-boot-${createHash('sha256').update(source).digest('base64url').slice(0, 8)}.js`;
          if (!bundle[fileName]) this.emitFile({ type: 'asset', fileName, source });
          asset.source = html.replace('<script src="/theme-boot.js"></script>', `<script src="${base}${fileName}"></script>`);
        }
      },
    },
  };
}
