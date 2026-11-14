import { createLogger, defineConfig, searchForWorkspaceRoot, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fromAppOrigin } from './src/devOrigin';
import { thirdPartyLicences } from './tools/licenses.mjs';

/**
 * The local API token, injected into proxied requests from the app itself.
 *
 * Deliberately read HERE and not exposed to the app: if this were a `define` or
 * a VITE_ env var it would be in the bundle, and any XSS in our own UI could
 * lift it. Injecting it in the proxy means page JavaScript never holds the
 * credential that authorises writes - the browser's own same-origin rules keep
 * it out of reach, and the token only ever exists in this Node process and the
 * backend.
 *
 * Read lazily and re-read on miss, because the backend mints the file at boot
 * and `npm run dev` starts both processes at once - on a first-ever run the
 * file may not exist yet when Vite starts.
 */
function tokenPath(): string {
  const override = process.env.VALUETRADE_LOCAL_TOKEN_FILE?.trim();
  if (override) return override;
  const base =
    platform() === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const dir = platform() === 'win32' ? 'Valuescan' : 'valuescan';
  return join(base, dir, 'local-api.token');
}

let cachedToken: string | null = null;
function localToken(): string | null {
  if (cachedToken) return cachedToken;
  const p = tokenPath();
  if (!existsSync(p)) return null;
  const hex = readFileSync(p, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  cachedToken = hex.toLowerCase();
  return cachedToken;
}

const TOKEN_HEADER = 'x-valuetrade-token';

/*
 * ...and only to the app's own requests (security audit W-04): src/devOrigin.ts
 * says which. Its origin is this server's REAL port, recorded by the plugin
 * below, so a dev server that moved to 5181 because 5180 was taken still works.
 */
const appPorts = new Set<number>();
const recordPort = (addr: string | AddressInfo | null | undefined): void => {
  if (addr && typeof addr === 'object') appPorts.add(addr.port);
};
const trackAppOrigin = (): Plugin => ({
  name: 'valuedesk:app-origin',
  configureServer(server) {
    appPorts.add(server.config.server.port ?? 5180);
    server.httpServer?.on('listening', () => recordPort(server.httpServer?.address()));
  },
  configurePreviewServer(server) {
    appPorts.add(server.config.preview.port ?? 4173);
    server.httpServer.on('listening', () => recordPort(server.httpServer.address()));
  },
});
const mayCarryToken = (headers: IncomingHttpHeaders): boolean => fromAppOrigin(headers, appPorts);

/*
 * THE PALETTE'S CHUNKS, ANNOUNCED UP FRONT.
 *
 * App.tsx holds the first render until the landing page's chunk AND the Cmd+K
 * palette's are in (a key pressed the moment the page appears must open the
 * palette as fast as it always did). The palette is needed on every page, so
 * its chunks are listed in the built index.html as modulepreload links: they
 * download alongside the entry instead of after it has run, and the wait costs
 * nothing. Page chunks are not listed - which one is needed depends on the URL.
 */
const preloadPalette = (): Plugin => {
  let base = '/';
  return {
    name: 'valuedesk:preload-palette',
    apply: 'build',
    configResolved(cfg) {
      base = cfg.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return [];
        const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
        const byName = new Map(chunks.map((c) => [c.fileName, c]));
        const entry = chunks.find((c) => c.isEntry);
        const palette = chunks.find((c) => c.isDynamicEntry && /[\\/]palette[\\/]CommandPalette\.tsx$/.test(c.facadeModuleId ?? ''));
        if (!entry || !palette) return [];
        const closure = (root: string): Set<string> => {
          const seen = new Set<string>();
          const stack = [root];
          while (stack.length) {
            const f = stack.pop()!;
            if (seen.has(f)) continue;
            seen.add(f);
            const c = byName.get(f);
            if (c && c.type === 'chunk') stack.push(...c.imports);
          }
          return seen;
        };
        const already = closure(entry.fileName);
        return [...closure(palette.fileName)]
          .filter((f) => !already.has(f))
          .map((f) => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: base + f }, injectTo: 'head' as const }));
      },
    },
  };
};

// `npm run dev` starts the backend and this dev server together, so every
// startup - and every tsx-watch restart after an edit - opens a window where
// the backend is briefly gone and the proxy throws ECONNREFUSED/ECONNRESET at
// whatever request lands in it. Vite's proxyMiddleware logs every one of
// those unconditionally, and it attaches that logging AFTER calling a proxy
// entry's own `configure` hook - so a `configure`-based error listener runs
// but can't stop Vite's own log line from also firing. Filtering it out of
// the logger itself is the only hook that actually works. Real backend-down
// state already surfaces through the app's own error UI (accountFeeds.ts et
// al.), so this loses no signal, only the noise.
const logger = createLogger();
const logError = logger.error.bind(logger);
logger.error = (msg, options) => {
  if (/(?:http|ws) proxy error/.test(msg)) return;
  logError(msg, options);
};

/** The local API's port: 8797, or another checkout's (VALUETRADE_DEV_API_PORT) when two run side by side. */
const DEV_API_PORT = /^\d{2,5}$/.test(process.env.VALUETRADE_DEV_API_PORT ?? '') ? process.env.VALUETRADE_DEV_API_PORT : '8797';

/**
 * VALUETRADE_DEV_API=prod: localhost on production's data (owner 2026-11-07: "for localhost i also just want to use
 * the production indexer"). /api and /api/copy go to www.valuedesk.so as the site's own requests do (Vercel adds the
 * origin secret and the viewer's country), the live heatmap socket to the instance. No local API or indexer runs (the
 * local one held 5 GB). The local token is never sent there.
 */
const DEV_PROD = process.env.VALUETRADE_DEV_API === 'prod';
const PROD_SITE = 'https://www.valuedesk.so';
const PROD_WS = 'wss://161-97-154-121.sslip.io';

/**
 * The build's name in client error reports and feedback (src/buildInfo.ts): the
 * commit Vercel builds (deploy/vercel/build.sh), else the minute of the build.
 * Public, like everything else in the bundle.
 */
const buildId = (): string => {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 12);
  return `local-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
};

/** The second build (tools/build-admin.mjs): the admin page alone, added to the site's dist. */
const ADMIN_PAGE = process.env.VS_WEB_PAGE === 'admin';

/**
 * Dev only (VS_BOTS_FIXTURES=<dir>): the Bots section's market estimates from a saved answer of the real computation
 * (apps/server flow/botMarkets.ts over production's recorded trades), since a laptop's API has no trade history to
 * compute them from. Serves <dir>/bm-24h.json and bm-7d.json at /api/vs/bots/markets (and <dir>/latency.json at
 * /api/copy/v1/bots/latency with VS_BOTS_LATENCY=1). Never in a build.
 */
/**
 * Dev only (VS_DEV_TEST_EXECUTOR=http://127.0.0.1:18799, the tunnel to the AWS test box): while that executor answers,
 * /api/copy goes there instead of production, so a live test (the test wallet's bots on the test box) shows on
 * localhost with its real volume, PnL, fees and orders (owner 2026-11-08: "fix the data sync"). Probed every 5 s;
 * when the tunnel is down, requests fall through to the usual proxy (production). Never in a build.
 */
function devTestExecutor(): Plugin {
  const base = process.env.VS_DEV_TEST_EXECUTOR?.trim();
  return {
    name: 'vs-dev-test-executor',
    apply: 'serve',
    configureServer(server) {
      if (!base || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) return;
      const target = new URL(base);
      let up = false;
      // The first probe's answer, waited for by the requests that arrive before it (a page loaded with the dev server
      // went to production for its first reads, then to the test box: two executors, two sign-ins).
      const probe = (): Promise<void> => new Promise((done) => {
        const q = httpRequest({ host: target.hostname, port: target.port, path: '/api/copy/v1/info', method: 'GET', timeout: 2500 }, (res) => { up = res.statusCode === 200; res.resume(); res.on('end', () => done()); res.on('error', () => done()); });
        q.on('timeout', () => { up = false; q.destroy(); done(); });
        q.on('error', () => { up = false; done(); });
        q.end();
      });
      const first = probe();
      const timer = setInterval(() => { void probe(); }, 5000);
      server.httpServer?.on('close', () => clearInterval(timer));
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/copy/')) return next();
        void first.then(() => {
          if (!up) return next();
          const headers = { ...req.headers, host: target.host };
          delete headers[TOKEN_HEADER];
          const out = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers }, (pres) => {
            res.writeHead(pres.statusCode ?? 502, { ...pres.headers, 'x-vs-dev-executor': 'test' });
            pres.pipe(res);
            // The test box broke off mid-answer: the browser's response ends too, never left hanging.
            pres.on('error', () => res.destroy());
            pres.on('aborted', () => res.destroy());
          });
          out.on('error', () => {
            up = false;
            if (!res.headersSent) { res.statusCode = 502; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'the test executor did not answer' })); }
            else res.destroy();
          });
          // The browser went away (a closed tab, an aborted read): the request to the test box stops as well.
          res.on('close', () => { if (!res.writableFinished) out.destroy(); });
          req.pipe(out);
        });
      });
    },
  };
}

/**
 * Dev only: /api/vs/invites to the local referral routes (apps/server/tools/invites-dev.ts, 127.0.0.1:18797, or
 * VS_DEV_INVITES) while they answer - localhost on production's data otherwise has no referrals until they are released.
 * Probed every 5 s; when it is down the request goes on to the usual proxy. Never in a build.
 */
function devInvites(): Plugin {
  const base = process.env.VS_DEV_INVITES?.trim() || (DEV_PROD ? 'http://127.0.0.1:18797' : '');
  return {
    name: 'vs-dev-invites',
    apply: 'serve',
    configureServer(server) {
      if (!base || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) return;
      const target = new URL(base);
      let up = false;
      const probe = (): Promise<void> => new Promise((done) => {
        const q = httpRequest({ host: target.hostname, port: target.port, path: '/api/vs/invites/check?code=PROBE', method: 'GET', timeout: 2000 }, (res) => { up = res.statusCode === 200; res.resume(); res.on('end', () => done()); res.on('error', () => done()); });
        q.on('timeout', () => { up = false; q.destroy(); done(); });
        q.on('error', () => { up = false; done(); });
        q.end();
      });
      const first = probe();
      const timer = setInterval(() => { void probe(); }, 5000);
      server.httpServer?.on('close', () => clearInterval(timer));
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/vs/invites/')) return next();
        void first.then(() => {
          if (!up) return next();
          const headers = { ...req.headers, host: target.host };
          delete headers[TOKEN_HEADER];
          const out = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers }, (pres) => {
            res.writeHead(pres.statusCode ?? 502, { ...pres.headers, 'x-vs-dev-invites': 'local' });
            pres.pipe(res);
            pres.on('error', () => res.destroy());
          });
          out.on('error', () => {
            up = false;
            if (!res.headersSent) { res.statusCode = 502; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'the local referral routes did not answer' })); }
            else res.destroy();
          });
          res.on('close', () => { if (!res.writableFinished) out.destroy(); });
          req.pipe(out);
        });
      });
    },
  };
}

function botsFixtures(): Plugin {
  const dir = process.env.VS_BOTS_FIXTURES?.trim();
  return {
    name: 'vs-bots-fixtures',
    apply: 'serve',
    configureServer(server) {
      if (!dir) return;
      server.middlewares.use((req, res, next) => {
        // The executor's latency too, when VS_BOTS_LATENCY=1: a real series saved from the test box's live runs (a
        // laptop's executor sends no order to SoDEX, so its chart is empty).
        if (req.url?.startsWith('/api/copy/v1/bots/latency') && process.env.VS_BOTS_LATENCY === '1' && existsSync(join(dir, 'latency.json'))) {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          return res.end(readFileSync(join(dir, 'latency.json')));
        }
        // The regime board (Explore): <dir>/regime.json holds one answer per 'SYMBOL|window' and 'ALL|window' (make-recorded.ts:
        // the server's own code over server 2's recorded prints).
        // On production's data (VALUETRADE_DEV_API=prod) the board and the estimates are production's, live: the files are a
        // frozen night (owner 2026-11-10: "0 datapoints of today on the chart").
        if (DEV_PROD && (req.url?.startsWith('/api/vs/bots/regime') || req.url?.startsWith('/api/vs/bots/markets'))) return next();
        if (req.url?.startsWith('/api/vs/bots/regime') && existsSync(join(dir, 'regime.json'))) {
          const q = new URL(req.url, 'http://x').searchParams;
          const sym = (q.get('symbol') ?? 'ALL').toUpperCase();
          const win = q.get('window') ?? '7d';
          const all = JSON.parse(readFileSync(join(dir, 'regime.json'), 'utf8')) as Record<string, unknown>;
          const hit = all[`${sym}|${win}`] ?? all[sym] ?? { ok: true, at: Date.now(), symbol: sym, window: win, markets: (all[`ALL|${win}`] as { markets?: string[] } | undefined)?.markets ?? [], hours: [] };
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          return res.end(JSON.stringify(hit));
        }
        if (!req.url?.startsWith('/api/vs/bots/markets')) return next();
        const asked = new URL(req.url, 'http://x').searchParams.get('window');
        const w = asked === '7d' || asked === '6h' || asked === '1h' ? asked : '24h';
        const f = join(dir, `bm-${w}.json`);
        if (!existsSync(f)) return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(f));
      });
    },
  };
}

export default defineConfig({
  customLogger: logger,
  plugins: [react(), trackAppOrigin(), preloadPalette(), thirdPartyLicences(), devTestExecutor(), devInvites(), botsFixtures()],
  define: { __VS_BUILD__: JSON.stringify(buildId()) },
  /*
   * The EIP-712 signing layer is SHARED with the backend, not copied.
   *
   * server/src/signing/* and decimal.ts are pure and isomorphic - only @noble,
   * no Node APIs - and their output is pinned byte-for-byte against the official
   * Go SDK by 19 reference vectors. Importing the same files here rather than
   * porting them means the browser signs with code that is already proven, and
   * that a change can never make the two halves disagree silently.
   */
  resolve: {
    alias: {
      '@sign': fileURLToPath(new URL('../server/src', import.meta.url)),
      /*
       * Browser trading signs with packages/sodex-core: pure TypeScript + @noble,
       * byte-identical to the official Go SDK (its test vectors pin that). Imported
       * from source like @sign, so there is no build step between the two.
       */
      '@sodex-core': fileURLToPath(new URL('../../packages/sodex-core/src/index.ts', import.meta.url)),
      /*
       * The copy engine: the same planner, feeds and runtime the hosted and
       * self-hosted executors run (packages/copy-engine), from source.
       */
      '@copy-engine': fileURLToPath(new URL('../../packages/copy-engine/src/index.ts', import.meta.url)),
    },
    /*
     * ONE React, whatever npm decides to hoist.
     *
     * This is a workspace, so a dependency can land a second physical copy of
     * react in web/node_modules while another resolves the root one. Two copies
     * means two module registries, and the first hook a component calls throws
     * "Invalid hook call ... more than one copy of React" - the whole app renders
     * blank. That is exactly what installing @walletconnect/modal did.
     *
     * `dedupe` makes every importer resolve to the same file regardless of where
     * it sits in the tree, so a future install cannot reintroduce it.
     */
    dedupe: ['react', 'react-dom'],
  },
  /*
   * PRE-BUNDLE APPKIT EXPLICITLY.
   *
   * Vite discovers dependencies by scanning static imports from the entry. AppKit
   * is reached only through a dynamic `import()` inside a function, so the scanner
   * never saw it, never emitted .vite/deps/@reown_appkit.js, and every attempt to
   * load it 504'd with "Outdated Optimize Dep" - which surfaced as a Connect
   * button that did nothing at all.
   *
   * `exclude` is NOT the fix here even though it gets past that error: AppKit
   * pulls in CommonJS transitives (dayjs among them) that have no ESM default
   * export until the optimizer converts them, so serving it raw just moves the
   * failure one module deeper. Naming it in `include` makes the optimizer process
   * it and its whole subtree up front, which is what a dynamic import needs.
   */
  optimizeDeps: {
    include: ['@reown/appkit'],
  },
  server: {
    host: '127.0.0.1',
    /*
     * A git worktree's node_modules are links into the main checkout: their real folders sit outside this root, and
     * Vite refused their files (the self-hosted fonts came back 403, so every page drew in a fallback face). The
     * workspace root as usual, plus wherever the two node_modules really are.
     */
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        ...[fileURLToPath(new URL('./node_modules', import.meta.url)), fileURLToPath(new URL('../../node_modules', import.meta.url))]
          .filter((p) => existsSync(p))
          .map((p) => realpathSync(p)),
      ],
    },
    /*
     * 5173 stays. SoPoints authentication needs an origin Privy's allowlist
     * accepts, and this is not one - but the login is proxied through the
     * backend (server/src/routes/pointsAuth.ts), which sets that origin itself.
     * Pinning the dev server to port 3000 to satisfy a third party's CORS rule
     * would have been a workaround leaking into everyone's local setup.
     */
    port: 5180,
    /*
     * Headers that a <meta> CSP cannot deliver.
     *
     * `frame-ancestors` is ignored inside <meta> - only a real header counts -
     * and framing is what a clickjacking attack on the order and withdrawal
     * confirmations would need. X-Frame-Options covers older browsers.
     *
     * These apply to the DEV server only. Anything serving web/dist in
     * production must send the same set; see DEPLOYMENT.md.
     */
    headers: {
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
    /*
     * No CORS at all (audit W-04). The app is same-origin with this server and
     * never needs it; Vite's default would let any other localhost page read
     * this server's responses.
     */
    cors: false,
    // Proxy keeps the browser same-origin, so there is no CORS preflight on the
    // hot path and the WebSocket upgrade works without extra configuration.
    proxy: DEV_PROD ? {
      // VS_DEV_EXECUTOR=local: production's data with a local executor (apps/executor on 8799), for tests that
      // must not reach the production executor (the Bots e2e). Listed first: the first matching prefix wins.
      // VIP (copy/executor.ts VIP_BASE): the local VIP executor on 8800 (launch config bots-wt-executor-vip), as /api/copy.
      ...(process.env.VS_DEV_EXECUTOR === 'local' ? { '/api/copy-vip': { target: 'http://127.0.0.1:8800', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/copy-vip/, '/api/copy') } } : {}),
      ...(process.env.VS_DEV_EXECUTOR === 'local' ? { '/api/copy': { target: 'http://127.0.0.1:8799', changeOrigin: true } } : {}),
      '/api': {
        target: PROD_SITE,
        changeOrigin: true,
        secure: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('origin', PROD_SITE);
            proxyReq.removeHeader(TOKEN_HEADER);
          });
        },
      },
      '/ws': {
        target: PROD_WS,
        ws: true,
        changeOrigin: true,
        secure: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            proxyReq.setHeader('origin', PROD_SITE);
            proxyReq.removeHeader(TOKEN_HEADER);
          });
        },
      },
    } : {
      '/api/copy-vip': {
        target: 'http://127.0.0.1:8800',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api\/copy-vip/, '/api/copy'),
      },
      // The copy executor (apps/executor, `npm start` there): hosted, the edge routes these the same way.
      '/api/copy': {
        target: 'http://127.0.0.1:8799',
        changeOrigin: true,
      },
      '/api': {
        target: `http://127.0.0.1:${DEV_API_PORT}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            // The beta site's token, as the Vercel function hands it on (deploy/vercel/api-proxy.cjs): its
            // cookie as x-vs-beta. Only a beta API (VALUESCAN_CHANNEL=beta) reads it.
            const beta = /(?:^|;\s*)vs_beta=(0x[0-9a-f]{40}\.\d{13}\.[A-Za-z0-9_-]{43})(?:;|$)/.exec(String(req.headers.cookie ?? ''));
            if (beta) proxyReq.setHeader('x-vs-beta', beta[1]!);
            if (!mayCarryToken(req.headers)) return;
            const t = localToken();
            if (t) proxyReq.setHeader(TOKEN_HEADER, t);
          });
        },
      },
      '/ws': {
        target: `ws://127.0.0.1:${DEV_API_PORT}`,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq, req) => {
            if (!mayCarryToken(req.headers)) return;
            const t = localToken();
            if (t) proxyReq.setHeader(TOKEN_HEADER, t);
          });
        },
      },
    },
  },
  build: {
    // The admin build adds its page to the site's dist; it never empties it.
    emptyOutDir: !ADMIN_PAGE,
    rollupOptions: {
      /*
       * Two pages, built ONE AT A TIME: the site (index.html), then the owner's admin suite
       * (admin.html, src/admin/; served only on dev.valuedesk.so - deploy/vercel/package.mjs
       * ADMIN_HOST) by tools/build-admin.mjs with VS_WEB_PAGE=admin into the same dist.
       * Both in one build (v0.2.112) made Rollup move every stylesheet the two pages share -
       * styles.css among them - into a shared CSS chunk loaded BEFORE the site's own: the
       * cascade order cssOrder.ts pins broke, and styles.css's overrides (meant to come last)
       * lost to the components' rules - the trade page's market strip got its panel border
       * back (owner 2026-11-01). Built alone, the site's CSS is one sheet in its fixed order.
       * The site's key stays `index`, so its entry chunk keeps its name (assets/index-*.js).
       */
      input: ADMIN_PAGE
        ? { admin: fileURLToPath(new URL('./admin.html', import.meta.url)) }
        : { index: fileURLToPath(new URL('./index.html', import.meta.url)) },
      output: {
        /*
         * React in a chunk of its own. It changes far less often than our code,
         * so after a deploy returning visitors keep it from their cache and
         * re-download only the app. The pages themselves are split by App.tsx
         * (dynamic imports); the chart library already loads on demand.
         */
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
});
