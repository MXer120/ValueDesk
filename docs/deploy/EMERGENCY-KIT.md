# The emergency kit: ValueDesk without the laptop

Status: 2026-10-28. The owner uses no password manager. Some files exist **only on the laptop**
(`deploy/contabo/README.md`, "Only on the owner's laptop"): lose the laptop and nobody can log in
to the servers, release, or open a backup. The kit is those files in one encrypted file on a USB
stick, plus a plain-text note on how to use it.

## What is in it

`deploy/release/emergency-kit.sh create` gathers:

| In the kit | From | Why |
|---|---|---|
| `ssh/valuescan-contabo` (+ `.pub`) | `~/.ssh/` (the `SSH_KEY_FILE` of the env files) | the only login to both servers |
| `ssh/valuedesk-contabo*.known_hosts`, `ssh/known_hosts` | `~/.ssh/` (`SSH_KNOWN_HOSTS`) | the servers' pinned host keys |
| `repo/deploy/aws/ec2/*.env`, `.out/state.*.env` | the release worktree (`--from`, default `~/vs-coh`) | `VS_EC2_ENV=...` releases and bootstraps |
| `repo/deploy/release/web.env` | the same | manual web builds |
| `origin-secret/<name>/origin-secret*` | `ORIGIN_SECRET_DIR` of the env files | bootstrap, Vercel |
| `backup-keys/*` | `~/ValueDesk-backups/keys/` - the current **and old** keys | opening any off-server copy |
| `executor/<block>` | `--kek-block=<file>` (`executor-secrets.sh export`) | the followers' keys after losing server 2 |
| `extra/*` | `--add=<file>` - e.g. the 2FA recovery codes of GitHub, Vercel, Contabo, the registrar | the accounts |
| `code/valuescan.bundle` | `--with-git` (a git bundle of `main`, ~20 MB) | the code without GitHub |
| `WHERE.txt`, `RESTORE.txt`, `MANIFEST.sha256` | made by the script | where each file goes, how to rebuild, every file's SHA-256 |

An expected file that is missing stops it (`--allow-missing` goes on and lists it in RESTORE.txt).
Without `--kek-block` it stops too: make the block first, or say `--allow-missing` on purpose.

## The commands

```bash
# make it (asks for the passphrase twice; 16+ characters - five or six random words)
deploy/release/emergency-kit.sh create --out=/e/ValueDesk --kek-block=kek-block-2026-10-28.txt \
    --contact="Jane Doe (holds the envelope), +49 ..." --with-git

deploy/release/emergency-kit.sh verify /e/ValueDesk/valuedesk-kit-<stamp>.tar.enc     # asks; lists; checks every file
deploy/release/emergency-kit.sh open   /e/ValueDesk/valuedesk-kit-<stamp>.tar.enc ~/kit-open   # restores (0700)
```

On the stick: `valuedesk-kit-<stamp>.tar.enc`, its `.sha256`, and `RESTORE.txt` - **plain text
and no secret**: what is inside (names only), the exact command to open it, how to rebuild from
nothing, which accounts are not in it, who to call. Print RESTORE.txt and put it in the envelope
too.

## How it is protected

- A tar archive encrypted with `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -salt`
  (the same as `executor-secrets.sh`): any computer with OpenSSL 1.1.1+ opens it without our code -
  ```bash
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in valuedesk-kit-<stamp>.tar.enc -out kit.tar
  tar -xf kit.tar && cd kit && sha256sum -c MANIFEST.sha256
  ```
  (tested word for word: `deploy/release/emergency-kit.test.mjs`).
- openssl's CBC mode has no authentication tag: the `.sha256` beside the bundle (checked by
  `verify` and `open`) and the manifest inside catch a damaged or changed file; a wrong passphrase
  gives "bad decrypt".
- The passphrase is read from the terminal (no echo) and handed to openssl through its
  environment, never on a command line; it is stored nowhere.
- While bundling, the files are copied into a `mktemp` directory (0700, Windows ACL narrowed to
  you), removed on every exit, Ctrl-C included. `open` writes only into the folder you name (new
  or empty, refused inside OneDrive). Nothing is printed but file names.
- The passphrase stretching (PBKDF2, 600 000 rounds) makes guessing slow, not impossible: the
  passphrase is what protects the kit. Five or six random words from a dice list are enough;
  a sentence you would post is not.

## The rules

1. **Two USB sticks, two places** (home and somewhere else you trust - a relative, a bank box).
   Not in the laptop bag.
2. **The passphrase on paper, in a sealed envelope, with a trusted person** - never on the sticks,
   never next to them, never in a chat or a photo. Write on the envelope what it is for and who
   may open it (you, or someone you named, if you cannot).
3. **Redo the kit after every rotation** (`docs/deploy/SECRETS.md` - each rotation reminds you):
   the SSH key, the origin secret, a backup key, the kek block. Old kits then hold old secrets:
   wipe or destroy the old sticks' bundles once the new ones are verified (keep the newest
   two kits only if the backup keys' old copies are still needed - the new kit holds the old
   backup keys anyway).
4. **Test opening once a year** (and right after making it): `emergency-kit.sh verify` on each
   stick, with the passphrase from the envelope - on a second computer if you have one. Write the
   date on the envelope.
5. A stick lost **without** the envelope: not urgent (encrypted) - make a new kit with a new
   passphrase and destroy the others. A stick **and** the passphrase lost or seen: rotate
   everything in it (`docs/deploy/SECRETS.md`, "After a leak").

## If the laptop is gone

1. Any computer: Git for Windows (it has bash, openssl, tar, ssh) and Node 24
   (`deploy/server/versions.env`).
2. `git clone https://github.com/MXer120/valuescan.git vs-coh` (or from `code/valuescan.bundle`).
3. Open the kit (`RESTORE.txt`), put each file where `WHERE.txt` says, owner-only.
4. Check: `ssh -i ~/.ssh/valuescan-contabo almalinux@161.97.154.121 true` (and 13.140.77.201);
   `VS_EC2_ENV=deploy/aws/ec2/ec2.contabo.env deploy/release/remote.sh health`.
5. The laptop may have been stolen, not lost: rotate the laptop SSH key first, then the origin
   secret and the backup keys (`docs/deploy/SECRETS.md`), then make a new kit.
