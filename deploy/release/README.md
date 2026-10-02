# Releases

Scripts you run on your workstation (bash and AWS CLI v2; Git Bash on Windows
works). They read `deploy/aws/params.env`, look up what the stacks output, and
print every AWS command before running it. `--print` shows the commands and calls
nothing. The runbook is `docs/deploy/DEPLOY.md`.

A release is always a **git tag**. The web and the server are released
separately and roll back separately.

| Script | Does |
|---|---|
| `build-web.sh <tag>` | typecheck + `vite build` of the clean tag with the settings of `web.env`, static audit, tarball in `deploy/.out/` |
| `publish-web.sh <tag>` | upload to the site bucket with the right types and cache headers, store the build for rollbacks, invalidate CloudFront |
| `release-server.sh <tag> [--api-only]` | `git archive` of the tag to the ops bucket, then `release.sh` on the instance through SSM |
| `rollback.sh web <tag>` / `rollback.sh server [--api-only]` / `rollback.sh status` | go back |
| `bootstrap-instance.sh` | upload `deploy/server` and run its `bootstrap.sh` on the instance (first setup, and after changing units, env templates, pinned versions or the secret) |
| `seed-index.sh <index.db> --work-dir=<dir>` | start a new instance from an index you already have |
| `remote.sh health` / `status` / `logs <unit>` / `restart <unit>` / `backup` / `restore <source> [--yes]` / `disk` / `run '<command>'` | one operations command on the instance through SSM Run Command - no SSH, no plugin |

## Web

```
cp deploy/release/web.env.example deploy/release/web.env     # once; fill it in
git tag v0.1.0 && git push origin v0.1.0
git checkout v0.1.0
deploy/release/build-web.sh v0.1.0
deploy/release/publish-web.sh v0.1.0
```

### The build-time settings (`web.env`)

Vite inlines every `VITE_*` value into public JavaScript. **None of them is a
secret, and no secret may be given a `VITE_` name.**

| Variable | For launch | Meaning |
|---|---|---|
| `VITE_WALLETCONNECT_PROJECT_ID` | **required** | Reown / WalletConnect project id. Without it wallets cannot connect by WalletConnect. Add the production domain to the project's allowed domains. |
| `VITE_BUILDER_ID` | owner's decision | Valuescan's SoDEX builder account id. Empty: no builder fee is approved or charged. |
| `VITE_BUILDER_FEE_PERPS` | with the id | Fee per perps order, tenths of a basis point (0..200). |
| `VITE_BUILDER_FEE_SPOT` | with the id | Fee per spot order, tenths of a basis point (0..2000). |
| `VITE_BUILDER_MAX_FEE` | optional | The ceiling a user approves (0..2000). Empty: the higher of the two fees. Below a fee: the builder is switched off. |
| `VITE_SODEX_NETWORK` | `mainnet` | Pins the network into the bundle; the API can then only turn trading off, never move the app to another network. |
| `VITE_SODEX_GATEWAY` | empty | A gateway override. Needs the CSP and the worker's allow-list changed too. |
| `VITE_ALLOW_MAINNET_TRADING` | empty | `1` ignores the server's trading switch. Leave empty to keep the emergency brake. |
| `VITE_TRADING_DISABLED` | empty | `1` = an emergency build that refuses every write. |
| `VITE_TRADING_KEY_TTL_H` | empty | Trading key lifetime in hours (1..168, default 168). |
| `VITE_CHART` | empty | `tradingview` needs the licensed library and a CSP review. |

The builder variables are being finished by the builder-codes work: check the
names and ranges against `apps/web/src/trading/config.ts` before the first release.

`build-web.sh` exports **every** variable above, set or empty, so a
`apps/web/.env.local` on the build machine cannot leak a development value; it
stops if such a file sets a `VITE_*` name it does not know, if the tree is not
exactly the tag, or if the WalletConnect id is missing.

### What `publish-web.sh` uploads

| Files | Cache-Control | How |
|---|---|---|
| `assets/*` (content-hashed) | `public, max-age=31536000, immutable` | `s3 sync --size-only`: a name that exists is the same file |
| `logos/*`, `addrbook/*` | `public, max-age=86400, stale-while-revalidate=604800` | always uploaded |
| other files (`favicon.svg`, `robots.txt`) | `public, max-age=3600` | always uploaded |
| `*.html` | `no-cache` | **last**, so the shell never points at scripts that are not there yet |

- The content type is set explicitly per extension (the CLI would otherwise guess
  from the operating system; with `nosniff`, a script served as `text/plain` does
  not run). An extension the script does not know stops the publish.
- Old hashed assets are not deleted: a visitor who still holds the previous
  `index.html` keeps working, and a rollback is only the previous HTML again.
- Then `aws cloudfront create-invalidation --paths '/*'` and a wait for it.
- The build is stored in the ops bucket (`releases/web/`) for rollbacks.

## Server

```
deploy/release/release-server.sh v0.1.0             # restarts the indexer, then the API
deploy/release/release-server.sh v0.1.1 --api-only  # restarts the API only
```

1. `git archive` of the **tag** (never the working tree): `package.json`,
   `package-lock.json`, `apps/server`, the other workspaces' `package.json` files
   (the lockfile names them), `deploy/server`. About 0.5 MB.
2. Upload to `s3://<ops bucket>/releases/server/` with a `.sha256`.
3. On the instance (`/opt/valuescan/bin/release.sh <tag>`): verify the checksum,
   unpack into `/opt/valuescan/releases/<tag>`, refuse a release that brings a
   `.env`, `npm ci --workspace apps/server --ignore-scripts` from the committed
   lockfile, check that the code loads, switch `/opt/valuescan/current`
   atomically, restart the indexer, then the API, check `/api/health`, keep the
   last three releases.

**The install command.** The server runs its TypeScript through `tsx`, a
devDependency of the server workspace, so `npm ci --omit=dev` would produce a
server that cannot start. `npm ci --workspace apps/server` installs the server's
79 packages (about 45 MB) and none of the web's. Never `npm install` on the
instance.

**The order, and what a restart costs.** The indexer first: it is the one writer
and applies schema changes as it opens the file. Then the API. Zero downtime is
not a goal - the API is back in seconds and CloudFront serves the index from its
short cache meanwhile - but **every indexer restart costs its Lighter stream
3.5-8 minutes** (it re-subscribes about 220 markets, one per 700 ms), and that gap
has to be re-read for the traders on the boards. Hyperliquid and SoDEX reconnect
in seconds. So:

- a release that changes only what the API runs (routes, `perf.ts`, the hosted
  gate): `--api-only`;
- everything else: the full restart, at a quiet moment.

A process that was not restarted keeps running the release it started from - the
release directories are separate, so nothing changes underneath it.

## Rollback

```
deploy/release/rollback.sh web v0.0.9        # publish the stored build of v0.0.9 again; about a minute
deploy/release/rollback.sh server            # the release before the current one, indexer then API
deploy/release/rollback.sh server --api-only
deploy/release/rollback.sh status            # what is installed and what each unit runs
```

- **Web:** downloads that tag's build from the ops bucket, verifies it, uploads
  its HTML and files, invalidates CloudFront.
- **Server:** switches `current` back to the previous release (still installed)
  and restarts in order. To go back further, release that tag again.
- **The database is not rolled back.** Schema changes so far only add tables and
  columns, which older code ignores. If a release ever changes data in a way older
  code cannot read, going back means restoring the backup taken before it
  (`deploy/server/README.md`, "Restore") - take one by hand before such a release:
  `deploy/release/remote.sh backup`.

## On the instance, from here

```
deploy/release/remote.sh health                 # one health pass: a JSON line with every check
deploy/release/remote.sh logs indexer 100       # the journal of indexer | api | caddy | health | backup
deploy/release/remote.sh restart api            # or indexer (costs the Lighter stream minutes), caddy
deploy/release/remote.sh backup                 # an index backup now
deploy/release/remote.sh restore latest         # dry run; --yes does it
deploy/release/remote.sh disk
deploy/release/remote.sh run 'uptime'           # anything else, as root
```

Each is one SSM Run Command; the output comes back when the command ends (SSM
returns the first 24,000 characters, so long logs are cut to their newest part).
The command text is recorded by AWS: never put a secret into `run`.

## The index seed

`seed-index.sh` copies an index read-only (`VACUUM INTO`; the local indexer keeps
running), compresses it and uploads it to `seed/` in the ops bucket, where it
expires after 14 days. The copy is as large as the index, so the work directory
must be outside any synced folder (OneDrive, Dropbox): the default,
`deploy/.out`, is refused when the repository lives in one. Name another with
`--work-dir=<dir>` or `SEED_WORK_DIR`.

## Git Bash

The scripts set `MSYS_NO_PATHCONV=1`: without it Git Bash rewrites arguments that
start with `/` (SSM names, S3 keys, `/*`) into Windows paths. For the same reason
they `cd` to the repository root and hand the AWS CLI relative paths only
(`seed-index.sh`, whose files live elsewhere, converts them with `cygpath`).
