# Production security headers, TLS and the hosted API

Status: 2026-09-30, written with the security audit (`docs/security/AUDIT-2026-09-30.md`).
It covers:

- the static site: `apps/web/dist` on CloudFront + S3, or on a small instance behind Caddy;
- the API/indexer instance, which runs the server in hosted mode (`VALUESCAN_HOSTED=1`).

The dev server's anti-framing headers (`apps/web/vite.config.ts`) apply to the dev server
only. The `<meta>` CSP in `apps/web/index.html` cannot carry `frame-ancestors`. Until the
headers below are configured, production has **no clickjacking protection**. Both
`index.html`'s CSP and `vite.config.ts` belong to other agents. This file is the deploy-side
counterpart.

---

## 1. The static site

### 1.1 Header set

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | see 1.2 | Script injection is the attack that matters in a trading UI. `frame-ancestors` only works as a header. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | Two years, and every subdomain. Add `; preload` only after every subdomain is HTTPS-only and the apex is submitted to hstspreload.org. Removing a domain from the preload list later takes months. |
| `X-Frame-Options` | `DENY` | Anti-framing for browsers without CSP level 2. |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Other sites see our origin, never a path or query. Our paths and queries carry wallet addresses. `no-referrer` (the dev value) also works, but it may stop WalletConnect Verify from attesting the domain. |
| `Permissions-Policy` | `accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=(), browsing-topics=(), clipboard-read=(), clipboard-write=(self), fullscreen=(self)` | The app uses clipboard writes (copy buttons) and fullscreen (charts), nothing else. Wallet popups are their own browsing contexts and are not affected. |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | Isolates the window from pages that open it. Wallet popups the app opens itself, such as the Coinbase Wallet SDK, keep their `window.opener`. Plain `same-origin` would break those popups. |
| `Cross-Origin-Resource-Policy` | `same-origin` | Other sites cannot embed our assets. |
| `X-XSS-Protection` | `0` | Turns off the legacy XSS auditor, which could itself be abused. |
| `Cache-Control` | `index.html` and `/scan/index.html`: `no-cache`. `/assets/*` (hashed): `public, max-age=31536000, immutable` | A security fix reaches users on their next load, not after a CDN TTL. |

Do **not** send `Cross-Origin-Embedder-Policy: require-corp`. It would block AppKit's
third-party wallet images and fonts, because those hosts send no CORP header.

### 1.2 Content-Security-Policy (header form)

This is the `<meta>` policy from `apps/web/index.html` with four changes:

1. `frame-ancestors 'none'` is added. It only works as a header.
2. The `ws: wss:` wildcards are replaced by the exact WebSocket origins. The wildcards let any
   injected script send data to any host. `ws:` also allows plaintext.
3. The testnet hosts are dropped. A production site is mainnet-only. Keep them only if the
   production build can switch networks.
4. `upgrade-insecure-requests` and `worker-src 'self'` are added. The copy simulator runs in a
   same-origin worker.

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://explorer-api.walletconnect.com https://api.web3modal.org;
font-src 'self' https://fonts.reown.com;
frame-src https://verify.walletconnect.org https://verify.walletconnect.com;
worker-src 'self';
connect-src 'self'
  https://mainnet-gw.sodex.dev wss://mainnet-gw.sodex.dev
  https://mainnet-data.sodex.dev https://alpha-biz.sodex.dev
  https://rpc.valuechain.xyz https://main-scan.valuechain.xyz
  https://arb1.arbitrum.io https://mainnet.base.org https://ethereum-rpc.publicnode.com
  https://bsc-dataseed.bnbchain.org https://polygon-bor-rpc.publicnode.com
  https://relay.walletconnect.org wss://relay.walletconnect.org
  https://relay.walletconnect.com wss://relay.walletconnect.com
  https://explorer-api.walletconnect.com https://api.web3modal.org https://fonts.reown.com
  https://api.hyperliquid.xyz https://mainnet.zklighter.elliot.ai https://api.arcus.xyz
  __API_ORIGIN__ __BROWSER_DIRECT_ORIGINS__;
form-action 'none';
base-uri 'none';
object-src 'none';
manifest-src 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

Fill in the two placeholders before deploying:

- `__API_ORIGIN__`: the hosted API's origin, e.g. `https://api.valuescan.example`. Omit it if
  CloudFront serves `/api/*` from the site's own origin; `'self'` then covers it.
- `__BROWSER_DIRECT_ORIGINS__`: any further exchange host in `docs/ARCH-traffic.md`. The three
  browser-direct REST hosts already known are listed above, from `apps/web/src/exchange/hosts.ts`:
  Hyperliquid info, Lighter and Arcus. Today's `index.html` does not list them yet.
  - If one of them is also streamed from, add its exact `wss://` origin. Today the browser's
    own sockets go only to the SoDEX gateway.
  - **Do not reintroduce `wss:` as a wildcard.**

**The header policy reaches places the `<meta>` policy cannot.** A worker's policy comes from
the response that delivered the worker script. The web's SharedWorker, which holds every
exchange socket, therefore runs with **no** CSP unless this header is sent. The same applies
to an SVG file opened directly. So send the header on every response of the site, including
`/assets/*`.

**Parity with dev.** This policy allows exactly what the dev `<meta>` policy allows, plus the
three exchange hosts. Two differences stay unresolved, and changing them changes behaviour,
so they are for the owner of `index.html` and `walletconnect.ts`:

- **`https://rpc.walletconnect.org` is used but blocked, in dev and prod alike.**
  WalletConnect's universal provider falls back to it for any chain without its own RPC
  entry. The fix is to give every EVM chain an RPC already listed here
  (`walletconnect.ts`), not to widen the CSP.
- **`https://verify.walletconnect.org` is allowed as a frame but not as `connect-src`.** Verify
  also fetches its public key from that host.

Some allowed hosts appear unused: `explorer-api.walletconnect.com`, the `https://` relay
origins and `fonts.reown.com`. Remove them after checking the Network tab with a real
pairing.

Headers are one line. Join the policy with single spaces. CloudFront limits a response
headers policy's CSP value to 1783 characters, and this policy is about 1,100 before the
placeholders.

**Image directories.** `/logos/*` and `/addrbook/*` hold third-party SVGs (see the audit,
W-09). Serve them with a policy under which nothing can run:

```
default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox
```

**Deploy only from a fresh `vite build`.** The checked-out `apps/web/dist` is stale: it still
contains `verify/` and the old scan scripts.

**The old `/scan/` redirect page** (`apps/web/public/scan/index.html`) keeps one inline
script. It forwards saved `?address=` links. Serve that one path with the same policy, plus
the script's hash:

```
script-src 'self' 'sha256-bXJtqdhzu4xrNuZI44nF3t24LtnovVLjGKp0GValFLk='
```

Recompute the hash if that script changes, with this command:

```
node -e "const h=require('fs').readFileSync('apps/web/public/scan/index.html','utf8');console.log(require('crypto').createHash('sha256').update(/<script>([\s\S]*?)<\/script>/.exec(h)[1]).digest('base64'))"
```

The file must have LF line endings, which `.gitattributes` enforces. Without the hash, the
`<meta refresh>` fallback still redirects, but it drops the address.

The rest of `apps/web/public/scan/*.js` is dead code: nothing loads it any more. Delete it
from the deploy, or from the repo.

### 1.3 CloudFront

**Distribution:**

- Viewer protocol policy: *Redirect HTTP to HTTPS*.
- Security policy: `TLSv1.2_2021`.
- HTTP/2 and HTTP/3: on.
- Certificate: ACM, in `us-east-1`.

**S3 origin:**

- Private bucket, reached through Origin Access Control (OAC).
- Block Public Access: on. The website endpoint stays off.
- Default root object: `index.html`.
- SPA fallback: map a 403 or 404 from S3 to `/index.html` with status 200, but only on the
  site behaviour, never on `/api/*`.

**Behaviours:**

- `/assets/*`: cache policy *Managed-CachingOptimized*.
- `index.html` and the default behaviour: TTL 0, or origin `Cache-Control: no-cache`.
- `/api/*`: send it to the API origin (section 2) with cache policy *Managed-CachingDisabled*
  and origin request policy *Managed-AllViewerExceptHostHeader*. The latter forwards the
  query string, the `Origin` header and the viewer headers.

Response headers policy for the site behaviours, as `aws cloudfront
create-response-headers-policy --response-headers-policy-config file://site-headers.json`:

```json
{
  "Name": "valuescan-site-security",
  "Comment": "docs/deploy/SECURITY-HEADERS.md section 1",
  "SecurityHeadersConfig": {
    "ContentSecurityPolicy": { "Override": true, "ContentSecurityPolicy": "<the one-line policy from 1.2>" },
    "StrictTransportSecurity": { "Override": true, "AccessControlMaxAgeSec": 63072000, "IncludeSubdomains": true, "Preload": false },
    "FrameOptions": { "Override": true, "FrameOption": "DENY" },
    "ContentTypeOptions": { "Override": true },
    "ReferrerPolicy": { "Override": true, "ReferrerPolicy": "strict-origin-when-cross-origin" },
    "XSSProtection": { "Override": true, "Protection": false }
  },
  "CustomHeadersConfig": {
    "Quantity": 3,
    "Items": [
      { "Header": "Permissions-Policy", "Override": true, "Value": "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=(), browsing-topics=(), clipboard-read=(), clipboard-write=(self), fullscreen=(self)" },
      { "Header": "Cross-Origin-Opener-Policy", "Override": true, "Value": "same-origin-allow-popups" },
      { "Header": "Cross-Origin-Resource-Policy", "Override": true, "Value": "same-origin" }
    ]
  },
  "RemoveHeadersConfig": { "Quantity": 1, "Items": [ { "Header": "Server" } ] }
}
```

Other behaviours need their own copies of this policy:

- `/scan/*`: attach a second policy that is identical except for the `script-src` hash above.
- `/logos/*` and `/addrbook/*`: attach a third, with the image-directory CSP from 1.2.

For `/api/*`, attach a policy that only sets HSTS with `Override: false`. The API sends its
own headers (section 2); do not overwrite them.

### 1.4 Caddy (site on an instance instead of S3)

Replace `<CSP>` and `<CSP with the /scan hash>` with the one-line policies from 1.2.

```caddyfile
valuescan.example {
	root * /srv/valuescan/dist
	encode zstd gzip

	header {
		Content-Security-Policy "<CSP>"
		Strict-Transport-Security "max-age=63072000; includeSubDomains"
		X-Frame-Options "DENY"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=(), browsing-topics=(), clipboard-read=(), clipboard-write=(self), fullscreen=(self)"
		Cross-Origin-Opener-Policy "same-origin-allow-popups"
		Cross-Origin-Resource-Policy "same-origin"
		X-XSS-Protection "0"
		-Server
	}

	@scan path /scan/ /scan/index.html
	header @scan Content-Security-Policy "<CSP with the /scan hash>"
	@images path /logos/* /addrbook/*
	header @images Content-Security-Policy "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"

	@assets path /assets/*
	header @assets Cache-Control "public, max-age=31536000, immutable"
	@html path / /index.html /scan/ /scan/index.html
	header @html Cache-Control "no-cache"

	# Same-origin API (optional): /api/* to the hosted server on loopback.
	handle /api/* {
		reverse_proxy 127.0.0.1:8797
	}

	try_files {path} /index.html
	file_server
}
```

---

## 2. The API in hosted mode

### 2.1 The switch

`VALUESCAN_HOSTED=1` turns the server into the public, read-only index API. The code is in
`apps/server/src/hosted.ts` and `index.ts`. Unset, local dev behaves exactly as before.

| Variable | Default | Meaning |
|---|---|---|
| `VALUESCAN_HOSTED` | unset | `1` = hosted mode. |
| `VALUESCAN_ALLOWED_ORIGINS` (legacy name: `VALUETRADE_ALLOWED_ORIGINS`) | none | The site's origins, comma-separated, exact (`https://valuescan.example`). CORS answers only these. They would also be the only `Origin` a state-changing route accepts, but none is listed today. Not needed when the site and API share an origin. A malformed entry stops the boot. |
| `VALUESCAN_TRUST_PROXY` | unset (the socket address is the client) | Who may set `X-Forwarded-For`. Either a hop count 1–9, or IPs/CIDRs plus `loopback` / `linklocal` / `uniquelocal`. `true` / `*` is refused. See 2.3. |
| `VALUESCAN_ORIGIN_SECRET` | unset | At least 32 characters. When set, every request except `/api/health` must carry `X-Origin-Verify: <secret>`. Set it as a CloudFront origin custom header, so that nobody can bypass CloudFront and WAF by calling the instance directly. |
| `VALUESCAN_RATE_READ_PER_MIN` | 600 | Per client: every allowed request. |
| `VALUESCAN_RATE_UPSTREAM_PER_MIN` | 120 | Per client: reads that can cost upstream calls. These are per-address and per-coin reads (`/api/vs/trader`, `fills`, `account`, `price`, leaderboard search, the `/api/external/*` lookups and `/api/feed/account`). |
| `VALUESCAN_RATE_AUTH_PER_MIN` | 20 | Per client: `auth`-class routes. None is listed today, because the SoPoints sign-in relay is unused and therefore 404. |
| `VALUESCAN_RATE_AUTH_GLOBAL_PER_MIN` | 300 | All clients together: `auth`-class routes. |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Keep `HOST` on loopback behind Caddy. |
| `VALUESCAN_INDEXER` | on | Run the indexer in this process. Set `0` on extra API nodes; see `docs/INDEXER.md`. |

A client is an IPv4 address or an IPv6 /64. Hosted mode also enforces the following, whatever
the other variables say:

- **Custodial off:** server signing and the `.env` key bootstrap are off. The custodial route
  plugins are not registered, and custodial paths answer 410.
- **Hub off:** the WebSocket hub and `/ws` are not registered.
- **Local token off:** the local token is neither minted nor required.
- **Route allow-list:** only the list in `hosted.ts` answers; every other route is 404. Today
  it holds 23 routes, all GET: 9 index routes and 14 marked provisional. The list is
  **provisional** until `docs/ARCH-traffic.md` is final.
- **CORS:** the site origins only. No loopback origins, no `DELETE`.
- **Minimal `/api/health`:** `{ ok, network, chainId, mainnetWritesAllowed }`.
- **Request limits:** 16 KiB request bodies, a 30 s request timeout, and a 400 for repeated
  query parameters.
- **Logs:** request logs record the path only, never the query string.

### 2.2 Headers the API sends

Every mode:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Cross-Origin-Resource-Policy: same-origin`
- `Cache-Control: no-store`, unless a route sets its own

Hosted mode adds:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains`
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`

For site origins, CORS sends `Access-Control-Allow-Origin` and `Vary: Origin`. Nothing is
cached at the edge unless a route opts in (the performance plugin). If it does, the cache
key must include the query string and the `Origin` header.

### 2.3 Topologies: getting the client address right

Rate limits are only as good as the address they are keyed on. Pick one topology:

**A. Caddy on the API instance, no CloudFront for `/api`.** Recommended for one box.
Caddy distrusts incoming `X-Forwarded-For` by default and replaces it with the real peer.

```
VALUESCAN_TRUST_PROXY=loopback
HOST=127.0.0.1
```

```caddyfile
api.valuescan.example {
	reverse_proxy 127.0.0.1:8797
	header -Server
}
```

**B. CloudFront, then Caddy (HTTPS), then the app.**

1. Restrict the instance's security group, inbound 443, to the AWS-managed prefix list
   `com.amazonaws.global.cloudfront.origin-facing`.
2. Add the CloudFront origin custom header `X-Origin-Verify: <secret>`.
3. Caddy must keep CloudFront's `X-Forwarded-For`. The security group already limits the port
   to CloudFront, so trusting every peer at Caddy is equivalent to trusting CloudFront.

```
VALUESCAN_TRUST_PROXY=2
VALUESCAN_ORIGIN_SECRET=<same secret>
HOST=127.0.0.1
```

Hop 0 is Caddy on loopback, hop 1 is the CloudFront edge, and hop 2 is the viewer that
CloudFront appended.

```caddyfile
{
	servers {
		trusted_proxies static 0.0.0.0/0 ::/0
	}
}
origin-api.valuescan.example {
	reverse_proxy 127.0.0.1:8797
}
```

**C. CloudFront straight to the app over HTTP.** Not recommended: the origin secret and all
traffic cross the internet in clear text. If you use it anyway:

- set `VALUESCAN_TRUST_PROXY=1`;
- restrict the security group to the prefix list above;
- set `HOST=0.0.0.0`.

Never set `VALUESCAN_TRUST_PROXY` to more hops than there really are proxies. Every extra
hop lets a client choose its own rate-limit key.

### 2.4 Edge backstop

Attach AWS WAF to the distribution with a rate-based rule on `/api/*`, for example 2,000
requests per 5 minutes per IP, action *Block*. It is a coarse backstop against floods from
many addresses, which per-client limits cannot see. Add the managed rule groups
*AWSManagedRulesCommonRuleSet* and *AWSManagedRulesKnownBadInputsRuleSet*.

### 2.5 Operations

- **Logs:** they keep client IPs, which are needed for abuse handling. Keep them 14 days or
  less. They are personal data under GDPR, alongside any wallet address that reaches a log
  line.
- **Updates:** run `npm ci` from the committed lockfile. Never run `npm install` on the
  server.
- **Process user:** run the process as an unprivileged user, and keep the index DB on a
  separate volume (`VALUESCAN_INDEX_DB`).
- **Firewall:** do not open 8797 or 8787 publicly.

---

## 3. TLS

- **Protocols:** TLS 1.2 minimum and 1.3 preferred everywhere.
  - CloudFront: `TLSv1.2_2021`.
  - Caddy: the default `protocols tls1.2 tls1.3`.
  - Origin protocol from CloudFront: *HTTPS only*, TLSv1.2.
- **Certificates:** ACM (`us-east-1`) for CloudFront. Caddy obtains and renews its own and
  staples OCSP by default.
- **HTTP:** redirect it to HTTPS everywhere. HSTS is as in 1.1 and 2.2.
- **DNS:** add CAA records naming only the CAs actually used, `amazon.com` and
  `letsencrypt.org`.
