#!/usr/bin/env bash
# The emergency kit: everything that exists ONLY on the owner's laptop and is needed to run or
# rebuild ValueDesk, as one passphrase-encrypted file for a USB stick (docs/deploy/EMERGENCY-KIT.md).
#
#   deploy/release/emergency-kit.sh create --out=<dir>   bundle it (asks for a passphrase twice)
#        [--from=<repo dir>]       where the release env files are (default ~/vs-coh,
#                                  else this checkout): deploy/aws/ec2/*.env, .out/state.*.env,
#                                  deploy/release/web.env
#        [--kek-block=<file>]      the executor's offline kek block (executor-secrets.sh export)
#        [--add=<file>]            any other file (2FA recovery codes, ...); repeatable
#        [--contact=<text>]        who to call, written into RESTORE.txt; repeatable
#        [--with-git]              also a git bundle of main (~20 MB) - the code without GitHub
#        [--allow-missing]         go on when an expected file is missing (listed in RESTORE.txt)
#   deploy/release/emergency-kit.sh verify <bundle>      asks the passphrase, lists the contents and
#                                                        checks every file against the manifest
#   deploy/release/emergency-kit.sh open <bundle> <dir>  restores into <dir> (new or empty; 0700)
#   ... --passphrase-stdin                               the passphrase is the first line of stdin
#
# FORMAT, openable without this script: a tar archive, encrypted with
#   openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -salt
# (the same as executor-secrets.sh). Open by hand:
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in <bundle> -out kit.tar && tar -xf kit.tar
# Next to the bundle: <bundle>.sha256 and RESTORE.txt (plain text, NO secret: what is inside, how
# to open it, how to rebuild, who to call). The passphrase is never stored anywhere by this script.
#
# Plaintext touches the disk only inside the output directory on `open`, and in a mktemp
# directory (0700) while bundling - removed on every exit. The secrets are never printed; the
# passphrase goes to openssl through its environment (-pass env:), never on a command line.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
die() { echo "emergency-kit: $*" >&2; exit 1; }
say() { echo "emergency-kit: $*" >&2; }
command -v openssl >/dev/null || die "openssl is needed (Git for Windows has it)"
command -v tar >/dev/null || die "tar is needed"

ENC=(-aes-256-cbc -pbkdf2 -iter 600000 -md sha256)
OUT="" FROM="" KEK="" WITH_GIT=0 ALLOW_MISSING=0 PASS_STDIN=0
ADD=() CONTACT=() POS=()
cmd="${1:-}"; shift || true
for a in "$@"; do
  case "$a" in
    --out=*) OUT="${a#--out=}" ;;
    --from=*) FROM="${a#--from=}" ;;
    --kek-block=*) KEK="${a#--kek-block=}" ;;
    --add=*) ADD+=("${a#--add=}") ;;
    --contact=*) CONTACT+=("${a#--contact=}") ;;
    --with-git) WITH_GIT=1 ;;
    --allow-missing) ALLOW_MISSING=1 ;;
    --passphrase-stdin) PASS_STDIN=1 ;;
    --*) die "unknown option $a" ;;
    *) POS+=("$a") ;;
  esac
done

STAGE=""
cleanup() { [ -n "$STAGE" ] && rm -rf "$STAGE"; STAGE=""; VDKIT_PASS=""; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

read_pass() {   # twice | once
  if [ "$PASS_STDIN" = 1 ]; then
    IFS= read -r VDKIT_PASS || true
    VDKIT_PASS="${VDKIT_PASS%$'\r'}"
  else
    [ -t 0 ] || die "no terminal to ask for the passphrase on (or --passphrase-stdin)"
    printf 'Passphrase (not shown): ' >&2; IFS= read -rs VDKIT_PASS; echo >&2
    if [ "$1" = twice ]; then
      local again; printf 'Again: ' >&2; IFS= read -rs again; echo >&2
      [ "$again" = "$VDKIT_PASS" ] || die "the two passphrases differ"
      again=""
    fi
  fi
  [ -n "$VDKIT_PASS" ] || die "an empty passphrase"
  if [ "$1" = twice ] && [ "${#VDKIT_PASS}" -lt 16 ]; then
    die "the passphrase must be 16 characters or more - five or six random words are best (written on paper, docs/deploy/EMERGENCY-KIT.md)"
  fi
  export VDKIT_PASS
}

narrow_acl() {   # a file or directory: only this Windows user
  if command -v icacls >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
    local g="${USERNAME:-$USER}:F"; [ -d "$1" ] && g="${USERNAME:-$USER}:(OI)(CI)F"
    icacls "$(cygpath -w "$1")" /inheritance:r /grant:r "$g" >/dev/null 2>&1 || say "WARNING: could not narrow the ACL of $1"
  fi
}

# Read three settings from a release env file, as lib.sh does (eval of the owner's own file).
env_values() {   # file -> SSH_KEY_FILE, SSH_KNOWN_HOSTS, ORIGIN_SECRET_DIR (one per line)
  ( set -a; SSH_KEY_FILE="" SSH_KNOWN_HOSTS="" ORIGIN_SECRET_DIR="" NAME=""
    eval "$(tr -d '\r' < "$1")" >/dev/null 2>&1 || true
    : "${NAME:=valuescan-test}"
    printf '%s\n%s\n%s\n' "${SSH_KEY_FILE:-$HOME/.ssh/$NAME.pem}" "${SSH_KNOWN_HOSTS:-$HOME/.ssh/$NAME.known_hosts}" "${ORIGIN_SECRET_DIR:-$HOME/.valuescan/$NAME}" )
}

MISSING=()
ITEMS=0
put() {   # source file, path inside the kit, required yes|no
  local src="$1" dst="$2"
  if [ ! -f "$src" ]; then
    [ "$3" = yes ] && MISSING+=("$src")
    return 0
  fi
  case "$dst" in *..*|/*) die "bad kit path $dst" ;; esac
  [ -e "$STAGE/kit/$dst" ] && return 0
  mkdir -p "$(dirname "$STAGE/kit/$dst")"
  cp -p "$src" "$STAGE/kit/$dst"
  local where="$src"; case "$src" in "$HOME"/*) where="~/${src#"$HOME"/}" ;; esac
  printf '%s\t%s\n' "$dst" "$where" >> "$STAGE/where"
  ITEMS=$((ITEMS + 1))
}

create() {
  [ -n "$OUT" ] || die "create --out=<dir> (a USB stick, e.g. /e/ValueDesk)"
  if [ -z "$FROM" ]; then
    if [ -d "$HOME/vs-coh/deploy/aws/ec2" ]; then FROM="$HOME/vs-coh"; else FROM="$ROOT"; fi
  fi
  [ -d "$FROM/deploy/aws/ec2" ] || die "--from=$FROM has no deploy/aws/ec2"
  case "$(printf '%s' "$OUT" | tr '[:upper:]' '[:lower:]')" in
    *onedrive*|*dropbox*|*google\ drive*|*icloud*) say "WARNING: $OUT looks like a synced folder - the bundle is encrypted, but a USB stick is the point" ;;
  esac
  mkdir -p "$OUT"
  # The passphrase first: nothing is gathered while the prompt waits.
  read_pass twice
  STAGE="$(mktemp -d)"
  chmod 700 "$STAGE"
  narrow_acl "$STAGE"
  mkdir -p "$STAGE/kit"
  : > "$STAGE/where"

  # 1. the release environments and their state (deploy/aws/ec2/*.env, .out/state.*.env)
  local f req
  for f in ec2.contabo.env ec2.contabo2.env; do put "$FROM/deploy/aws/ec2/$f" "repo/deploy/aws/ec2/$f" yes; done
  for f in state.contabo.env state.contabo2.env; do put "$FROM/deploy/aws/ec2/.out/$f" "repo/deploy/aws/ec2/.out/$f" yes; done
  for f in "$FROM"/deploy/aws/ec2/*.env; do [ -f "$f" ] && put "$f" "repo/deploy/aws/ec2/$(basename "$f")" no; done
  for f in "$FROM"/deploy/aws/ec2/.out/state.*.env; do [ -f "$f" ] && put "$f" "repo/deploy/aws/ec2/.out/$(basename "$f")" no; done
  put "$FROM/deploy/release/web.env" "repo/deploy/release/web.env" no
  [ -f "$FROM/deploy/release/web.env" ] || put "$ROOT/deploy/release/web.env" "repo/deploy/release/web.env" no

  # 2. what the env files point at: the ssh key, the known_hosts files, the origin secret
  local keys=() khs=() osd=()
  for f in "$FROM/deploy/aws/ec2/ec2.contabo.env" "$FROM/deploy/aws/ec2/ec2.contabo2.env"; do
    [ -f "$f" ] || continue
    local v; mapfile -t v < <(env_values "$f")
    keys+=("${v[0]}") khs+=("${v[1]}") osd+=("${v[2]}")
  done
  [ "${#keys[@]}" -gt 0 ] || keys=("$HOME/.ssh/valuescan-contabo")
  [ "${#osd[@]}" -gt 0 ] || osd=("$HOME/.valuescan/valuescan-test")
  for f in "${keys[@]}"; do put "$f" "ssh/$(basename "$f")" yes; put "$f.pub" "ssh/$(basename "$f").pub" no; done
  for f in "${khs[@]}"; do put "$f" "ssh/$(basename "$f")" no; done
  put "$HOME/.ssh/known_hosts" "ssh/known_hosts" no
  local d
  for d in "${osd[@]}"; do
    put "$d/origin-secret" "origin-secret/$(basename "$d")/origin-secret" yes
    for f in "$d"/origin-secret.*; do [ -f "$f" ] && put "$f" "origin-secret/$(basename "$d")/$(basename "$f")" no; done
  done

  # 3. the backup keys (the old ones too: copies made with them open only with them)
  local kd="${PULL_DEST:-$HOME/ValueDesk-backups}/keys"
  put "$kd/server1.backup.key" "backup-keys/server1.backup.key" yes
  put "$kd/server2.backup.key" "backup-keys/server2.backup.key" yes
  for f in "$kd"/*; do [ -f "$f" ] && put "$f" "backup-keys/$(basename "$f")" no; done

  # 4. the kek block, extras, the code
  if [ -n "$KEK" ]; then
    [ -f "$KEK" ] || die "--kek-block=$KEK does not exist"
    grep -q 'BEGIN VALUEDESK EXECUTOR SECRETS' "$KEK" || die "$KEK is not an executor-secrets.sh export block"
    put "$KEK" "executor/$(basename "$KEK")" yes
  else
    MISSING+=("the executor's kek block (--kek-block=<file>; without it, a lost server 2 means every follower registers a new key)")
  fi
  for f in ${ADD[@]+"${ADD[@]}"}; do [ -f "$f" ] || die "--add=$f does not exist"; put "$f" "extra/$(basename "$f")" yes; done
  if [ "$WITH_GIT" = 1 ]; then
    git -C "$FROM" bundle create "$STAGE/valuescan.bundle" main >/dev/null 2>&1 || die "git bundle failed in $FROM"
    put "$STAGE/valuescan.bundle" "code/valuescan.bundle" yes
    rm -f "$STAGE/valuescan.bundle"
  fi

  if [ "${#MISSING[@]}" -gt 0 ]; then
    printf 'emergency-kit: missing: %s\n' "${MISSING[@]}" >&2
    [ "$ALLOW_MISSING" = 1 ] || die "${#MISSING[@]} expected file(s) missing (above) - add them, or --allow-missing"
  fi

  # Where each file belongs, RESTORE.txt, then the manifest of all of it (sha256sum -c format).
  { echo "# kit path<TAB>where it belongs on the laptop (~ = the home directory; repo/ = the release worktree)"; cat "$STAGE/where"; } > "$STAGE/kit/WHERE.txt"
  local stamp name bundle
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  name="valuedesk-kit-$stamp.tar.enc"
  bundle="$OUT/$name"
  restore_txt "$name" > "$STAGE/restore"
  mv "$STAGE/restore" "$STAGE/kit/RESTORE.txt"
  ( cd "$STAGE/kit" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r p; do printf '%s  %s\n' "$(sha256sum "$p" | cut -c1-64)" "$p"; done ) > "$STAGE/manifest"
  mv "$STAGE/manifest" "$STAGE/kit/MANIFEST.sha256"

  tar -C "$STAGE" -cf - kit | openssl enc "${ENC[@]}" -salt -pass env:VDKIT_PASS -out "$bundle.partial"
  mv -f "$bundle.partial" "$bundle"
  ( cd "$OUT" && printf '%s  %s\n' "$(sha256sum "$name" | cut -c1-64)" "$name" > "$name.sha256" )
  # RESTORE.txt beside it: the same text, plus the bundle's checksum.
  { cat "$STAGE/kit/RESTORE.txt"; echo; echo "SHA-256 of $name: $(cut -c1-64 "$bundle.sha256")"; } > "$OUT/RESTORE.txt"
  cleanup_stage
  # Prove it opens with what was typed.
  if ! verify_bundle "$bundle" >/dev/null; then die "the new bundle does not open again - do not use it"; fi
  VDKIT_PASS=""
  say "wrote $bundle ($ITEMS files, $(wc -c < "$bundle" | tr -d ' ') bytes), $name.sha256 and RESTORE.txt (no secret) in $OUT"
  say "test it once: deploy/release/emergency-kit.sh verify $bundle   - then the second stick, and the envelope"
}
cleanup_stage() { [ -n "$STAGE" ] && rm -rf "$STAGE"; STAGE=""; }

restore_txt() {   # bundle name
  local p
  cat <<EOF
VALUEDESK EMERGENCY KIT - $1
Made $(date -u +'%Y-%m-%d %H:%M UTC') on $(hostname). THIS FILE HOLDS NO SECRET.

WHAT THIS IS
  $1 is an encrypted archive of everything that existed only on the owner's laptop and is
  needed to run, release or rebuild ValueDesk (two Contabo servers, the site on Vercel):
  the SSH key for both servers, the release settings, the origin secret, the backup keys
  and (if listed below) the executor's kek block. The passphrase is NOT in this kit: it is
  on paper, in a sealed envelope, with a trusted person.

WHAT IS INSIDE (file names only)
EOF
  ( cd "$STAGE/kit" && find . -type f | sed 's|^\./|  |' | LC_ALL=C sort )
  echo "  RESTORE.txt (this text)"
  echo "  MANIFEST.sha256 (the SHA-256 of every file above)"
  [ "${#MISSING[@]}" -gt 0 ] && { echo; echo "NOT IN THIS KIT (missing when it was made):"; for p in "${MISSING[@]}"; do echo "  $p"; done; }
  cat <<'EOF'

OPEN IT (any computer with OpenSSL 1.1.1 or newer and tar - Git for Windows has both,
Linux and macOS too; it asks for the passphrase):
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in <the .tar.enc file> -out kit.tar
  tar -xf kit.tar
  cd kit && sha256sum -c MANIFEST.sha256        (every line must say OK; macOS: shasum -a 256 -c)
A wrong passphrase gives "bad decrypt". Open it in a folder that is not synced (no OneDrive),
and delete kit.tar and the folder when done. With the repository at hand, the same in one step:
  deploy/release/emergency-kit.sh open <the .tar.enc file> <new folder>

PUT IT BACK (kit/WHERE.txt says where each file belongs)
  ssh/*            -> ~/.ssh/  (valuescan-contabo is the key for almalinux@161.97.154.121 and
                      almalinux@13.140.77.201; *.known_hosts pin the servers' host keys)
  repo/...         -> the release worktree (git clone https://github.com/MXer120/valuescan.git,
                      or from code/valuescan.bundle: git clone valuescan.bundle valuescan)
  origin-secret/<name>/ -> ~/.valuescan/<name>/   (ORIGIN_SECRET_DIR in the env files)
  backup-keys/*    -> ~/ValueDesk-backups/keys/
  executor/*       -> the kek block: on server 2 (or its replacement), as root:
                      bash /opt/valuescan/bin/executor-secrets.sh import < <block>  (its own passphrase)
Keep the files owner-only (Windows: right-click > Properties > Security; Linux: chmod 600).

REBUILD FROM NOTHING
  The servers still run: you only need ssh/ and repo/ - releases work as before
  (deploy/release/README.md). A server is gone: the repository's deploy/contabo/README.md,
  "Rebuilding a server from nothing", step by step; the data comes back from the other
  server's off-server copies (docs/deploy/BACKUPS.md, "Restore") with backup-keys/; on
  server 2 the kek block goes back FIRST, then executor.db. Every secret and how to replace
  it: docs/deploy/SECRETS.md (deploy/release/rotate.sh). If this kit may have been seen by
  someone else, rotate everything in it (docs/deploy/SECRETS.md, "After a leak").

NOT IN THIS KIT - the accounts (each needs its login and 2FA recovery codes):
  GitHub (MXer120/valuescan; repository secrets TELEGRAM_TOKEN, TELEGRAM_CHAT_ID),
  Vercel (the site; VALUESCAN_ORIGIN_SECRET), Contabo (both servers; the VNC console),
  the domain registrar (valuedesk.so), Telegram (@BotFather, the alert bot), SoSoValue and
  YouTube (API keys), the SoDEX builder account.

WHO TO CALL
EOF
  if [ "${#CONTACT[@]}" -gt 0 ]; then for p in "${CONTACT[@]}"; do echo "  $p"; done
  else echo "  (write here by hand: the owner, the person holding the envelope, a technical helper)"; fi
}

# Decrypt to a pipe and check every file against the manifest - nothing written to disk.
verify_bundle() {   # bundle -> prints "OK  <path>  <size>" lines; exit 1 on any mismatch
  local b="$1" out
  # One pass: tar hands each file to sha256sum (--to-command); the manifest itself is printed.
  out="$(openssl enc -d "${ENC[@]}" -pass env:VDKIT_PASS -in "$b" 2>/dev/null \
    | tar -xf - --to-command='if [ "$TAR_FILENAME" = kit/MANIFEST.sha256 ]; then sed "s/^/M /"; else printf "H %s %s %s\n" "$(sha256sum | cut -c1-64)" "$TAR_SIZE" "$TAR_FILENAME"; fi' 2>/dev/null)" \
    || { echo "emergency-kit: cannot open $b - wrong passphrase, or a damaged file" >&2; return 1; }
  local want got bad=0 n=0 line
  want="$(printf '%s\n' "$out" | sed -n 's/^M \([0-9a-f]\{64\}\)  \(.*\)$/\1 kit\/\2/p' | LC_ALL=C sort)"
  got="$(printf '%s\n' "$out" | sed -n 's/^H \([0-9a-f]\{64\}\) [0-9]* \(kit\/.*\)$/\1 \2/p' | grep -v ' kit/MANIFEST.sha256$' | LC_ALL=C sort)"
  [ -n "$want" ] || { echo "emergency-kit: no manifest in $b" >&2; return 1; }
  while IFS= read -r line; do
    n=$((n + 1))
    local h="${line%% *}" p="${line#* }"
    if printf '%s\n' "$got" | grep -qxF "$h $p"; then
      printf 'OK       %s  (%s bytes)\n' "${p#kit/}" "$(printf '%s\n' "$out" | sed -n "s|^H $h \([0-9]*\) $p\$|\1|p" | head -n 1)"
    else
      printf 'DAMAGED  %s\n' "${p#kit/}"; bad=1
    fi
  done <<< "$want"
  [ "$(printf '%s\n' "$got" | grep -c .)" = "$n" ] || { echo "emergency-kit: files in the bundle that the manifest does not list" >&2; bad=1; }
  return "$bad"
}

case "$cmd" in
  create)
    [ "${#POS[@]}" = 0 ] || die "create takes options only"
    create ;;
  verify)
    [ "${#POS[@]}" = 1 ] || die "verify <bundle>"
    [ -f "${POS[0]}" ] || die "${POS[0]} does not exist"
    # The checksum beside it catches any changed byte (the tar's padding included, which the
    # manifest inside cannot see: openssl enc has no authentication tag).
    if [ -f "${POS[0]}.sha256" ]; then
      [ "$(sha256sum "${POS[0]}" | cut -c1-64)" = "$(cut -c1-64 "${POS[0]}.sha256")" ] || die "${POS[0]} does not match ${POS[0]}.sha256 - the file changed (use the other stick)"
      say "the bundle matches its .sha256"
    else
      say "no ${POS[0]}.sha256 beside it - checking the contents only"
    fi
    read_pass once
    verify_bundle "${POS[0]}" || die "verify FAILED"
    say "every file matches the manifest" ;;
  open)
    [ "${#POS[@]}" = 2 ] || die "open <bundle> <dir>"
    b="${POS[0]}" dir="${POS[1]}"
    [ -f "$b" ] || die "$b does not exist"
    if [ -f "$b.sha256" ] && [ "$(sha256sum "$b" | cut -c1-64)" != "$(cut -c1-64 "$b.sha256")" ]; then
      die "$b does not match $b.sha256 - the file changed (use the other stick)"
    fi
    if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then die "$dir is not empty - name a new folder"; fi
    case "$(printf '%s' "$dir" | tr '[:upper:]' '[:lower:]')" in *onedrive*|*dropbox*) die "$dir is a synced folder - open the kit somewhere that is not synced" ;; esac
    read_pass once
    ( umask 077; mkdir -p "$dir" )
    chmod 700 "$dir"
    narrow_acl "$dir"
    if ! openssl enc -d "${ENC[@]}" -pass env:VDKIT_PASS -in "$b" 2>/dev/null | ( umask 077; tar -xf - -C "$dir" ) 2>/dev/null; then
      rm -rf "$dir"; die "cannot open $b - wrong passphrase, or a damaged file (nothing kept)"
    fi
    VDKIT_PASS=""
    ( cd "$dir/kit" && sha256sum -c --quiet MANIFEST.sha256 ) || die "some files do not match the manifest (above)"
    say "opened into $dir/kit - every file matches the manifest. Where each one goes: $dir/kit/WHERE.txt"
    say "delete $dir when you are done with it" ;;
  *) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
