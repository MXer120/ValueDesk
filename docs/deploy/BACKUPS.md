# Backups: what is copied where, how to get it back, and the drill

Status: 2026-10-27. Production is two Contabo servers (`deploy/contabo/README.md`).
Until now every backup sat on the disk it protects; a dead disk or a cancelled VPS
would have taken them along. Now each server sends its state **encrypted** to the
other one, the owner's laptop pulls the small sets, and the keys are kept offline.

```
server 1 (France)                                  server 2 (Tokyo)
  index (nightly, local: backup.sh)                  executor.db (nightly, local: backup.sh --executor)
  api-state  ----- encrypted, ssh ------------->     /var/lib/vsbackup/api-state     30 days
  folders    ------------------------------------>   /var/lib/vsbackup/folders        7 days (strict)
  journal    ------------------------------------>   /var/lib/vsbackup/journal      400 days
  index      ------------ weekly ---------------->   /var/lib/vsbackup/index         14 days
  hl-archive ------------ weekly, if changed ---->   /var/lib/vsbackup/hl-archive    60 days
  /var/lib/vsbackup/executor  30 days  <---------    executor
  /var/lib/vsbackup/journal  400 days  <---------    journal
                   \                                   /
                    `--- deploy/release/pull-backups.sh (laptop, 16 Mbit/s): api-state, executor ---
```

## The sets

| Set | From | What | When |
|---|---|---|---|
| `api-state` | server 1 | `builder.db` (the fee ledger, a consistent VACUUM INTO copy), `builder-terms.key` (the terms signing key - the site pins its public half, `VITE_BUILDER_TERMS_KEYS`), `builder-tiers.json`, the visitors' `feedback.jsonl` and `client-errors.db`, `etf-flows.json`, `release-results.json`, `device.key` if present; `/etc/valuescan` (configuration and its secrets, without `offsite/` and `*.bak*`); `/etc/caddy/Caddyfile` | within 15 min of a change; at least every 20 h |
| `folders` | server 1 | the knowledge folders: `folders.db`, their `session.key`, `files/` | within 15 min of a change; at least every 20 h |
| `executor` | server 2 | `executor.db` (copies, activity, the audit log, accepted terms, signed instructions, the followers' **sealed** keys); `/etc/valuescan` | within 15 min of a change; at least every 20 h |
| `journal` | both | the main journal since the last copy (`journalctl -o export`), ~10 MB a day from server 1, ~2 MB from server 2 | daily, 04-05 UTC |
| `index` | server 1 | the newest nightly index backup (`valuescan-index-*.db.zst`, ~4.6 GB; the live index is 21 GB) | weekly, 04-05 UTC |
| `hl-archive` | server 1 | `/var/lib/valuescan/archive/*.tsv.gz` (~0.6 GB, the Hyperliquid fills replay) | weekly, when it changed |

**Never copied:** the executor's `kek`, `session.key` and `import.key`. Every follower's
trading key in executor.db is sealed with the kek; a database copy is harmless only
while the kek is elsewhere. backup-offsite.sh reads nothing of the executor's directory
but executor.db, and refuses - before encrypting anything - a set that contains a file
named `kek` or `import.key`, or anything else from that directory (tested:
`deploy/server/bin/offsite.test.mjs`). The kek's only copy off the server is the
owner's offline block (`executor-secrets.sh export`).

**Not copied:** the API's and the executor's request logs (journal namespace `pii`,
14 days by the privacy policy), the HL archive's work files, the releases (they come
from git), Caddy's certificates (re-issued), `/root`.

**Is the index worth copying?** It can be rebuilt: a new server starts cold
(`docs/INDEXER.md`), or from a seed. But a cold start loses its 31 days of history (the
boards' windows fill again over a month) and the archive replay took 12-20 hours plus
paid S3 reads that are no longer set up. 4.6 GB a week to server 2 (97 GB free) at 10 MB/s
is about 8 minutes - cheap insurance, so it is copied weekly and kept 14 days, as the
privacy policy says for index backups. It is never pulled to the laptop.

## How it works

- `deploy/server/bin/backup-offsite.sh` (timer every 15 min, `valuescan-offsite.service`,
  root with a narrow capability set): puts a set together - SQLite files with VACUUM
  INTO **as the file's owner** (setpriv), so no root-owned `-shm` ever appears in a
  service's directory -, packs it with a deterministic tar, and sends it only when it
  differs from the last copy (or that one is 20 h old).
- `deploy/server/bin/backup-crypt.mjs`: AES-256-GCM with this server's own key
  (`/etc/valuescan/offsite/backup.key`, 32 random bytes), zstd inside, authenticated -
  a wrong key or one changed bit fails the whole file. Node only: opens on the laptop too.
- Transport: ssh as `vsbackup@<other server>` with a key that may run nothing but
  `backup-receive.sh` (`restrict,from="<IP>",command=...`): no shell, no forwarding.
  It checks the size and SHA-256 of what arrived, never replaces a copy, keeps each
  set its number of days (the newest always - except `folders`), and refuses when the
  disk gets full (`RECEIVE_MIN_FREE_GB`, `RECEIVE_MAX_TOTAL_GB`). A sender that floods
  cannot push good copies out: nothing younger than the retention is removed.
- **The receiver cannot read what it holds.** It never has the sender's key. A stolen
  server 2 gives away server 2's own secrets, not server 1's ledger or signing key.
- Markers: `/var/lib/valuescan/state/offsite-<set>.json`. The health check fails when
  the api-state (server 1) or executor (server 2) copy is older than 36 h, and a failed
  copy is sent to Telegram (at most every 6 h per set).
- Settings: `deploy/contabo/server*/offsite.env` and `backup-receive.env`.

```
sudo /opt/valuescan/bin/backup-offsite.sh status           # the last copy of each set
sudo /opt/valuescan/bin/backup-offsite.sh push api-state   # one set now
sudo -u vsbackup /opt/valuescan/bin/backup-receive.sh list # what this server holds for the other
journalctl -u valuescan-offsite -n 50
deploy/release/remote.sh offsite                           # both views, from the laptop
```

## The keys - the owner keeps them offline

| Key | Opens | Where |
|---|---|---|
| server 1's `backup.key` | api-state, folders, index, hl-archive, server 1's journal | server 1 `/etc/valuescan/offsite/`, laptop `~/ValueDesk-backups/keys/server1.backup.key`, password manager |
| server 2's `backup.key` | executor, server 2's journal | server 2, laptop `server2.backup.key`, password manager |
| server 2's kek block | the followers' keys inside executor.db | **offline only** (`executor-secrets.sh export`); passphrase kept apart |

Losing a server loses its copy of its key - which is why the laptop and the password
manager hold one. `deploy/release/pull-backups.sh --fetch-keys` copies both once
(never printed; 0600 and the Windows ACL narrowed). Keep them out of OneDrive.

## The laptop

```
deploy/release/pull-backups.sh                    # newest api-state and executor copies
deploy/release/pull-backups.sh --sets=api-state,executor,folders,journal --all-new --verify
```

Rate-limited (`scp -l 16000`) for the laptop's 20 Mbit/s cap. The big sets need
`--sets=index --big-ok` and the owner's yes. Weekly is plenty.

## Restore

Find the newest copy (on the server that HOLDS it), and open it - decrypt, verify,
unpack, check every SQLite file - into a new directory. Nothing running is touched:

```
f=$(sudo /opt/valuescan/bin/backup-restore.sh latest api-state)      # on server 2
sudo /opt/valuescan/bin/backup-restore.sh open "$f" /path/to/server1.backup.key /root/restore-api
```

The key travels on stdin or as a file you remove afterwards; never leave a sender's key
on the receiver. To restore ON server 1, copy the `.enc` there first (it is encrypted;
through the laptop is fine for the small sets: `ssh S2 'sudo cat <f>' | ssh S1 'cat > /tmp/x.enc'`).

Put it in place on the target server (plan first, then `--yes`; current files are moved
to `*.replaced-<time>`, never deleted; the unit is stopped and started around it):

```
sudo /opt/valuescan/bin/backup-restore.sh apply /root/restore-api                 # the plan
sudo /opt/valuescan/bin/backup-restore.sh apply /root/restore-api --yes           # api-state: stops/starts the API
sudo /opt/valuescan/bin/backup-restore.sh apply /root/restore-api --with-etc --yes  # a rebuilt server: /etc/valuescan too
```

- **executor**: on server 2 (or its replacement) put the kek back FIRST -
  `sudo bash /opt/valuescan/bin/executor-secrets.sh import < block` - then
  `apply <dir> --yes` (it refuses without a kek: the executor would make a new one and
  the restored keys would never open). Copies catch up on start without doubling orders.
- **folders**: `apply` as for api-state (the API holds them).
- **index**: open it, then `restore.sh` with the `.db.zst` inside (its `.sha256` next to
  it is checked): `sudo /opt/valuescan/bin/restore.sh /root/restore-index/tree/valuescan-index-<time>.db.zst`
  (the plan), then the same with `--yes`. It needs the size of the database free twice
  over (~45 GB).
- **hl-archive**: open it, copy `tree/*.tsv.gz` into `/var/lib/valuescan/archive/`
  (`chown valuescan:valuescan`), restart the indexer at a quiet moment.
- **journal**: open it; read the export with `systemd-journal-remote`
  (`dnf install systemd-journal-remote`): `/usr/lib/systemd/systemd-journal-remote -o /root/old.journal journal.export`,
  then `journalctl --file /root/old.journal`.

After a restore: `deploy/release/remote.sh health`, and delete the `*.replaced-*` files
once everything is confirmed.

## The restore drill (monthly; 5 minutes; touches nothing in production)

On the server that HOLDS the copies, open the newest one with the key from the laptop,
check it, throw the scratch copy away:

```
ssh S2 'sudo /opt/valuescan/bin/backup-restore.sh drill api-state --key-stdin' < ~/ValueDesk-backups/keys/server1.backup.key
ssh S2 'sudo /opt/valuescan/bin/backup-restore.sh drill folders   --key-stdin' < ~/ValueDesk-backups/keys/server1.backup.key
ssh S1 'sudo /opt/valuescan/bin/backup-restore.sh drill executor  --key-stdin' < ~/ValueDesk-backups/keys/server2.backup.key
```

It decrypts into `/var/tmp/vs-drill.*` (0700), checks the SHA-256, the authentication
tag and every database's integrity, lists the files, prints `DRILL PASSED`, and deletes
the scratch directory and the key it was given. It never stops a unit or writes
outside the scratch directory. On the laptop, `pull-backups.sh --verify` does the same
for what it pulled.

A full drill, once after any change to the backups: open the newest api-state copy on
server 2 and compare it with production by numbers, not by eye -
`node backup-index.mjs --check` prints each database's page count; the ledger's row
counts must be at least those of the copy's time. Then delete the opened directory.

## The old local backups

They go on as before (`deploy/server/README.md`, "Backups"): the index nightly to
`/var/lib/valuescan/backup/archive` (newest 1), executor.db nightly to
`/var/lib/valuescan/backup/executor/archive` (newest 7). They are the fast way back from
a broken file; the off-server copies are the way back from a broken server.
