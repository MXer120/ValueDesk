# beta.valuedesk.so - beta first, then everyone

Owner, 2026-11-01: "create a beta.valuedesk.so page (whitelist only for set wallet via dev page) where we push
features to test live before main for all users". Chosen: the website AND the API run ahead on beta; the
indexer and the copy executor are shared (they have no beta); a release goes to beta first and the SAME tag is
then promoted to everyone.

## Who gets in

- The list is on the admin suite's **Beta** page (dev.valuedesk.so#/beta, `apps/web/src/admin/pages/Beta.tsx`).
  Adding or removing a wallet asks the builder wallet for a signature naming that wallet (`beta.add` /
  `beta.remove`, audited). The list lives in admin.db, table `beta_wallets`.
- A tester opens beta.valuedesk.so, connects a wallet and signs a free `BetaSignIn`
  (`apps/server/src/beta/signIn.ts`); the beta API hands out a 7-day token, only to a listed wallet. The site
  keeps it in the `vs_beta` cookie (`apps/web/src/beta/BetaGate.tsx`).
- **The lock is the beta API, not the page** (`apps/server/src/beta/gate.ts`): every route but `/api/health`,
  the sign-in and the heatmap socket needs the token of a wallet that is on the list now. The list is read
  again every 10 s, so a removed wallet is out within seconds; the page notices within a minute (or when the
  tab comes back) and says "Your beta access ended".

## How a request reaches the beta API

1. beta.valuedesk.so is the Vercel project's domain for the git branch `beta` (preview protection skips custom
   domains). `deploy/vercel/build.sh` builds that branch with `beta.settings` over `production.settings`
   (`VITE_CHANNEL=beta`, the beta socket) and marks the function `VALUESCAN_CHANNEL=beta`.
2. The function (`deploy/vercel/api-proxy.cjs`) adds `x-vs-channel: beta` and the cookie's token as
   `x-vs-beta` to every request; on beta every answer is `no-store` (never in the CDN, where another visitor
   could get it). `/api/beta/*` is a 404 on the main site.
3. Caddy on server 1 (`deploy/server/caddy/Caddyfile.template`): past the origin secret, `/api/copy/*` still
   goes to the executor, `X-VS-Channel: beta` to 127.0.0.1:8798; `/ws/liq-beta` to 8798 as `/ws/liq`.
4. `valuescan-api-beta.service` (port 8798, `/etc/valuescan/api-beta.env`) runs `/opt/valuescan/beta-current`
   with `VALUESCAN_CHANNEL=beta`: none of the main API's background jobs (release watcher, status prober,
   Telegram poller, fee-order copier, folders upkeep, builder verifier) - it reads the same index and state.

## Releasing

    bash deploy/release/ship-beta.sh beta --yes            HEAD -> tag, CI gate, the beta API, branch beta (Vercel)
    bash deploy/release/ship-beta.sh promote vX.Y.Z --yes  that tag to everyone: ship.sh run from the tag

`release.sh <tag> --beta` on server 1 moves only `beta-current` and restarts only the beta API; a normal release
never touches the beta. A tag whose indexer or executor changed runs on beta against today's indexer and
executor; they change on promote.

## Set up once (infra, by hand)

- server 1: `deploy/server/units/valuescan-api-beta.service` + `deploy/contabo/server1/systemd/valuescan-api-beta.service.d/contabo.conf`,
  `/etc/valuescan/api-beta.env` from `deploy/server/env/api-beta.env.example`, Caddy from the template, a first
  `release.sh <tag> --beta`.
- server 2: `https://beta.valuedesk.so` added to the executor's `EXECUTOR_ALLOWED_ORIGINS` (a restart of the executor: with its guards).
- Vercel: domain beta.valuedesk.so on git branch `beta`; `VALUESCAN_ORIGIN_SECRET` also for Preview (branch `beta`).
- DNS (owner): CNAME `beta` -> `cname.vercel-dns.com`.
