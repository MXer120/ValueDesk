// The response headers production sends with the site, per path - the values of
// deploy/aws/edge.yaml (CloudFront response headers policies), which are
// docs/deploy/SECURITY-HEADERS.md section 1.
//
// The smoke test's static server applies exactly these, so a page that works
// locally under them works behind CloudFront. deploy/aws/validate_offline.py
// fails when this file and edge.yaml drift apart.
//
//   node deploy/smoke/prod-headers.mjs --json     the table, for the validator
import { pathToFileURL } from 'node:url';

// Order matters only for deploy/aws/validate_offline.py, which compares this list,
// joined, with edge.yaml's text: keep both in the same order.
const CONNECT_SRC = [
  "'self'",
  'https://mainnet-gw.sodex.dev', 'wss://mainnet-gw.sodex.dev',
  'https://testnet-gw.sodex.dev', 'wss://testnet-gw.sodex.dev',
  'https://mainnet-data.sodex.dev', 'https://testnet-data.sodex.dev',
  'https://alpha-biz.sodex.dev',
  // wss: the browser copier's userFills stream.
  'https://api.hyperliquid.xyz', 'wss://api.hyperliquid.xyz',
  // A self-hosted copy executor on the follower's own machine (apps/executor: loopback,
  // plain http, any port). Loopback only - never a scheme-wide http: source.
  'http://127.0.0.1:*', 'http://localhost:*',
  'https://mainnet.zklighter.elliot.ai', 'https://api.arcus.xyz',
  'wss://relay.walletconnect.org', 'https://api.web3modal.org',
  // Reown's usage reports: sent only with the visitor's consent (legal/reownConsent.ts).
  'https://pulse.walletconnect.org',
  'https://main-scan.valuechain.xyz',
  'https://rpc.valuechain.xyz', 'https://arb1.arbitrum.io', 'https://mainnet.base.org',
  'https://ethereum-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org',
  'https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io',
  // The Fed live widget: the Federal Reserve's broadcast (Brightcove: manifests, segments).
  'https://*.boltdns.net', 'https://*.brightcovecdn.com',
  // The live liquidation heatmap: a WebSocket straight to the instance (apps/server routes/liqWs.ts).
  'wss://161-97-154-121.sslip.io',
];

/** The inline script of apps/web/public/scan/index.html (the redirect for old links). */
export const SCAN_SCRIPT_HASH = "'sha256-bXJtqdhzu4xrNuZI44nF3t24LtnovVLjGKp0GValFLk='";

const sitePolicy = (scriptSrc) => [
  "default-src 'self'",
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://api.web3modal.org https://*.boltdns.net",
  "font-src 'self'",
  'frame-src https://verify.walletconnect.org https://www.youtube.com https://player.twitch.tv https://player.kick.com https://player.vimeo.com',
  "worker-src 'self'",
  // The Fed live widget's player (Media Source Extensions).
  "media-src 'self' blob:",
  `connect-src ${CONNECT_SRC.join(' ')}`,
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

export const CSP = {
  /** Every site response, /assets/*.js included (the SharedWorker reads it from its own script). */
  // wasm-unsafe-eval: WebAssembly only (the Fed live widget's speech model), never eval.
  site: sitePolicy("'self' 'wasm-unsafe-eval'"),
  /** /scan/*: the site policy plus the hash of the one inline script. */
  scan: sitePolicy(`'self' 'wasm-unsafe-eval' ${SCAN_SCRIPT_HASH}`),
  /** /logos/* and /addrbook/*: third-party SVGs - nothing may run in one opened directly. */
  images: "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
};

/** Sent with every site response. */
export const HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'accelerometer=(), autoplay=(self "https://www.youtube.com" "https://player.twitch.tv" "https://player.kick.com" "https://player.vimeo.com"), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=(), browsing-topics=(), clipboard-read=(), clipboard-write=(self), fullscreen=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-XSS-Protection': '0',
};

/**
 * Whether a CSP source list allows an origin ("https://host[:port]"), for the checks
 * that judge what a page contacted: an exact entry, or a host source with a port
 * wildcard (http://127.0.0.1:* allows http://127.0.0.1:8799). Keywords and scheme
 * sources are not interpreted - connect-src has none but 'self'. Stricter than a
 * browser in one way: CSP 3 also lets http://h:* match https:// and ws(s):// on h;
 * this does not.
 */
export function sourceAllows(sources, origin) {
  const list = [...sources];
  if (list.includes(origin)) return true;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  return list.some((s) => {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/:]+):\*$/i.exec(s);
    return !!m && u.protocol === `${m[1].toLowerCase()}:` && u.hostname === m[2].toLowerCase();
  });
}

/** Which policy a path gets: the cache behaviours of edge.yaml, in CloudFront's precedence. */
export function policyFor(pathname) {
  if (pathname.startsWith('/logos/') || pathname.startsWith('/addrbook/')) return 'images';
  if (pathname.startsWith('/scan/')) return 'scan';
  return 'site';
}

/**
 * Cache-Control per published file, as deploy/release/publish-web.sh sets it on the
 * S3 objects (docs/deploy/SECURITY-HEADERS.md 1.1, docs/PERFORMANCE.md "Deployment notes").
 * `file` is the path of the object that is served, e.g. /index.html for an app route.
 */
export function cacheControlFor(file) {
  if (file.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (file.endsWith('.html')) return 'no-cache';
  if (file.startsWith('/logos/') || file.startsWith('/addrbook/')) return 'public, max-age=86400, stale-while-revalidate=604800';
  return 'public, max-age=3600';
}

/**
 * The object a site path is answered with: edge.yaml's CloudFront function.
 * App routes (last segment without a dot) get the shell; /scan/ is the legacy page.
 */
export function rewrite(pathname) {
  if (pathname === '/scan/') return '/scan/index.html';
  const name = pathname.slice(pathname.lastIndexOf('/') + 1);
  return name.includes('.') ? pathname : '/index.html';
}

/** Every header a site response carries for `pathname` (the request path, before the rewrite). */
export function headersFor(pathname) {
  return {
    ...HEADERS,
    'Content-Security-Policy': CSP[policyFor(pathname)],
    'Cache-Control': cacheControlFor(rewrite(pathname)),
  };
}

// Run directly: print the table for deploy/aws/validate_offline.py.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ csp: CSP, headers: HEADERS }));
}
