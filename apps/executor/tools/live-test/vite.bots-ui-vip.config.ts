/**
 * The dev web for bots-ui-vip.ts: apps/web's own Vite config, with only the executor routes and the VIP read moved to
 * this run's local processes (ports from the environment bots-ui-vip.ts sets). Everything else is apps/web's config
 * as it is (VALUETRADE_DEV_API=prod: public market data from production's read API, like the bots-wt-test-web launch
 * config). Its own cache folder, so the owner's dev server's optimised deps are never touched.
 */
import base from '../../../web/vite.config.ts';

const need = (k: string): string => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is not set (bots-ui-vip.ts starts this config)`);
  return v;
};
const std = need('LIVE_BOTS_STD_ORIGIN');
const vip = need('LIVE_BOTS_VIP_ORIGIN');
const stub = need('LIVE_BOTS_STUB_ORIGIN');
const server = (base as { server?: Record<string, unknown> }).server ?? {};
const proxy = (server.proxy as Record<string, unknown> | undefined) ?? {};

export default {
  ...base,
  cacheDir: need('LIVE_BOTS_VITE_CACHE'),
  server: {
    ...server,
    port: Number(need('LIVE_BOTS_WEB_PORT')),
    strictPort: true,
    // First match wins: this run's executors and the stub's VIP read before apps/web's own routes.
    proxy: {
      '/api/vs/bots/vip': { target: stub, changeOrigin: true },
      '/api/copy-vip': { target: vip, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/copy-vip/, '/api/copy') },
      '/api/copy': { target: std, changeOrigin: true },
      ...proxy,
    },
  },
};
