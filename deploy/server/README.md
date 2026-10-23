# The instance

Everything that runs on the one instance, and the script that puts it there.
The runbook is `docs/deploy/DEPLOY.md`; this is the reference.

```
deploy/server/
  bootstrap.sh             set the instance up; idempotent, run through SSM
  versions.env             pinned Node and Caddy versions with their checksums
  units/                   systemd units and timers
  env/                     templates of /etc/valuescan/*.env (every variable, commented)
  caddy/Caddyfile.template TLS in front of the API and the copy executor (/api/copy/*)
  journald/valuescan.conf  log retention
  bin/                     installed to /opt/valuescan/bin
    release.sh             install a release, switch to it, restart in order, roll back
    backup.sh              one index backup to S3 or the data volume (run nightly by a timer);
                           --executor: the copy executor's database
    backup-index.mjs       the consistent copy itself (VACUUM INTO, read-only)
    restore.sh             put a backup (or a seed) in place
    healthcheck.mjs        one health pass (run every minute by a timer)
```

Target: Amazon Linux 2023, arm64 (x86_64 works too). Run it with
`deploy/release/bootstrap-instance.sh` from your workstation - through SSM on the
CloudFormation instance, over SSH on the EC2 test instance, which has no instance
role (`docs/deploy/EC2-VERCEL.md`). On that instance:

- SSH stays on (`KEEP_SSHD=1`, remembered in `/etc/valuescan/bootstrap.env`); keys
  only, port 22 from the deploying machine's address only;
- the origin secret comes from a root-only file the workstation wrote through SSH's
  stdin (`ORIGIN_SECRET_FILE`, `/root/.valuescan/origin-secret`), not from SSM;
- there is no ops bucket (`OPS_BUCKET` empty): a release arrives over SSH
  (`release.sh <tag> --from=<file>`), backups stay on the data volume, and EBS
  snapshots of that volume carry them off the box;
- the health check alerts nobody (no SNS without a role): it logs.

## What ends up where

| Path | What | Owner, mode |
|---|---|---|
| `/opt/node/v<version>`, `/opt/node/current` | Node, pinned and checksum-verified | root |
| `/usr/local/bin/caddy` | Caddy, pinned and checksum-verified | root |
| `/opt/valuescan/releases/<tag>/` | one installed release each (the last 3 are kept) | root:valuescan, not writable by the service |
| `/opt/valuescan/current` | link to the active release | |
| `/opt/valuescan/bin/` | the operations scripts | root |
| `/etc/valuescan/api.env`, `indexer.env`, `ops.env` | rendered from `env/*.example` on every bootstrap | root:valuescan 0640 |
| `/etc/valuescan/executor.env` | rendered from `env/executor.env.example` | root:valuescan-executor 0640 |
| `/etc/valuescan/api.secret.env` | `VALUESCAN_ORIGIN_SECRET` (`current`, or `current,next` while it is rotated), from SSM Parameter Store or `ORIGIN_SECRET_FILE` | root:valuescan 0640 |
| `/etc/valuescan/caddy.secret.env` | the same one or two values for Caddy's gate (`VALUESCAN_ORIGIN_SECRET_1`, `_2`) | root 0600 |
| `/etc/valuescan/executor.secret.env` | the same values for the copy executor's own check (`EXECUTOR_ORIGIN_SECRET`, `_2`) | root 0600 |
| `/etc/valuescan/*.local.env` | your own overrides; never touched | you create them |
| `/etc/caddy/Caddyfile` | rendered from the template | root 0644 |
| `/var/lib/valuescan/` | the data volume (xfs, encrypted EBS) | |
| `/var/lib/valuescan/index/valuescan-index.db` (+ `-wal`, `-shm`) | the index | valuescan 0640 |
| `/var/lib/valuescan/state/` | small state: health state, last backup marker | valuescan |
| `/var/lib/valuescan/executor/` | the copy executor's data: `executor.db` (+ `-wal`, `-shm`), `kek` (the key that seals every follower's trading key), `session.key` | valuescan-executor 0700 |
| `/var/lib/valuescan/backup/` | staging for the nightly copy; `archive/` holds the backups when there is no ops bucket; `seed/` a seed copied over SSH | valuescan (seed: root) |
| `/var/lib/valuescan/backup/executor/` | the executor database's nightly copy: staging, `archive/` (the newest 7), `last-backup.json` | valuescan-executor 0700 |
| `/var/lib/caddy/` | certificates and the ACME account | caddy |

## The units

| Unit | Runs | Restart | Notes |
|---|---|---|---|
| `valuescan-indexer.service` | `node --import tsx src/indexer/main.ts` as `valuescan` | always, after 30 s | the ONE writer of the index; holds the trade streams |
| `valuescan-api.service` | `node --import tsx src/index.ts` as `valuescan`, hosted mode, `VALUESCAN_INDEXER=0`, `127.0.0.1:8797` | always, after 3 s | restarting it is cheap |
| `valuescan-executor.service` | `node --import tsx src/main.ts` in `apps/executor` as `valuescan-executor`, `EXECUTOR_KIND=hosted`, `127.0.0.1:8799` | always, after 5 s | the hosted copy executor; its own user, so nothing that runs as `valuescan` can read its keys; independent of the API (no dependency on it) |
| `caddy.service` | Caddy as `caddy`, ports 80 and 443 | on failure | TLS for the origin name; passes on only requests that carry the origin secret; `/api/copy/*` to the executor, the rest to the API |
| `valuescan-backup.timer` -> `.service` | `backup.sh`, 03:17 UTC, I/O-throttled | - | catches up after a stop; wants the next one |
| `valuescan-executor-backup.service` | `backup.sh --executor` as `valuescan-executor`, after the index backup | - | the executor's database only, never `kek` or `session.key` |
| `valuescan-health.timer` -> `.service` | `healthcheck.mjs`, every minute | - | alerts on a change of state |

`node --import tsx` runs the TypeScript sources directly in one process (the server
has no build step; `tsx` is a devDependency of the server workspace, which is why a
release installs with `npm ci --workspace apps/server` and not with `--omit=dev`).

Hardening, the same on the three Valuescan services: `NoNewPrivileges`,
`ProtectSystem=strict` with `ReadWritePaths` limited to the index and state
directories (the executor: its own directory and the state directory), `ProtectHome`, `PrivateTmp`, `PrivateDevices`, the `Protect*` kernel
switches, `RestrictAddressFamilies`, `RestrictNamespaces`, an empty capability set,
`SystemCallFilter=@system-service` without `@privileged`, `MemoryHigh`/`MemoryMax`
(sized for a 4 GiB instance: API 1300M/1500M, indexer 1400M/1800M, executor
400M/600M; on 8 GiB use drop-ins with more for the API and the indexer, as their
units say). Not set, on purpose: `MemoryDenyWriteExecute`
(V8's JIT needs it off).
`systemd-analyze security valuescan-api` rates both at about 1.4 ("OK").

If a unit fails after a systemd or kernel update with a `SIGSYS` or an odd `EPERM`,
the system call filter is the first suspect: override it with a drop-in
(`systemctl edit valuescan-api`, `SystemCallFilter=` empty) and report it.

**The API reads the index read-only** (`apps/server/src/indexer/reader.ts`,
`{ readOnly: true }`: no schema, no migration). Its unit may still write to the index
directory because a WAL reader maps the `-shm` file read-write. The API also reads
the venues itself for Explore, the whale tape, the screener and podium curves, from
the same address as the indexer - bounded, never per visitor
(`apps/server/test/publicBudgets.test.ts`); an API-only process's Hyperliquid share
defaults to 200 weight a minute.

**Caddy's gate.** Caddy passes a request to the API or the copy executor only when it carries
`X-Origin-Verify` with the current (or, during a rotation, the next) origin secret;
anything else gets a 403 from Caddy (`caddy/Caddyfile.template`, `@edge`). Behind
CloudFront the security group already admits nobody else; behind the Vercel function
port 443 is open to everyone, and the gate is what keeps the API - and the
`X-Forwarded-For` it keys its limits on - reachable only through the edge.

## Environment

`env/api.env.example`, `env/indexer.env.example`, `env/executor.env.example` and
`env/ops.env.example` list every variable with what it does. The hosted-mode ones in short:

| Variable | Production value | |
|---|---|---|
| `VALUESCAN_HOSTED` | `1` | the public read-only API: 18 GET routes, the rest 404 |
| `VALUESCAN_INDEXER` | `0` | this process never starts an indexer |
| `HOST` / `PORT` | `127.0.0.1` / `8797` | loopback; Caddy is in front |
| `VALUESCAN_ALLOWED_ORIGINS` | `https://<site>` | CORS; unused while site and API share an origin |
| `VALUESCAN_TRUST_PROXY` | `2` | Caddy, then CloudFront; the next address is the viewer |
| `VALUESCAN_ORIGIN_SECRET` | from SSM, or the root-only file (EC2) | required on every request but `/api/health`; `current,next` while it is rotated |
| `VALUESCAN_RATE_READ_PER_MIN` | 600 | per client |
| `VALUESCAN_RATE_UPSTREAM_PER_MIN` | 120 | per client, routes that can cost upstream calls |
| `VALUESCAN_RATE_AUTH_PER_MIN` / `_GLOBAL_PER_MIN` | 20 / 300 | no such route is listed today |
| `VALUESCAN_INDEX_DB` | `/var/lib/valuescan/index/valuescan-index.db` | same in `indexer.env` |
| `VALUETRADE_ALLOW_MAINNET` | `1` | `0` + restart = trading off for every visitor (emergency brake) |

No secret is in a template, in this repository or in a release. The origin secret
is created once in SSM Parameter Store (`deploy/aws/deploy.sh secret --execute`) -
or, for the EC2 test instance, on the workstation by the first
`bootstrap-instance.sh` - and the bootstrap copies it into
`/etc/valuescan/api.secret.env`, `caddy.secret.env` and `executor.secret.env`; the edge gets the same value
(CloudFormation hands it to CloudFront; the Vercel function has it as a production
environment variable).

## Logs

Everything logs to the journal; there are no log files, so there is nothing for
logrotate to rotate.

```
journalctl -u valuescan-api -f
journalctl -u valuescan-indexer -f               # one status line a minute
journalctl -t valuescan-health -n 20 -o cat      # one JSON line per pass (-t: the check's own lines, without systemd's)
journalctl -u valuescan-backup -n 50
journalctl -u valuescan-executor -f
journalctl -t valuescan-executor-backup -n 20
journalctl -u caddy -f                           # certificate issuance and renewal
```

From the workstation, without a shell on the instance:
`deploy/release/remote.sh logs indexer 100` (and `api`, `executor`, `caddy`, `health`, `backup`, `executor-backup`).

- Retention: `journald/valuescan.conf` keeps 14 days and at most 1 GB. The API's
  request lines carry the client address (needed for abuse handling, personal data
  under GDPR) and the path, never the query string.
- Caddy writes **no access log**, deliberately: it would record request headers,
  and every request carries the origin secret.
- If a file log is ever added, give it a logrotate rule with `rotate 14`, `daily`,
  `compress`, `missingok`, `notifempty`, and `copytruncate` unless the writer
  reopens its file on `SIGHUP`.

## Backups

- **What:** the index database, and the copy executor's `executor.db`
  (`valuescan-executor-backup.service`, right after the index, as the executor's own
  user: `backup.sh --executor`, the same `VACUUM INTO` copy, to
  `backups/valuescan-executor-<UTC time>.db.zst` or
  `/var/lib/valuescan/backup/executor/archive`, the newest `EXECUTOR_BACKUP_KEEP` (7)).
  **Never `kek` or `session.key`**: the followers' keys in the database are sealed with
  the kek, so a backup holds nothing a trade could be signed with; those two files
  exist only on the data volume and in its EBS snapshots. The builder ledger and
  signing key in `/var/lib/valuescan/state` are not backed up either (DEPLOY.md
  section 16). Nothing else on the instance is state (code comes from a release,
  configuration from this directory and SSM, certificates are re-issued).
- **How:** `backup-index.mjs` opens the database read-only and runs `VACUUM INTO`,
  one read transaction - a consistent copy while the indexer keeps writing. The
  copy is integrity-checked, compressed with zstd and streamed to
  `s3://<ops bucket>/backups/valuescan-index-<UTC time>.db.zst`, with a `.sha256`
  of the uncompressed file next to it. (`sqlite3 .backup` is not used: the backup
  API restarts whenever another connection writes, and the indexer writes every
  few seconds.)
- **Without an ops bucket** (the EC2 test instance): the compressed copy and its
  `.sha256` go to `BACKUP_DIR` (`/var/lib/valuescan/backup/archive`), the newest
  `BACKUP_KEEP` (1) are kept. Off the box they go as EBS snapshots of the data volume
  (`deploy/aws/ec2/provision.sh snapshot`), which hold the live index as well
  (crash-consistent: SQLite in WAL mode recovers from that like from a power cut).
- **When:** nightly at 03:17 UTC plus up to ten minutes (`valuescan-backup.timer`;
  a run missed while the instance was stopped is caught up); by hand with
  `sudo systemctl start valuescan-backup.service`, or `deploy/release/remote.sh backup`
  from the workstation.
- **Retention:** the bucket's lifecycle rule (`BackupRetentionDays`, 14). The
  instance role can write backups and cannot delete them.
- **Cost on the box:** the copy needs the size of the database free on the data
  volume and reads the whole file once; the unit caps its I/O at 40 MB/s so the
  indexer's event loop is not starved, and the WAL grows a little meanwhile.

### Restore

```
sudo /opt/valuescan/bin/restore.sh latest            # dry run: downloads, verifies, prints the plan
sudo /opt/valuescan/bin/restore.sh latest --yes      # stops both services, swaps the file, starts them
sudo /opt/valuescan/bin/restore.sh backups/valuescan-index-20261002T031912Z.db.zst --yes
```

The script verifies the checksum and the integrity of the download **before** it
stops anything, moves the current database aside (`...replaced-<time>`, with its
WAL) instead of deleting it, and starts the indexer before the API. Delete the
replaced file once the restore is confirmed; it is as large as the database.

After a restore the index is at the moment of the backup. The indexer re-reads the
gap for the traders on the boards; the all-account activity counts have a hole for
the time in between (`status.gaps`).

Rebuilding from nothing instead: a new instance with an empty data volume starts
cold (`docs/INDEXER.md`, "Cold start"). Seed it instead:
`deploy/release/seed-index.sh` on a machine that has an index, then
`restore.sh seed/<name>.db.zst --yes` on the instance.

From the workstation the same commands are `deploy/release/remote.sh restore latest`
(the dry run) and `deploy/release/remote.sh restore latest --yes`.

`restore.sh` restores the index only, and refuses an executor backup. The copy
executor's database is put back by hand (`docs/deploy/EC2-VERCEL.md`, "The copy
executor"); the followers' keys in it open only with the `kek` of the data volume it
came from.

## Health

`healthcheck.mjs` runs every minute. By hand, for the same answer:

```
sudo systemctl start valuescan-health.service
journalctl -t valuescan-health -n 1 --no-pager -o cat      # one JSON line: ok, failed, warned, checks
```

`deploy/release/remote.sh health` does exactly that from the workstation.

| Check | Fails when |
|---|---|
| `api` | `/api/health` does not answer `{ok:true}` |
| `lockdown` | a route that only a local server answers is served: hosted mode is not in effect |
| `index` | a board read through the gate fails, or the board is older than 15 minutes |
| `indexer` | `/api/vs/index/health` (the indexer's own status, published every 30 s) is older than 3 minutes, or no board was built for 15 minutes (a stream that is down is a warning; the API not answering makes this a warning too - `api` fails then) |
| `disk` | the data or root volume is over 80 %, or there is no room for the next backup copy |
| `backup` | the last successful backup is older than 36 hours |
| `executor` | the copy executor (`EXECUTOR_URL`, 127.0.0.1:8799) does not answer `/api/copy/v1/health` with `ok` (its SoDEX feed down is a warning; skipped when `EXECUTOR_URL` is empty) |
| `tls` | Caddy's certificate expires in under 14 days, or it serves its internal one |
| `units` | a service is not active |

`/api/vs/index/status` is not served in hosted mode (diagnostics are not public). The
check asks `/api/vs/index/health`, which the API answers only to a caller on the
instance itself (numbers and booleans, no secret needed); it never opens the index
file, so its unit has no write access to the index directory. During a rotation it
sends the first value of `VALUESCAN_ORIGIN_SECRET`.

With `ALERT_TOPIC_ARN` set it publishes to the SNS topic after two failing passes in
a row, on recovery, and every six hours while it stays unhealthy.

## Updating what is pinned

Change `versions.env` (version **and** checksums, from the official checksum files
named there), re-run `deploy/release/bootstrap-instance.sh`, then restart when it
suits: `sudo systemctl restart valuescan-api`, and `valuescan-indexer` at a quiet
moment (it costs the Lighter stream 3.5-8 minutes). The operating system is not
updated automatically: once a month, `sudo dnf upgrade --releasever=latest -y` and a
reboot through `deploy/aws/deploy.sh stop --execute` / `start --execute`, or
`sudo systemctl reboot`.

## Tests

```
node --disable-warning=ExperimentalWarning --test "deploy/server/bin/*.test.mjs"
```

`backup-index.test.mjs` copies a database that another process is writing to and
proves the copy consistent; `healthcheck.test.mjs` runs the check against a stand-in
API. The shell scripts were exercised on Linux with every external command stubbed
(release, rollback, refusals, backup, restore, bootstrap in a private namespace,
the data-volume decisions); those harnesses are not part of the repository.
