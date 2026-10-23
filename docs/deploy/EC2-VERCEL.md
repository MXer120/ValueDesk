# The test environment: one EC2 instance + Vercel

The deployment that is actually being set up (decided 2026-10-03): the site and
`/api/*` on **Vercel** (`https://valuedeskapp.vercel.app`, no own domain yet), the
index and the hosted copy executor on **one EC2 instance** - in **ap-northeast-1
(Tokyo)** from 2026-10-23, in eu-central-1 (Frankfurt) before (the move: section 12;
the executor: section 13). `docs/deploy/DEPLOY.md` stays the reference for everything
on the instance and for the CloudFormation design this replaces for now; this file
says what is different and how to run it.

The owner's short version is `docs/deploy/OWNER-STEPS.md`.

> **State on 2026-10-03.** Prepared and tested offline; nothing is created yet. Every
> AWS and Vercel write is run by hand from the list in section 6.
>
> **State on 2026-10-23.** Frankfurt runs (sections 1-11 describe it as it was set up).
> The move to Tokyo and the copy executor are prepared and tested offline only;
> nothing of section 12 has been run. Until it is, the live origin is Frankfurt's and
> the function runs in fra1.

## 1. What runs where

```
visitor ──HTTPS──> Vercel  valuedeskapp.vercel.app
                     ├── the built site (static files, the production headers and CSP of edge.yaml)
                     └── /api/* ──> function api/__vs_proxy (Node.js, hnd1 Tokyo; fra1 before the move)
                                      ──HTTPS + X-Origin-Verify + the viewer's address
                                        (+ X-Viewer-Country on /api/copy/*)──>
                                    Caddy :443 on the instance (<elastic-ip-with-dashes>.sslip.io)
                                      refuses anything without the secret, then
                                        /api/copy/* ──> 127.0.0.1:8799  valuescan-executor (hosted copy executor)
                                        the rest    ──> 127.0.0.1:8797  valuescan-api (hosted mode, 18 GET routes)
                                    + valuescan-indexer
browser ──directly──> SoDEX, Hyperliquid, Lighter, Arcus, WalletConnect, public RPCs (as before)
browser ──directly──> http://127.0.0.1:<port> - a follower's self-hosted executor, only when they set one up
```

| Piece | Where it is defined |
|---|---|
| The instance, its data volume, the Elastic IP, the security group, the key pair | `deploy/aws/ec2/provision.sh` + `ec2.env` (Tokyo during the move: `ec2.tokyo.env`, `VS_EC2_ENV`) |
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
| No SNS alerts, no CloudWatch alarms: the health check logs only | no IAM / CloudFormation | watch `https://valuedeskapp.vercel.app/api/health` from outside (section 7) |
| **Port 443 is open to everyone**, and **Caddy refuses every request without the origin secret** before the API sees it. Without that gate a client could connect directly and set its own `X-Forwarded-For`, which the API keys its limits on. | Vercel functions have no published address range, so no security group can admit "Vercel only" | `Caddyfile.template` (`@edge`), `caddy.service` (`caddy.secret.env`), `deploy/smoke/deployed.mjs` (`--edge=vercel`) |
| The edge is a Vercel function, not CloudFront: same methods (GET, HEAD, OPTIONS), same forwarded headers, same 60 s ceiling on caching, the viewer's address in `X-Forwarded-For`. Beyond CloudFront, for the copy executor only (`/api/copy/*`): POST (64 KB), `Content-Type` and `Authorization`, `X-Viewer-Country` from Vercel's `x-vercel-ip-country`, never cached | the owner's choice; the executor | `deploy/vercel/api-proxy.cjs` |
| The copy executor runs on the instance as its own user, behind the same Caddy gate (section 13) | its followers' sealed keys | `valuescan-executor.service`, `Caddyfile.template` |
| No WAF and no country restriction at the edge. Left: Vercel's own DDoS mitigation, the API's per-client limits, Caddy's gate. Vercel's firewall can add custom rules (3 on Hobby) if needed. | no CloudFront | - |
| Memory caps for 4 GiB: API 1300M/1500M, indexer 1400M/1800M, copy executor 400M/600M (high/max) | `t4g.medium` | the three units |
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

**Tokyo (ap-northeast-1), from the move on (section 12).** The same shape costs a
little more there. These are the ap-northeast-1 list prices as known on 2026-10-23,
**not checked against the live price list** - confirm them before relying on them
(`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-northeast-1/index.json`,
or `aws pricing get-products --region us-east-1 --service-code AmazonEC2 --filters
Type=TERM_MATCH,Field=regionCode,Value=ap-northeast-1
Type=TERM_MATCH,Field=instanceType,Value=t4g.medium ...` if the profile may):

| Item | Price (ap-northeast-1) | Running, USD/month | Stopped, USD/month |
|---|---|---|---|
| `t4g.medium` on demand | 0.0432 / hour | 31.54 | 0 |
| CPU above the baseline (`unlimited`) | 0.04 / vCPU-hour | **estimate** 6 to 18, as above | 0 |
| Root volume, gp3 16 GiB | 0.096 / GB-month | 1.54 | 1.54 |
| Data volume, gp3 (80 GiB as Frankfurt's live one; 150 GiB as planned) | 0.096 / GB-month | 7.68 (80) / 14.40 (150) | same |
| Elastic IP (public IPv4) | 0.005 / hour | 3.65 | 3.65 |
| EBS snapshots | 0.05 / GB-month | **estimate** 3 to 9 | same |
| Data out to the internet | first 100 GB a month free (all of AWS), then 0.114 / GB | **estimate** 0 | 0 |
| The move, once: the snapshot copy from eu-central-1 | about 0.02 / GB transferred between regions | **estimate** 1 to 2, once | - |
| **Total (Hobby, 80 GiB)** | | **about 44.40 + CPU surplus + snapshots** | **about 12.90 + snapshots** |

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

This is how the Frankfurt environment was set up (2026-10-03), with the values the
template had then (eu-central-1a, `valuescan-test`, `ami-0fc2b4786eaf34856`). The
template holds Tokyo's since 2026-10-23; moving the running environment, with its
data, is section 12 - not these steps.

**0. Settings** (both files are ignored by git; neither holds a secret).

```
cp deploy/aws/ec2/ec2.env.example deploy/aws/ec2/ec2.env       # preset then: eu-central-1a, t4g.medium, 150 GiB, valuedeskapp.vercel.app
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
npx vercel@latest link --yes --project valuedesk --scope mxer120s-projects --cwd C:/Temp/valuedesk-deploy
npx vercel@latest env add VALUESCAN_ORIGIN_SECRET production --sensitive --scope mxer120s-projects --cwd C:/Temp/valuedesk-deploy < ~/.valuescan/valuescan-test/origin-secret
```

Production only, on purpose: preview deployments (other host names) get no secret,
and their `/api` answers 503. Only `valuedeskapp.vercel.app` reaches the index.

**7. The site.**

```
git checkout v0.1.0
deploy/release/build-web.sh v0.1.0                       # needs VITE_WALLETCONNECT_PROJECT_ID; a first test without it: --allow-dirty
deploy/release/publish-vercel.sh v0.1.0 --out=/c/Temp/valuedesk-deploy --deploy
```

`publish-vercel.sh` checks and audits the build, writes
`/c/Temp/valuedesk-deploy/.vercel/output` (the static site, `config.json` with the
routes and headers, the function with `VALUESCAN_ORIGIN_URL=https://<origin name>`),
then runs `npx vercel@latest deploy --prebuilt --prod --cwd ...`. Without `--deploy`
it prints that command. The project is `valuedesk` (renamed from `valuexplorer` on 2026-10-03; `valuedesk.vercel.app`
is someone else's, so the site's address is `valuedeskapp.vercel.app`, and the old
`valuexplorer.vercel.app` still serves it). A new address goes into `SITE_DOMAIN` in `ec2.env`
(then `bootstrap-instance.sh` again) - or, without a re-bootstrap, into
`VALUESCAN_ALLOWED_ORIGINS` in `/etc/valuescan/api.env` (comma separated) and `remote.sh restart api`.

**8. Check what is out there.**

```
node deploy/smoke/smoke.mjs --site=https://valuedeskapp.vercel.app --origin=<elastic-ip-with-dashes>.sslip.io --edge=vercel
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
| The copy executor | `remote.sh logs executor 100` / `restart executor`; a release of it alone: `release-server.sh <tag> --executor-only` (section 13) |
| The Tokyo environment during the move | the same commands with `VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env` in front (section 12) |
| A server release / rollback | `deploy/release/release-server.sh <tag> [--api-only]` / `deploy/release/rollback.sh server` |
| A web release / rollback | `build-web.sh <tag>` + `publish-vercel.sh <tag> --out=... --deploy` / `npx vercel@latest rollback` |
| A backup now; a snapshot | `deploy/release/remote.sh backup` (the index, then the executor's database); `deploy/aws/ec2/provision.sh snapshot` (weekly, and before a risky release) |
| Restore | `deploy/release/remote.sh restore latest` (dry run), then `--yes`; older: a snapshot -> a new volume, by hand |
| More disk | raise `DATA_VOLUME_GIB` in `ec2.env`, `provision.sh grow`, then `remote.sh run 'xfs_growfs /var/lib/valuescan'` |
| Trading off for every visitor | DEPLOY.md section 15 (`VALUETRADE_ALLOW_MAINNET=0`), unchanged |
| A new origin secret | `deploy/release/rotate-origin-secret.sh begin`, then the Vercel variable and a deploy, then `... finish` (the script's `--help`) |
| Alerts | none from AWS (no SNS without a role). Put a free uptime monitor on `https://valuedeskapp.vercel.app/api/health`; `remote.sh health` on demand |
| OS updates | monthly: `remote.sh run 'dnf upgrade --releasever=latest -y'`, then `provision.sh stop` and `start` |

Snapshots are never deleted by the scripts; remove old ones in the EC2 console
(Snapshots, tag `env=valuescan-test`) when they are no longer wanted.

## 8. Moving to a domain of its own later

1. Buy or add the domain in Vercel (Domains), add it to the project `valuedesk`;
   Vercel issues the site's certificate. Keep `valuedeskapp.vercel.app` working
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
- The move to Tokyo (section 12) and the copy executor (section 13) are prepared and
  checked offline only: the scripts against a stand-in for the AWS CLI, the Vercel
  function, the health check and the backup against loopback and local files. Not
  checked: the Caddyfile with a Caddy binary (bootstrap.sh validates it on the
  instance before it installs it), the units with systemd, a real snapshot copy.
- `apps/executor` is not a workspace of the root `package.json`: on the instance it
  runs on the `@noble/*` and `tsx` that the server workspace installs. Should it get
  dependencies of its own, it has to become a workspace (`release.sh` then installs
  it too).
- Whether `upgrade-insecure-requests` leaves a request to a self-hosted executor on
  `http://127.0.0.1:<port>` alone in every supported browser is to be confirmed in a
  browser against the production header (SECURITY-HEADERS.md 1.2).
- The Tokyo prices in section 4 are not checked against the live price list.

## 12. Moving to Tokyo (2026-10-23)

The instance moves from eu-central-1 (Frankfurt, environment `valuescan-test`) to
ap-northeast-1 (Tokyo, environment `valuescan-tokyo`), and the `/api` function from
`fra1` to `hnd1`. Nothing is replaced in place: Tokyo is a second environment, made
from a copy of Frankfurt's data volume; Frankfurt is stopped at the end, not deleted.

| | Moves with the data volume (snapshot -> copy -> new volume) | New in Tokyo | Stays the same |
|---|---|---|---|
| What | the index and its WAL, the nightly backup, `/var/lib/valuescan/state` (builder ledger `builder.db`, the builder-terms signing key, `device.key`) | instance, Elastic IP (so a new `<ip>.sslip.io` name and certificate), security group, key pair `valuescan-tokyo`, the root volume (Node, Caddy, `/etc/valuescan`, written by the bootstrap) | the site address, the origin secret (`~/.valuescan/valuescan-test/origin-secret`: the Vercel variable needs no change), the builder-terms public key in the web build |

**Lost in the move:** what Frankfurt writes after its snapshot - index fills (the
indexer re-reads the gap for the traders on the boards, as after any stop) and what
its API counts into `builder.db` until Vercel points at Tokyo. Keep the time between
step 2 and step 8 short; the snapshot copy (step 3) is the slow part.

**The copy executor never runs in Frankfurt.** Two executors started from copies of
one data directory would both trade for the same followers. Frankfurt has had no
release with `apps/executor`, so its volume holds no executor data; step 0 checks it.
Do not release a tag with the executor to Frankfurt (the commands without
`VS_EC2_ENV` go to Frankfurt).

Every Tokyo command below carries `VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env`; a
command without it works on `deploy/aws/ec2/ec2.env`, which is Frankfurt. Each script
first prints `environment: <name> in <region>` - read it. All from the repository
root in Git Bash; `v0.2.0` stands for the tag that contains this `deploy/` and
`apps/executor`.

**0. Before.** The tag exists and is pushed; Frankfurt is healthy; no executor runs there.

```
git tag v0.2.0 && git push origin v0.2.0
deploy/release/remote.sh health                                                   # Frankfurt: "ok":true
deploy/release/remote.sh run 'systemctl is-active valuescan-executor || true'     # Frankfurt: "inactive" - nothing else
```

**1. Tokyo's settings** (ignored by git; no secret in them).

```
cp deploy/aws/ec2/ec2.tokyo.env.example deploy/aws/ec2/ec2.tokyo.env
aws ec2 describe-images --profile claude --region ap-northeast-1 --owners amazon \
  --filters 'Name=name,Values=al2023-ami-2023.*-kernel-6.1-arm64' 'Name=state,Values=available' \
  --query 'sort_by(Images,&CreationDate)[-1].[ImageId,Name,CreationDate]' --output text
```

In `ec2.tokyo.env`: `AMI_ID=<that ImageId>`. `DATA_VOLUME_GIB`: at least the size of
Frankfurt's volume (`ec2.env` says 80; `provision.sh status` shows it) - 80 moves it as
it is; more needs step 5b.

**2. Snapshot Frankfurt.**

```
deploy/release/remote.sh backup                 # a fresh consistent copy of the index onto the volume
deploy/aws/ec2/provision.sh snapshot            # Frankfurt's data volume; prints snap-...
deploy/aws/ec2/provision.sh status              # repeat until that snapshot is "completed"
```

**3. Copy it to Tokyo.**

```
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/aws/ec2/provision.sh copy-snapshot --print
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/aws/ec2/provision.sh copy-snapshot      # prints the copy's snap-...
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/aws/ec2/provision.sh status             # "copied data snapshots": repeat until completed
```

`copy-snapshot` takes the newest completed `role=data-snapshot` of `valuescan-test` in
eu-central-1 (`SNAPSHOT_SOURCE_*` in `ec2.tokyo.env`; a `snap-...` argument names one),
copies it encrypted with ap-northeast-1's default EBS key and tags it
`role=data-snapshot-copy`, `source-snapshot=<id>`; run again, it finds that copy and
makes no second. When it is completed: `DATA_VOLUME_SNAPSHOT=<the copy's snap-...>` in
`ec2.tokyo.env`.

**4. The Tokyo environment, from the copy.**

```
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/aws/ec2/provision.sh up --print   # 10 writes; "creating it FROM snap-..."
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/aws/ec2/provision.sh check
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/aws/ec2/provision.sh up
```

Creates the key pair `valuescan-tokyo` (private key to `~/.ssh/valuescan-tokyo.pem`),
the security group, an Elastic IP, the instance and the data volume from the copy;
writes `deploy/aws/ec2/.out/state.tokyo.env` (Frankfurt's `state.env` is not touched)
and prints Tokyo's origin name, `<tokyo-ip-with-dashes>.sslip.io` - called `$TOKYO`
below. `InsufficientInstanceCapacity` in ap-northeast-1a: `AVAILABILITY_ZONE=ap-northeast-1c`
(or `-1d`; Tokyo has no `-1b` for most accounts) in `ec2.tokyo.env` - only while the
data volume does not exist yet - and `up` again.

**5. Bootstrap Tokyo** (give it a minute to boot).

```
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/release/bootstrap-instance.sh
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/release/remote.sh logs caddy 40     # "certificate obtained successfully" for $TOKYO
```

It mounts the copied volume as it is ("already holds an xfs filesystem"), hands the
files over if the new instance's user ids differ from Frankfurt's ("belongs to ids
..."), creates `valuescan-executor` and `/var/lib/valuescan/executor` (0700), and uses
the existing origin secret - it generates none. No release is installed yet, so
nothing but Caddy starts.

5b. Only if `DATA_VOLUME_GIB` is larger than Frankfurt's volume:
`VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/release/remote.sh run 'xfs_growfs /var/lib/valuescan'`.

5c. A volume made from a snapshot fetches each block from S3 on its first read. On
2026-10-23 that held the indexer on the 18 GB index at ~90 % IO pressure (12 s of CPU in
23 minutes, the board a week old), and a `dd` read-through managed 6 MiB/s next to it:
hours. What worked: a second volume from the same snapshot with EBS's provisioned
initialization rate, fully read in ~5 minutes while the first one still served, then
swapped in (the filesystem UUID is the snapshot's, so `/etc/fstab` mounts it as is):

```
aws ec2 create-volume --profile claude --region ap-northeast-1 --availability-zone ap-northeast-1a \
  --snapshot-id <copy> --volume-type gp3 --size 80 --encrypted --volume-initialization-rate 300 \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=project,Value=valuescan},{Key=env,Value=valuescan-tokyo},{Key=role,Value=data-next}]'
aws ec2 describe-volume-status ... --volume-ids <new>      # until initialization-state=completed
# on the instance: stop valuescan-health.timer, the indexer, the API and the executor; umount /var/lib/valuescan
aws ec2 detach-volume --volume-id <old>; aws ec2 attach-volume --volume-id <new> --instance-id <i> --device /dev/sdf
# on the instance: mount /var/lib/valuescan, bootstrap.sh's adopt + install -d lines (section 3), start the units
```

Then tag the new volume `role=data` and the old `role=data-replaced` (provision.sh finds
the data volume by tag), and put the new id in `.out/state.tokyo.env`. Next time, create the
volume like this in the first place (provision.sh `up` does not pass the rate yet).

**6. The server release in Tokyo.**

```
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/release/release-server.sh v0.2.0
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/release/remote.sh status    # indexer, api, executor: active, release v0.2.0
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/release/remote.sh health    # "ok":true; executor "0 copies, 0 active"
```

**7. Check Tokyo through its origin**, from the workstation, while Vercel still points
at Frankfurt. The secret goes to curl on stdin, never on a command line:

```
TOKYO=<tokyo-ip-with-dashes>.sslip.io        # ORIGIN_NAME in deploy/aws/ec2/.out/state.tokyo.env
printf 'X-Origin-Verify: %s\n' "$(cat ~/.valuescan/valuescan-test/origin-secret)" | curl -fsS -H @- "https://$TOKYO/api/health"
printf 'X-Origin-Verify: %s\n' "$(cat ~/.valuescan/valuescan-test/origin-secret)" | curl -fsS -H @- "https://$TOKYO/api/vs/leaderboard?venue=hyperliquid&window=1d&limit=1" | head -c 300; echo
printf 'X-Origin-Verify: %s\n' "$(cat ~/.valuescan/valuescan-test/origin-secret)" | curl -fsS -H @- "https://$TOKYO/api/copy/v1/info"
node --input-type=module -e "const m = await import('./deploy/smoke/deployed.mjs'); console.log(JSON.stringify(await m.probeOrigin(process.argv[1], { edge: 'vercel' }), null, 2))" "$TOKYO"
```

The first three answer; the last must report `"problems": []` (nothing served without
the secret, ports 8797 and 8799 closed).

**8. Vercel: the function in `hnd1`, pointing at Tokyo.**

Since 2026-10-23 the `valuedesk` project is connected to the repository and builds a
commit itself (`vercel.json` -> `deploy/vercel/build.sh`, the same build, checks and
Build Output as below). Then this step is: `VALUESCAN_ORIGIN=$TOKYO` in
`deploy/vercel/production.settings`, commit, push to a branch (Vercel builds a preview:
check it built), then to `main` (production). The upload below still works when the
CLI is logged in:

```
git checkout v0.2.0
deploy/release/build-web.sh v0.2.0
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/release/publish-vercel.sh v0.2.0 --out=/c/Temp/valuedesk-deploy            # read: "the /api function in hnd1 -> https://$TOKYO"
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/release/publish-vercel.sh v0.2.0 --out=/c/Temp/valuedesk-deploy --deploy
```

The origin comes from Tokyo's state file, the region from `deploy/vercel/package.mjs`.
No Vercel variable changes (the same origin secret). From here `/api` reaches Tokyo;
Frankfurt still runs, but nothing reaches it.

**9. Smoke test.**

```
node deploy/smoke/smoke.mjs --site=https://valuedeskapp.vercel.app --origin=$TOKYO --edge=vercel
curl -fsS https://valuedeskapp.vercel.app/api/health
curl -fsS https://valuedeskapp.vercel.app/api/copy/v1/health
curl -fsSI https://valuedeskapp.vercel.app/api/health | grep -i x-vercel-id         # contains hnd1
curl -fsSI https://valuedeskapp.vercel.app/api/copy/v1/info | grep -i cache-control  # no-store
```

**Going back**, any time before step 10: `npx vercel@latest rollback` (the previous
production deployment: `fra1`, Frankfurt's origin). After step 10: `provision.sh start`
first.

**10. Stop Frankfurt - stop, never terminate.**

```
deploy/aws/ec2/provision.sh stop      # ec2.env: Frankfurt. Nothing is deleted; termination protection stays on
deploy/aws/ec2/provision.sh status    # stopped; its volumes, address and snapshots are still there
```

**What still costs while Frankfurt is stopped** (eu-central-1 prices, section 4):

| Item | USD/month |
|---|---|
| Elastic IP (billed in use or idle) | 3.65 |
| Root volume, 16 GiB | 1.52 |
| Data volume, 80 GiB | 7.62 |
| Frankfurt's snapshots | 0.054 per GB-month of stored blocks |
| Tokyo's copied snapshot (`role=data-snapshot-copy`) - a full copy, in ap-northeast-1 | 0.05 per GB-month; it can go once Tokyo has its own snapshot (step 11) |
| **Frankfurt, stopped** | **about 12.80 + snapshots** |

**11. After the first night in Tokyo.**

```
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/release/remote.sh health      # the backup is fresh
VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env deploy/aws/ec2/provision.sh snapshot # Tokyo's first own snapshot
```

Optional, later: make Tokyo the default, so the commands need no `VS_EC2_ENV` (the
state files follow the env files' names):

```
mv deploy/aws/ec2/ec2.env deploy/aws/ec2/ec2.frankfurt.env && mv deploy/aws/ec2/.out/state.env deploy/aws/ec2/.out/state.frankfurt.env
mv deploy/aws/ec2/ec2.tokyo.env deploy/aws/ec2/ec2.env && mv deploy/aws/ec2/.out/state.tokyo.env deploy/aws/ec2/.out/state.env
```

Frankfurt is then `VS_EC2_ENV=deploy/aws/ec2/ec2.frankfurt.env`.

**Deleting Frankfurt is a separate decision**, the owner's, made by hand later - not
part of the move. It is section 10 for Frankfurt only (eu-central-1, tag
`env=valuescan-test`): termination protection off, terminate, the data volume (keep a
snapshot or not), the Elastic IP, the security group, the key pair, the snapshots no
longer wanted; then the Tokyo copy of its snapshot. No script does it. Until then,
Frankfurt is the way back.

## 13. The copy executor

The hosted copy executor (`apps/executor`, `EXECUTOR_KIND=hosted`): it watches the
leaders' public trades and places each follower's copies on SoDEX with the key that
follower registered. The same program a follower can run on their own machine
(`apps/executor/README.md`); this is ValueDesk's own instance of it.

| | |
|---|---|
| Unit | `valuescan-executor.service`: `node --max-old-space-size=384 --import tsx src/main.ts` in `/opt/valuescan/current/apps/executor`, `Restart=always`, MemoryHigh 400M / MemoryMax 600M, no core dumps. Independent of the API: an API restart never touches it |
| User | `valuescan-executor`, a member of the group `valuescan` (reads the release, `/etc/valuescan`, the builder ledger) - not `valuescan`, so the API and the indexer cannot read its keys. What the group may read, it may read: keep `/etc/valuescan/api.local.env` (the SoSoValue key) root-only, `chmod 600` - systemd reads it as root |
| Listens | `127.0.0.1:8799` only. Caddy sends `/api/copy/*` there, behind the origin-secret gate; the executor checks the secret again (all but `/api/copy/v1/health`) |
| The edge | `/api/copy/*` only: POST (64 KB), `Content-Type`, `Authorization`, `X-Viewer-Country` from Vercel's `x-vercel-ip-country`, never cached (`deploy/vercel/api-proxy.cjs`) |
| Settings | `/etc/valuescan/executor.env` (from `deploy/server/env/executor.env.example`; `executor.local.env` for your own), `/etc/valuescan/executor.secret.env` (root only: the origin secret(s)) |
| Data | `/var/lib/valuescan/executor` (0700): `executor.db` (+ `-wal`, `-shm`), `kek`, `session.key` |
| Release | in the same tarball as the server; `release-server.sh` restarts it after the API; alone: `--executor-only` |
| Health | `healthcheck.mjs` check `executor` (`/api/copy/v1/health`), and the unit in `units`. Its nightly backup is not in the health check (the marker is in its own 0700 directory): `remote.sh logs executor-backup` |
| Logs | `remote.sh logs executor 100` (request lines only at `LOG_LEVEL=debug`) |

**What is where - backup and snapshots:**

| File | Nightly backup (`valuescan-executor-backup.service`, after the index's) | EBS snapshots of the data volume |
|---|---|---|
| `executor.db`: copies, activity, accepted terms, every signed instruction, the followers' keys **sealed** | yes: a consistent `VACUUM INTO` copy, `/var/lib/valuescan/backup/executor/archive/valuescan-executor-<time>.db.zst` (newest 7) or `s3://<ops bucket>/backups/valuescan-executor-*` | yes |
| `kek` (the key that seals every follower's key), `session.key` (signs the followers' read tokens) | **never** | yes - only there |

So a backup alone cannot sign a trade, and cannot bring the followers' keys back: on a
new volume without a snapshot, every follower registers a new key. **A snapshot holds
everything needed to trade for every follower** - treat it like a key (as the builder
signing key, DEPLOY.md section 16): never share one, delete old ones.

**Never two executors from copies of one data directory** - a volume made from a
snapshot while the original still runs would place every copy twice. Before an
executor's volume is copied elsewhere, stop and disable it at the source
(`systemctl disable --now valuescan-executor`) and keep it so.

**Restoring `executor.db`** (only when the live one is lost or damaged). A restored
database knows nothing after its time: a copy stopped or a key deleted since then is
back as it was - tell the followers concerned (their hard stop is revoking the key on
SoDEX). On the instance (`remote.sh shell`):

```
sudo systemctl stop valuescan-executor
B=/var/lib/valuescan/backup/executor/archive/valuescan-executor-<time>.db.zst
D=/var/lib/valuescan/executor
sudo -u valuescan-executor sh -c "zstd -d -q -c $B > $D/executor.db.restore"
sudo sha256sum $D/executor.db.restore; sudo cat $B.sha256            # the same sum - or stop here
sudo -u valuescan-executor mv $D/executor.db $D/executor.db.replaced-$(date -u +%Y%m%dT%H%M%SZ)
sudo -u valuescan-executor rm -f $D/executor.db-wal $D/executor.db-shm
sudo -u valuescan-executor mv $D/executor.db.restore $D/executor.db
sudo systemctl start valuescan-executor
```

`restore.sh` (the index) refuses an executor backup.

**A follower's self-hosted executor** listens on `http://127.0.0.1:<port>` on their own
machine; the site's CSP allows `http://127.0.0.1:*` and `http://localhost:*` in
`connect-src` for it (SECURITY-HEADERS.md 1.2), and the executor answers Chrome's
Private Network Access preflight.
