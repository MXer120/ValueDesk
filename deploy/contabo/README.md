# The two Contabo servers: what is on them, and how to build them again

Production since 2026-10-25. Both run AlmaLinux 9 (x86_64), SSH as `almalinux` with the
key `~/.ssh/valuescan-contabo` on the owner's laptop.

| | server 1 | server 2 |
|---|---|---|
| address, origin name | 161.97.154.121, `161-97-154-121.sslip.io` | 13.140.77.201, `13-140-77-201.sslip.io` |
| place, plan | France, Cloud VPS 12 (12 vCPU, 47 GB, 400 GB) | Japan (Tokyo), Cloud VPS 4 (4 vCPU, 7 GB, 100 GB) |
| runs | indexer, API, Caddy (`/api/copy/*` -> server 2) | the copy executor, Caddy |
| held (hold.conf) | the executor (`/etc/valuescan/executor-here` absent) | the indexer and the API (`/etc/valuescan/never`) |
| sends off the box (backup-offsite.sh) | api-state, folders, journal, index, hl-archive -> server 2 | executor, journal -> server 1 |
| watches (health.env) | itself + server 2's executor + the site | itself + server 1's API + the site |

Everything common to both is `deploy/server` (bootstrap.sh installs it). What differs
between them, and what hardens Contabo's image, is this directory:

```
deploy/contabo/
  apply-overlay.sh                 puts a server's part in place (idempotent; restarts no service)
  common/sshd/10-valuedesk.conf    keys only; almalinux and vsbackup only
  common/cloud/99-valuedesk.cfg    keeps cloud-init from turning password logins on again
  common/firewalld/public.xml      the zone as it is (ssh, http, https) - for reference
  server1/  server2/
    health.env                     -> /etc/valuescan/health.env   the health check's role and peers
    offsite.env                    -> /etc/valuescan/offsite.env  what this server sends, and where
    backup-receive.env             -> /etc/vsbackup/receive.env   what it receives, kept how long
    systemd/<unit>.d/*.conf        the drop-ins (memory sizes on server 1; the holds)
    units/                         server 2: valuescan-ledger-pull.service/.timer
    bootstrap.env.example          bootstrap.sh's answers for this server (public names)
    env/*.example                  the hand-made /etc/valuescan/*.local.env: variable NAMES only
```

Nothing in this directory is secret; the secrets are listed further down, with where
each one lives.

## Inventory (read-only, 2026-10-27)

Both servers were inventoried over SSH without changing anything (env files: variable
names only). Everything under `deploy/server` matched git byte for byte: the nine units,
the bin scripts, the journald file. **What was on the servers but not in git** - all of
it is in git now:

| What | Where | Now in git |
|---|---|---|
| indexer memory drop-in (heap 8 GB, MemoryHigh 36G / Max 40G) | s1 `/etc/systemd/system/valuescan-indexer.service.d/contabo.conf` | `server1/systemd/...` (same bytes) |
| API memory drop-in (heap 3 GB, 4G / 5G) | s1 `valuescan-api.service.d/contabo.conf` | `server1/systemd/...` |
| executor hold | s1 `valuescan-executor.service.d/hold.conf` | `server1/systemd/...` |
| indexer and API holds | s2 `valuescan-{indexer,api}.service.d/hold.conf` | `server2/systemd/...` |
| builder ledger pull, every 5 min | s2 `valuescan-ledger-pull.service`, `.timer`; key `/root/.ssh/ledger_pull` | `server2/units/` (the key stays on the box) |
| the ledger snapshot it runs | s1 `/opt/valuescan/bin/builder-snapshot.sh`, forced command of a key in `~almalinux/.ssh/authorized_keys` (`from="13.140.77.201"`, no pty/forwarding) | `deploy/server/bin/builder-snapshot.sh` (same bytes) |
| the executor's switch | s2 `/etc/valuescan/executor-here` (empty file) | created by `apply-overlay.sh server2` |
| firewalld (installed by hand 2026-10-25; public zone: ssh, http, https) | both | `common/firewalld/public.xml`; `apply-overlay.sh` keeps exactly these |
| hand-made env files | s1 `api.local.env` (SOSOVALUE_API_KEY, YOUTUBE_API_KEY, VALUESCAN_ALLOWED_ORIGINS), `indexer.local.env` (VALUESCAN_INDEX_HLC_CONCURRENCY, _HL_WEIGHT, _HL_COHORT - temporary), `executor.local.env` (EXECUTOR_LOCAL_ADDRESS - an AWS leftover); s2 `executor.local.env` (EXECUTOR_LOCATION) | `server*/env/*.example` (names) |
| bootstrap's answers | both `/etc/valuescan/bootstrap.env` | `server*/bootstrap.env.example` |

Found on the way, and dealt with by `apply-overlay.sh` / bootstrap.sh:

- **The journal was not persistent** (no `/var/log/journal`): every reboot erased it.
  Server 1's journal began at its last boot (2026-10-26 01:32). bootstrap.sh now sets
  `Storage=persistent`, a year for the main journal (`deploy/server/journald/`).
- **Password logins were on**: `50-cloud-init.conf` says `PasswordAuthentication yes`,
  and the user `admin` has a password and passwordless sudo. `/var/log/btmp` is 14 MB of
  failed tries. Now keys only, `almalinux` and `vsbackup` only. `admin` keeps its
  password for Contabo's VNC console (not sshd); lock it (`passwd -l admin`) if the owner
  never uses that console.
- **`/etc/cron.hourly/free` empties the page cache every hour** (`echo 1 >
  /proc/sys/vm/drop_caches`, part of Contabo's image). On server 1 that throws the 22 GB
  index out of memory every hour; at the inventory the indexer's last board build had
  taken 2.7 hours with 5 s of event-loop lag and the board was 40 minutes old (its health
  check had been failing for 46 hours - nobody heard it: no alert channel worked since
  AWS). Removed (a copy stays in /root).
- **rsyslog copied the journal into `/var/log/messages`**, rotated weekly, four kept: the
  API's request lines with IP addresses for up to five weeks, the privacy policy says 14
  days. Disabled; the persistent journal has everything, and the API's and executor's
  lines are in their own 14-day namespace now (`journald@pii.conf`).
- `rpcbind` listened on port 111 (blocked by firewalld; nothing uses NFS): disabled.
- **The health check had the wrong role on both servers**: server 1 checked an executor
  that is held there, server 2 an API and index it does not have. Both failed every
  minute since 2026-10-25. `health.env` gives each its own checks and the cross-watch.
- **Backups sat on the disk they protect** (index and executor.db), the builder ledger,
  the terms signing key and the knowledge folders had none at all: `backup-offsite.sh`,
  `docs/deploy/BACKUPS.md`.

Noted, not changed:

- Server 2 runs kernel 5.14.0-687.53 with 687.59 installed: reboot it at a quiet moment
  (`sudo systemctl reboot`; the executor starts by itself, copies catch up).
- Server 2: `cloud-final.service` failed at its first boot (harmless now).
- Leftovers on server 1: `/root/state-before-final/` (a copy of builder.db and the
  folders from the move), `/root/pull-index.log`, `/etc/valuescan/indexer.local.env.bak-20261027`,
  `/var/lib/valuescan/archive/{checkpoint,hourly}` (the import's work files). Delete
  once nobody needs them.
- SELinux is enforcing; the services run as `unconfined_service_t`, no custom contexts,
  ports or booleans. `vsbackup`'s home is under /home so its `.ssh` gets `ssh_home_t`.
- Packages beyond the image: only `firewalld` (+ `zstd` from bootstrap). Node and Caddy
  come from bootstrap.sh (`/opt/node`, `/usr/local/bin/caddy`, pinned in versions.env).
- Users: `valuescan` (995), `valuescan-executor` (994), `caddy` (993) from bootstrap;
  `admin` (1000) and `almalinux` (1001) from Contabo's cloud-init, both with passwordless
  sudo (`/etc/sudoers.d/90-cloud-init-users`). sysctl: only the image's `kernel.panic=10`.
  No logrotate rules of ours (nothing writes files). No crontabs of ours.

### Only on the owner's laptop (not in git, not on the servers)

| What | Where | Needed for |
|---|---|---|
| SSH key for both servers | `~/.ssh/valuescan-contabo` (+ `.pub`) | everything |
| the servers' host keys | `~/.ssh/known_hosts` (and `valuedesk-contabo*.known_hosts`) | verifying them |
| release environments | `~/vs-coh/deploy/aws/ec2/ec2.contabo.env`, `ec2.contabo2.env` - REGION, NAME, SSH_USER, SSH_KEY_FILE, SSH_KNOWN_HOSTS, SITE_DOMAIN, ORIGIN_DOMAIN_NAME, ACME_EMAIL, ORIGIN_SECRET_DIR (no secret; ACME_EMAIL is personal) | `VS_EC2_ENV=...` releases and bootstraps |
| their state | `vs-coh/deploy/aws/ec2/.out/state.contabo.env`, `state.contabo2.env` - STATE_NAME, STATE_REGION, PUBLIC_IP | the same |
| **the origin secret** | `~/.valuescan/valuescan-test/origin-secret` (ORIGIN_SECRET_DIR) - also on both servers (`/root/.valuescan/origin-secret`) and in Vercel (`VALUESCAN_ORIGIN_SECRET`) | bootstrap, rotation |
| the web build's settings | `deploy/release/web.env` (gitignored) | manual web releases |
| (from now) the two backup keys | `~/ValueDesk-backups/keys/server{1,2}.backup.key` (`pull-backups.sh --fetch-keys`) | opening any off-server copy |

Copy the two `ec2.contabo*.env` files into any new worktree (they are gitignored on
purpose: `deploy/.gitignore`). Their content is small and public apart from ACME_EMAIL.

### The secrets, and where each one lives

| Secret | On | Also with |
|---|---|---|
| origin secret (`api.secret.env`, `caddy.secret.env`, `executor.secret.env`, `/root/.valuescan/origin-secret`) | both | laptop, Vercel |
| SoSoValue and YouTube API keys (`api.local.env`) | server 1 | the owner's accounts |
| builder-terms signing key (`/var/lib/valuescan/state/builder-terms.key`) | server 1 | the api-state off-server copy (encrypted) |
| executor kek, session.key, import.key | server 2 only | **the owner's offline block** (`executor-secrets.sh export`) - never in any backup |
| Telegram bot token (`/etc/valuescan/alert.env`) | both | GitHub secret TELEGRAM_TOKEN, the owner's BotFather |
| backup keys (`/etc/valuescan/offsite/backup.key`) | each its own | laptop / password manager |
| off-server ssh keys (`/etc/valuescan/offsite/id_ed25519`), ledger pull key (`/root/.ssh/ledger_pull`) | the sending server | nobody (made again if lost) |

## Apply (the lead runs these; in this order)

From a clean checkout of the commit with these files (LF line endings - bootstrap-instance.sh
refuses CRLF), Node on PATH, and the two `ec2.contabo*.env` copied into
`deploy/aws/ec2/`. `S1=almalinux@161.97.154.121`, `S2=almalinux@13.140.77.201`,
`K="-i ~/.ssh/valuescan-contabo"`.

1. **Common parts, server 1 then server 2** (installs the new scripts and units, the
   journald settings - the journal becomes persistent -, the health unit's new env files;
   restarts the API on server 1 and the executor on server 2 once, because their units
   changed: `LogNamespace=pii`):
   ```
   VS_EC2_ENV=deploy/aws/ec2/ec2.contabo.env  deploy/release/bootstrap-instance.sh
   VS_EC2_ENV=deploy/aws/ec2/ec2.contabo2.env deploy/release/bootstrap-instance.sh
   ```
2. **Each server's own part** (upload, look at the plan, apply). Keep the SSH session open
   while sshd reloads; then open a new one to see that the key still works:
   ```
   for h in $S1 $S2; do tar -C deploy/contabo -cf - . | ssh $K $h 'sudo rm -rf /opt/valuescan/overlay && sudo mkdir -p /opt/valuescan/overlay && sudo tar -xf - -C /opt/valuescan/overlay --no-same-owner'; done
   ssh $K $S1 'sudo bash /opt/valuescan/overlay/apply-overlay.sh server1 --dry-run'
   ssh $K $S1 'sudo bash /opt/valuescan/overlay/apply-overlay.sh server1'
   ssh $K $S1 true
   ssh $K $S2 'sudo bash /opt/valuescan/overlay/apply-overlay.sh server2 --dry-run'
   ssh $K $S2 'sudo bash /opt/valuescan/overlay/apply-overlay.sh server2'
   ssh $K $S2 true
   ssh $K $S2 'sudo systemctl start valuescan-ledger-pull.service && systemctl is-active valuescan-ledger-pull.timer'
   ```
3. **The health check in its new role** (no restart needed - the next pass reads health.env):
   ```
   deploy/release/remote.sh health    # with VS_EC2_ENV=... for each server
   ```
   Expect server 2 all green; server 1 fails `index`/`indexer` as long as the board is
   stale (a real finding, see above), its peers green.
4. **Telegram** (after the owner made the bot and wrote to it - owner steps below):
   ```
   ssh -t $K $S1 'sudo bash /opt/valuescan/bin/telegram-setup.sh --name="server 1 (France)"'
   ssh -t $K $S2 'sudo bash /opt/valuescan/bin/telegram-setup.sh --chat-id=<the id printed> --name="server 2 (Tokyo)"'
   ```
   The token is asked without echo (or `--token-stdin < file`). Both send a test message.
5. **Off-server backups** (each direction: sender first, its public key to the receiver):
   ```
   ssh $K $S1 'sudo bash /opt/valuescan/bin/offsite-setup.sh sender --to=13.140.77.201'
   ssh $K $S2 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'          # = the fingerprint server 1 pinned
   ssh $K $S2 "sudo bash /opt/valuescan/bin/offsite-setup.sh receiver --from=161.97.154.121 --pubkey='<line server 1 printed>'"
   ssh $K $S2 'sudo bash /opt/valuescan/bin/offsite-setup.sh sender --to=161.97.154.121'
   ssh $K $S1 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'
   ssh $K $S1 "sudo bash /opt/valuescan/bin/offsite-setup.sh receiver --from=13.140.77.201 --pubkey='<line server 2 printed>'"
   ssh $K $S1 'sudo bash /opt/valuescan/bin/offsite-setup.sh test'
   ssh $K $S2 'sudo bash /opt/valuescan/bin/offsite-setup.sh test'
   ssh $K $S1 'sudo /opt/valuescan/bin/backup-offsite.sh push api-state && sudo /opt/valuescan/bin/backup-offsite.sh push folders'
   ssh $K $S2 'sudo /opt/valuescan/bin/backup-offsite.sh push executor'
   ```
   The journal, the index (~4.6 GB, ~8 minutes) and the HL archive go by themselves in the
   next 04:00-05:59 UTC window (valuescan-offsite.timer), or now with `push journal`,
   `push index`, `push hl-archive` on server 1 (`push journal` on server 2).
6. **The keys offline, and the first drill** (on the laptop; docs/deploy/BACKUPS.md):
   ```
   deploy/release/pull-backups.sh --fetch-keys --verify
   ssh $K $S2 'sudo /opt/valuescan/bin/backup-restore.sh drill api-state --key-stdin' < ~/ValueDesk-backups/keys/server1.backup.key
   ssh $K $S1 'sudo /opt/valuescan/bin/backup-restore.sh drill executor --key-stdin' < ~/ValueDesk-backups/keys/server2.backup.key
   ```
7. Later, at a quiet moment: reboot server 2 (kernel), delete the leftovers listed above,
   `sudo find /var/log -maxdepth 1 -name 'messages*' -mtime +14 -delete` on both after 14 days.

## Owner steps

1. **Telegram bot** (2 minutes, in the Telegram app): open `@BotFather`, send `/newbot`,
   pick a name and a user name ending in `bot`; it answers with the **token** - keep it
   in the password manager. Open the new bot and press **Start** (or write anything): a
   bot may only write to someone who wrote to it first. Give the token to whoever runs
   step 4 (never in a chat log: a file, or typed at the hidden prompt).
2. **GitHub** -> the repository -> Settings -> Secrets and variables -> Actions -> New
   repository secret: `TELEGRAM_TOKEN` (the token), `TELEGRAM_CHAT_ID` (the id step 4
   printed). The uptime workflow runs every 30 minutes (`.github/workflows/uptime.yml`
   says why not 5; a public repository or bought minutes allow 5).
3. **The backup keys**: after step 6 they are in `~/ValueDesk-backups/keys/`. Put both
   into the password manager as well. Without them no off-server copy can be opened.
4. **The executor's kek**, if not done yet: `ssh -t ... 'sudo bash /opt/valuescan/bin/executor-secrets.sh export'`
   on server 2, keep the block offline and its passphrase apart from it.
5. Optional: lock `admin`'s password on both servers if the Contabo VNC console is never used.
6. Optional, for releases: a fine-grained GitHub token (this repository; Checks: read,
   Contents: read) as `GITHUB_TOKEN` in the shell that runs `release-server.sh`, so the
   release accepts CI's green run instead of running the suites again.

## Rebuilding a server from nothing

A new Contabo VPS (AlmaLinux 9) in place of a lost one - same order as the first time:

1. In Contabo's panel: AlmaLinux 9, the laptop's public key `~/.ssh/valuescan-contabo.pub`
   for `almalinux`. Note the new IP. If it changed: the sslip.io origin name changes with
   it (`<a-b-c-d>.sslip.io`) - update `deploy/vercel/production.settings` (server 1),
   `EXECUTOR_UPSTREAM` in server 1's bootstrap.env (server 2), the IPs in
   `deploy/contabo/*/offsite.env`, `health.env`, `apply-overlay.sh`, the ledger-pull unit,
   and the `from="..."` of the keys that point at it.
2. `sudo dnf -y upgrade && sudo dnf install -y firewalld && sudo systemctl enable --now firewalld && sudo reboot`
3. The origin secret onto the box and bootstrap: `ec2.contabo*.env` with the new IP in
   `.out/state.contabo*.env`, then `VS_EC2_ENV=... deploy/release/bootstrap-instance.sh`
   (it copies the secret from the laptop's ORIGIN_SECRET_DIR, renders every env file,
   installs Node, Caddy, the units, journald; DATA_DEVICE=none and EXECUTOR_UPSTREAM come
   from `server*/bootstrap.env.example` - pass them on the first run).
4. The hand-made env files from `server*/env/*.example` (values from the owner, or from the
   newest api-state / executor copy: `backup-restore.sh open`, then `apply --with-etc`).
5. `apply-overlay.sh server1|server2` (above, step 2), then a release:
   `VS_EC2_ENV=... deploy/release/release-server.sh <tag>`.
6. The data: server 1 - `backup-restore.sh apply` of the newest api-state and folders
   copies (held on server 2), the index from the newest `index` copy or a cold start
   (docs/INDEXER.md), the HL archive from `hl-archive`. Server 2 - FIRST the kek
   (`executor-secrets.sh import < block`), THEN the newest executor copy (held on server 1),
   then start the executor. docs/deploy/BACKUPS.md has each command.
7. Steps 4-6 of "Apply" (Telegram, off-server keys - new ones; the old copies still open
   with the old keys, which the owner keeps -, the drill).
