/**
 * THE LANDING PAGE'S CHUNKS, TEXT AND FIRST READS, ASKED FOR WHILE THE HTML IS STILL BEING READ (phone pass, 2026-11-18).
 *
 * A page's code was requested only once the entry chunk had downloaded AND run: App.tsx calls the page's import()
 * then. On a phone over DevTools' "Slow 4G" with 4x CPU that was ~4.9 s after navigation on /trade, and the page's
 * own chunks (TradeDashboard and what it imports) then queued behind it, ~1.5 s more before the first paint
 * could start. The URL already says which page it is, so the build writes a small script (assets/route-preload-*.js,
 * loaded async from index.html: the site's CSP allows no inline script) that maps the path to that page's chunks
 * and adds a <link rel="modulepreload"> for each. They download alongside the entry; App.tsx's import() then finds
 * them in the module map instead of on the network. A path it does not know preloads nothing, as before.
 *
 * Only chunks the entry does not already pull in are listed (those are in index.html's own modulepreload links).
 *
 * FIRST READS. The page's index reads used to leave only when the entry had run (src/serverFetch.ts primeFirstReads),
 * and on a first visit only once the page had rendered. This script starts them: what this browser remembers the
 * page read first on this URL (localStorage vs.firstReads), else the build's defaults (src/firstReadDefaults.ts; an
 * empty list there means none for that URL, whatever is remembered: its page waits on SoDEX's reads first) -
 * at most six and 64 KB on the wire together, never for a URL with a wallet or a search in it or a tab opened in the
 * background, at low priority so the scripts keep the line. The fetches are left in `window.__vsEarly` for
 * serverFetch.ts to adopt (the same request: one per read), and the tables in `window.__vsReads` / `window.__vsAhead`
 * for a page primed on a touch. Only the landing page's own reads start here; nothing else is asked for before the
 * first paint.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

/** Path (first segment, '' for /) -> the page module App.tsx imports for it. Mirrors App.tsx PAGES and SODEX_DOCS. */
export const ROUTE_PAGES = {
  '': /[\\/]dashboard[\\/]TradeDashboard\.tsx$/,
  trade: /[\\/]dashboard[\\/]TradeDashboard\.tsx$/,
  // The home page (src/homeRoute.ts): also what / is on a first visit - theme-boot.js has said so in data-boot by now.
  home: /[\\/]landing[\\/]site[\\/]HomePage\.tsx$/,
  explore: /[\\/]explore[\\/]Explore\.tsx$/,
  copy: /[\\/]copy[\\/]CopyPage\.tsx$/,
  leaderboard: /[\\/]leaderboard[\\/]LeaderboardPage\.tsx$/,
  portfolio: /[\\/]dashboard[\\/]PortfolioDashboard\.tsx$/,
  scan: /[\\/]dashboard[\\/]ScanDashboard\.tsx$/,
  bots: /[\\/]bots[\\/]BotsPage\.tsx$/,
  referrals: /[\\/]referrals[\\/]ReferralsPage\.tsx$/,
  points: /[\\/]sodex[\\/]SoPointsPage\.tsx$/,
  'blind-boxes': /[\\/]sodex[\\/]BlindBoxPage\.tsx$/,
  wealth: /[\\/]sodex[\\/]WealthPage\.tsx$/,
};

/** The id of the catalogue part a chunk names (tools/i18n-parts.mjs), or null. */
export const partOf = (code) => /__vsI18n[^;]{0,80}\.push\("([A-Za-z0-9_-]{10})"\)/.exec(code)?.[1] ?? null;

/** serverFetch.ts PERSONAL, FIRST_READS_MAX and FIRST_READS_BUDGET (route-preload.test.mjs holds them equal). */
export const PERSONAL_SRC = '[?&](address|q|account|accountId|id|find|wallets|w)=';
export const READS_MAX = 6;
export const READS_BUDGET = 64 * 1024;

/**
 * The script itself: pure, so a test can run it against a fake document. `map`: path segment -> chunk files;
 * `parts`: chunk file -> its catalogue part (tools/i18n-parts.mjs); `first`: path segment -> the landing file of that
 * page's own text ({ f: file name, ids: the parts it holds }); `opts.shell`: the shell's text file, the same for every
 * page ({ f, ids }); `opts.reads`: URL (path + query) -> its default first reads; `opts.ahead`: URL -> its reads on
 * intent where nothing starts on landing (left on the page only); `opts.hints`: path segment ->
 * [rel, href, crossorigin] connection hints.
 *
 * It leaves src/i18n/store.ts which parts belong to which page (`window.__vsI18nPages`), so a page whose code is
 * fetched ahead of a visit brings its text only when it is opened, and which text files this page has
 * (`window.__vsI18nShell`, `window.__vsI18nFirst`). With a language other than English chosen, those TWO files are
 * preloaded: the shell's text (one file per language, shared by every page) and this page's. Tried first
 * (2026-11-18): one file per chunk, preloaded or fetched as each chunk ran - Portuguese /trade then read in Portuguese
 * at 11.6-12.5 s instead of ~10 s: 38 requests each a round trip behind its own chunk. Then one file per page with the
 * shell's text in each: the same text written into every page's file, 11 times per language in every deployment.
 *
 * `langs`: the language codes the app has, English included. A visitor who never chose one reads the first of the
 * browser's languages among them (src/i18n/browserLang.ts, the same rule), so that language's files are preloaded too.
 */
export function preloadScript(map, base = '/', parts = {}, first = {}, { shell = null, reads = {}, ahead = {}, hints = {}, langs = [] } = {}) {
  const J = JSON.stringify;
  return `(function(){var m=${J(map)},p=${J(parts)},r=${J(first)},sh=${J(shell)},d=${J(reads)},ah=${J(ahead)},hs=${J(hints)},b=${J(base)},h=document.head,` +
    `s=(location.pathname.split('/')[1]||'').toLowerCase(),i,e,hm=0;` +
    `try{hm=document.documentElement.getAttribute('data-boot')==='home';if(hm)s=location.pathname.split('/')[2]?'-':'home';}catch(z){}` +
    `function ln(rel,href,co,as){e=document.createElement('link');e.rel=rel;if(as)e.as=as;if(co)e.crossOrigin='';e.href=href;h.appendChild(e);}` +
    // The page's chunks, and where its connections go.
    `try{var w={},k,j;for(k in m){w[k]=[];for(j=0;j<m[k].length;j++)if(p[m[k][j]])w[k].push(p[m[k][j]]);}window.__vsI18nPages=w;` +
    `var l=m[s]||[];for(i=0;i<l.length;i++)ln('modulepreload',b+l[i],1);` +
    `var x=hs[s]||[];for(i=0;i<x.length;i++)ln(x[i][0],x[i][1],x[i][2]);}catch(z){}` +
    // Its first reads.
    `try{window.__vsReads=d;window.__vsAhead=ah;if(!hm&&!window.__vsPrimed&&document.visibilityState==='visible'){` +
    `var u=location.pathname+location.search,P=new RegExp(${J(PERSONAL_SRC)},'i');if(!P.test(u)){` +
    `var q=null,o=null,dd=d[u];if(Array.isArray(dd)&&!dd.length)q=dd;else{try{o=JSON.parse(localStorage.getItem('vs.firstReads')||'null')}catch(z){}` +
    `if(o&&typeof o==='object'&&!Array.isArray(o)&&Object.prototype.hasOwnProperty.call(o,u)&&Array.isArray(o[u]))q=o[u];}` +
    `if(!q)q=dd||[];var E={},n=0,t=0,a,y,c,f;` +
    `for(i=0;i<q.length&&n<${READS_MAX};i++){a=q[i];y=typeof a==='string'?a:(a&&typeof a[0]==='string'?a[0]:null);` +
    `c=a&&typeof a==='object'?Number(a[1]):0;if(!(c>0))c=0;` +
    `if(!y||y.indexOf('/api/vs/')!==0||P.test(y)||E[y]||t+c>${READS_BUDGET})continue;` +
    `f=fetch(y,{headers:{Accept:'application/json'},credentials:'same-origin',priority:'low'});f['catch'](function(){});E[y]=f;n++;t+=c;}` +
    `window.__vsEarly=E;}}}catch(z){}` +
    // Its text, in the language chosen.
    `try{var tf=r[s];window.__vsI18nShell=sh;if(tf)window.__vsI18nFirst=tf;` +
    `var g=null;try{g=localStorage.getItem('vs.lang')}catch(z){}` +
    (langs.length ? `if(g===null)g=${browserPick(langs)};` : '') +
    `if(g&&g!=='en'&&/^[a-z]{2}(-[A-Z]{2})?$/.test(g)){if(sh)ln('preload',b+'i18n/'+g+'/'+sh.f+'.json',1,'fetch');if(tf)ln('preload',b+'i18n/'+g+'/'+tf.f+'.json',1,'fetch');}` +
    `}catch(z){}})();
`;
}

/**
 * An expression for the emitted script: the first of `navigator.languages` that is one of `langs` - the exact code, then
 * the base language, Chinese by its script or region - or null. src/i18n/browserLang.ts pickLanguage, in ES5.
 */
export function browserPick(langs) {
  return `(function(c){var n=window.navigator,q=n?(n.languages&&n.languages.length?n.languages:[n.language]):[],y,z,u,a,want;` +
    `for(y=0;y<q.length;y++){u=String(q[y]||'').replace(/_/g,'-').toLowerCase();if(!u)continue;a=u.split('-');` +
    `want=a[0]==='zh'?(/-(hant|tw|hk|mo)(-|$)/.test(u)?'zh-tw':'zh-cn'):null;` +
    `for(z=0;z<c.length;z++)if(c[z].toLowerCase()===u)return c[z];` +
    `for(z=0;z<c.length;z++)if(c[z].toLowerCase()===(want||a[0]))return c[z];}return null;})(${JSON.stringify(langs)})`;
}

/** The text file for these parts: a single part is its own file (already written by tools/i18n-parts.mjs), else a merge. */
const fileFor = (prefix, ids) => (ids.length === 1 ? ids[0] : `${prefix}-${createHash('sha256').update(ids.join(',')).digest('base64url').slice(0, 10)}`);

/**
 * A TypeScript module's `firstReadDefaults()` and `aheadReads()`, run under Node: bundled whole by esbuild (Vite's own
 * copy) so its imports resolve as the app's do (`alias`: Vite's string aliases, e.g. @sign).
 */
export async function loadFirstReads(file, alias = {}) {
  const require = createRequire(import.meta.url);
  const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
  const out = await esbuild.build({ entryPoints: [file], bundle: true, write: false, format: 'esm', platform: 'node', alias, logLevel: 'silent', define: { 'import.meta.env': '{}' } });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  return { reads: mod.firstReadDefaults(), ahead: typeof mod.aheadReads === 'function' ? mod.aheadReads() : {} };
}

/**
 * `firstReads` / `aheadReads`: the tables themselves, or `firstReadsModule`: the file that builds them
 * (src/firstReadDefaults.ts), loaded when the build starts. `liveSocket`: the live socket's URL (default
 * VITE_LIQ_WS_URL), whose host the cohort pages connect to - its name is looked up while the page loads.
 */
export function routePreload({ i18n, firstReads = {}, aheadReads = {}, firstReadsModule = null, liveSocket = null } = {}) {
  let base = '/';
  let liveHost = liveSocket;
  let reads = firstReads;
  let ahead = aheadReads;
  let alias = {};
  return {
    name: 'valuedesk:route-preload',
    apply: 'build',
    configResolved(cfg) {
      base = cfg.base;
      liveHost ??= cfg.env?.VITE_LIQ_WS_URL?.trim() || null;
      const list = Array.isArray(cfg.resolve?.alias) ? cfg.resolve.alias : Object.entries(cfg.resolve?.alias ?? {}).map(([find, replacement]) => ({ find, replacement }));
      for (const a of list) if (typeof a.find === 'string' && typeof a.replacement === 'string' && !a.find.startsWith('/')) alias[a.find] = a.replacement;
    },
    async buildStart() {
      if (firstReadsModule) ({ reads, ahead } = await loadFirstReads(firstReadsModule, alias));
    },
    generateBundle: {
      order: 'post',
      handler(_opts, bundle) {
        const html = bundle['index.html'];
        if (!html || html.type !== 'asset') return;
        const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
        const byName = new Map(chunks.map((c) => [c.fileName, c]));
        const entry = chunks.find((c) => c.isEntry);
        if (!entry) return;
        const closure = (root) => {
          const seen = new Set();
          const stack = [root];
          while (stack.length) {
            const f = stack.pop();
            if (seen.has(f)) continue;
            seen.add(f);
            const c = byName.get(f);
            if (c) stack.push(...c.imports);
          }
          return seen;
        };
        const already = closure(entry.fileName);
        const map = {};
        for (const [seg, re] of Object.entries(ROUTE_PAGES)) {
          // By its facade, else the chunk that holds the page module (Rollup gives a chunk no facade when the module is
          // also imported statically elsewhere: the trade page's was found by neither and preloaded nothing).
          const page = chunks.find((c) => c.isDynamicEntry && re.test(c.facadeModuleId ?? '')) ?? chunks.find((c) => !c.isEntry && c.moduleIds.some((id) => re.test(id.split('?')[0])));
          if (page) map[seg] = [...closure(page.fileName)].filter((f) => !already.has(f));
        }
        const parts = {};
        for (const c of chunks) { const id = partOf(c.code); if (id) parts[c.fileName] = id; }
        const core = [...new Set([...already].map((f) => parts[f]).filter(Boolean))].sort();
        for (const f of already) delete parts[f];
        /* The shell's text in one file per language, shared by every page; each landing page's own text in another. */
        const first = {};
        let shell = null;
        const catalogues = i18n?.api?.catalogues?.();
        if (catalogues && i18n.api.parts.size) {
          const written = new Set();
          const emit = (f, ids) => {
            if (ids.length === 1 || written.has(f)) return; // a single part is its own file already
            written.add(f);
            const keys = new Set(ids.flatMap((id) => i18n.api.parts.get(id) ?? []));
            for (const [code, cat] of Object.entries(catalogues)) {
              const out = {};
              for (const k of keys) if (cat[k]) out[k] = cat[k];
              this.emitFile({ type: 'asset', fileName: `i18n/${code}/${f}.json`, source: JSON.stringify(out) });
            }
          };
          if (core.length) {
            shell = { f: fileFor('s', core), ids: core };
            emit(shell.f, core);
          }
          for (const [seg, files] of Object.entries(map)) {
            const ids = [...new Set(files.map((f) => parts[f]).filter(Boolean))].filter((id) => !core.includes(id)).sort();
            if (!ids.length) continue;
            first[seg] = { f: fileFor('p', ids), ids };
            emit(first[seg].f, ids); // '' and trade: one file
          }
        }
        const used = new Set(Object.values(map).flat());
        for (const f of Object.keys(parts)) if (!used.has(f)) delete parts[f];
        const hints = {};
        const add = (seg, hint) => { (hints[seg] ??= []).push(hint); };
        // The cohort pages' live socket (live/liveSocket.ts): its own host, not this site's.
        try { if (liveHost) add('explore', ['dns-prefetch', `https://${new URL(liveHost).host}`, 0]); } catch { /* not a URL: no hint */ }
        // SoPoints reads its season and boost cards from SoDEX's biz host on every visit (points.ts BIZ): a cold
        // connection there was DNS + TCP + TLS after the first paint. Only on that page: another would hold an idle socket.
        add('points', ['preconnect', 'https://alpha-biz.sodex.dev', 1]);
        const langs = catalogues ? [...new Set(['en', ...Object.keys(catalogues)])] : [];
        const source = preloadScript(map, base, parts, first, { shell, reads, ahead, hints, langs });
        const fileName = `assets/route-preload-${createHash('sha256').update(source).digest('base64url').slice(0, 8)}.js`;
        this.emitFile({ type: 'asset', fileName, source });
        const tag = `<script async src="${base}${fileName}"></script>`;
        const text = String(html.source);
        html.source = text.includes('/theme-boot.js"></script>')
          ? text.replace('/theme-boot.js"></script>', `/theme-boot.js"></script>\n    ${tag}`)
          : text.replace('</head>', `  ${tag}\n</head>`);
      },
    },
  };
}
