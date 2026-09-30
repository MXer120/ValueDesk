import { createLogger, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * The local API token, injected into every proxied request.
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
  plugins: [react()],
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
    // Proxy keeps the browser same-origin, so there is no CORS preflight on the
    // hot path and the WebSocket upgrade works without extra configuration.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8797',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const t = localToken();
            if (t) proxyReq.setHeader(TOKEN_HEADER, t);
          });
        },
      },
      '/ws': {
        target: 'ws://127.0.0.1:8797',
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
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
        // Split the charting library so first paint does not wait on it.
        manualChunks: { charts: ['lightweight-charts'] },
      },
    },
  },
});
