import { createLogger, defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fromAppOrigin } from './src/devOrigin';

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
  name: 'valuescan:app-origin',
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
    name: 'valuescan:preload-palette',
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

export default defineConfig({
  customLogger: logger,
  plugins: [react(), trackAppOrigin(), preloadPalette()],
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
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8797',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (!mayCarryToken(req.headers)) return;
            const t = localToken();
            if (t) proxyReq.setHeader(TOKEN_HEADER, t);
          });
        },
      },
      '/ws': {
        target: 'ws://127.0.0.1:8797',
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
    rollupOptions: {
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
