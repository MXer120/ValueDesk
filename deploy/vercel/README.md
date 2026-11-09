# The Vercel edge

The site and `/api/*` of the EC2 + Vercel test environment
(`docs/deploy/EC2-VERCEL.md`): what CloudFront is in `deploy/aws/edge.yaml`, as a
prebuilt Vercel deployment (Build Output API v3). Nothing here is built by Vercel;
the web is built by `deploy/release/build-web.sh`.

| File | |
|---|---|
| `package.mjs` | writes `<dir>/.vercel/output` from a build: `static/`, `config.json` (the routes), the function |
| `api-proxy.cjs` | the function behind `/api/*` (Node.js, `hnd1` - Tokyo, next to the instance in ap-northeast-1; `fra1` until 2026-10-23): to `https://<origin>` with the origin secret and the viewer's address |
| `vercel.test.mjs` | `node --test deploy/vercel/vercel.test.mjs` |
| `ignore-build.sh` | Vercel's Ignored Build Step: each project builds only its branch, and `main` only when `web-changed.mjs` finds a file of the site changed since the last deployment (`VS_ALWAYS_BUILD=1` builds every push) |
| `web-changed.mjs` | does a commit range change the site's build input? (both pages' run-time import graph, apps/web, packages, the build and route files); `web-changed.test.mjs` |

```
deploy/release/publish-vercel.sh <tag> --out=/c/Temp/valuedesk-deploy            # prepare
deploy/release/publish-vercel.sh <tag> --out=/c/Temp/valuedesk-deploy --deploy   # ... and deploy to production
```

**Sanctioned places first.** A request whose `x-vercel-ip-country` is a sanctioned
country, or whose `x-vercel-ip-country-region` is a sanctioned region of one
(`apps/web/src/legal/jurisdictions.mjs`: Cuba, Iran, North Korea, Syria, Russia,
Belarus, Myanmar; Crimea, Sevastopol, Donetsk, Luhansk), is answered **451** with
`/restricted.html` (or `/restricted.json` under `/api/`), `Cache-Control: no-store`,
before any other route - except the legal pages (`/impressum`, `/privacy`,
`/cookies`, `/terms`, `/risk`, `/copy-terms`), the files they load (`/assets/*`,
the favicon, `robots.txt`) and `/api/edge/geo`. The function refuses the same
places itself (`VALUESCAN_GEO_BLOCK`, written into its config from the same list),
and answers `GET /api/edge/geo` - `{"country","region"}` as Vercel reports them,
no-store, never forwarded - so the app can apply the same rules (`legal/geo.ts`).
The test drives every sanctioned country and region through the routes.

**The routes** (`config.json`, in order): the 451 routes above; `/api/*` to the function and nothing
else; the headers of every other path from `deploy/smoke/prod-headers.mjs` - the
table `edge.yaml` is validated against - one route per path class, so a header is
never set twice; `/scan/` to the legacy redirect page; the files; any path whose
last segment has no dot to `/index.html`. All case-sensitive, like CloudFront's
path patterns. The test walks 35 paths through a model of Vercel's routing and
compares each with `headersFor()` and `rewrite()`.

**The function** forwards GET, HEAD and OPTIONS (405 otherwise), the path and query
unchanged, and only `Accept`, `Accept-Encoding`, `If-None-Match`,
`If-Modified-Since`, `Origin` (and a preflight's two headers). It adds
`X-Origin-Verify` and `X-Forwarded-For: <viewer>` - the address Vercel puts in
`x-real-ip`, never the client's own header. A path with a dot segment, `//`, or an
encoded slash, backslash, dot or NUL is a 404 at the edge.

**The copy executor's paths, `/api/copy/*`** (Caddy sends them to the executor on
127.0.0.1:8799), differ in four ways: POST is allowed there too (and only there) -
the body is read first, at most 64 KB (413 above), and sent on with its length;
`Content-Type` and `Authorization` (a follower's read token) are forwarded, nowhere
else; `X-Viewer-Country` is set from Vercel's `x-vercel-ip-country` (two letters, or
not at all) - a client's own `X-Viewer-Country` never passes, as no header outside
these lists does; and nothing is cached: the answer leaves with `Cache-Control:
no-store`, without any CDN cache header the origin might send. `X-Pairing-Code` is
not forwarded: only a self-hosted executor uses it. The answer is streamed back as is
(compressed bytes included), without hop-by-hop headers, `Set-Cookie` or `Server`.
A `200` with `public, max-age=N` also gets `Vercel-CDN-Cache-Control:
max-age=min(N,60)` (and the API's `stale-while-revalidate`, at most 60): Vercel's
CDN does not cache a function's answer on `max-age` alone, and this is what
CloudFront's API cache policy does with the same header. No origin answer in two
5-second connection attempts: 502; none in 30 s: 504.

**Settings.** `VALUESCAN_ORIGIN_URL` is written into the function's `.vc-config.json`
by `package.mjs` (not secret). `VALUESCAN_ORIGIN_SECRET` is a Vercel environment
variable, **production only**, marked sensitive:

```
npx vercel@latest env add VALUESCAN_ORIGIN_SECRET production --sensitive < ~/.valuescan/valuescan-test/origin-secret
```

A preview deployment therefore has no secret and its `/api` answers 503: only the
production address reaches the index. An environment variable reaches only
deployments made after it changed - deploy again after setting it.
