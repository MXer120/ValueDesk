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
| `api-state` | server 1 | `builder.db` (the fee ledger, a consistent VACUUM INTO copy), `builder-terms.key` (the terms signing key - the site pins its public half, `VITE_BUILDER_TERMS_KEYS`), `builder-tiers.json`, the visitors' feedback chats (`feedback.db`, a consistent copy, and their screenshots in `feedback-images/`; not `feedback-auth/`, the chats' sign-in key - losing it only asks people to sign again) and `client-errors.db`, `etf-flows.json`, `release-results.json`, `device.key` if present; `/etc/valuescan` (configuration and its secrets, without `offsite/` and `*.bak*`); `/etc/caddy/Caddyfile` | within 15 min of a change; at least every 20 h |
| `folders` | server 1 | the knowledge folders' data (the feature was removed 2026-11-05, the data stays): `folders.db`, their `session.key`, `files/` | within 15 min of a change; at least every 20 h |
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

## The index: WAL shipping (2026-11-09)

**Why.** The nightly index backup held ONE read transaction on the 50 GB live file for its whole
copy. On 2026-11-08 that was 41 minutes (the unit's 40 MB/s): no checkpoint could pass it, the
WAL grew to 5.5 GB, the indexer starved, the boards went 2 h stale. Before that, 11 of the
indexer's 12 worst stalls (up to 834 s) fell inside backups, and the backup's reads pushed the
live index out of the page cache. The timer has been off since.

**What now.** `valuescan-walship.service` (`deploy/server/bin/wal-ship.mjs`) keeps a replica of
the index in `WALSHIP_DIR` (`/var/lib/valuescan/backup/replica/replica.db`) that follows the
live file by seconds. It reads each commit out of the WAL (pages just written, so from the page
cache), checks every frame's salt and checksum chain the way SQLite's own recovery does, and a
writer thread puts committed pages into the replica. Its read transactions on the live file
are a rolling chain of short ones: every 10 ms it takes a new one, reads the WAL up to what
the `-shm` says is committed, and lets go of the older one. That is what keeps SQLite from
starting the WAL over frames it has not read, and it is all the indexer ever waits for. The
live file is read once, for the first base copy (25 MB/s, pages the WAL brings meanwhile win
over the copy's older bytes), and never again. The nightly `backup.sh` asks it for a
**snapshot of the replica** (40 MB/s, cut between two commits), checks it, compresses it,
writes `.sha256` and a `.meta.json` (the check's figures) next to it. Everything downstream
(the archive, `restore.sh`, the weekly off-server `index` set) is unchanged.

Safety nets: a watchdog kills the shipper if its loop stalls for 2 s while a read transaction
is open; a read transaction that ages past 1 s without the reading getting anywhere is let go
(and the base copy redone); the live database is opened read-only. Page cache: the unit runs
under `MemoryHigh=1G`, the backup unit under `MemoryHigh=6G`, so what they read is reclaimed
from their own cgroup, not from the indexer's (cgroup v2, AlmaLinux 9's default).

**The options weighed:**

| | Live-file read transaction | Finishes on a file written every few seconds | Chosen |
|---|---|---|---|
| (a) WAL shipping (our own, `wal-ship.mjs`) | ~10-40 ms each, rolling | yes: a base copy once, then only the WAL | **yes** |
| (b) SQLite online backup API, small steps | short per step | **no**: it restarts from page 1 whenever another connection writes; on a 50 GB file at 25-40 MB/s (20-35 min) with writes every few seconds it never completes | no |
| (c) filesystem / LVM snapshot | none | yes (WAL mode is crash-consistent) | not available or not checked (below); would need a copy-out anyway |
| old: byte copy / VACUUM INTO | **the whole copy** (41-170 min) | yes | removed (only `BACKUP_ALLOW_LIVE_COPY=1`) |

(c) needs a volume manager under `/var/lib/valuescan`, which a Contabo VPS image usually does not
have. To check on server 1: `findmnt -no SOURCE,FSTYPE /var/lib/valuescan`, `lsblk -f`,
`sudo vgs; sudo lvs` (LVM: free extents in the VG for the snapshot's copy-on-write, at least the
writes of the copy-out window), `stat -fc %T /sys/fs/cgroup` (cgroup2fs). An XFS reflink copy was
tried on 2026-11-05 and fragmented the live file for good (61 -> 1,172,730 extents, +24 GB). An LVM
snapshot copies blocks on first write instead, so it does not fragment the origin, but it still
needs the 50 GB copy-out read.

**Measured** (`deploy/server/bin/wal-ship.test.mjs`, 2026-11-09, Windows laptop, Node 24.22, 8
logical CPUs at 76-90 % load from other programs; 57 MB scratch database; a writer with the
indexer's settings and checkpoint thread (PASSIVE + FULL with a 250 ms wait), small and
cache-spilling transactions, rollbacks, deletes, incremental vacuum; 5 s phases):

| | writer's small commits p50 / p99 / max | frames in the WAL at a checkpoint, max | shipper read transactions |
|---|---|---|---|
| writer alone | 0.4 / 9.2 / 14.4 ms | 4,572 | - |
| shipper: base copy (58 MB/s) | 0.3 / 8.1 / 8.1 ms | 5,273 | |
| shipper: following | 0.3 / 6.2 / 15.7 ms | 5,265 | 627 until kill -9: max 38.6 ms, mean 14.7 ms, 99.9 % <= 50 ms |
| shipper: snapshot (78 MB/s) | 0.3 / 5.3 / 5.3 ms | 6,888 | |
| shipper: after kill -9 (resumed, no new copy) | 0.3 / 35.7 / 35.7 ms | 12,892 | 174: max 43.4 ms, 99.9 % <= 50 ms |
| one read transaction held 5 s (the old way) | 0.3 / 6.7 / **437 ms** | 7,678 | - |

Snapshots taken while the writer ran were one committed instant (integrity_check ok; totals row =
count/sum of the items table = the last ledger row). The final snapshot equalled the source table by
table (SHA-256 of every row). The drill restored the zstd archive, matched its SHA-256 and
the backup-time figures, and passed integrity_check. On the same laptop under heavier load, pins
reached 823 ms and the writer's own baseline commits reached 615 ms, all of it timer and CPU delay (the
debug log shows the shipper's own work per pin under 10 ms in most of them). Hence the test's tight
bounds only with `WALSHIP_TEST_STRICT=1` on a quiet machine. **Not measured: Linux, and the 50 GB
production file**; the base copy there takes ~35 min at 25 MB/s. A risk to watch: the WAL can only
start over when no reader holds a positive read mark, so while the indexer writes without pauses the
shipper delays WAL restarts (2.8x the frames after the kill -9 phase above). See "verify" below.

### Enable (owner, server 1; nothing of this is switched on by a release)

1. Release the code (it lands in `/opt/valuescan/bin` and the unit in `/etc/systemd/system` via
   bootstrap; the unit is installed, not enabled):
   `VS_EC2_ENV=deploy/aws/ec2/ec2.contabo.env deploy/release/bootstrap-instance.sh`
2. Room: the replica needs the size of the index, a new base copy once more, each snapshot once
   more while it is compressed. `df -h /var/lib/valuescan` should show at least 3x the index
   (`ls -l /var/lib/valuescan/index/`) free.
3. The setting:
   `echo 'WALSHIP_DIR=/var/lib/valuescan/backup/replica' | sudo tee -a /etc/valuescan/ops.local.env`
4. Start it, at a quiet hour (the base copy reads the live file at 25 MB/s for ~35 min, with short
   read transactions only):
   `sudo systemctl enable --now valuescan-walship.service`
5. Watch the base copy and the indexer: 
   `journalctl -u valuescan-walship -f` (`base copy ... done`), and every few minutes
   `sudo -u valuescan /opt/node/current/bin/node /opt/valuescan/bin/wal-ship.mjs status --dir /var/lib/valuescan/backup/replica`
   for `mode` (`rebase` -> `follow`), `copy.done/total`, `pins.maxMs` / `pins.lastMinuteMaxMs` (expect tens of ms) and
   `walBytes`. Also the indexer's own status page/health: stalls and staleness as before.
6. One backup by hand, then the timer:
   `sudo systemctl start valuescan-backup.service; journalctl -t valuescan-backup -n 30`
   (`snapshot verified`, `done`), then `sudo systemctl enable --now valuescan-backup.timer`.
7. The drill (below) once, on that backup.

### Verify (after enabling, and after any change)

- `wal-ship.mjs status`: `mode: follow`, `lastSyncAgoS` < 10, `pins.lastMinuteMaxMs` well under 250,
  `stuck: 0`, `appliedFrame` close to `frame`.
- The WAL: `ls -l /var/lib/valuescan/index/valuescan-index.db-wal` and the indexer's checkpoint status
  (`log` frames). If the WAL keeps growing past ~1 GB while the shipper runs (WAL restarts blocked), stop
  the shipper (below) and report it.
- `last-backup.json` fresh: `deploy/release/remote.sh health` (check `backup`).

### Restore

- From the newest nightly backup, as before: `sudo /opt/valuescan/bin/restore.sh latest` (plan), then
  with `--yes`. The `.sha256` is checked; the integrity check runs.
- From the replica (seconds old, when the archive is older than wanted): ask for a snapshot, then
  restore that file:
  ```
  sudo -u valuescan /opt/node/current/bin/node /opt/valuescan/bin/wal-ship.mjs snapshot \
    --dir /var/lib/valuescan/backup/replica --out /var/lib/valuescan/backup/now.db
  sudo /opt/valuescan/bin/restore.sh /var/lib/valuescan/backup/now.db          # plan, then --yes
  ```
  `restore.sh` stops the shipper with the indexer and starts it again afterwards; it then makes one new
  base copy of the restored file. (Should the file be replaced any other way, the shipper notices the new
  inode within 2 s, exits, and systemd starts it on the new file.)

### The index restore drill (monthly, and after any change to the backups; touches nothing that runs)

```
sudo -u valuescan /opt/node/current/bin/node /opt/valuescan/bin/index-drill.mjs latest           # quick_check
sudo -u valuescan /opt/node/current/bin/node /opt/valuescan/bin/index-drill.mjs latest --full    # integrity_check (hours)
```

It restores the newest `valuescan-index-*.db.zst` into a scratch directory under
`/var/lib/valuescan/backup`, compares the SHA-256 with the `.sha256`, runs the check, compares
page count, schema, freelist, table count and the row counts of `meta`, `board_meta`, `coverage`
with the `.meta.json` written at backup time, prints `DRILL PASSED` and deletes the scratch
copy. It needs the index's size free. Run it under the backup unit's limits so it cannot push
the index out of memory:
`sudo systemd-run --wait --pty -p MemoryHigh=6G -p IOReadBandwidthMax="/var/lib/valuescan 40M" -p User=valuescan /opt/node/current/bin/node /opt/valuescan/bin/index-drill.mjs latest`.
A received off-server copy: `backup-restore.sh open` it first, then `index-drill.mjs <the .db.zst inside>`.

### Stop / roll back

`sudo systemctl disable --now valuescan-walship.service` lets go of the live file at once. Nothing
else depends on it except the nightly backup, which then fails loudly (Telegram, `backup` check)
instead of copying the live file. The replica in `WALSHIP_DIR` is a derived copy. It stays until the
owner removes it (`/var/lib/valuescan/backup/replica`, the size of the index).

## The old local backups

They go on as before (`deploy/server/README.md`, "Backups"): the index nightly to
`/var/lib/valuescan/backup/archive` (newest 1), executor.db nightly to
`/var/lib/valuescan/backup/executor/archive` (newest 7). They are the fast way back from
a broken file; the off-server copies are the way back from a broken server.
