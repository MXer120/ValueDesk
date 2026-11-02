# The admin suite - dev.valuedesk.so

The owner's private dev and admin pages (owner, 2026-10-31): feedback tickets, volume and builder fees, every
user, product analytics, the status of everything. Built 2026-10-31; first version.

## 1. Who gets in (apps/server/src/admin/auth.ts, routes/admin.ts)

| Step | What | Where it is checked |
|---|---|---|
| Wallet | EIP-712 `AdminSignIn` (domain "ValueDesk Admin"), recovered signer must be an admin wallet: `VALUESCAN_ADMIN_WALLETS`, default the builder wallet 0x1e43…1dDe (account 234812). 5 min TTL, nonce once. | server, before anything else |
| Password | scrypt (N=2^17, r=8, p=1, 16 B salt, 64 B key), only the hash, in `/var/lib/valuescan/state/admin-auth/password` (0600, user valuescan). Checked only after a valid admin signature, so outsiders cannot guess it or lock it. | server |
| Session | random `vda_…` token, only its SHA-256 in `admin.db`; 24 h fixed from sign-in; revocable. Kept in dev.valuedesk.so's localStorage. | server, on every route |
| Write | a fresh `AdminAction` signature per change, naming the action, the target and the keccak-256 of the exact payload; 5 min, nonce once. | server |

- No password file on the server: every `/api/admin/*` route is a 404 - the suite is off.
- Every route is a POST, needs Origin exactly `https://dev.valuedesk.so` (`VALUESCAN_ADMIN_ORIGINS`), is in
  `HOSTED_ROUTES` as class `admin`, and has its own limits (sign-in 10 / 15 min per client, 60 / h overall).
- 5 wrong passwords in 15 minutes (each with a valid admin signature) lock the sign-in for 15 minutes.
- Telegram: `ℹ️ INFO · Admin sign-in` on each sign-in, `🚨 FAILURE · Admin sign-in refused` on each wrong
  password. Answers written in the suite are copied into the ticket's Telegram thread.
- Audit log: `admin.db` table `audit`, append-only, every row chained to the one before by SHA-256
  (`verifyAudit`); the Audit page shows whether the chain is intact.
- Edge (deploy/vercel/api-proxy.cjs): `/api/admin/*` passes only for Host dev.valuedesk.so, and that host
  reaches no other `/api` path. Pages (deploy/vercel/package.mjs `ADMIN_HOST`): the host serves `admin.html`
  for every route with its own CSP (deploy/smoke/prod-headers.mjs `ADMIN_CSP`), `X-Robots-Tag: noindex`,
  `no-store`; every other host answers `/admin.html` with 404.

## 2. Setting it up (owner)

1. DNS at Namecheap: `CNAME dev -> cname.vercel-dns.com`.
2. Vercel: add the domain `dev.valuedesk.so` to the project `valuedesk` (Settings > Domains), production.
3. After the release that carries this: on server 1, in an SSH terminal,
   `sudo bash /opt/valuescan/bin/admin-password.sh` - typed twice, nothing shown, at least 12 characters.
   `--status` shows whether one is set; `--off` turns the suite off again. No restart needed.
4. Sign in at https://dev.valuedesk.so with the builder wallet (browser extension or WalletConnect). If the
   Reown project has a domain allowlist, add dev.valuedesk.so there for WalletConnect.

## 3. Pages and their sources

| Page | Source |
|---|---|
| Overview | the ones below, today |
| Tickets | `feedback.db` (ops/feedbackThreads.ts): every chat, messages with page info, screenshots; status (open / waiting / closed) in `admin.db`; answer = an owner message in the chat (signed) |
| Users | union of the builder ledger's wallets, the copy executor's wallets (server 2, `GET /api/copy/v1/internal/users` with X-Internal-Token = VALUESCAN_INTERNAL_TOKEN and the origin secret, kept a minute; VALUESCAN_ADMIN_EXECUTOR_URL, default `https://13-140-77-201.sslip.io`: joined, site / copy terms, declared country, copies and algos active / all, keys), wallets seen in analytics, wallets with a chat, our own wallets marked Internal: volume (lifetime, 30 d, tier window), fees paid, orders, tier and fee, signed fee, flags, last trade, visits, time, last seen, countries, top features; CSV |
| Volume & fees | `builder.db` (read-only): counted volume per day; fees = counted notional x the order's fee / 100 000, from `admin.db` `fee_orders` (a copy of every counted order, synced every 5 min - the ledger keeps only 2,000 orders a wallet) |
| Analytics | `analytics.db` (ops/analytics.ts), consenting visitors only |
| Status | status page store, the indexer's whole status row, executor health (www.valuedesk.so/api/copy/v1/health), brake file, release dirs, server 1 load / memory / disk, client error reports |
| Audit & sessions | `admin.db` |

## 4. Analytics - what is tracked (only after consent)

Consent: "Accept all" in the terms popup, or the switch on /cookies (section 5); withdrawable there. Without
it nothing is stored or sent. With it, POST /api/vs/a (ops/analyticsModel.ts is the contract):

- page views (route only, addresses / ids replaced, no query) and visible time per page;
- feature uses by name (FEATURES list; unknown names dropped): order placed / cancelled, algo started, copy
  started / stopped, wallet connected, trading enabled, terms signed, deposit / withdraw / transfer opened,
  dashboard edited / reset, feedback opened, settings changed - details a few words, never amounts or addresses;
- referrer domain, utm source / medium / campaign, landing page;
- country + region from Vercel's edge (no IP stored);
- device class, screen size, browser + OS family, language, time zone, theme;
- page speed (LCP, CLS, INP, FCP, TTFB);
- the connected wallet address (links use to the builder ledger);
- a random visitor id (localStorage `vd.an.v1`, 13 months) and visit id (sessionStorage, 30 min idle).

Not tracked: IP, cookies, keystrokes, form contents, mouse movement, session recordings, other sites, no third
party of any kind. Retention: `[[OWNER]]` in the privacy text - nothing is deleted until the owner sets it.

## 5. Files

- Server: `apps/server/src/admin/` (signIn, auth, store, builderStats, statusView), `routes/admin.ts`,
  `routes/analytics.ts`, `ops/analytics.ts`, `ops/analyticsModel.ts`, `tools/admin-password.ts`,
  `deploy/server/bin/admin-password.sh`; tests `apps/server/test/admin.test.ts`.
- Web: `apps/web/admin.html`, `apps/web/src/admin/` (page), `apps/web/src/analytics/usage.ts`,
  `apps/web/src/legal/analyticsConsent.ts`, Cookies section 5, Privacy section 13.
- Edge: `deploy/vercel/api-proxy.cjs`, `deploy/vercel/package.mjs`, `deploy/smoke/prod-headers.mjs`.
