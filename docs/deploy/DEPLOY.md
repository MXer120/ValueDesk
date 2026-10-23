# Deploying Valuescan to AWS

The runbook: what to fill in, what to run, in which order, and what to look at
afterwards. The reference for each part sits next to its code:

| | |
|---|---|
| `deploy/aws/README.md` | the three CloudFormation stacks, their parameters, what an update does to the instance |
| `deploy/server/README.md` | everything on the instance: units, environment files, logs, backups, the health check |
| `deploy/release/README.md` | the release scripts and the build-time settings of the web |
| `deploy/smoke/README.md` | the smoke test, locally and against the deployed site |
| `docs/deploy/SECURITY-HEADERS.md` | why the headers, the CSP and the hosted-mode settings are what they are |

> **The deployment being set up now is not this one.** Since 2026-10-03 the test
> environment is one EC2 instance made by a script plus Vercel for the site and
> `/api` - the deploying AWS user may not use CloudFormation, IAM or SSM, and the
> owner chose Vercel: **`docs/deploy/EC2-VERCEL.md`** (and, for the owner,
> `docs/deploy/OWNER-STEPS.md`). Everything about the instance itself - units,
> environment, backups, health, releases, the switches - is this file and applies
> there too; section 3 of EC2-VERCEL.md lists each difference.
>
> **State of this design on 2026-10-03.** Nothing is deployed with it. The templates
> passed the offline validation only; AWS's own `validate-template` is step 2 below.
> Section 13 says what the local smoke test proved, section 14 what was found while
> preparing this and where each item stands.

## 1. What gets deployed

```
visitor ──HTTPS──> CloudFront ──┬── site bucket (S3, private)          the built web: /, /assets/*, /logos/*, ...
   │                (+ WAF)     └── /api/* ──HTTPS + secret──> Caddy :443 ──> 127.0.0.1:8797
   │                                                           on ONE instance:  valuescan-api      (hosted mode, 18 GET routes)
   │                                                                             valuescan-indexer  (the one writer of the index)
   └──────────── directly from the browser ──> SoDEX, Hyperliquid, Lighter, Arcus, WalletConnect, public RPCs
```

- **The server is only the index.** Trading, balances, history, Scan and the live
  streams go from each visitor's browser straight to the exchanges
  (`docs/ARCH-traffic.md`). No key, no order and no funds ever touch the instance.
- **Three stacks, defined once** (`deploy/aws`): `valuescan-network` (free: VPC,
  security group, the ops bucket), `valuescan-compute` (billed by the hour: the
  one instance, its volume, its address), `valuescan-edge` (us-east-1: site
  bucket, CloudFront, certificate, WAF, DNS).
- **Pausing is stop, never delete.** `deploy.sh stop` / `start` flip one
  parameter; the instance, both volumes, the address and the network stay. Nothing
  here creates and deletes instances per test, and there is one region.

## 2. What only the owner can supply

| What | Where it goes | Notes |
|---|---|---|
| AWS account and region | `REGION` in `deploy/aws/params.env`; credentials in the AWS CLI | The account must be allowed to launch an instance - see "If the instance cannot be launched" in section 15. The region is a price and data-protection choice: the index only reads the exchanges, latency does not matter to it. |
| Domain and its Route 53 zone | `DOMAIN_NAME`, `HOSTED_ZONE_ID`, `ORIGIN_DOMAIN_NAME` | With the zone id the certificate and all records are automatic. With DNS elsewhere leave it empty and create three records by hand (section 15). |
| WalletConnect / Reown project id | `VITE_WALLETCONNECT_PROJECT_ID` in `deploy/release/web.env` | Create the project at dashboard.reown.com and put the production domain on its allowed list. Without it wallets connect only as browser extensions. |
| Builder account id and fee | `VITE_BUILDER_ID`, `VITE_BUILDER_FEE_PERPS`, `VITE_BUILDER_FEE_SPOT`, `VITE_BUILDER_MAX_FEE` in `web.env` | Fees are in tenths of a basis point. All empty = no fee is approved or charged. Whether and what to charge is a business and a legal decision. Per-wallet tiers: section 16. |
| Legal pages: Impressum, privacy policy, terms and risk notice | `/impressum`, `/privacy`, `/terms` (`apps/web/src/legal/`), linked from every page | Drafts with `[[OWNER: ...]]` placeholders. The texts are the owner's and need legal review; `build-web.sh --public` refuses a build while a placeholder is left. The privacy policy has to name what this setup does: section 12. |
| Contact address | the legal pages | |
| Alert address | `ALERT_EMAIL` in `params.env` | Receives the alarms and the health alerts; the address must confirm one mail from AWS. |
| ACME contact | `ACME_EMAIL` in `params.env` | Optional. Let's Encrypt warns it about a certificate problem at the origin. |
| Countries served | `GEO_RESTRICTION_TYPE`, `GEO_RESTRICTION_COUNTRIES` | CloudFront can refuse or admit countries. Which ones is a legal decision; the default is none. |
| Release tags | `git tag vX.Y.Z` | A release is always a tag; the scripts refuse anything else. |
| Start with the existing index, or cold | step 6 of the setup | A cold index needs a day to a quarter to fill its longer windows (`docs/INDEXER.md`). |

Nothing in this list is a secret that belongs in the repository. The one secret of
the deployment - the header value CloudFront and the origin share - is generated
into SSM Parameter Store and never printed or stored anywhere else.

## 3. Prerequisites

On the workstation:

- **bash** (Git Bash on Windows works) and **AWS CLI v2**, signed in with rights
  to create the stacks (CloudFormation, EC2, IAM, S3, CloudFront, ACM, Route 53,
  WAF, SSM, Lambda, SNS, CloudWatch).
- **Node 24** and the repository with `npm ci` done (the web is built here).
- **Python 3 with PyYAML** for the offline template validation (optional).
- **Chrome** for the smoke test.
- `deploy/` **committed and pushed**: a server release is `git archive` of a tag,
  and the tag has to contain `deploy/server`.
- The repository lives in a OneDrive folder on the owner's machine. The web build
  and the tarballs under `deploy/.out` are small and ignored by git, but they are
  synced. The index seed is gigabytes: `seed-index.sh` refuses a synced work
  directory and asks for another one.

In the AWS account:

- EC2 instance launches allowed (one `t4g.large`), one Elastic IP, one VPC.
- A Route 53 hosted zone for the domain, or access to its DNS elsewhere.
- If the zone has **CAA records**, they must allow `amazon.com` (CloudFront's
  certificate) and `letsencrypt.org` (the origin's). Without CAA records nothing
  needs doing; adding exactly these two is the recommended end state.

## 4. One-time setup

All commands from the repository root. Every script prints the AWS commands it
runs; `--print` shows them and runs nothing. `deploy.sh` creates a **change set and
stops** unless it is given `--execute`.

**1. Fill in the two files.**

```
cp deploy/aws/params.env.example  deploy/aws/params.env      # REGION, DOMAIN_NAME, HOSTED_ZONE_ID, ORIGIN_DOMAIN_NAME, ALERT_EMAIL
cp deploy/release/web.env.example deploy/release/web.env     # VITE_WALLETCONNECT_PROJECT_ID, the builder values
```

Both are ignored by git. Neither holds a secret.

**2. Validate.**

```
python deploy/aws/validate_offline.py        # no AWS call: syntax, intrinsics, the headers against the web's CSP, no ids or secrets
deploy/aws/deploy.sh validate                 # AWS's own check, read-only
```

The second runs exactly:

```
cd deploy/aws
aws cloudformation validate-template --region <REGION>  --template-body file://network.yaml
aws cloudformation validate-template --region <REGION>  --template-body file://compute.yaml
aws cloudformation validate-template --region us-east-1 --template-body file://edge.yaml
```

**3. The secret, then the network.**

```
deploy/aws/deploy.sh secret --execute         # 64 random hex characters into SSM Parameter Store; never printed
deploy/aws/deploy.sh network                  # read the change set
deploy/aws/deploy.sh network --execute
```

**4. The instance - the one launch of this environment.**

```
deploy/aws/deploy.sh compute                  # read the change set; it prints AMI_ID=ami-...
```

Put that `AMI_ID=ami-...` line into `params.env` now and never change it (a
different image id would replace the instance). Then:

```
deploy/aws/deploy.sh compute --execute
```

Confirm the subscription mail AWS sends to `ALERT_EMAIL`. If the stack fails at
`Instance`, see section 15 - do not retry in a loop.

**5. Set the instance up.**

```
deploy/release/bootstrap-instance.sh          # a few minutes: packages, Node, Caddy, users, units, the secret from SSM
deploy/release/remote.sh logs caddy           # look for "certificate obtained successfully"
```

The bootstrap is idempotent. Run it again whenever `deploy/server` changes.

**6. Optional: bring the index you already have.** Otherwise the instance starts
cold.

```
deploy/release/seed-index.sh "$LOCALAPPDATA/Valuescan/valuescan-index.db" --work-dir=/c/Temp/valuescan-seed
deploy/release/remote.sh restore seed/<the name it printed>.db.zst --yes
```

It copies the index read-only while the local indexer keeps running, but it reads
the whole file once (3.3 GB on 2026-10-02) and writes as much: pick a quiet moment.

**7. The first server release.**

```
git tag v0.1.0 && git push origin v0.1.0
deploy/release/release-server.sh v0.1.0
deploy/release/remote.sh health               # one JSON line: "ok":true, and which checks warn
```

Right after a first start `backup` warns (none yet) and, without a seed, `index`
fails until the first board is built. Everything else must pass.

**8. The edge.** 10 to 20 minutes (certificate validation, the distribution).

```
deploy/aws/deploy.sh edge
deploy/aws/deploy.sh edge --execute
```

**9. The site.**

```
git checkout v0.1.0
deploy/release/build-web.sh v0.1.0            # typecheck, vite build, the static audit against the production CSP
deploy/release/publish-web.sh v0.1.0          # upload, cache headers, CloudFront invalidation
```

**10. Check what is really out there.**

```
node deploy/smoke/smoke.mjs --site=https://<DOMAIN_NAME> --origin=<ORIGIN_DOMAIN_NAME>
```

It walks every page of the deployed site in headless Chrome and checks the
headers CloudFront really sends against `edge.yaml`, the hosted gate through the
edge, that no page violates the CSP or asks for a route the server does not serve,
that the SharedWorker runs under the production policy, and that the instance is
closed to everyone but CloudFront. Then work through section 11.

## 5. Release

A release is a git tag. The web and the server are released separately.

```
git tag v0.1.1 && git push origin v0.1.1

# server
deploy/release/release-server.sh v0.1.1               # restarts the indexer, then the API
deploy/release/release-server.sh v0.1.1 --api-only    # restarts the API only

# web
git checkout v0.1.1
deploy/release/build-web.sh v0.1.1
deploy/release/publish-web.sh v0.1.1
```

- **Order on the instance: the indexer first, then the API.** The indexer is the
  writer and applies schema changes as it opens the index. Zero downtime is not a
  goal: the API is back in seconds, and CloudFront serves the index from its short
  cache meanwhile.
- **Every indexer restart costs its Lighter stream 3.5 to 8 minutes** (about 220
  markets are re-subscribed one by one), and that gap has to be re-read for the
  traders on the boards. Hyperliquid and SoDEX are back in seconds. So a release
  that changes only what the API runs - routes, payloads, `perf.ts`, the hosted
  gate - goes out with `--api-only`; everything else at a quiet moment.
- **Server first when both change**, so the web never asks for a route or a field
  the server does not have yet.
- **A release that changes the CSP** (`apps/web/index.html`): change
  `deploy/aws/edge.yaml` and `deploy/smoke/prod-headers.mjs` in the same commit -
  `validate_offline.py` and `build-web.sh` fail until the three agree. Then
  `deploy/aws/deploy.sh edge --execute` **before** `publish-web.sh`: a browser
  enforces both the header and the page's own policy, so the header has to allow
  the new host by the time the page asks for it.
- The install on the instance is `npm ci --workspace apps/server` from the
  committed lockfile. Not `--omit=dev`: the server runs its TypeScript through
  `tsx`, a devDependency. Never `npm install` on the instance.

## 6. Rollback

```
deploy/release/rollback.sh web v0.1.0          # the stored build of that tag again; about a minute
deploy/release/rollback.sh server              # back one release, indexer then API
deploy/release/rollback.sh server --api-only
deploy/release/rollback.sh status              # what is installed, what each unit runs
```

- **Web:** every published build is kept in the ops bucket, and old hashed assets
  are never deleted from the site bucket, so going back is only the old HTML again.
- **Server:** the instance keeps the last three releases installed; a rollback
  switches a link and restarts. Further back: release that tag again.
- **The database is not rolled back.** Schema changes so far only add tables and
  columns, which older code ignores. Before a release that changes data in a way
  older code cannot read, take a backup by hand (`deploy/release/remote.sh backup`);
  going back then means restoring it.

## 7. Stop and start

```
deploy/aws/deploy.sh stop  --execute           # the instance stops; nothing is deleted
deploy/aws/deploy.sh start --execute           # the units come up by themselves
```

While it is stopped the site still loads and trading, Portfolio and Scan still
work (they are browser-direct); the index pages say the index is unavailable. A
stopped instance costs its storage, its address and the edge (section 10). After a
start the indexer re-reads the gap for the traders on its boards; the all-account
activity counts keep a hole for the time it was away.

## 8. Backups

- **What:** the index database, nightly at about 03:20 UTC, as one consistent copy
  (`VACUUM INTO` from a read-only connection - the indexer keeps writing),
  integrity-checked, compressed, with a checksum, in
  `s3://<ops bucket>/backups/`. Right after it, the copy executor's database the same
  way (`backups/valuescan-executor-*`, `valuescan-executor-backup.service`) - without
  its key-encryption key and session key, which stay on the data volume and in its
  snapshots only (EC2-VERCEL.md section 13). Nothing else on the instance is backed up
  (the builder files of section 16 neither).
- **Retention:** 14 days, by the bucket's lifecycle rule (`BackupRetentionDays`).
  The instance can write backups and cannot delete them.
- **By hand:** `deploy/release/remote.sh backup`.

Restore:

```
deploy/release/remote.sh restore latest            # DRY RUN: downloads, verifies, prints the plan
deploy/release/remote.sh restore latest --yes      # stops both services, swaps the file, starts them
deploy/release/remote.sh restore backups/valuescan-index-20261002T031712Z.db.zst --yes
```

The download is verified (checksum, integrity) before anything is stopped, and the
replaced database is moved aside, not deleted: remove it once the restore is
confirmed (`deploy/release/remote.sh disk` shows it). **Test a restore once before
launch** - a backup that was never restored is a hope.

Losing the instance entirely: the data volume is a separate, encrypted EBS volume
and is snapshotted if the compute stack is ever deleted
(`DataVolumeSnapshotId` brings it back). Losing the volume: a new one, the
bootstrap, `restore latest --yes`.

## 9. Monitoring

| Watch | How | Bad when |
|---|---|---|
| The API answers | `curl -s https://<DOMAIN>/api/health` (public, through CloudFront) | not `{"ok":true,...}`. Put any external uptime monitor on this URL: the instance cannot report its own death. |
| The trading switch | the same answer: `"mainnetWritesAllowed":true`, `"network":"mainnet"` | not what you set |
| The index is fresh | `deploy/release/remote.sh health` → `index` | the board is older than 15 minutes |
| The indexer | `remote.sh health` → `indexer`; `remote.sh logs indexer` (one status line a minute) | its status is older than 3 minutes, no board for 15 minutes; a stream that is down is a warning |
| Disk | `remote.sh health` → `disk`; `remote.sh disk` | a volume over 80 %, or no room for the next backup copy (it needs the size of the index free) |
| Backups | `remote.sh health` → `backup` | the last one is older than 36 hours |
| The origin's certificate | `remote.sh health` → `tls`; `remote.sh logs caddy` | under 14 days left (Caddy renews long before that) |
| CPU credits | CloudWatch, `AWS/EC2`: `CPUCreditBalance`, `CPUSurplusCreditBalance`, `CPUSurplusCreditsCharged`, `CPUUtilization` | the balance falls towards 0, or surplus credits are charged hour after hour: section 10 |
| The edge | CloudFront console: 4xx / 5xx rate, origin latency; WAF: blocked requests | a 5xx rate that is not a release in progress; real visitors blocked by the rate rule (many behind one address): raise `WAF_API_RATE_LIMIT` in `params.env`, then `deploy.sh edge --execute` |
| Releases | `deploy/release/rollback.sh status` | a unit runs a release other than `current` |

**The indexer's status endpoint is not public.** `/api/vs/index/status` answers
404 in hosted mode, from loopback too - diagnostics are not on the allow-list. The
health check asks `/api/vs/index/health` instead: a reduced view (numbers and
booleans only) that the API answers to a caller on the instance itself and to
nobody through the proxy (`apps/server/src/hosted.ts`, `ON_INSTANCE_ROUTES`). It
never opens the index file. `remote.sh health` is that check, on demand.

**What alerts by itself** (to `ALERT_EMAIL`, through SNS):

- the health check on the instance, every minute: after two failing passes in a
  row, on recovery, and every six hours while it stays unhealthy;
- three CloudWatch alarms: the EC2 status check, the CPU credit balance under 50,
  surplus credits charged for six hours.

A stopped or dead instance sends nothing - that is what the external monitor on
`/api/health` is for.

## 10. Costs and sizing

On-demand prices of October 2026, us-east-1, per month (730 hours). Check the AWS
pricing pages before relying on them.

| Component | Basis | USD / month |
|---|---|---|
| Instance `t4g.large` (2 vCPU, 8 GiB) | 0.0672 / hour (eu-central-1 about 0.077, ap-northeast-1 about 0.086) | 49 (56 / 63) |
| CPU above the baseline, `unlimited` | 0.04 per vCPU-hour above an average of 0.6 vCPU | 0 to 41 |
| Volumes, gp3 16 + 40 GiB | 0.08 per GiB (about 0.095 in the other two regions) | 4.50 |
| Elastic IP | 0.005 / hour, running or stopped | 3.65 |
| WAF | 5 for the ACL, 1 per rule (3), 0.60 per million requests | 8 + traffic |
| CloudFront | pay-as-you-go: the first 1 TB and 10 million requests a month are free | 0 at test traffic |
| Route 53 | 0.50 per hosted zone, 0.40 per million queries | 0.50 |
| Ops bucket | 14 backups of about 1 GB compressed, release artifacts | about 0.35 |
| Site bucket | about 17 MB per release, old assets kept | under 0.05 |
| Certificate, SSM, Lambda, SNS, alarms | free or inside the free allowances | 0 |
| **Running** | | **about 66, plus CPU surplus** (about 74 in eu-central-1, 81 in ap-northeast-1) |
| **Stopped** | volumes, address, WAF, zone, buckets | **about 17** |

Sizing:

- **Measured on a desktop CPU:** API and indexer together use about 0.9 GB of
  memory and 0.5 to 0.7 of a core, continuously.
- **`t4g.large` earns 0.6 vCPU of sustained load** (30 % per vCPU), and a
  Graviton2 core is slower than a desktop core. Expect the load at or above the
  baseline. `CpuCredits=unlimited` (the default) means it is never throttled and
  the excess is billed: at worst both vCPUs flat out, about 41 USD a month.
  `standard` would throttle the indexer instead - its event loop does not take
  that well.
- **Decide after the first week.** If the average CPU utilisation stays above
  about 48 % (0.96 vCPU), `m7g.large` (0.0816 / hour, about 60 a month, no credits,
  faster cores) is cheaper and faster: set `INSTANCE_TYPE=m7g.large` and
  `CPU_CREDITS=none` in `params.env`, then `deploy/aws/deploy.sh compute --execute`.
  That is a stop and a start - nothing is replaced. A one-year commitment takes
  roughly a third off the instance; decide that after the type has settled.
- **Memory:** 8 GiB is ample. The units are capped for the 4 GiB test instance
  (API 640M high / 900M max, indexer 1400M / 1800M); on 8 GiB put the larger caps
  back with a drop-in (API 1500M / 2G, indexer 3G / 4G - the units name them); the
  rest is page cache for the index.
- **Disk:** the index is 3.3 GB on the development machine today. The data volume
  needs about three times the index (the index, the nightly staging copy, a
  replaced copy during a restore): 40 GiB lasts to about 12 GB. Growth is bounded
  per trader and by retention (`docs/INDEXER.md`, "Storage"). Raise
  `DATA_VOLUME_SIZE_GIB` any time; it grows online
  (`deploy/release/remote.sh run 'xfs_growfs /var/lib/valuescan'`).
- **Visitors do not scale the instance.** CloudFront caches each index response
  for the 10 to 30 seconds the API allows (`apps/server/src/perf.ts`), so the
  API's load is per distinct request, not per visitor; everything per-user goes
  from the browser to the exchanges.
- **One address for everything on the instance.** The exchanges limit per
  address. The API process's own reads are bounded and do not grow with visitors
  (section 14, item 2); the shares are in `deploy/server/env/api.env.example` and
  `indexer.env.example` - change them together.
- **No latency tests are needed for any of this.** Should one ever be wanted:
  measure from this running instance, never with throwaway instances.

## 11. Pre-launch checklist

Before anyone is given the URL.

Decisions and texts (the owner):

- [ ] Impressum, privacy policy, terms and risk notice exist, are reviewed, and
      are linked from every page; a contact address is on them.
- [ ] The privacy policy names what section 12 lists.
- [ ] Countries: `GEO_RESTRICTION_*` set as decided, and the edge stack deployed
      with it.
- [ ] Builder fee: id and rates in `web.env` as decided, or deliberately empty.
- [ ] WalletConnect: the production domain is on the project's allowed list.

Code (section 14):

- [x] The API opens the index read-only (item 1, closed).
- [x] The maintenance banner uses the server's verdict (item 3, closed).
- [x] `apps/web/index.html` has a description; legal pages and `/favicon.ico` exist
      (items 4 and 5, closed).
- [ ] The open items of `docs/security/AUDIT-2026-09-30.md` §9 are closed or
      accepted (S-12 is fixed in code; K-02 and D-02 remain there).
- [ ] The legal pages are filled in: `deploy/release/build-web.sh <tag> --public`
      passes its legal check.
- [ ] The full local smoke test has passed once
      (`deploy/smoke/README.md`, "Run it").

The deployment:

- [ ] `web.env`: `VITE_SODEX_NETWORK=mainnet`; `VITE_ALLOW_MAINNET_TRADING` and
      `VITE_TRADING_DISABLED` empty.
- [ ] `node deploy/smoke/smoke.mjs --site=https://<DOMAIN> --origin=<ORIGIN>`
      passes: headers, gate, every page, the worker, the origin closed.
- [ ] `deploy/release/remote.sh health`: `"ok":true` with no warning but, on the
      first day, `backup`.
- [ ] `curl -sI https://<DOMAIN>/` shows `content-security-policy`,
      `strict-transport-security` and `x-frame-options: DENY`;
      `curl -sI http://<DOMAIN>/` redirects to https.
- [ ] `https://<ORIGIN_DOMAIN_NAME>/` does not answer from your own connection
      (port 443 is open to CloudFront only).
- [ ] The alert mail was confirmed, and one alert was seen arriving: stop the API
      for three minutes (`remote.sh run 'systemctl stop valuescan-api; sleep 200; systemctl start valuescan-api'`).
- [ ] A backup exists (`remote.sh backup`) and a restore was done once
      (`remote.sh restore latest --yes`).
- [ ] An external uptime monitor watches `https://<DOMAIN>/api/health`.
- [ ] The trading switch was tried once in both directions (section 15).
- [ ] The instance's `AMI_ID` is in `params.env`; `deploy/aws/deploy.sh status`
      shows the three stacks complete.
- [ ] CAA records allow `amazon.com` and `letsencrypt.org` (or there are none).

## 12. Public testing checklist

For the owner, with a small real account. Nobody else's wallet, and no agent,
ever signs anything: every step below is clicked by hand, with an amount you can
afford to lose to a mistake. Keep the browser's console open the whole time. The
only red lines to expect are Lighter answering 400 and Arcus 403 for an address
they do not know; any other one is a finding - note the page and the line.

First visit, no wallet:

- [ ] `/trade`: chart, order book and ticker fill within seconds; the status line
      at the bottom says Live.
- [ ] Explore (overview, cohorts, market map, one asset), Leaderboard, Copy: data,
      not "index unavailable".
- [ ] Scan for a known address on each venue; the command palette (Ctrl/Cmd+K):
      a market, a trader.
- [ ] A second tab: both stay live (one SharedWorker holds the sockets). Close
      the first: the second keeps going.
- [ ] A phone, and a second browser (Safari or Firefox).

Wallet:

- [ ] Connect with a browser extension; connect with WalletConnect by QR code
      from a phone wallet. No CSP line may appear in the console while pairing. If
      the wallet warns that it cannot verify the site, the domain is missing from
      the WalletConnect project's allowed list.
- [ ] Reject a signature request once: the app says so and nothing is stuck.
- [ ] Enable trading (the trading key): read what the wallet asks you to sign.
      Then look the key up on SoDEX's own site: it must be able to trade and
      nothing else - no withdrawal, no transfer. Reload the page and note whether
      trading is still enabled, and for how long (a key lasts 7 days at most).
- [ ] If a builder fee is set: the approval names the fee and its ceiling once,
      and the order form shows the fee per order.

Funds (smallest amounts):

- [ ] Deposit to a new account, and to one that exists.
- [ ] Transfer between Spot, Futures and EVM.
- [ ] Withdraw.
- [ ] Each of them appears in Portfolio and in the account history afterwards.

Trading (smallest size):

- [ ] A limit order far from the market: it rests; cancel it.
- [ ] A market order; a take-profit / stop-loss on the position; close it.
- [ ] Order, trade, funding and position history show them. Leave the page open
      for ten minutes: the history fills without errors (it is read slowly on
      purpose).
- [ ] Portfolio agrees with what SoDEX's own site shows for the account.
- [ ] Scan of your own address shows the same account.

The switches:

- [ ] Trading off on the server (section 15): an open page re-reads
      `/api/health` every 30 seconds, then the order form refuses and says why.
      On again.
- [ ] The instance stopped (`deploy.sh stop --execute`): the site loads, Trade,
      Portfolio and Scan work, the index pages say unavailable. Started again:
      they come back by themselves.

What a visitor's browser sends, what the server keeps, and to whom - the privacy
policy (`/privacy`, `apps/web/src/legal/`) has to say it:

- **To Valuescan's edge, then the instance.** In this design: CloudFront and its
  firewall. In the test environment (`EC2-VERCEL.md`): **Vercel** - its CDN, in
  whichever of its regions is nearest the visitor, and the `/api` function in its
  Tokyo region (hnd1; Frankfurt, fra1, until 2026-10-23) - in place of CloudFront; the
  privacy policy's list of processors has to name Vercel (and AWS, ap-northeast-1,
  Tokyo, for the instance; eu-central-1 until 2026-10-23) instead. The instance is
  outside the EU since then: the policy has to name the transfer to Japan and its basis.
  What arrives: the address of the connection and the pages' index requests.
  **Index requests can carry wallet addresses or search text**
  (`/api/vs/leaderboard?q=`, `/api/vs/lbrow?address=`, `/api/feed/account?id=`);
  the hosted API's log strips the query and keeps the client address and the path
  for 14 days. CloudFront keeps no access log in this setup; its firewall shows a
  sample of recent requests, addresses included, for a few hours. On Vercel, the
  function logs nothing but an error line (path and reason); Vercel keeps its own
  request and runtime logs as its plan says (runtime logs: 1 hour on Hobby, 1 day
  on Pro). There is no analytics and no cookie.
- **Builder fee tiers** (section 16). When trading is enabled or restored, every 4
  minutes while it stays on, and after fills, the browser sends the wallet address
  to `/api/vs/builder/terms`. The server then reads that wallet's fills from SoDEX
  and its orders from SoDEX's explorer, and keeps a record per wallet in
  `builder.db`: counted volume, orders, fee history, flags with their evidence, and
  the app's key addresses. **Nothing expires by itself** - only
  `builderTiers.ts forget --address 0x...` removes a wallet. The retention period is
  the owner's to set (a placeholder in `/privacy`).
- **The hosted copy executor** (`apps/executor`, on the instance; EC2-VERCEL.md
  section 13). For each follower who uses it: the wallet address, every instruction the
  wallet signed (an append-only log the executor never changes or deletes) with the
  country Vercel's edge reported for that request (`x-vercel-ip-country`, sent on as
  `X-Viewer-Country`), the copies, their activity (365 days, `EXECUTOR_ACTIVITY_DAYS`),
  and the copy key the follower registered - sealed with a key that never leaves the
  data volume. The request's address is used for the executor's per-client limits in
  memory. The nightly backup carries the database (not the key that unseals it);
  the EBS snapshots carry both.
- **The index holds other people's public trading activity**: wallet addresses,
  fills, positions, PnL, and the venues' display names (stored, never shown). The
  privacy policy needs a section on it, and an objection needs a way to act on it:
  **none exists in the indexer today** (section 14, item 10).
- Directly to SoDEX, Hyperliquid, Lighter and Arcus: the visitor's address of
  connection, and every wallet address looked at; to the ValueChain explorer
  (`main-scan.valuechain.xyz`) likewise.
- To WalletConnect / Reown: it starts on any wallet connection - browser
  extensions included - and when a session is restored: `relay.walletconnect.org`,
  `api.web3modal.org`, `verify.walletconnect.org` (Reown's telemetry is blocked in
  the code). To the public RPC endpoints of ValueChain, Arbitrum, Base, Ethereum,
  BNB Chain and Polygon for balances.
- In the browser's own storage, never sent to Valuescan: settings, saved address
  names, the WalletConnect session, the trading key
  (`apps/web/src/trading/vault.ts`), the trading history of up to six wallets
  looked at (IndexedDB), per-address statistics, the watchlist, recent searches,
  recently viewed traders, the log of the visitor's own transfers, chart and
  dashboard layouts; a deposit or withdrawal in progress in session storage.

## 13. What was proven locally

The smoke test (`deploy/smoke/smoke.mjs`) serves the production build with the
production headers and puts the real server in hosted mode behind `/api`, the way
the edge does.

**The run of 2026-10-02:**

| Check | Result |
|---|---|
| Production build, static audit against the production CSP | pass (about 1,000 files, 16 to 17 MB; one warning, since fixed: no meta description) |
| Hosted gate of the real server (`VALUESCAN_HOSTED=1`, `VALUESCAN_INDEXER=0`): health open, index routes only with the secret, per-user routes 404, custodial routes 410, writes refused, repeated parameters refused | pass, 10 of 10 |
| All 15 pages, browser offline: renders, no CSP violation, only allow-listed API routes, none refused, sockets to the exchanges only | pass, 15 of 15 |
| Browser online against the live exchanges: Trade, Explore, Cohorts, Market map, an asset, Leaderboard, Copy, Portfolio, the palette, Scan of a SoDEX market maker | pass, 10 of 10; live chart, book and account data rendered |
| SharedWorker under the production CSP: starts, served with the policy, opens the SoDEX socket itself | pass |
| The spawned server wrote nothing and reached nothing | confirmed: empty state directory, every outbound connection refused |

Not run then, because the API still opened the index read-write and its own
exchange reads were not bounded (both fixed since: section 14, items 1 and 2):
index data through the hosted server, the server's own exchange reads, and Scan on
Hyperliquid, trade.xyz, Lighter and Arcus with the browser online. The page list
has grown since by the three legal pages (18 pages; `/favicon.ico` is among the
header samples). The run that covers all of it, on a machine that runs no other
Valuescan server (or with the development server stopped):

```
node deploy/smoke/smoke.mjs --snapshot --server-egress=allow
```

**Offline, 2026-10-03** (for the EC2 + Vercel environment, `EC2-VERCEL.md`):

| Check | Result |
|---|---|
| `python deploy/aws/validate_offline.py` | 21 checks, 0 errors |
| `node --test` deploy/smoke, deploy/server/bin (health check, backup copy), deploy/vercel | 32 of 32 |
| The Vercel routes give every sampled path (35, odd cases included) exactly the headers of `prod-headers.mjs`, from one route each; `/api/*` only the function | pass |
| The `/api` function against a stand-in origin: path, query and secret forwarded, the viewer's address from Vercel's header only, no cookie / authorization / user agent, the compressed body byte for byte, the edge cache rule, 405 for writes, 503 without the secret, 502 for a stopped instance, no secret or query in its log | pass |
| `provision.sh up --print` and `status` against the real account (read-only): the plan of 10 writes | as expected; nothing exists yet |
| `backup.sh` and `restore.sh latest` without an ops bucket, on a small index (Git Bash, a stand-in zstd) | pass: copy, checksum, keep 1, restore dry run |
| A deployment directory from the 2026-10-02 build (`publish-vercel.sh ... --origin=... --out=...`, no deploy) | 1,012 files, 16.4 MB, 14 routes |
| The server suite (S-12 included) | 623 of 623 |

## 14. Items found while preparing this, and where they stand

1. **Closed - the API reads the index read-only.** `apps/server/src/indexer/reader.ts`
   opens it with `{ readOnly: true }` and runs no statement that changes it (no
   schema, no migration). The release order (indexer, then API) stays the rule; the
   API unit still has write access to the index directory, because a WAL reader
   maps the `-shm` file read-write.
2. **Closed - the API's exchange reads are bounded.** Positioning is answered from
   the index, the whale feeds from one shared buffer bounded by the clock, and an
   API-only process's Hyperliquid client defaults to 200 weight a minute
   (`apps/server/test/publicBudgets.test.ts`). `api.env.example` no longer overrides
   that (it set 450).
3. **Closed - the maintenance banner shows the server's verdict**
   (`apps/web/src/components/maintenanceVerdict.ts`), not "maintenance" whenever the
   status service is unreachable.
4. **Closed - legal pages:** `/impressum`, `/privacy`, `/terms`
   (`apps/web/src/legal/`, linked from every page). They are drafts with
   `[[OWNER: ...]]` placeholders: `build-web.sh` warns about them, `build-web.sh
   --public` refuses the build.
5. **Closed - `apps/web/index.html`** has a description, its comment no longer
   points at a missing file, and `/favicon.ico` exists.
6. **Closed - diagnostics on the instance:** `/api/vs/index/health`, answered only
   to a caller on the instance (`hosted.ts` `ON_INSTANCE_ROUTES`). The health check
   reads it; its unit no longer has write access to the index directory.
7. **Closed - the origin secret rotates without a gap.** The API accepts
   `VALUESCAN_ORIGIN_SECRET=current,next` (`hosted.ts`); Caddy accepts both in the
   EC2 + Vercel environment; the health check sends the first; the scripts carry a
   rotation through (section 15).
8. **Closed - `docs/deploy/SECURITY-HEADERS.md`** has the SPA fallback as a
   CloudFront Function, HTTP-01 only for Caddy, no access log and no admin endpoint.
9. **Observation - a public RPC answered an error once:**
   `https://polygon-bor-rpc.publicnode.com` (`apps/web/src/trading/onboard.ts`)
   returned HTTP 529 once on the Scan page. The page rendered; a full smoke run
   counts such a line as a console error.
10. **Open - objections to the index.** The index holds other people's public
    trading activity (section 12). The privacy policy needs a section on it and
    there has to be a way to act on an objection (remove a wallet and keep it out);
    the indexer has none today. For the owner and the indexer's maintainer.
11. **Open - `docs/security/AUDIT-2026-09-30.md`** still lists S-12 as open. It is
    fixed in `apps/server/src/localHost.ts` (local mode answers only to `127.0.0.1`,
    `localhost` and `[::1]`, any port - the Vite `/ws` proxy keeps the browser's
    Host - with a 421 otherwise); the audit's owner should mark it.

## 15. Operations

**Turning trading off.** Two switches, and what each can do:

```
# 1. Through the API: /api/health then reports mainnetWritesAllowed:false and every open page refuses to sign.
deploy/release/remote.sh run "echo VALUETRADE_ALLOW_MAINNET=0 >> /etc/valuescan/api.local.env && systemctl restart valuescan-api"
# back on:
deploy/release/remote.sh run "sed -i '/^VALUETRADE_ALLOW_MAINNET=/d' /etc/valuescan/api.local.env && systemctl restart valuescan-api"
```

It only works while the API answers: a page that cannot read `/api/health` trades
as it was built. The switch that does not depend on the instance is a build:

```
# 2. An emergency web build: set VITE_TRADING_DISABLED=1 in deploy/release/web.env, then
deploy/release/build-web.sh <tag> && deploy/release/publish-web.sh <tag>
```

Neither touches anyone's funds or positions: users hold their own keys and can
always use SoDEX directly.

**Rotating the origin secret - without a gap.** The instance can accept two values
at once (`VALUESCAN_ORIGIN_SECRET=current,next`, `apps/server/src/hosted.ts`; Caddy's
gate likewise in the EC2 + Vercel environment), so the edge can switch whenever it
is ready and no request is refused meanwhile:

```
deploy/aws/deploy.sh secret --rotate --execute   # 1. <prefix>/origin-secret-next in SSM, beside the current value
deploy/release/bootstrap-instance.sh             # 2. the instance accepts both (the API restarts: seconds)
deploy/aws/deploy.sh edge --rotate --execute     # 3. CloudFront sends the next value (several minutes)
deploy/aws/deploy.sh secret --finish --execute   # 4. origin-secret := the next value, -next deleted
                                                 #    (refused unless CloudFront already sends it)
deploy/release/bootstrap-instance.sh             # 5. the instance accepts only the new value
```

Out of order is safe as long as step 2 comes before step 3: a plain `deploy.sh edge`
in between sends the current value (accepted), and `bootstrap-instance.sh` keeps
accepting both while `-next` exists. The health check sends the first value of the
list. In the EC2 + Vercel environment the same is `deploy/release/rotate-origin-secret.sh
begin`, the new value into Vercel and a deploy, then `... finish` (`EC2-VERCEL.md`).

**Changing a setting on the instance.** Put it into
`/etc/valuescan/api.local.env` or `indexer.local.env` (the bootstrap rewrites the
other files and never touches these), then restart that unit
(`deploy/release/remote.sh restart api`). A change that should survive a rebuild
belongs in `deploy/server/env/*.example`, followed by `bootstrap-instance.sh`.

**Updates.** The operating system is not updated automatically: once a month
`deploy/release/remote.sh run 'dnf upgrade --releasever=latest -y'`, then
`deploy.sh stop --execute` and `start --execute`. Node and Caddy are pinned with
their checksums in `deploy/server/versions.env`: change both, run
`bootstrap-instance.sh`, restart the units when it suits.

**A shell on the instance.** There is no SSH. `deploy/release/remote.sh run '<command>'`
for one command (its text is recorded by AWS: no secrets in it), or Session
Manager: `aws ssm start-session --region <REGION> --target <instance id>`. (The EC2
test instance has SSH instead: `deploy/release/remote.sh shell`.)

**DNS elsewhere than Route 53.** Leave `HOSTED_ZONE_ID` empty and create by hand:
an `A` record for `ORIGIN_DOMAIN_NAME` to the stack output `OriginIp` (after step
4, before step 5); the certificate's validation `CNAME` (shown in the ACM console
while the edge stack waits for it); and for the site a `CNAME` to the stack output
`DistributionDomainName` - which a bare domain (`example.com`) cannot have at most
providers, so use a name like `app.example.com` there.

**If the instance cannot be launched.** `deploy.sh compute --execute` is the one
`RunInstances` of this environment. If the account is not allowed to launch
(AWS blocked launches on the owner's account on 2026-09-06 after a burst of test
instances), the stack fails at `Instance` and rolls back; the network stack is
not affected. Resolve it with AWS Support. Do not retry in a loop, do not probe
with throwaway instances, and do not take `--dry-run` as proof - it does not test
that gate. A stack that failed on creation stays in `ROLLBACK_COMPLETE` and holds
nothing: delete it
(`aws cloudformation delete-stack --region <REGION> --stack-name valuescan-compute`),
then run the command once more.

**Troubleshooting.**

| Symptom | Look at |
|---|---|
| Index pages say unavailable, the rest works | `remote.sh health`; `remote.sh logs api`; is the instance running (`deploy.sh status`)? |
| Every `/api` route but health answers 403 | the secret differs between the edge and the instance: `deploy.sh edge --execute`, then `bootstrap-instance.sh` (EC2 + Vercel: every route, health included, answers 403 at Caddy - compare the Vercel variable with `~/.valuescan/valuescan-test/origin-secret`, redeploy) |
| CloudFront answers 502 or 504 for `/api` | Caddy has no certificate yet or is down: `remote.sh logs caddy`. It needs `ORIGIN_DOMAIN_NAME` to resolve to the instance and port 80 reachable; a CAA record that excludes `letsencrypt.org` stops it. |
| A page is blank after a release | a file of the build is missing or has the wrong type: `node deploy/smoke/smoke.mjs --site=https://<DOMAIN>`. A missing file answers 403, not 404 (the bucket is private). Roll the web back. |
| The console shows a CSP violation | the page asks for a host the policy does not list: section 5, "A release that changes the CSP" |
| The API unit restarts in a loop after a system update | `remote.sh logs api`; a `SIGSYS` or an odd `EPERM` is the system-call filter (`deploy/server/README.md`, "The units") |
| The health check says `lockdown` | the API is not in hosted mode. Stop it; check `/etc/valuescan/api.env`. |
| Git Bash turns `/valuescan/prod/...` into `C:/Program Files/Git/...` | the scripts switch that conversion off; in your own commands set `MSYS_NO_PATHCONV=1` |

**Taking it down** at the end: `deploy/aws/README.md`, "Taking it down".

## 16. Builder fee tiers

Per-wallet builder fees (`docs/BUILDER-TIERS.md`): the API signs the fee each wallet owes and lowers it
as the wallet's verified volume passes the tiers. Off until its configuration exists; the web build then
charges its own `VITE_BUILDER_FEE_*` to everyone. Nothing here is needed for a deployment without a
builder.

**On the instance**, as the service user, in the release that runs (the files go into
`/var/lib/valuescan/state`, next to `device.key`):

```
deploy/release/remote.sh run "cd /opt/valuescan/current/apps/server && sudo -u valuescan env VALUETRADE_DEVICE_KEY=/var/lib/valuescan/state/device.key /opt/node/current/bin/node --import tsx tools/builderTiers.ts init --builder-id <id> --test-tiers"
```

- `builder-tiers.json` - the tiers. `--test-tiers` writes 2 bp on both engines and 1.5 bp on perps from
  10 USD of counted volume; for production write the default fee with `--fee-perps <n> --fee-spot <n>`
  and edit the file (it is re-read within seconds, no restart; an invalid file is ignored and logged).
  The first tier must equal the build's `VITE_BUILDER_FEE_PERPS` / `VITE_BUILDER_FEE_SPOT`. The live
  schedule (BUILDER-TIERS.md section 4): `init --builder-id 221909 --fee-perps 15 --fee-spot 15 --max-fee 25
  --volume-days 14`, then `fees.sh set-tier` for $1M / $5M / $25M / $100M (12, 10, 8, 5).
- `builder-terms.key` - the Ed25519 signing key, created once, readable by `valuescan` only. Never copy
  it off the instance; it is in no release (the release refuses `*.key`) and no backup (the backup takes
  the index and the copy executor's database only). Losing it means a new key and a new web build.
- `builder.db` - created by the API on first use: the counted volume. Not backed up; lost, every wallet
  starts again from the default fee (never from a lower one).
- On the EC2 test instance the same commands work (`remote.sh run` goes over SSH there), and the files
  live in the same place - `/var/lib/valuescan/state` on the data volume. So **the EBS snapshots of that
  volume (`provision.sh snapshot`) contain `builder-terms.key` and `builder.db`**: encrypted, private to
  the account, but copies of the key all the same. Delete snapshots that are no longer needed, and treat
  a snapshot shared outside the account as a leaked key (a new key and a new web build).

The command prints `publicKey` and `keyId` - never the private key. Put the public key into
`deploy/release/web.env` as `VITE_BUILDER_TERMS_KEYS=<publicKey>` (comma separated while a key is
replaced), next to the builder values, and build and publish the web. Then:

```
deploy/release/remote.sh run "cd /opt/valuescan/current/apps/server && sudo -u valuescan env VALUETRADE_DEVICE_KEY=/var/lib/valuescan/state/device.key /opt/node/current/bin/node --import tsx tools/builderTiers.ts status"
```

shows whether the file is valid and which key is in force; `status --address 0x...` shows what is
counted for one wallet and which orders raised a flag; `forget --address 0x...` removes one wallet from
the ledger (the live test's wallet between two runs). Settings: `api.env.example`, "builder fee tiers".

Changing the fees on the go (no restart, no release; read again within 5 s, in every app within 10 min):

```
deploy/release/fees.sh status
deploy/release/fees.sh set-tier --from-usd 100000 --perps 15 --spot 18     # a milestone, or new fees for one
deploy/release/fees.sh remove-tier --from-usd 100000
deploy/release/fees.sh set-fee --address 0x... --perps 5 --spot 10 --note partner_x
deploy/release/fees.sh clear-fee --address 0x...
```

A change that would make the file invalid is refused and nothing is written. Milestones apply by
themselves: each verification puts a wallet on the tier its counted volume has reached. The default fee
(`--from-usd 0`) is also pinned in the web build: raising it needs a new web build.
The verifier reads SoDEX's history from the instance's address at 1 request a minute, so keep the
indexer's `/trades` drip off (`VALUESCAN_INDEX_SODEX_TRADES` unset in `indexer.env`).
