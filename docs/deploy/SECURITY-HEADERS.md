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

This is the `<meta>` policy in `apps/web/index.html` (exact hosts, no wildcard; see
`docs/ARCH-traffic.md` §4), with three additions a `<meta>` tag cannot make or that only
matter in production:

1. `frame-ancestors 'none'`. It only works as a header.
2. `upgrade-insecure-requests` and `manifest-src 'self'`.
3. The hosted API's origin, if the API is not served from the site's own origin.

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://api.web3modal.org;
font-src 'self';
frame-src https://verify.walletconnect.org;
worker-src 'self';
connect-src 'self'
  https://mainnet-gw.sodex.dev wss://mainnet-gw.sodex.dev
  https://testnet-gw.sodex.dev wss://testnet-gw.sodex.dev
  https://mainnet-data.sodex.dev https://testnet-data.sodex.dev
  https://alpha-biz.sodex.dev
  https://api.hyperliquid.xyz https://mainnet.zklighter.elliot.ai https://api.arcus.xyz
  wss://relay.walletconnect.org https://api.web3modal.org
  https://main-scan.valuechain.xyz
  https://rpc.valuechain.xyz https://arb1.arbitrum.io https://mainnet.base.org
  https://ethereum-rpc.publicnode.com https://bsc-dataseed.bnbchain.org
  https://polygon-bor-rpc.publicnode.com
  __API_ORIGIN__;
form-action 'none';
base-uri 'none';
object-src 'none';
manifest-src 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

- **`__API_ORIGIN__`:** the hosted API's origin, e.g. `https://api.valuescan.example`. Omit it
  if `/api/*` is served from the site's own origin, because `'self'` covers it then.
- **Keep the header equal to `index.html`.** When that policy changes, change this header in
  the same deploy. **Never reintroduce a `ws:`/`wss:`/`https:` wildcard.**
- **Testnet hosts:** a deployment that can only ever run mainnet may drop the testnet ones.
- **Length:** a header is one line; join the policy with single spaces. CloudFront limits a
  response headers policy's CSP value to 1783 characters, and this policy is about 900.

### 1.2.1 The SharedWorker script

**A worker does not inherit the page's policy.** Its CSP comes from the HTTP headers of the
response that delivered its script (`docs/ARCH-traffic.md` §4).

- **Why it matters:** the web's socket host is a module SharedWorker holding every exchange
  socket (`apps/web/src/exchange/ws/worker.ts`). Without a header on that script response it
  runs with **no CSP at all**, and the `<meta>` tag cannot reach it.
- **The build output:** Vite emits the worker as `/assets/worker-<hash>.js`. Confirm the name
  in the build's `assets/` folder.

Send one of these two headers:

**A. Recommended: the site policy on every response.** Send the §1.2 header on every response,
`/assets/*.js` included. A CSP header on an ordinary script response is ignored, so this is
harmless for the rest, and the worker gets exactly the page's policy:
`connect-src` lists the SoDEX gateways over `wss`, and `script-src 'self'` covers its own
module imports.

**B. Tightest: a worker-only policy** on the worker script's response, and only there:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self' wss://mainnet-gw.sodex.dev wss://testnet-gw.sodex.dev; base-uri 'none'
```

This policy covers exactly what the socket host does:

- it opens only the two SoDEX gateway origins over `wss`, checked again inside the worker by
  `exchange/ws/allowed.ts`;
- it imports only its own modules from `'self'`;
- it fetches nothing else.

If a build points the app at another gateway (`VITE_SODEX_GATEWAY`), add that gateway's
`wss://` origin to both policies.

With either option, the worker's own allow-list check stays the first line of defence. The
header is the second.

- **CloudFront:** add a behaviour for the path pattern `/assets/worker-*.js`, with the same
  origin and cache policy as `/assets/*`, and a response headers policy identical to the site
  one (§1.3) except that its `ContentSecurityPolicy` is option B.
- **Caddy:** see the `@worker` matcher in §1.4.

Check it after a deploy. Both commands must print the policy:

```
curl -sI https://<site>/assets/worker-<hash>.js | grep -i content-security-policy
curl -sI https://<site>/ | grep -i content-security-policy
```

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
- `/assets/worker-*.js` (optional, only for option B of 1.2.1): attach a fourth, whose
  `ContentSecurityPolicy` is the worker-only policy. Otherwise the site policy on `/assets/*`
  already covers the SharedWorker (option A).

For `/api/*`, attach a policy that only sets HSTS with `Override: false`. The API sends its
own headers (section 2); do not overwrite them.

### 1.4 Caddy (site on an instance instead of S3)

Replace `<CSP>` and `<CSP with the /scan hash>` with the one-line policies from 1.2. The global
`header` block sends the site policy on every response, `/assets/*.js` included, which covers
the SharedWorker (1.2.1, option A). The `@worker` lines are option B; drop them to keep A.

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
	@worker path /assets/worker-*.js
	header @worker Content-Security-Policy "default-src 'none'; script-src 'self'; connect-src 'self' wss://mainnet-gw.sodex.dev wss://testnet-gw.sodex.dev; base-uri 'none'"

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
| `VALUESCAN_RATE_UPSTREAM_PER_MIN` | 120 | Per client: reads that can cost upstream calls. These are leaderboard search (`/api/vs/leaderboard?q=`), deep links by account id (`/api/feed/account`) and one announcement (`/api/external/announcements/:id`). |
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
- **Route allow-list:** only the list in `hosted.ts` answers; every other route is 404. The
  list is final, per `docs/ARCH-traffic.md` §5: 16 routes, all GET.
  - **Index routes:** `/api/health`, the leaderboard, explore, the 5 cohort routes, the
    screener, whales and positioning.
  - **`/api/vs/lbrow`:** one Hyperliquid leaderboard row for a Scan profile.
  - **`/api/feed/account`:** deep links by account id.
  - **Maintenance:** the maintenance status and the announcements.
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
