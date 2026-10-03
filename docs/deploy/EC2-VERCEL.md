# The test environment: one EC2 instance + Vercel

The deployment that is actually being set up (decided 2026-10-03): the site and
`/api/*` on **Vercel** (`https://valuexplorer.vercel.app`, no own domain yet), the
index on **one EC2 instance** in eu-central-1. `docs/deploy/DEPLOY.md` stays the
reference for everything on the instance and for the CloudFormation design this
replaces for now; this file says what is different and how to run it.

The owner's short version is `docs/deploy/OWNER-STEPS.md`.

> **State on 2026-10-03.** Prepared and tested offline; nothing is created yet. Every
> AWS and Vercel write is run by hand from the list in section 6.

## 1. What runs where

```
visitor ──HTTPS──> Vercel  valuexplorer.vercel.app
                     ├── the built site (static files, the production headers and CSP of edge.yaml)
                     └── /api/* ──> function api/__vs_proxy (Node.js, fra1)
                                      ──HTTPS + X-Origin-Verify + the viewer's address──>
                                    Caddy :443 on the instance (<elastic-ip-with-dashes>.sslip.io)
                                      refuses anything without the secret, then ──> 127.0.0.1:8797
                                    valuescan-api (hosted mode, 17 GET routes) + valuescan-indexer
browser ──directly──> SoDEX, Hyperliquid, Lighter, Arcus, WalletConnect, public RPCs (as before)
```

| Piece | Where it is defined |
|---|---|
| The instance, its data volume, the Elastic IP, the security group, the key pair | `deploy/aws/ec2/provision.sh` + `ec2.env` |
| Everything on the instance | `deploy/server` (unchanged design, changes in section 3) |
| Getting code and settings onto it | `deploy/release/*.sh`, over SSH (`deploy/release/lib.sh`: `ec2.env` exists, so `VS_TARGET=ec2`) |
| The Vercel deployment: site, headers, routes, the `/api` function | `deploy/vercel/package.mjs`, `deploy/vercel/api-proxy.cjs`, `deploy/release/publish-vercel.sh` |

## 2. Why this shape, and how it keeps the AWS rule

The AWS user that deploys (profile `claude`) may launch EC2
resources but may not use CloudFormation, IAM, SSM or Route 53. So:

- **No CloudFormation** -> `provision.sh` is the environment's definition: every
  resource carries `project=valuescan`, `env=valuescan-test`, `role=...` and is
  found by those tags. `up` creates only what is missing and never deletes,
  terminates or replaces anything; a resource that differs from `ec2.env` is
  reported, not rebuilt. The launch carries a client token: a retried `up` cannot
  start a second instance.
- **This is the owner's rule for AWS test environments, kept:** one environment,
  defined once, in code; the free part (security group, key pair) separate from
  what bills (instance; the Elastic IP and volumes bill while stopped too); pause is
  `provision.sh stop` (never terminate; API termination protection is on); one
  region, one instance, no fan-out; no latency tests at all. `provision.sh check`
  uses `--dry-run` for permissions only - it does not prove the account may launch.
- **No IAM role** -> no SSM and no S3 from the instance: commands and files go over
  SSH (port 22 open to the deploying machine's address only), backups stay on the
  data volume and leave it as EBS snapshots.
- **Vercel instead of CloudFront** (the owner's choice): the site is served from
  Vercel's CDN with the same headers, and `/api/*` goes through one small function.

## 3. What differs from the reviewed design, and why

Everything not listed here is as reviewed: hosted mode, the units and their
hardening, the env files, Caddy's TLS (Let's Encrypt over HTTP-01 on port 80), the
health check, the release order, the consistent backup copy.

| Change | Forced by | Where |
|---|---|---|
| SSH stays on (`KEEP_SSHD=1`, remembered by the bootstrap), keys only, port 22 from one address | no SSM | `bootstrap.sh`, `provision.sh allow-ssh` |
| The origin secret is generated on the workstation (`~/.valuescan/valuescan-test/origin-secret`, 0600, never printed) and written to a root-only file on the instance through SSH's stdin | no SSM Parameter Store | `bootstrap-instance.sh`, `bootstrap.sh` (`ORIGIN_SECRET_FILE`) |
| Releases are copied over SSH and installed with `release.sh <tag> --from=<file>` | no S3 | `release-server.sh`, `release.sh` |
| Nightly backups go to `/var/lib/valuescan/backup/archive` (newest 1 kept); `provision.sh snapshot` takes them, and the live index, off the box. A snapshot holds the whole data volume - `/var/lib/valuescan/state` too, so the builder-terms signing key and `builder.db` (DEPLOY.md section 16) are in every snapshot: encrypted and private to the account, but never share one | no S3 | `backup.sh`, `restore.sh` (`latest` = newest local) |
| A seed is copied over SSH into `/var/lib/valuescan/backup/seed/` | no S3 | `seed-index.sh` |
| No SNS alerts, no CloudWatch alarms: the health check logs only | no IAM / CloudFormation | watch `https://valuexplorer.vercel.app/api/health` from outside (section 7) |
| **Port 443 is open to everyone**, and **Caddy refuses every request without the origin secret** before the API sees it. Without that gate a client could connect directly and set its own `X-Forwarded-For`, which the API keys its limits on. | Vercel functions have no published address range, so no security group can admit "Vercel only" | `Caddyfile.template` (`@edge`), `caddy.service` (`caddy.secret.env`), `deploy/smoke/deployed.mjs` (`--edge=vercel`) |
| The edge is a Vercel function, not CloudFront: same methods (GET, HEAD, OPTIONS), same forwarded headers, same 60 s ceiling on caching, the viewer's address in `X-Forwarded-For` | the owner's choice | `deploy/vercel/api-proxy.cjs` |
| No WAF and no country restriction at the edge. Left: Vercel's own DDoS mitigation, the API's per-client limits, Caddy's gate. Vercel's firewall can add custom rules (3 on Hobby) if needed. | no CloudFront | - |
| Memory caps for 4 GiB: API 640M/900M, indexer 1400M/1800M (high/max) | `t4g.medium` | the two units |
| `VALUESCAN_INDEX_RETAIN_DAYS=31` | the 150 GiB volume | `indexer.env.example` |

## 4. Sizing and cost

**Instance: `t4g.medium`** (2 vCPU, 4 GiB, Graviton2). Measured on a desktop: API
and indexer together about 0.9 GB of memory and 0.5 to 0.7 of a core,
continuously. The units are capped at 0.9 + 1.8 GB, which leaves over 1 GB for the
system, Caddy, the health check, the nightly backup and `npm ci` during a release:
a runaway is killed and restarted inside its own unit, it cannot take the box (or
sshd) down. A `t4g.medium` earns 0.4 vCPU of sustained load (20 % per vCPU); with
`CPU_CREDITS=unlimited` it is never throttled and the excess is billed.

**Data volume: 150 GiB gp3.** The index is 3.4 GB today and grows with about 4.5
million fills a day; at `VALUESCAN_INDEX_RETAIN_DAYS=31` the indexer's estimate is
33 to 44 GB steady for about 3,300 wallets. DEPLOY.md's rule is three times the
index (the index, the nightly staging copy, a replaced copy during a restore): 132
GB at the upper estimate, plus the one compressed backup kept on the volume (about
a third of the index, 15 GB) = about 147 GB. Peak during a backup at the upper
estimate: about 119 GB (79 %); the health check's `disk` alarm is at 80 %. The
volume can grow online any time (`provision.sh grow`); it cannot shrink. Starting
at 60 GiB and growing when `disk` warns would save about 8.60 USD a month in the
first weeks.

Prices: AWS's public price list for eu-central-1, published 2026-09-25
(`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2|AmazonVPC|AWSDataTransfer/current/eu-central-1`);
a month is 730 hours. Vercel: vercel.com/docs (plans), October 2026.

| Item | Price | Running, USD/month | Stopped, USD/month |
|---|---|---|---|
| `t4g.medium` on demand | 0.0384 / hour | 28.03 | 0 |
| CPU above the baseline (`unlimited`) | 0.04 / vCPU-hour above 0.4 vCPU | **estimate** 6 (at 0.6 vCPU average) to 18 (at 1.0); at most 47 (both vCPUs flat out) | 0 |
| Root volume, gp3 16 GiB | 0.0952 / GB-month | 1.52 | 1.52 |
| Data volume, gp3 150 GiB (3,000 IOPS, 125 MiB/s included) | 0.0952 / GB-month | 14.28 | 14.28 |
| Elastic IP (public IPv4) | 0.005 / hour, in use or idle | 3.65 | 3.65 |
| EBS snapshots | 0.054 / GB-month of stored blocks | **estimate** 3 to 10 (one full copy of about 60 GB used, then what changes; none is deleted automatically) | same |
| Data out to the internet | first 100 GB a month free (all of AWS), then 0.09 / GB | **estimate** 0 (compressed index answers to Vercel, requests to the exchanges) | 0 |
| Vercel Hobby | free, **non-commercial use only** | 0 | 0 |
| Vercel Pro (needed for a launch that charges a builder fee) | 20 / developer seat, usage credit included | 20 | 20 |
| **Total (Hobby)** | | **about 47.50 + CPU surplus + snapshots: roughly 57 to 75** | **about 19.50 + snapshots** |

Stopped means: `provision.sh stop`. The instance costs nothing then; the volumes,
the address and the snapshots still do. The site keeps working while it is
stopped (trading, Portfolio, Scan are browser-direct); the index pages say the
index is unavailable.

**Vercel Hobby or Pro.** Vercel's terms restrict Hobby to non-commercial, personal
use. A test with the owner and a few testers fits Hobby; a launch that charges a
builder fee is commercial and needs Pro (Settings -> Billing -> Upgrade). Hobby's
included usage: 1,000,000 function invocations, 4 CPU-hours of active CPU, 100 GB
of data transfer and 1,000,000 CDN requests a month. One app tab left open polls
`/api/health` every 30 s and the leaderboard every 15 s - on the order of 10
function calls a minute while the CDN has no fresh copy, so roughly 400,000 a month
per tab open around the clock: enough for a test, not for a public launch.

**Decide after the first week**: CPU (`deploy/release/remote.sh run 'uptime; cat /proc/loadavg'`,
or the EC2 console's CPU and `CPUSurplusCreditsCharged` graphs). If the average
stays above about 1 vCPU, `t4g.large` (8 GiB, 0.0768 / hour, 56 USD) earns 0.6 vCPU
and doubles the memory: stop, change the type (`aws ec2 modify-instance-attribute
--instance-type`), start - nothing is replaced. Then put the 8 GiB memory caps back
(the units name them).

## 5. Vercel's CDN and the API's Cache-Control

- The API sends `public, max-age=10, stale-while-revalidate=20` on boards,
  cohorts, screener, Explore and `lbrow`, `public, no-cache` on the whale tape and
  positioning, `no-store` on everything else (`apps/server/src/perf.ts`).
- **Vercel's CDN does not cache a function's answer on `max-age` alone** - it needs
  `s-maxage`, `CDN-Cache-Control` or `Vercel-CDN-Cache-Control`. Without one of them
  every request reaches the function and the instance, and Vercel also strips
  `stale-while-revalidate` from what the browser gets.
- So the function translates, without a server change: on a `200` whose
  Cache-Control is `public, max-age=N` it adds `Vercel-CDN-Cache-Control:
  max-age=min(N,60)[, stale-while-revalidate=min(M,60)]` - exactly what CloudFront's
  API cache policy does with the same header. Vercel consumes that header (it never
  reaches the browser) and, because it is present, passes the API's own
  Cache-Control to the browser unchanged. `no-cache`, `no-store`, errors and `304`s
  are never cached at the edge. Vercel's cache is per region and keyed by URL
  (query included), `Accept` and `Accept-Encoding`, and the API's `Vary`.
- **No change to `perf.ts` is needed.** If the server should ever say it itself,
  the place is `perf.ts` `CachePolicy`: a `CDN-Cache-Control` next to Cache-Control
  (it would then also apply to any other CDN). That is a proposal, not done.

## 6. Setting it up: the commands, in order

All from the repository root in Git Bash, with AWS CLI v2 (profile `claude`), Node
24, the repository's `npm ci` done, and `ssh`. Every script prints each AWS or SSH
command before it runs it; `--print` runs none.

**0. Settings** (both files are ignored by git; neither holds a secret).

```
cp deploy/aws/ec2/ec2.env.example deploy/aws/ec2/ec2.env       # preset: eu-central-1a, t4g.medium, 150 GiB, valuexplorer.vercel.app
cp deploy/release/web.env.example deploy/release/web.env       # the WalletConnect id and the builder values, when the owner has them
```

**1. The plan, read-only.**

```
deploy/aws/ec2/provision.sh up --print      # describes what exists; prints the 10 writes `up` would make
deploy/aws/ec2/provision.sh check           # dry runs: may this profile make them?
```

**2. The environment - the one launch.**

```
deploy/aws/ec2/provision.sh up
```

Creates: the key pair `valuescan-test` (private key to `~/.ssh/valuescan-test.pem`,
never shown), the security group `valuescan-test-origin` (in 443 and 80 from
anywhere, 22 from this machine; out 443 and 80), an Elastic IP, the instance
(`t4g.medium`, AMI `ami-0fc2b4786eaf34856`, 16 GiB encrypted root, IMDSv2,
termination protection), the 150 GiB encrypted data volume (attached as
`/dev/sdf`), and associates the address. It prints the origin name,
`<elastic-ip-with-dashes>.sslip.io`, and writes `deploy/aws/ec2/.out/state.env`.

Can fail: **the launch** (`run-instances`) if the account may not launch -
do not retry in a loop, ask AWS Support (see DEPLOY.md, "If the instance cannot be
launched"); `InsufficientInstanceCapacity` in `eu-central-1a` (set
`AVAILABILITY_ZONE=eu-central-1b` in `ec2.env` - only before the data volume
exists - and run `up` again); a permission `check` showed as denied. A half-done
`up` is finished by running it again.

**3. The instance** (give it a minute to boot).

```
deploy/release/bootstrap-instance.sh
deploy/release/remote.sh logs caddy 40        # "certificate obtained successfully" for <...>.sslip.io
```

On its first run it generates the origin secret into
`~/.valuescan/valuescan-test/origin-secret` (0600, never shown). Then packages,
the `valuescan` user, formats the blank data volume, Node and Caddy (pinned,
checksums verified), the env files, the secret, the Caddyfile, the units. Idempotent:
run it again after any change under `deploy/server`.

Can fail: SSH not up yet (run it again); a download checksum (`versions.env`);
Caddy's certificate - Let's Encrypt needs port 80 and the sslip.io name to resolve to
the address; if it reports a rate limit, see section 9.

**4. Optional: start from the index you have.**

```
deploy/release/seed-index.sh "$LOCALAPPDATA/Valuescan/valuescan-index.db" --work-dir=/c/Temp/valuescan-seed
deploy/release/remote.sh restore /var/lib/valuescan/backup/seed/<the name it printed> --yes
```

**5. The first server release.** A release is a git tag that contains `deploy/`:
these changes must be committed and pushed first.

```
git tag v0.1.0 && git push origin v0.1.0
deploy/release/release-server.sh v0.1.0
deploy/release/remote.sh health               # "ok":true; `backup` warns until the first night; `index` fails until the first board without a seed
```

**6. Vercel: link a deployment directory once, and give the function the secret.**
The directory must be outside the OneDrive folder.

```
npx vercel@latest link --yes --project valuexplorer --scope mxer120s-projects --cwd C:/Temp/valuexplorer-deploy
npx vercel@latest env add VALUESCAN_ORIGIN_SECRET production --sensitive --scope mxer120s-projects --cwd C:/Temp/valuexplorer-deploy < ~/.valuescan/valuescan-test/origin-secret
```

Production only, on purpose: preview deployments (other host names) get no secret,
and their `/api` answers 503. Only `valuexplorer.vercel.app` reaches the index.

**7. The site.**

```
git checkout v0.1.0
deploy/release/build-web.sh v0.1.0                       # needs VITE_WALLETCONNECT_PROJECT_ID; a first test without it: --allow-dirty
deploy/release/publish-vercel.sh v0.1.0 --out=/c/Temp/valuexplorer-deploy --deploy
```

`publish-vercel.sh` checks and audits the build, writes
`/c/Temp/valuexplorer-deploy/.vercel/output` (the static site, `config.json` with the
routes and headers, the function with `VALUESCAN_ORIGIN_URL=https://<origin name>`),
then runs `npx vercel@latest deploy --prebuilt --prod --cwd ...`. Without `--deploy`
it prints that command. If the project's production URL is not
`valuexplorer.vercel.app` (the name taken elsewhere), use the one Vercel shows, and
set it as `SITE_DOMAIN` in `ec2.env`, then `bootstrap-instance.sh` again.

**8. Check what is out there.**

```
node deploy/smoke/smoke.mjs --site=https://valuexplorer.vercel.app --origin=<elastic-ip-with-dashes>.sslip.io --edge=vercel
```

Every page in headless Chrome; the headers against `prod-headers.mjs`; the hosted
gate through the function; the instance: the API port closed, and nothing served on
443 or 80 without the secret.

**9. After the first night**: `deploy/release/remote.sh health` (no warning but
none), then `deploy/aws/ec2/provision.sh snapshot`.

## 7. Operating it

| What | How |
|---|---|
| Pause / resume | `deploy/aws/ec2/provision.sh stop` / `start` (the units start by themselves; the address and the volumes stay) |
| What exists | `deploy/aws/ec2/provision.sh status` |
| My address changed (SSH times out) | `deploy/aws/ec2/provision.sh allow-ssh` (opens 22 to the new address, closes the old one) |
| Health, logs, a restart, a shell | `deploy/release/remote.sh health` / `logs api 100` / `restart api` / `shell` |
| A server release / rollback | `deploy/release/release-server.sh <tag> [--api-only]` / `deploy/release/rollback.sh server` |
| A web release / rollback | `build-web.sh <tag>` + `publish-vercel.sh <tag> --out=... --deploy` / `npx vercel@latest rollback` |
| A backup now; a snapshot | `deploy/release/remote.sh backup`; `deploy/aws/ec2/provision.sh snapshot` (weekly, and before a risky release) |
| Restore | `deploy/release/remote.sh restore latest` (dry run), then `--yes`; older: a snapshot -> a new volume, by hand |
| More disk | raise `DATA_VOLUME_GIB` in `ec2.env`, `provision.sh grow`, then `remote.sh run 'xfs_growfs /var/lib/valuescan'` |
| Trading off for every visitor | DEPLOY.md section 15 (`VALUETRADE_ALLOW_MAINNET=0`), unchanged |
| A new origin secret | `deploy/release/rotate-origin-secret.sh begin`, then the Vercel variable and a deploy, then `... finish` (the script's `--help`) |
| Alerts | none from AWS (no SNS without a role). Put a free uptime monitor on `https://valuexplorer.vercel.app/api/health`; `remote.sh health` on demand |
| OS updates | monthly: `remote.sh run 'dnf upgrade --releasever=latest -y'`, then `provision.sh stop` and `start` |

Snapshots are never deleted by the scripts; remove old ones in the EC2 console
(Snapshots, tag `env=valuescan-test`) when they are no longer wanted.

## 8. Moving to a domain of its own later

1. Buy or add the domain in Vercel (Domains), add it to the project `valuexplorer`;
   Vercel issues the site's certificate. Keep `valuexplorer.vercel.app` working
   meanwhile.
2. DNS for the origin: an `A` record `api.<domain>` -> the Elastic IP (Vercel DNS:
   `npx vercel@latest dns add <domain> api A <elastic ip>`). Wait until it resolves.
3. `ec2.env`: `SITE_DOMAIN=<domain>` and `ORIGIN_DOMAIN_NAME=api.<domain>`, then
   `deploy/release/bootstrap-instance.sh`: Caddy gets a certificate for
   `api.<domain>`, the API allows `https://<domain>`. **From here until step 4 is
   live the index pages fail** (the function still asks for the sslip.io name,
   which Caddy no longer serves) - a few minutes; do it at a quiet moment.
4. `deploy/release/publish-vercel.sh <tag> --out=... --deploy` (the function now
   points at `https://api.<domain>`).
5. WalletConnect: add the domain to the project's allowed origins (OWNER-STEPS.md).
6. Smoke with `--site=https://<domain> --origin=api.<domain> --edge=vercel`.

Nothing on AWS is replaced: the instance, the volumes and the address stay. If the
address should not be exposed through a DNS name at all later, that is the
CloudFormation design (CloudFront in front, DEPLOY.md).

## 9. The origin name: sslip.io

`1-2-3-4.sslip.io` resolves to `1.2.3.4` - a free public service that gives the
instance a DNS name without a domain, so Caddy can get a Let's Encrypt certificate
for it over HTTP-01.

- **Public Suffix List (checked 2026-10-03, list version 2026-10-01): `sslip.io` is
  NOT on it** (nor is `nip.io`). For Let's Encrypt every `*.sslip.io` name therefore
  belongs to the one registered domain `sslip.io`, and shares its rate limit with
  everyone who uses it. sslip.io says Let's Encrypt has raised that limit for it
  from 50 to 250,000 certificates (a week), and that a request can still be
  rate-limited at busy times.
- One certificate (and a renewal every 60 or so days) is what this needs, so it is
  usable for the test. If Caddy logs a rate limit (`rateLimited`, "too many
  certificates"), the fallbacks, in order: wait and let Caddy retry (it backs off by
  itself); `nip.io` instead (the same service under another registered domain:
  `ORIGIN_DOMAIN_NAME=<ip-with-dashes>.nip.io` in `ec2.env`, `bootstrap-instance.sh`,
  `publish-vercel.sh ... --deploy`); or the domain step of section 8.
- **Trust**: whoever answers DNS for `sslip.io` decides where the function connects.
  A hijack of that DNS could obtain a certificate for the name and receive the
  origin secret. What the secret protects is public index data, and the test runs
  without a domain by the owner's choice; the move to `api.<domain>` (section 8)
  ends that dependency.

## 10. Taking it down (the end of the campaign, by hand)

Stop is usually what is wanted. To remove everything, in the EC2 console or with
the CLI: disable the instance's termination protection, terminate it (its root
volume goes with it), snapshot and then delete the data volume (or keep the
snapshot), release the Elastic IP, delete the security group and the key pair,
delete snapshots no longer wanted; in Vercel, remove the project or its domain. No
script does this, on purpose.

## 11. Open

- Not yet run against AWS or Vercel: everything above was tested offline (the
  scripts' `--print` plans against the real account's read-only answers, the Vercel
  routes and function against loopback, the backup and restore scripts locally).
- The legal pages (`/impressum`, `/privacy`, `/terms`) are being built in the web
  app; their placeholders are the owner's to fill (OWNER-STEPS.md).
- An external uptime monitor on `/api/health` is not set up.
- `docs/security/AUDIT-2026-09-30.md` still lists S-12 as open; it is fixed in
  `apps/server/src/localHost.ts` (any port on `127.0.0.1`, `localhost`, `[::1]`).
