/**
 * Valuetrade local backend.
 *
 * Binds to 127.0.0.1 only. It is not hardened for network exposure and is not
 * meant to be: it holds a signing key, and its whole security model assumes the
 * only caller is a browser on this machine.
 *
 * The one exception is HOSTED MODE (VALUESCAN_HOSTED=1, hosted.ts): the public,
 * read-only index API - an allow-list of routes, per-client rate limits behind
 * the configured proxy, CORS for the site only, no hub, nothing custodial.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';

import { HOST, PORT, NET, NETWORK, BOOTSTRAP, ALLOW_ENV_KEY, ALLOW_MAINNET_WRITES, KEYSTORE_PATH, ENV_FILE, ENV_FILE_LOADED, enginePath, SERVER_SIGNING, ALLOWED_ORIGINS, HOSTED, HOSTED_CONFIG, SITE_ORIGINS } from './config.js';
import { siteBrakeReader } from './ops/brake.js';
import { HOSTED_RESPONSE_HEADERS, HOSTED_ROUTES, ON_INSTANCE_ROUTES, fastifyTrustProxy, installHostedGate, installServerSigningGate } from './hosted.js';
import { sodex, SodexApiError, NotUnlockedError } from './sodex/rest.js';
import { upstreams } from './sodex/ws.js';
import { addClient, removeClient, startHub, hubStats } from './hub.js';
import { marketRoutes } from './routes/market.js';
import { accountRoutes } from './routes/account.js';
import { tradeRoutes } from './routes/trade.js';
import { walletRoutes } from './routes/wallet.js';
import { moneyRoutes } from './routes/money.js';
import { depositRoutes } from './routes/deposit.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { mirrorRoutes } from './routes/mirror.js';
import { externalRoutes } from './routes/external.js';
import { statsRoutes } from './routes/stats.js';
import { scanRoutes } from './routes/scan.js';
import { pointsAuthRoutes } from './routes/pointsAuth.js';
import { valuedeskRoutes } from './routes/valuedesk.js';
import { builderRoutes } from './routes/builder.js';
import { foldersRoutes } from './routes/folders.js';
import { reportRoutes } from './routes/reports.js';
import { statusRoutes } from './routes/status.js';
import { proberEnabled, siteNoticeReader } from './ops/status.js';
import { hexToBytes, privateKeyToAddress } from './signing/eip712.js';
import { canMoveFunds } from './signing/actions.js';
import { OrderValidationError, SymbolNotFoundError } from './sodex/symbols.js';
import { KeystoreError } from './keystore.js';
import * as ks from './keystore.js';
import { isAllowedOrigin, isSiteOrigin } from './origin.js';
import { liqWsRoute } from './routes/liqWs.js';
import { CHAIN } from './sodex/chain.js';
import { localToken, localTokenPath, tokenMatches, LOCAL_TOKEN_HEADER, TOKEN_REQUIRED } from './localToken.js';
import { ElevationError, revokeAllElevations } from './elevation.js';
import { classify, take } from './rateLimit.js';
import { perfPlugin } from './perf.js';
import { installLocalHostGate } from './localHost.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: undefined,
    // Hosted: log the path, never the query string - it carries wallet
    // addresses and search text, which a public server has no reason to keep.
    ...(HOSTED
      ? { serializers: { req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }) } }
      : {}),
  },
  bodyLimit: HOSTED ? 16_384 : 1_000_000,
  // Hosted: X-Forwarded-For is believed only from the configured proxy hops;
  // locally there is no proxy and the socket address is the client.
  trustProxy: HOSTED ? fastifyTrustProxy(HOSTED_CONFIG.trustProxy) : false,
  // Hosted: a slow client may not hold a connection open indefinitely.
  ...(HOSTED ? { requestTimeout: 30_000 } : {}),
});

// Local mode answers only to a loopback Host (DNS rebinding, audit S-12). First, so that
// nothing - not even a CORS preflight - answers to a Host that is not ours. Hosted: no-op.
installLocalHostGate(app, HOSTED);

await app.register(cors, HOSTED
  ? {
      // The site's own origin(s), exactly - no loopback, no patterns.
      origin: [...SITE_ORIGINS],
      methods: ['GET', 'POST', 'OPTIONS'],
    }
  : {
      // The Vite dev server is a different origin from the API; both are loopback.
      // A hosted deployment adds its own site(s) with VALUETRADE_ALLOWED_ORIGINS.
      origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/, ...ALLOWED_ORIGINS],
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    });

// Compression, ETag/304 and short caching for the index routes (perf.ts).
// Before the security-header hook, so its Cache-Control on index routes stands.
await app.register(perfPlugin);

// Custodial routes answer 410 while server signing is off - the default, and
// always in hosted mode (hosted.ts: SERVER_SIGNING_PATHS). Matched on the raw
// path AND the route the router picked, so percent-encoding cannot slip past.
if (!SERVER_SIGNING) installServerSigningGate(app);
// The hub is a local-only feature: hosted, the web opens its own streams.
// Client messages are small subscribe/unsubscribe ops; 64 KiB is far above them.
// The hub is local-only (below); hosted mode serves one WebSocket, the live liquidation heatmap (routes/liqWs.ts).
await app.register(websocket, { options: { maxPayload: HOSTED ? 4 * 1024 : 64 * 1024 } });

/** One error shape for the whole API, with an actionable hint where we have one. */
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof SodexApiError) {
    app.log.warn({ code: err.code, path: err.path }, err.message);
    return reply.code(err.httpStatus >= 400 ? err.httpStatus : 400).send({
      error: err.message,
      code: err.code,
      hint: err.hint,
      source: 'sodex',
    });
  }
  if (err instanceof NotUnlockedError) {
    return reply.code(401).send({
      error: err.message,
      source: 'session',
      hint: 'Open the Wallet tab to create a restricted signing key, or unlock an existing one.',
    });
  }
  if (err instanceof SymbolNotFoundError) {
    return reply.code(404).send({ error: err.message, source: 'validation' });
  }
  if (err instanceof OrderValidationError) {
    return reply.code(400).send({ error: err.message, source: 'validation' });
  }
  if (err instanceof KeystoreError) {
    return reply.code(401).send({ error: err.message, source: 'keystore' });
  }
  if (err instanceof ElevationError) {
    return reply.code(err.statusCode).send({
      error: err.message,
      source: 'elevation',
      hint: 'Money movement needs a fresh wallet signature for that exact operation.',
    });
  }
  const e = err as Error & { statusCode?: number };
  const status = e.statusCode ?? 500;
  if (status >= 500) {
    // The full error goes to the local log, where the operator can see it. The
    // RESPONSE gets a fixed string: an unhandled 500 carries stack frames, file
    // paths and occasionally upstream detail, and there is no version of that
    // which belongs in a browser payload.
    app.log.error({ err: e }, 'unhandled error');
    return reply.code(500).send({
      error: 'internal error - see the backend log for details',
      source: 'server',
    });
  }
  return reply.code(status).send({ error: e.message, source: 'server' });
});

// The operator's emergency brake (ops/brake.ts): hosted, /var/lib/valuescan/brake.json unless VALUEDESK_BRAKE_FILE says otherwise.
const siteBrake = siteBrakeReader(process.env.VALUEDESK_BRAKE_FILE?.trim() || (HOSTED ? '/var/lib/valuescan/brake.json' : null));
// The status page's open incidents and maintenance (ops/statusNotices.ts) for the app's banner: one read per 30 s.
const siteNotices = siteNoticeReader(HOSTED);

app.get('/api/health', async () => (HOSTED
  // Hosted: only what the web reads (trading/config.ts configureFromHealth).
  // No upstream URLs, budgets, hub or stream stats - the latter name every
  // wallet whose account stream is open.
  ? { ok: true, network: NETWORK, chainId: NET.chainId, mainnetWritesAllowed: NETWORK === 'testnet' || ALLOW_MAINNET_WRITES, brake: siteBrake(), notices: siteNotices() }
  : {
  ok: true,
  network: NETWORK,
  chainId: NET.chainId,
  restBase: NET.restBase,
  wsBase: NET.wsBase,
  mainnetWritesAllowed: NETWORK === 'testnet' || ALLOW_MAINNET_WRITES,
  brake: siteBrake(),
  notices: siteNotices(),
  chain: { chainId: CHAIN.chainId, name: CHAIN.name, explorerUrl: CHAIN.explorerUrl },
  serverSigning: SERVER_SIGNING,
  weightSpent: sodex.weightSpent(),
  weightLimit: sodex.weightLimit(),
  hub: hubStats(),
  // Machine-local details (file paths, key sessions) exist only in the local,
  // server-signing setup - never on a hosted server.
  ...(SERVER_SIGNING
    ? {
        envFile: { path: ENV_FILE, loaded: ENV_FILE_LOADED },
        localToken: { required: TOKEN_REQUIRED, path: localTokenPath() },
        unlocked: sodex.isUnlocked,
        unlockedAccounts: sodex.sessionCount,
        activeAddress: sodex.activeAddress,
      }
    : {}),
}));

await app.register(marketRoutes);
await app.register(accountRoutes);
// Custodial plugins: never even registered on a hosted server.
if (!HOSTED) {
  await app.register(tradeRoutes);
  await app.register(walletRoutes);
  await app.register(moneyRoutes);
}
await app.register(depositRoutes);
await app.register(onboardingRoutes);
await app.register(mirrorRoutes);
// Read-only: proxies SoDEX's public data/business hosts (leaderboard,
// maintenance status, announcements) so the browser stays same-origin.
await app.register(externalRoutes);
// All-time account aggregates, backed by the paged history walk + SQLite cache.
await app.register(statsRoutes);
// Backend for the ported static Scan page (web/public/scan/) - see that
// file's own header comment for the full /api/scan/* contract this serves.
await app.register(scanRoutes);
// SoPoints login (routes/pointsAuth.ts) is NOT registered: it relays SoDEX's private
// sign-in API under a forged `Origin: https://sodex.com` to get past the allowlist SoDEX
// chose, which SoDEX's terms forbid (s. 5.6; docs/legal/TECH-AUDIT.md). The Points page is
// not mounted either. Bring it back only with SoDEX's written OK or an official API - and
// without the forged headers.
void pointsAuthRoutes;
// ValueDesk: multi-venue traders (SoDEX + Hyperliquid) for Explore,
// Leaderboard, Scan and Copy. Read-only - see routes/valuedesk.ts.
await app.register(valuedeskRoutes);
// Builder fee tiers: the signed terms of the fee a wallet owes - see routes/builder.ts.
await app.register(builderRoutes);
// Knowledge folders: each wallet's own research (notes, tables, chart snapshots, news,
// files), behind a signed sign-in - see routes/folders.ts.
await app.register(foldersRoutes);
// What visitors send the owner - the feedback form and client error reports (routes/reports.ts) -
// and the public status page's data (routes/status.ts).
await app.register(reportRoutes);
await app.register(statusRoutes);

// --- browser websocket -------------------------------------------------------

// The live liquidation heatmap: public, read-only; the site's own origins only (hosted), or the local ones.
liqWsRoute(app, (origin) => (HOSTED ? isSiteOrigin(origin, SITE_ORIGINS) : isAllowedOrigin(origin, ALLOWED_ORIGINS)));

if (!HOSTED) app.get('/ws', { websocket: true }, (socket, req) => {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin, ALLOWED_ORIGINS)) {
    app.log.warn({ origin }, 'rejected cross-origin websocket upgrade');
    socket.close(1008, 'origin not allowed');
    return;
  }
  // The account channels stream balances, positions, orders and fills. That is
  // not a mutation, so the hook above does not cover it - but it is exactly the
  // data a hostile local process would want, and such a process reaches this
  // socket by simply omitting Origin. Same token, same reasoning.
  if (TOKEN_REQUIRED && !tokenMatches(req.headers[LOCAL_TOKEN_HEADER] as string | undefined)) {
    app.log.warn({ origin: origin ?? null }, 'rejected websocket upgrade with no valid local token');
    socket.close(1008, 'missing or invalid local API token');
    return;
  }
  const client = addClient(socket);
  socket.on('message', (raw: Buffer) => client.handle(raw.toString()));
  socket.on('close', () => removeClient(client));
  socket.on('error', () => removeClient(client));
});

/**
 * Headers that apply to every response.
 *
 * This process serves JSON to one local page. It should never be framed, never
 * be sniffed into another content type, never leak a referrer to an upstream,
 * and - because responses carry balances, positions and order history - never
 * be written to a disk cache. A route that sets its own Cache-Control (public
 * index data) keeps it; nothing does today.
 *
 * Hosted adds HSTS and a deny-all CSP (hosted.ts HOSTED_RESPONSE_HEADERS).
 */
app.addHook('onSend', async (_req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  if (HOSTED) for (const [k, v] of Object.entries(HOSTED_RESPONSE_HEADERS)) reply.header(k, v);
  return payload;
});

/**
 * Same reasoning for state-changing HTTP requests. @fastify/cors already stops a
 * browser from READING a cross-origin response, but the request still executes;
 * for a signed trading action that side effect is the whole problem.
 *
 * Two independent gates, because they close different holes:
 *
 *  - the Origin check stops a hostile WEB PAGE. Browsers always attach Origin to
 *    a POST, so this is airtight against that class.
 *  - the token stops a hostile PROCESS, which simply omits Origin. Previously a
 *    missing Origin was accepted outright, which meant anything on the machine
 *    that could open a socket could trade or move funds.
 *
 * A request must pass BOTH: a browser request carries a loopback Origin and gets
 * the token injected by the Vite proxy; a legitimate native client (CLI, tests)
 * carries the token and no Origin.
 *
 * HOSTED MODE replaces all of this with hosted.ts's gate: the origin secret,
 * the route allow-list (plus the health route a caller on the instance may
 * read), the site Origin for a state-changing route, per-client limits.
 */
if (HOSTED) installHostedGate(app, { cfg: HOSTED_CONFIG, site: SITE_ORIGINS });
else app.addHook('onRequest', async (req, reply) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  if (!isAllowedOrigin(req.headers.origin, ALLOWED_ORIGINS)) {
    return reply.code(403).send({ error: 'origin not allowed', source: 'server' });
  }
  if (TOKEN_REQUIRED && !tokenMatches(req.headers[LOCAL_TOKEN_HEADER] as string | undefined)) {
    app.log.warn(
      { path: req.url.split('?')[0], origin: req.headers.origin ?? null },
      'rejected a mutating request with no valid local token',
    );
    return reply.code(401).send({
      error: 'missing or invalid local API token',
      source: 'server',
      hint: `Native clients must send ${LOCAL_TOKEN_HEADER}: <contents of ${localTokenPath()}>`,
    });
  }
  // Counted only AFTER the auth gates, so rejected traffic cannot exhaust the
  // budget that legitimate requests depend on. Classified by the route the
  // router matched, so a percent-encoded path cannot dodge the money class.
  for (const { key, limit } of classify(req.routeOptions?.url ?? req.url.split('?')[0] ?? '')) {
    const retryAfter = take(key, limit);
    if (retryAfter !== null) {
      app.log.warn({ path: req.url.split('?')[0], key }, 'rate limit hit');
      reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({
        error: `too many ${key} requests - wait ${retryAfter}s`,
        source: 'server',
        hint: 'This cap exists so a runaway loop or a compromised page cannot flood the exchange.',
      });
    }
  }
});

if (HOSTED) {
  // No local token (there is no Vite proxy to hand it over) and no hub.
  app.log.warn(
    {
      siteOrigins: SITE_ORIGINS,
      trustProxy: HOSTED_CONFIG.trustProxy,
      // How many values are accepted - never a value.
      originSecret: HOSTED_CONFIG.originSecrets.length ? `set (${HOSTED_CONFIG.originSecrets.length} accepted)` : 'not set',
      limitsPerMinute: Object.fromEntries(Object.entries(HOSTED_CONFIG.limits).map(([k, l]) => [k, l.max])),
      routes: HOSTED_ROUTES.map((r) => `${r.method} ${r.url}`),
      onInstanceOnly: ON_INSTANCE_ROUTES.map((r) => `${r.method} ${r.url}`),
    },
    'HOSTED MODE: public read-only index API - custodial routes, the hub and the local token are off',
  );
  if (HOSTED_CONFIG.originSecrets.length > 1) {
    // Meant for the minutes of a rotation; a forgotten old value stays valid for as long as it is listed.
    app.log.warn(
      `${HOSTED_CONFIG.originSecrets.length} origin secrets are accepted (a rotation): remove the old value from VALUESCAN_ORIGIN_SECRET once the edge sends the new one`,
    );
  }
  if (!SITE_ORIGINS.length) {
    app.log.warn('hosted mode without VALUESCAN_ALLOWED_ORIGINS: a site on another origin gets no CORS headers (a same-origin site is unaffected)');
  }
  for (const o of SITE_ORIGINS) if (!o.startsWith('https://')) app.log.warn({ origin: o }, 'hosted site origin is not https');
  if (HOSTED_CONFIG.trustProxy === false) {
    app.log.warn('hosted mode without VALUESCAN_TRUST_PROXY: behind a proxy every client shares the proxy address and its rate limit');
  }
} else {
  // Minted before the first request so the dev proxy always has a file to read.
  localToken();
  if (!TOKEN_REQUIRED) {
    app.log.warn('VALUETRADE_REQUIRE_TOKEN=0 - the local API accepts unauthenticated writes from any process on this machine');
  }

  startHub();
}

// --- no auto-unlock ------------------------------------------------------------

/**
 * There is deliberately NO unlock at boot.
 *
 * The one-click flow now mints a memory-only session key, so in the normal case
 * there is nothing on disk to unlock at all. What remains is a keystore the user
 * created explicitly under Advanced - and auto-unlocking that would recreate the
 * exact property this design removes: a fund-signing key armed in a long-running
 * process with no human present, reachable by anything that can reach the local
 * API, for as long as the machine is on.
 *
 * An existing keystore is therefore listed but left locked. Unlocking it is one
 * call to POST /api/session/unlock (no passphrase needed for a device-protected
 * record), which requires someone to actually be there.
 */
if (ks.load(KEYSTORE_PATH)) {
  app.log.warn(
    { keystore: KEYSTORE_PATH },
    'a keystore file from an older version is still on disk. Nothing writes one any more and ' +
      'nothing reads it to sign. Open the Wallet tab to move that key into memory and delete the ' +
      'file, or delete it yourself.',
  );
}

// --- optional env bootstrap --------------------------------------------------

if (BOOTSTRAP.privateKey && !ALLOW_ENV_KEY) {
  app.log.warn(
    { envFile: ENV_FILE },
    'SODEX_PRIVATE_KEY is set but IGNORED. A raw key in .env is plaintext on disk inside the ' +
      'cloud-synced project folder. Remove it, or set VALUETRADE_ALLOW_ENV_KEY=1 if this is a ' +
      'headless setup that genuinely cannot sign in a browser.',
  );
} else if (BOOTSTRAP.privateKey && BOOTSTRAP.apiKeyName && BOOTSTRAP.accountId) {
  try {
    const pk = BOOTSTRAP.privateKey.startsWith('0x') ? BOOTSTRAP.privateKey : '0x' + BOOTSTRAP.privateKey;
    const keyAddress = privateKeyToAddress(hexToBytes(pk));
    const address = BOOTSTRAP.address || keyAddress;

    /*
     * Ask the EXCHANGE what this key may do, rather than assuming.
     *
     * `permissions` on the wire is a mask of DISABLED bits, and an ordinary key
     * has no such field at all - which means everything is enabled, withdrawal
     * included. So a missing field is mask 0 (full access), not "no
     * permissions". The only reason to refuse is that the key is not registered.
     */
    let permissions: number | null = null;
    try {
      const keys = await sodex.get<any[]>(`${enginePath('spot')}/accounts/${address}/api-keys`);
      const match = (keys ?? []).find(
        (k) => String(k.name) === BOOTSTRAP.apiKeyName ||
          String(k.publicKey).toLowerCase() === keyAddress.toLowerCase(),
      );
      if (match) permissions = Number(match.permissions ?? 0);
    } catch (e) {
      app.log.warn({ err: (e as Error).message }, 'could not read the env key permissions from the exchange');
    }
    if (permissions === null) {
      app.log.error(
        { keyAddress },
        'refusing the env key: the exchange does not list it for this account (wrong name, wrong ' +
          'account, or it was revoked)',
      );
    } else {
      if (canMoveFunds(permissions)) {
        app.log.warn(
          { keyAddress, permissions },
          'the env key can move funds (withdraw or transfer are enabled on it) - anything that reads .env can drain the account',
        );
      }
      sodex.addSession({
        privateKey: hexToBytes(pk),
        apiKeyName: BOOTSTRAP.apiKeyName,
        accountId: Number(BOOTSTRAP.accountId),
        address,
        keyAddress,
        permissions,
      });
      app.log.warn(
        { keyAddress, apiKey: BOOTSTRAP.apiKeyName, permissions },
        'session unlocked from environment - a raw key is sitting in .env on disk',
      );
    }
  } catch (e) {
    app.log.error({ err: e }, 'SODEX_* environment bootstrap failed');
  }
}

// --- lifecycle ---------------------------------------------------------------

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.log.info('shutting down');
    upstreams.spot.close();
    upstreams.perps.close();
    // Any armed elevation is a live fund-moving key. It expires on its own, but
    // leaving one valid for up to three minutes after the app is gone is exactly
    // the window this design exists to remove.
    void revokeAllElevations()
      .catch(() => {})
      .finally(() => app.close().then(() => process.exit(0)));
  });
}

await app.listen({ host: HOST, port: PORT });

// Cohorts: the first load is built from behind a few seconds after the start
// (indexer/read.ts warmCohorts), so a restart does not leave the first visitor -
// and, the read being synchronous, the whole API with them - waiting for it.
setTimeout(() => {
  void Promise.all([import('./indexer/read.js'), import('./valuedesk/types.js')])
    .then(([r, t]) => r.warmCohorts(t.VENUES))
    .catch((e) => app.log.warn({ err: e }, 'cohorts warm-up failed'));
}, 3_000).unref();

// Official economic results at the release second (valuedesk/releases.ts): one
// watcher in this process, hosted or not; idle but for a minute's look at the
// calendar outside the minutes around a release. VALUESCAN_RELEASES=0 turns it off.
if (process.env.VALUESCAN_RELEASES !== '0') {
  const { startReleaseWatcher } = await import('./valuedesk/releases.js');
  startReleaseWatcher({ log: app.log });
}

// The status page's prober (ops/status.ts): every minute, the site, this API the way a visitor
// reaches it, the copy executor and the indexer. On a hosted server unless VALUESCAN_STATUS_PROBE=0.
if (proberEnabled(process.env, HOSTED)) {
  const [{ startStatusProber }, { indexerStatus }] = await Promise.all([import('./ops/status.js'), import('./indexer/read.js')]);
  startStatusProber({ indexerStatus, log: app.log });
}

// The owner's answers to feedback, read from Telegram by long polling (ops/telegramReplies.ts):
// a hosted server with ALERT_TELEGRAM_* set, unless VALUESCAN_FEEDBACK_REPLIES=0.
{
  const { repliesEnabled, startReplyPoller } = await import('./ops/telegramReplies.js');
  if (repliesEnabled(process.env, HOSTED)) {
    const { FeedbackStore } = await import('./ops/feedbackThreads.js');
    // ...and the status page's commands from the same chat (ops/statusTelegram.ts).
    const [{ statusTelegramHandler }, { StatusStore }] = await Promise.all([import('./ops/statusTelegram.js'), import('./ops/status.js')]);
    startReplyPoller(new FeedbackStore(), { log: app.log, onCommand: statusTelegramHandler({ open: () => new StatusStore(), log: app.log }) });
  }
}

// The leaderboard indexer (src/indexer): top and worst hundreds by PnL for
// every window, with every board member's fills. It runs on a worker thread
// so a board rebuild never holds an API request. Production runs it as its
// own process (`npm run indexer`) and sets VALUESCAN_INDEXER=0 here.
if (process.env.VALUESCAN_INDEXER !== '0' && process.env.VALUETRADE_TRADER_INDEX !== '0') {
  const { startIndexerWorker } = await import('./indexer/host.js');
  startIndexerWorker();
}

app.log.info(
  {
    network: NETWORK,
    chainId: NET.chainId,
    keystore: KEYSTORE_PATH,
    envFile: ENV_FILE_LOADED ? ENV_FILE : `${ENV_FILE} (not present - using defaults)`,
    mainnetWrites: NETWORK === 'mainnet' ? (ALLOW_MAINNET_WRITES ? 'ENABLED' : 'blocked') : 'n/a',
  },
  `Valuetrade backend on http://${HOST}:${PORT}`,
);
