# Production security headers, TLS and the hosted API

Status: 2026-09-30, written with the security audit (`docs/security/AUDIT-2026-09-30.md`);
brought in line with the deployment that was built, 2026-10-02 (`deploy/`, commit 5406b3d).
It covers:

- the static site: `apps/web/dist` on CloudFront + S3, or on a small instance behind Caddy;
- the API/indexer instance, which runs the server in hosted mode (`VALUESCAN_HOSTED=1`).

**This page says why; `deploy/` is what runs.** The deployed values live in these files, and
a change to one side is a change to the other in the same commit:

| What | Where it is deployed from | What checks it |
|---|---|---|
| CloudFront: behaviours, cache policies, response headers policies, the SPA rewrite, WAF | `deploy/aws/edge.yaml` | `deploy/aws/validate_offline.py` (offline) |
| The header table per path | `deploy/smoke/prod-headers.mjs` | `deploy/smoke/smoke.test.mjs`; after a deploy `node deploy/smoke/smoke.mjs --site=<url>` |
| Caddy on the origin | `deploy/server/caddy/Caddyfile.template` | `deploy/server/bootstrap.sh` (`caddy validate`) |
| Security group of the origin | `deploy/aws/network.yaml` | `smoke.mjs --site=<url> --origin=<origin host>` |
| The API's hosted settings | `deploy/server/env/api.env.example` | `deploy/server/bin/healthcheck.mjs` (`lockdown`, `index`) |

How to roll it out and operate it is `docs/deploy/DEPLOY.md`.

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

- **CloudFront, as deployed: option A.** `deploy/aws/edge.yaml` attaches the site policy to
  `/assets/*`, so the worker script carries the page's policy and nothing else is needed.
- **CloudFront, option B:** add a behaviour for the path pattern `/assets/worker-*.js`, with
  the same origin and cache policy as `/assets/*`, and a response headers policy identical to
  the site one (§1.3) except that its `ContentSecurityPolicy` is option B.
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
- The bucket policy grants the distribution `s3:GetObject` only, not `s3:ListBucket`. A file
  that is not there is therefore a 403 from S3, never a listing and never the shell.

**SPA fallback: a CloudFront Function, never custom error responses.**

The app has flat client-side routes (`/trade`, `/explore`, `/scan?address=…`) that are not
objects in the bucket. They get the shell from a viewer-request function, `SpaRewriteFunction`
in `edge.yaml`, attached to the **site behaviours only** (the default one and `/scan/*`):

- `/scan/` becomes `/scan/index.html` (the old redirect page);
- a path whose last segment has no dot becomes `/index.html`;
- everything else, `/assets/…js` or `/favicon.svg`, is asked for as it is.

Do **not** build the fallback from custom error responses ("map 403/404 to `/index.html`
with status 200"), although that is the usual recipe. An earlier version of this page said
to do that "only on the site behaviour"; that cannot be done:

- **Custom error responses belong to the distribution, not to a behaviour.** They would also
  turn the API's own 403 and 404 into `200 index.html`.
- **The API's statuses carry meaning.** A 403 is the origin secret being refused, a 404 a
  route that hosted mode does not serve, and the web reads both. As `200` plus HTML they
  would look like a working API returning something unparsable, and the production smoke
  test's gate checks (`smoke.mjs`: "diagnostics are not served" expects 404) could not tell
  a locked-down server from an open one.
- **A missing asset must stay an error.** With the function, `/assets/gone-123.js` is a 403.
  With error responses it would be the shell with status 200, under a script's URL.

**Behaviours** (`edge.yaml`; the first match wins):

| Path | Origin | Cache policy | Response headers policy | Notes |
|---|---|---|---|---|
| `/api/*` | the instance (section 2) | `ApiCachePolicy`: honours the API's `Cache-Control`, never beyond 60 s; the key is path + query string + `Origin` | `ApiHeadersPolicy` | HTTPS only (no redirect). `GET`, `HEAD`, `OPTIONS`: no other method reaches the origin. |
| `/assets/*` | S3 | *Managed-CachingOptimized* | site | Content-hashed files; this is also where the SharedWorker script is (§1.2.1, option A). |
| `/logos/*`, `/addrbook/*` | S3 | `SiteCachePolicy` | images | The image-directory CSP from §1.2. |
| `/scan/*` | S3 | `SiteCachePolicy` | scan | The site policy plus the script hash; SPA function attached. |
| default | S3 | `SiteCachePolicy`: honours the object's `Cache-Control`; nothing in the key but the path | site | SPA function attached. |

- **Site objects carry their own `Cache-Control`**, set when a release is published
  (`deploy/release/publish-web.sh`): HTML `no-cache`, `/assets/*` a year and `immutable`,
  logos a day. An object published without the header is not cached at all.
- **`/api/*` is not "caching disabled".** Most answers are `no-store` and pass straight
  through; the index routes opt in to a few seconds (the performance plugin, §2.2). That is
  only safe because the cache key holds the query string and the `Origin` header. Do not
  swap the policy for one with a smaller key.
- **No origin request policy on `/api/*`.** Only what is in the cache key is forwarded: the
  query string, `Origin` and a normalised `Accept-Encoding`. No cookie reaches the API, and
  no other header of the viewer's. CloudFront adds `X-Forwarded-For`, `Via` and the origin
  custom header itself (§2.3 B).

Response headers policy for the site behaviours (`SiteHeadersPolicy` in `edge.yaml`), in the
form `aws cloudfront create-response-headers-policy --response-headers-policy-config
file://site-headers.json` takes:

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

For `/api/*`, attach a policy that only sets HSTS with `Override: false` and removes
`Server` (`ApiHeadersPolicy`). The API sends its own headers (section 2); do not overwrite
them.

### 1.4 Caddy (site on an instance instead of S3)

This is the alternative to §1.3; `deploy/` does not build it. Here Caddy faces the internet
on 443 itself, so it can obtain its certificate over either ACME challenge with its
defaults (ports 80 and 443 open). The origin behind CloudFront is a different case: §2.3 B.

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
| `VALUESCAN_ORIGIN_SECRET` | unset | One secret, or `<current>,<next>` while it is rotated (§2.6). Each value is at least 32 characters of visible ASCII; a comma only ever separates. When set, every request except `/api/health` must carry `X-Origin-Verify` with exactly one of the values (and see §2.7 for the one route answered on the instance). Set it as a CloudFront origin custom header, so that nobody can bypass CloudFront and WAF by calling the instance directly. An empty entry, a short value or more than 4 values stops the boot. |
| `VALUESCAN_RATE_READ_PER_MIN` | 600 | Per client: every allowed request. |
| `VALUESCAN_RATE_UPSTREAM_PER_MIN` | 120 | Per client: reads that can cost upstream calls. These are leaderboard search (`/api/vs/leaderboard?q=`), deep links by account id (`/api/feed/account`) and one announcement (`/api/external/announcements/:id`). |
| `VALUESCAN_RATE_AUTH_PER_MIN` | 20 | Per client: `auth`-class routes. None is listed today, because the SoPoints sign-in relay is unused and therefore 404. |
| `VALUESCAN_RATE_AUTH_GLOBAL_PER_MIN` | 300 | All clients together: `auth`-class routes. |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Keep `HOST` on loopback behind Caddy. The deployment sets `PORT=8797`, which is the port every example on this page uses. |
| `VALUESCAN_INDEXER` | on | Run the indexer in this process. The deployment sets `0`: the indexer is its own service, and the API only reads the index file; see `docs/INDEXER.md`. |

A client is an IPv4 address or an IPv6 /64. Hosted mode also enforces the following, whatever
the other variables say:

- **Custodial off:** server signing and the `.env` key bootstrap are off. The custodial route
  plugins are not registered, and custodial paths answer 410.
- **Hub off:** the WebSocket hub and `/ws` are not registered.
- **Local token off:** the local token is neither minted nor required.
- **Route allow-list:** only the list in `hosted.ts` answers; every other route is 404. The
  list is final, per `docs/ARCH-traffic.md` §5: 17 routes, all GET.
  - **Index routes:** `/api/health`, the leaderboard, explore, the 5 cohort routes, the
    screener, whales and positioning.
  - **`/api/vs/lbrow`:** one Hyperliquid leaderboard row for a Scan profile.
  - **`/api/feed/account`:** deep links by account id.
  - **`/api/vs/builder/terms`:** the builder fee a wallet owes, signed (`docs/BUILDER-TIERS.md` §3).
    Class `read`; a request with `hint=1` counts as `upstream` too.
  - **Maintenance:** the maintenance status and the announcements.
- **Diagnostics stay on the instance:** `/api/vs/index/status` (the indexer's full status,
  with wallet addresses and error text) is 404 for every caller. `/api/vs/index/health`, a
  numbers-only view of it, answers a caller on the instance and nobody else (§2.7). It is
  not on the public list.
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

**B. CloudFront, then Caddy (HTTPS), then the app.** This is what `deploy/` builds
(`deploy/aws/network.yaml`, `edge.yaml`, `deploy/server/caddy/Caddyfile.template`).

1. **Security group, inbound** (`network.yaml`):
   - **443 from the AWS-managed prefix list `com.amazonaws.global.cloudfront.origin-facing`
     only.** Nobody else reaches the API's port.
   - **80 from anywhere.** This is required, not an oversight. With 443 closed to everyone
     but CloudFront, the certificate authority cannot reach 443, so Caddy can only prove
     that it holds the name with the ACME HTTP-01 challenge, which arrives on port 80.
     Close port 80 and the first certificate is never issued, or the running one is not
     renewed and expires; CloudFront then answers 502 for every `/api` request. Port 80
     serves that challenge and a redirect to HTTPS, nothing else: the API is never served in
     clear text, and the redirect points at a port that is closed to the asker.
   - No SSH. A shell is AWS Systems Manager.
2. **CloudFront origin custom header** `X-Origin-Verify: <secret>` (`edge.yaml`, from a
   `NoEcho` parameter). The prefix list admits every CloudFront customer's distribution; the
   secret is what tells this one apart. Rotating it: §2.6.
3. **Caddy keeps CloudFront's `X-Forwarded-For`** (`trusted_proxies`). Trusting every peer
   at Caddy is right only because the security group lets nobody but CloudFront reach 443.
4. **Caddy asks for its certificate over HTTP-01 only** (`disable_tlsalpn_challenge`).
   Otherwise it tries the TLS-ALPN challenge on 443 first, which can never succeed here.
5. **Caddy writes no access log.** Its access log records request headers, and every
   request carries `X-Origin-Verify`: the secret would be written to the journal with each
   request, next to query strings that hold wallet addresses. The API logs each request
   itself, as the path and the client address, never the query string (§2.1). Do not add a
   `log` directive to the site block.
6. **Caddy's admin endpoint is off** (`admin off`). By default it listens on
   `localhost:2019`, and anything on the instance, the API process included, could
   reconfigure Caddy through it. A configuration change is a restart of Caddy.

```
VALUESCAN_TRUST_PROXY=2
VALUESCAN_ORIGIN_SECRET=<same secret>
HOST=127.0.0.1
PORT=8797
```

Hop 0 is Caddy on loopback, hop 1 is the CloudFront edge, and hop 2 is the viewer that
CloudFront appended.

```caddyfile
{
	admin off
	servers {
		trusted_proxies static 0.0.0.0/0 ::/0
	}
}
origin.valuescan.example {
	tls {
		issuer acme {
			disable_tlsalpn_challenge
		}
	}
	reverse_proxy 127.0.0.1:8797
	header -Server
	# No `log` directive: see point 5.
}
```

Check it from outside after a deploy: `node deploy/smoke/smoke.mjs --site=<url>
--origin=<origin host>`. It expects 443 and the API port closed to you, and port 80 to
answer nothing but a redirect to HTTPS.

**C. CloudFront straight to the app over HTTP.** Not recommended: the origin secret and all
traffic cross the internet in clear text. If you use it anyway:

- set `VALUESCAN_TRUST_PROXY=1`;
- restrict the security group to the prefix list above;
- set `HOST=0.0.0.0`.

Never set `VALUESCAN_TRUST_PROXY` to more hops than there really are proxies. Every extra
hop lets a client choose its own rate-limit key.

Whatever proxy stands in front must mark what it relays with `X-Forwarded-For`. Caddy and
CloudFront always do. A proxy that relays without it gives every client one shared
rate-limit key, and its requests look as if they started on the instance (§2.7).

### 2.4 Edge backstop

Attach AWS WAF to the distribution with a rate-based rule on `/api/*`, for example 2,000
requests per 5 minutes per IP, action *Block*. It is a coarse backstop against floods from
many addresses, which per-client limits cannot see. Add the managed rule groups
*AWSManagedRulesCommonRuleSet* and *AWSManagedRulesKnownBadInputsRuleSet*.

As deployed (`edge.yaml`, `WebAcl`; on unless `ENABLE_WAF` says otherwise): the rate rule
counts paths that start with `/api/` (`WAF_API_RATE_LIMIT`, default 2,000), the common rule
set is scoped to the same paths, and the known-bad-inputs set covers every request.

### 2.5 Operations

- **Logs:** they keep client IPs, which are needed for abuse handling. Keep them 14 days or
  less. They are personal data under GDPR, alongside any wallet address that reaches a log
  line.
- **Updates:** run `npm ci` from the committed lockfile. Never run `npm install` on the
  server.
- **Process user:** run the process as an unprivileged user, and keep the index DB on a
  separate volume (`VALUESCAN_INDEX_DB`).
- **Firewall:** do not open 8797 or 8787 publicly. Behind CloudFront the origin has 443 open
  to CloudFront and 80 open for ACME, and nothing else (§2.3 B).
- **Caddy:** no access log and no admin endpoint (§2.3 B, points 5 and 6).
- **Monitoring:** `/api/health` from outside says that the API answers; it says nothing
  about the indexer, which is another process. The indexer's health is read on the instance
  (§2.7).

### 2.6 Rotating the origin secret

The server accepts more than one value, so no step of a rotation has the edge sending a
value the server refuses. The order:

1. **Make the next value.** The current one stays where it is.
2. **Instance:** `VALUESCAN_ORIGIN_SECRET=<current>,<next>`, then restart the API. Its boot
   line reports `"originSecret":"set (2 accepted)"`, followed by a warning that a rotation
   is open.
3. **Edge:** set the CloudFront origin custom header `X-Origin-Verify` to `<next>` and wait
   until the distribution is `Deployed`. Edge locations switch one after another over
   several minutes. Both values arrive during that time, and both are accepted.
4. **Instance:** `VALUESCAN_ORIGIN_SECRET=<next>`, then restart the API. The old value is
   refused from this moment.

What the server guarantees, and what it asks:

- **The header carries exactly one value, never the list.** A client on the instance that
  reads the same variable (the health check does) must send one entry of it, not the
  variable as it is: `<current>,<next>` in the header is a 403.
- **Every listed value is compared on every request**, in constant time and without an
  early exit, so neither the order of the list nor the timing of an answer says which value
  matched. Each side is hashed first, so lengths do not show either.
- **A typo never weakens the gate.** An empty entry (a stray comma), a value under 32
  characters, one with a space in it or a fifth value stops the boot. None of them reads as
  "no secret".
- **Do not leave two values in place.** The old one works for as long as it is listed, and
  the warning is logged at every boot until it is removed.
- **Going back** before step 4 is safe at any time: point the edge at `<current>` again.
- **The restarts** in steps 2 and 4 are the few seconds of any API restart. CloudFront
  serves what it has cached and answers 502 for the rest; no request is refused with 403.
- **If the current value has leaked,** the overlap is the time the leaked value keeps
  working, so run the four steps without delay. Or take the gap instead and put only
  `<next>` on the instance first: the index routes answer 403 until the edge follows, and
  the site, trading and Scan are not affected. In the meantime a leaked value is only
  usable through another CloudFront distribution, because port 443 admits nothing else.

How the two values reach the instance and CloudFront is the deployment's business:
`docs/deploy/DEPLOY.md`, "Rotating the origin secret". As of 2026-10-02 the deploy scripts
carry one value (`deploy/server/bootstrap.sh` refuses a comma, and the health check sends
the variable as it is), so that procedure still has its 403 window until they follow.

### 2.7 The indexer's health, on the instance only

`GET /api/vs/index/health` is what monitoring reads about the indexer:

```json
{
  "ok": true,
  "status": {
    "at": 1790974323141,
    "streams": { "sodex": true, "hyperliquid": true, "tradexyz": true, "lighter": false, "arcus": true },
    "loopLagMs": { "lastMinute": 12, "sinceStart": 340 },
    "lanes": {
      "hl": { "queued": 3, "done": 1200, "failed": 2, "backoffMs": 1500 },
      "sgw": { "queued": 0, "done": 10, "failed": 0, "backoffMs": 0 },
      "strades": { "queued": 41, "done": 7, "failed": 1, "backoffMs": 30000 },
      "sdata": { "queued": 0, "done": 0, "failed": 0, "backoffMs": 0 }
    },
    "lastBuildAt": 1790974303141,
    "lastBuildMs": 431,
    "errorSinceStart": false
  }
}
```

| Field | Meaning |
|---|---|
| `at` | When the indexer last published its status (ms since the epoch). It does so every 30 s, so an old value means the indexer is stuck or down. |
| `streams` | Venue → its trade stream is connected. A stream that is down right after a restart is normal (Lighter needs minutes). |
| `loopLagMs` | The indexer's worst event-loop delay: within the last minute, and since it started. |
| `lanes` | One entry per upstream budget's work queue: `queued`, `done`, `failed`, and `backoffMs` (above 0: the venue rate-limited it and it is waiting). |
| `lastBuildAt`, `lastBuildMs` | When the boards were last built and how long that took. `null`: not yet. |
| `errorSinceStart` | The indexer has recorded an error since it started. It keeps the last one, so this stays `true`. The text is in the indexer's log. |
| `status: null` | Nothing has been published: no index file yet, or an indexer that never ran. |

Thresholds are the monitor's (`deploy/server/env/ops.env.example`: status older than 180 s,
no build for 900 s); the route reports and does not judge.

**Who gets an answer.** In hosted mode, only a request that started on the instance. All
three must hold:

- the TCP peer is loopback (the socket's address; `X-Forwarded-For` plays no part);
- the `Host` header is a loopback name: `127.0.0.1`, `localhost` or `[::1]`, any port;
- the request carries nothing a relaying proxy adds: no `X-Forwarded-*`, `Forwarded`, `Via`,
  `X-Real-IP`, or a CDN's own headers.

Everything from the internet arrives through Caddy, which fails all three: it marks what it
relays and keeps the public `Host`. For such a request the route answers what a path that
does not exist answers: 403 without the origin secret, 404 with it. It is not on the public
allow-list and is not reachable through CloudFront.

**No origin secret is needed on the instance.** A monitor should not hold the credential
that gets past the edge:

```
curl -s http://127.0.0.1:8797/api/vs/index/health
```

The request counts against the `read` limit of `127.0.0.1` like any other. Outside hosted
mode the route answers the same body to the local app.

**Why it is built this way:**

- **Not public.** Even this view tells an attacker, live, how the indexer copes with what
  they send: which lane backs off, which stream dropped. Nobody outside needs it. An
  external monitor has `/api/health`, and the freshness of the index is already in every
  board answer (`index.updatedAt` of `/api/vs/leaderboard`).
- **Not the full status.** `/api/vs/index/status` holds the wallet a lane is working on,
  error texts that name addresses and URLs, and a pid. It stays a 404 for every caller in
  hosted mode, on the instance too. That 404 is also how the health check's `lockdown` test
  tells that hosted mode is in effect.
- **Not the index file.** Reading the status row from the database works, and the health
  check does it today. But a reader of a WAL database needs write access to its directory,
  and the monitor then depends on the store's schema. Over HTTP it needs neither.
- **Nothing can ride along.** The body is not the status with fields removed. Each field is
  picked by name and rebuilt as a number or a boolean (`indexerHealth` in
  `apps/server/src/hosted.ts`), and venue and lane names must look like names. Whatever the
  indexer adds to its status later is not sent until it is added there.
- **If the "on the instance" test were ever wrong** (a proxy on the instance that relays
  without marking, §2.3), the loss is this body and nothing else.

---

## 3. TLS

- **Protocols:** TLS 1.2 minimum and 1.3 preferred everywhere.
  - CloudFront: `TLSv1.2_2021`.
  - Caddy: the default `protocols tls1.2 tls1.3`.
  - Origin protocol from CloudFront: *HTTPS only*, TLSv1.2.
- **Certificates:** ACM (`us-east-1`) for CloudFront. Caddy obtains and renews its own.
  Behind CloudFront it can only do so over the HTTP-01 challenge on port 80, because 443 is
  closed to the certificate authority (§2.3 B): keep port 80 open on the origin.
- **HTTP:** redirect it to HTTPS everywhere. HSTS is as in 1.1 and 2.2. On the origin, port
  80 answers the ACME challenge and that redirect, never the API.
- **DNS:** add CAA records naming only the CAs actually used, `amazon.com` and
  `letsencrypt.org`. A CAA record that leaves out `letsencrypt.org` stops Caddy's
  certificate.
