# Secrets: every one, where it lives, and how to replace it

Status: 2026-10-28. Production is two Contabo servers (`deploy/contabo/README.md`): **server 1**
161.97.154.121 (API, indexer, Caddy) and **server 2** 13.140.77.201 (the copy and algo executor);
the site is on Vercel. Backups: `docs/deploy/BACKUPS.md`. The laptop-only files and the USB
kit: `docs/deploy/EMERGENCY-KIT.md`.

## One command

```bash
deploy/release/rotate.sh list                       # every secret and its command
deploy/release/rotate.sh status                     # read-only: what is in place on both servers (ids, never contents)
deploy/release/rotate.sh <what> [<step>]            # THE PLAN: every step and command, what users notice - runs nothing
deploy/release/rotate.sh <what> [<step>] --execute  # do it (asks "yes" first; --yes without a terminal)
```

Run it from the release worktree (`~/vs-coh`: it has `deploy/aws/ec2/ec2.contabo*.env`),
in Git Bash, with `~/.ssh/valuescan-contabo`. Every rotation:

- **plans by default** and changes nothing - not even an ssh call;
- with `--execute` runs its steps in order and **stops at the first that fails**, printing the
  rollback for that point;
- checks the **health of what it touched afterwards** (the unit's own health URL on the server,
  then the site through Vercel) - a rotation that leaves a service unhealthy is a failure;
- **never prints a secret**: keys are named by an id (16 hex of SHA-256 over a fixed label and the
  key - `rotate-secret.sh status` and the executor's audit log use the same ids) or by their
  public half; secrets travel **only on ssh's stdin**, never on a command line;
- keeps the old file beside the new one (`<file>.old-<stamp>`, 0600) for a rollback - delete it
  once all is well (except where it says *keep*, below).

The server half is `deploy/server/bin/rotate-secret.sh` (installed in `/opt/valuescan/bin` by
bootstrap). The executor's rotations use `apps/executor/tools/rotate-kek.ts` and `rotate-key.ts`.

**Before the first use:** both servers need the new scripts and the executor needs a release
that contains the tools:

```bash
VS_EC2_ENV=deploy/aws/ec2/ec2.contabo.env  deploy/release/bootstrap-instance.sh
VS_EC2_ENV=deploy/aws/ec2/ec2.contabo2.env deploy/release/bootstrap-instance.sh
VS_EC2_ENV=deploy/aws/ec2/ec2.contabo2.env deploy/release/release-server.sh <tag>   # a tag with tools/rotate-kek.ts
```

**After any rotation:** make a new emergency kit (`deploy/release/emergency-kit.sh create`), and
after a kek rotation a new kek block first.

## The list

"Who can read it" = who can read the file on the server (root can read everything).

| Secret | Where | Who can read it | A leak allows | Rotate | Users notice |
|---|---|---|---|---|---|
| **laptop SSH key** `~/.ssh/valuescan-contabo` | laptop (and the emergency kit); its public half in `~almalinux/.ssh/authorized_keys` on both servers and in Contabo's panel | the owner's Windows account | log in to both servers as `almalinux`, with sudo: **everything** | `rotate.sh laptop-ssh` | nothing |
| **origin secret** | laptop `~/.valuescan/valuescan-test/origin-secret`; both servers `/root/.valuescan/origin-secret` -> `/etc/valuescan/{api,caddy,executor}.secret.env`; Vercel `VALUESCAN_ORIGIN_SECRET` | root; the API's group (`api.secret.env`) | call the API and the executor directly, past Vercel (its rate limits and headers) | `rotate.sh origin-secret begin`, Vercel, `... finish` | nothing (unless Vercel still sends the old value at `finish`: every `/api` call 403 until the rollback) |
| **executor kek** | server 2 `/var/lib/valuescan/executor/kek`; offline: the kek block | `valuescan-executor` | together with a copy of `executor.db`: open every follower's sealed trading key - sign trades for them until their keys expire or are revoked | `rotate.sh executor-kek` | a few seconds' pause of the executor |
| executor `session.key` | server 2, same directory | `valuescan-executor` | forge a follower's dashboard token: read their copies, algos and activity (not trade) | `rotate.sh executor-session` | every follower signs once more (a free signature); copies run on |
| executor `import.key` | server 2, same directory | `valuescan-executor` | with the site's traffic: read a SoDEX key a follower imports | `rotate.sh executor-import` | an import under way at that moment fails once |
| folders `session.key` | server 1 `/var/lib/valuescan/state/folders/` | `valuescan` | open the knowledge folders (owner only) | `rotate.sh folders-session` | the owner signs in again |
| feedback `session.key` | server 1 `/var/lib/valuescan/state/feedback-auth/` | `valuescan` | read and write the feedback chats kept on wallets | `rotate.sh feedback-session` | chat users sign once more |
| **builder terms key** `builder-terms.key` | server 1 `/var/lib/valuescan/state/` (and in the api-state backups); its public half in the web build (`VITE_BUILDER_TERMS_KEYS`) | `valuescan` | sign "fee terms": make the app charge a wallet less builder fee than its tier (fee income, never user funds) | `rotate.sh builder-terms begin`, web release, `... finish` | nothing if both keys are pinned first (below) |
| Telegram bot token | both `/etc/valuescan/alert.env`; GitHub secret `TELEGRAM_TOKEN`; BotFather | root | send messages as the bot, read what is sent to it | BotFather `/revoke`, then `rotate.sh telegram` | nothing (alerts are silent between the revoke and the setup) |
| **backup key**, one per server | each `/etc/valuescan/offsite/backup.key`; laptop `~/ValueDesk-backups/keys/server{1,2}.backup.key`; the kit | root | read that server's off-server copies (whoever also has a copy: the other server, the laptop) | `rotate.sh backup-key server1\|server2` | nothing |
| off-server ssh keys | each sender `/etc/valuescan/offsite/id_ed25519`; public half in the other's `/home/vsbackup/.ssh/authorized_keys` | root | put files into (and list) the other server's `/var/lib/vsbackup`, only from the sender's address, only through `backup-receive.sh` - never read the copies (encrypted) | `rotate.sh offsite-ssh server1\|server2` | nothing |
| ledger pull key | server 2 `/root/.ssh/ledger_pull`; public half in server 1 `~almalinux/.ssh/authorized_keys` (`from="13.140.77.201"`, forced `builder-snapshot.sh`) | root | read the builder ledger (counted fee volume per wallet), only from server 2's address | `rotate.sh ledger-pull` | nothing |
| SoSoValue, YouTube API keys | server 1 `/etc/valuescan/api.local.env` (0600 root) | root | spend the quota | provider console, then `VS_EC2_ENV=deploy/aws/ec2/ec2.contabo.env deploy/release/set-sosovalue-key.sh` / `set-youtube-key.sh` (`rotate.sh sosovalue` prints this) | the widgets pause for the API restart |
| `VALUESCAN_INTERNAL_TOKEN` / `EXECUTOR_BUILDER_TOKEN` | **not set in production** (2026-10-28; the executor reads the ledger copy instead). If set: `api.secret.env` / `executor.secret.env` | root | read a wallet's counted volume | by hand: a new random value in both, restart API and executor | nothing |
| the kek block (`executor-secrets.sh export`) and its passphrase | offline (paper / the kit); the passphrase apart from it | whoever holds them | with a database copy: the kek (above) | a new block after every kek rotation; keep the old one while backups from before exist | - |
| the emergency kit and its passphrase | two USB sticks; the passphrase on paper with a trusted person | whoever holds both | everything above | a new kit, a new passphrase; rotate everything in it if a stick was lost *with* the envelope | - |
| servers' SSH host keys `/etc/ssh/ssh_host_*` | each server | root | pretend to be the server (a man in the middle on first contact) | by hand: `ssh-keygen -A` after deleting them, restart sshd, then update `~/.ssh/valuedesk-contabo*.known_hosts` and the offsite `known_hosts` (`offsite-setup.sh sender`) | nothing |
| the owner's accounts (GitHub, Vercel, Contabo, registrar, Telegram, SoDEX builder) | the providers | the owner | depends: Vercel or the registrar can send the site's visitors anywhere | change the password, revoke sessions and tokens there; keep 2FA recovery codes in the kit (`--add=`) | - |

Followers' own SoDEX keys are theirs: if the executor's kek **and** executor.db were exposed,
rotating the kek does not undo it - followers revoke the ValueDesk key on SoDEX (the copy setup
shows how) and register a new one.

## The rotations, step by step

Each one prints exactly this, with the commands, when run without `--execute`.

### laptop-ssh - never a lock-out

1. The old key logs in to both servers (else stop: fix that first).
2. `ssh-keygen -t ed25519 -a 100` into `~/.ssh/valuescan-contabo.new` - **it asks for a passphrase**
   (refused if empty).
3. Both servers get the new public key **beside** the old (`rotate-secret.sh authorized add`).
4. The new key logs in to **both** and runs `sudo -n true`. Any failure stops here: nothing was
   removed, the old key still works.
5. Server 1, then server 2: the old key is removed - over a connection made **with the new key**,
   and the helper refuses unless the new key remains and at least one login key is left; it never
   touches forced-command lines (the ledger pull key) without `--like`. After each: log in again.
6. On the laptop the new key takes the usual name; the old stays as `valuescan-contabo.old-<stamp>`.

Then: put the new public key into Contabo's panel (used for a reinstall), a new emergency kit.

**The passphrase and the release scripts:** they run ssh with `BatchMode=yes`. Load the key once
per Git Bash session: `eval "$(ssh-agent -s)"; ssh-add ~/.ssh/valuescan-contabo`.

### origin-secret - two parts, no gap

`begin`: a new value into `origin-secret.next`; `bootstrap-instance.sh` for server 1 (through
`rotate-origin-secret.sh begin`) and server 2 - both accept old **and** new. The owner sets the new
value in Vercel and redeploys. `finish` (after "done"): the laptop keeps the old value as
`origin-secret.old-<stamp>`, the new one becomes the only one on both servers, then the site's
`/api/health` and `/api/copy/v1/health` through Vercel must answer. **Rollback** after `finish`:
copy `origin-secret.old-<stamp>` to `origin-secret.next` and run `bootstrap-instance.sh` for both
env files - both values are accepted again.

### executor-kek - a real rotation

`rotate-secret.sh executor-kek` on server 2:

1. `rotate-kek.ts check` (read-only, next to the running executor): every sealed key opens under
   the kek in force. Else nothing happens.
2. The executor stops (copies catch up afterwards, algos resume their schedule).
3. `rotate-kek.ts rotate`, as `valuescan-executor`:
   `executor.db.before-kek-<stamp>` (a consistent copy) -> `kek.new` (0600, fsync) -> **one
   transaction**: every key opened under the old kek and sealed again under the new one, every row
   opened under the new one, an audit row (`kind secret`, `ref kek`, the old and new ids) -> COMMIT
   -> the old kek copied to `kek.old-<stamp>` -> `kek.new` renamed to `kek` -> every row opened
   again under the file now on disk. The database lock refuses to run next to a live executor. A
   crash at any point is finished or undone by the next run (src/rotation.ts says how).
4. The executor starts; its health; `rotate-kek.ts check` again.

**Keep `kek.old-<stamp>`** (and the old kek block) as long as executor.db backups from before the
rotation exist - 7 nights locally, 30 days off-server: they open only with the old kek.
**Undo:** `sudo bash /opt/valuescan/bin/rotate-secret.sh executor-kek --kek-from=/var/lib/valuescan/executor/kek.old-<stamp>`
(seals everything again under that kek). **Then the kek block** - the old one holds the old kek:

```bash
ssh -t -i ~/.ssh/valuescan-contabo almalinux@13.140.77.201 'sudo bash /opt/valuescan/bin/executor-secrets.sh export' > kek-block-<date>.txt
```

### executor-session, executor-import, folders-session, feedback-session

Stop (or restart) the unit, a new file (old kept), start, health. The executor ones go through
`rotate-key.ts` (with an audit row). Rollback: `rotate-secret.sh restore <file>.old-<stamp>`.

### telegram

BotFather first (`/revoke` - the old token stops at once), then the new token at the hidden prompt
or `--token-file=<f>`; the chat id is read from server 1's `alert.env`. `telegram-setup.sh
--token-stdin` on both servers sends a test message (that is the health check). Then the GitHub
secret: `gh secret set TELEGRAM_TOKEN --repo MXer120/valuescan` (asks for the value). Delete the
token file.

### backup-key server1|server2

1. The laptop must already hold the server's **current** key (same id) - else stop: an old key
   that exists only on the server would be lost with it.
2. On the server: the old key kept as `backup.key.old-<stamp>`, a new one, one set pushed with it.
3. On the laptop: the old key renamed to `<label>.backup.key.old-<id>` (**keep it**), the new one
   fetched (`pull-backups.sh --fetch-keys --no-pull`), its id compared.
4. The drill: the newest copy (made with the new key) is opened on the holding server.

**Copies made with the old key open only with the old key**: keep it until the last of them is
pruned - journal copies 400 days, the others 14-60 days (BACKUPS.md). If the old key leaked, delete
the old copies you do not need on the holding server. The emergency kit must hold both.

### offsite-ssh server1|server2, ledger-pull

The new key pair is made on the server that uses it; its **public** line goes to the other server
**beside** the old one (with the old line's options: `from=`, the forced command); the new key is
tested; the server switches to it (old kept); the other server forgets the old one; a final test
(`offsite-setup.sh test`, one ledger pull). If anything fails before the switch, the old key works
throughout.

### builder-terms - what it signs, and why two steps

`builder-terms.key` (Ed25519) signs the fee terms (`docs/BUILDER-TIERS.md` §3): nine lines that
let the app charge one wallet a builder fee below its build's default for 10 minutes. The app
verifies them with public keys **pinned in its build** (`VITE_BUILDER_TERMS_KEYS`, comma
separated; each signature carries a `keyId`). So:

1. `rotate.sh builder-terms begin --execute`: `builder-terms.key.next` on server 1 (0600,
   `valuescan`); both public keys are printed (not secrets).
2. The owner sets `VITE_BUILDER_TERMS_KEYS=<current>,<next>` in `deploy/vercel/production.settings`
   (and `deploy/release/web.env`), commits, pushes - Vercel deploys. Wait until it is live; a day
   lets old tabs reload.
3. `rotate.sh builder-terms finish --execute`: the next key in force (the API picks the file up
   within seconds, no restart); the helper asks the API for terms and checks they carry the new
   `keyId`. Rollback: `rotate-secret.sh restore .../builder-terms.key.old-<stamp>`.
4. Later: the old public key out of `VITE_BUILDER_TERMS_KEYS`, deploy, delete the `.old` file. If
   the old key leaked, do this at once - until then it can still sign terms the app accepts.

What users notice: nothing, if the web build pinned both keys before step 3. A tab still on a
build that pins only the old key gets terms it cannot verify and charges the default fee until
it reloads. A key file that is missing or broken is never replaced by an older one: terms go out
unsigned and every app charges its default fee - safe, but more expensive for users.

## After a leak (or a suspected compromise)

The order, from `docs/INCIDENT-RUNBOOK.md`: brake first. Then, for a **server**: stop the
executor; rebuild from git on a fresh box (`deploy/contabo/README.md`); rotate everything that
server held - for server 2 the kek **and** ask followers to revoke their ValueDesk key on SoDEX;
the origin secret (both hold it); its backup key and off-server ssh key; the Telegram token;
server 1's builder terms key, folders and feedback keys, the API keys. For the **laptop**: the
laptop SSH key first (from another machine, with the kit), then the origin secret, the backup keys
(the laptop held them), and the account passwords. For a **lost USB stick without the envelope**:
nothing urgent (it is encrypted) - make a new kit with a new passphrase; with the envelope:
everything in it.
