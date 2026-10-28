#!/usr/bin/env bash
# The server half of a secret rotation. deploy/release/rotate.sh (on the laptop) calls these
# over ssh, in the right order, and stops at the first that fails; the whole picture, and
# what users notice, is docs/deploy/SECRETS.md. Run as root (sudo). Never prints a secret:
# keys are named by an id (16 hex of SHA-256 over a fixed label and the key) or, for key
# pairs, by their PUBLIC half. Secrets arrive on stdin, never on the command line.
#
#   status                                   every secret file here: present, mode, owner, id, old copies kept
#
#   executor-session | executor-import       (server 2) stop the executor, a new session.key / import.key
#                                            (tools/rotate-key.ts: old kept as *.old-<stamp>, audit row),
#                                            start, health
#   executor-kek [--kek-from=<file>]         (server 2) stop, tools/rotate-kek.ts rotate (every sealed key
#                                            again, one transaction), start, health, tools/rotate-kek.ts check;
#                                            --kek-from=<dir>/kek.old-<stamp> undoes a rotation
#   executor-kek-check                       every sealed key opens under the kek in force (read-only)
#
#   folders-session | feedback-session       (server 1) a new 32-byte session.key for the knowledge folders
#                                            / the feedback chats; restart the API, health
#
#   terms-key new | finish | abort           (server 1) the builder terms key: `new` makes builder-terms.key.next
#                                            and prints its PUBLIC key (pin it in the web build first);
#                                            `finish` puts it in force (the API reads it within seconds) and
#                                            checks the terms come signed by it
#
#   backup-key id | rotate                   this server's off-server backup key: `rotate` keeps the old one as
#                                            backup.key.old-<stamp> (copies made with it open only with it),
#                                            makes a new one, pushes one set with it
#
#   offsite-ssh new | test-new | finish | abort    (the sending server) the ssh key the copies travel with
#   offsite-receiver add --from=<ip>               (the receiving server) its PUBLIC line on stdin: allowed
#                                                  beside the one in place (offsite-setup.sh receiver then
#                                                  keeps only the new one)
#   ledger-pull new | old-pub | test-new | finish | abort   (server 2) the key that pulls builder.db from server 1
#
#   authorized list --user=<u>
#   authorized add --user=<u> [--like=<text>]      a PUBLIC key line on stdin into ~u/.ssh/authorized_keys;
#                                                  --like copies the options (from=, command=, restrict...) of
#                                                  the line that contains <text> (the ledger pull: builder-snapshot.sh)
#   authorized remove --user=<u> [--like=<text>]   stdin: line 1 the key to remove, line 2 (optional) a key that
#                                                  must remain. Refuses to leave no unrestricted key (no lock-out),
#                                                  and to remove a forced-command line without --like
#
#   restore <file>.old-<stamp>               put an old copy back (the current file is kept as
#                                            *.rolledback-<stamp>), with the stop/start it needs. Not the kek:
#                                            executor-kek --kek-from=<kek.old-file> re-seals the keys
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${NODE:-${NODE_BIN_DIR:-/opt/node/current/bin}/node}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
CURL="${CURL:-curl}"
ETC_DIR="${ETC_DIR:-/etc/valuescan}"
EXECUTOR_DATA_DIR="${EXECUTOR_DATA_DIR:-/var/lib/valuescan/executor}"
EXECUTOR_APP="${EXECUTOR_APP:-/opt/valuescan/current/apps/executor}"
EXECUTOR_USER="${EXECUTOR_USER:-valuescan-executor}"
EXECUTOR_HERE_FILE="${EXECUTOR_HERE_FILE:-$ETC_DIR/executor-here}"
EXECUTOR_URL="${EXECUTOR_URL:-http://127.0.0.1:8799}"
API_URL="${API_URL:-http://127.0.0.1:8797}"
STATE_DIR="${STATE_DIR:-/var/lib/valuescan/state}"
FOLDERS_DIR="${FOLDERS_DIR:-$STATE_DIR/folders}"
FEEDBACK_AUTH_DIR="${FEEDBACK_AUTH_DIR:-$STATE_DIR/feedback-auth}"
API_USER="${API_USER:-valuescan}"
OFFSITE_DIR="${OFFSITE_DIR:-$ETC_DIR/offsite}"
OFFSITE_CONF="${OFFSITE_CONF:-$ETC_DIR/offsite.env}"
LEDGER_KEY="${LEDGER_KEY:-/root/.ssh/ledger_pull}"
LEDGER_HOST="${LEDGER_HOST:-161.97.154.121}"
LEDGER_USER="${LEDGER_USER:-almalinux}"
HEALTH_WAIT="${HEALTH_WAIT:-60}"
BACKUP_OFFSITE="${BACKUP_OFFSITE:-$HERE/backup-offsite.sh}"
OFFSITE_SETUP="${OFFSITE_SETUP:-$HERE/offsite-setup.sh}"
# setpriv: as the file's owner (production); self: as whoever runs this (the tests).
ROTATE_AS="${ROTATE_AS:-setpriv}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

die() { printf 'rotate-secret: %s\n' "$*" >&2; exit 1; }
say() { printf 'rotate-secret: %s\n' "$*" >&2; }
# This machine's short name for key comments. Not every system has `hostname` (the
# Vercel build that runs the tests has none): /etc/hostname, then the kernel's, then "server".
short_host() {
  local h
  h="$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || true)"
  h="${h%%.*}"
  printf '%s' "${h:-server}"
}
journal() { command -v logger >/dev/null 2>&1 && logger -t valuescan-rotate -- "$*" 2>/dev/null || true; }

[ "$(id -u)" = 0 ] || [ "${ROTATE_ALLOW_NONROOT:-0}" = 1 ] || die "run as root (sudo)"
umask 077

as_user() {   # user, command...
  local u="$1"; shift
  if [ "$ROTATE_AS" = setpriv ] && [ "$(id -u)" = 0 ]; then
    setpriv --reuid="$u" --regid="$(id -gn "$u")" --init-groups -- "$@"
  else
    "$@"
  fi
}
own_like() {   # file, reference file: owner and group of the reference, mode 0600
  chmod 0600 "$1"
  [ "$(id -u)" = 0 ] && chown --reference="$2" "$1" || true
}
# The id of a secret file: the same as apps/executor/src/rotation.ts secretId.
secret_id() { { printf 'valuedesk-secret-id\0'; cat "$1"; } | sha256sum | cut -c1-16; }
pub_of() { ssh-keygen -y -f "$1" 2>/dev/null; }   # the PUBLIC line of an ssh private key
fp_of_line() { local t; t="$(mktemp)"; printf '%s\n' "$1" > "$t"; ssh-keygen -lf "$t" | awk '{print $2}'; rm -f "$t"; }

wait_ok() {   # url, seconds
  local i
  for ((i = 0; i < $2; i++)); do
    if "$CURL" -fsS --max-time 3 "$1" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    sleep 1
  done
  return 1
}

# A key line (public): "<type> <base64> [comment]". Prints "type blob" or fails.
KEYRE='(^|[[:space:]])(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)[[:space:]]+([A-Za-z0-9+/]+={0,3})([[:space:]]|$)'
blob_of() { [[ "$1" =~ $KEYRE ]] || return 1; printf '%s' "${BASH_REMATCH[3]}"; }
options_of() {   # everything in front of the key type
  [[ "$1" =~ $KEYRE ]] || return 1
  local pre="${1%%"${BASH_REMATCH[0]}"*}"
  printf '%s' "$pre"
}
read_pub_line() {   # one PUBLIC key line from stdin, checked
  local l
  IFS= read -r l || true
  l="$(printf '%s' "$l" | tr -d '\r')"
  local re='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]{60,}={0,3}( [[:print:]]*)?$'
  [[ "$l" =~ $re ]] || die "expected one public key line (ssh-ed25519 AAAA... comment) on stdin"
  case "$l" in *\"*|*\\*|*\`*) die "a public key line with quotes or backslashes is refused" ;; esac
  printf '%s' "$l"
}

# --- the executor (server 2) -----------------------------------------------------------------------
executor_here() {
  [ -e "$EXECUTOR_HERE_FILE" ] || die "$EXECUTOR_HERE_FILE does not exist: the executor does not run on this server (server 2 runs it)"
  [ -f "$EXECUTOR_DATA_DIR/executor.db" ] || die "$EXECUTOR_DATA_DIR/executor.db does not exist"
}
network() { local n; n="$(sed -n 's/^SODEX_NETWORK=//p' "$ETC_DIR/executor.env" 2>/dev/null | tr -d '\r' | tail -n 1)"; [ "$n" = testnet ] && echo testnet || echo mainnet; }
exec_tool() {   # tool, args...  (as the executor's user, from its app directory)
  local tool="$1"; shift
  ( cd "$EXECUTOR_APP" && as_user "$EXECUTOR_USER" env EXECUTOR_DATA_DIR="$EXECUTOR_DATA_DIR" SODEX_NETWORK="$(network)" \
      "$NODE" --disable-warning=ExperimentalWarning --import tsx "tools/$tool" "$@" --dir "$EXECUTOR_DATA_DIR" )
}
EXEC_WAS_ACTIVE=0
executor_stop() {
  if "$SYSTEMCTL" is-active -q valuescan-executor; then EXEC_WAS_ACTIVE=1; fi
  say "stopping the executor (copies catch up after the start; algos resume their schedule)"
  "$SYSTEMCTL" stop valuescan-executor
}
executor_start() {   # what to say if it is not healthy
  if [ "$EXEC_WAS_ACTIVE" != 1 ]; then
    say "the executor was not running before - left stopped (start it: systemctl start valuescan-executor)"
    return 0
  fi
  "$SYSTEMCTL" start valuescan-executor
  if ! wait_ok "$EXECUTOR_URL/api/copy/v1/health" "$HEALTH_WAIT"; then
    die "the executor does not answer $EXECUTOR_URL/api/copy/v1/health after the rotation - journalctl --namespace=pii -u valuescan-executor -n 80. ROLL BACK: $1"
  fi
  say "the executor is up and answers its health check"
}

executor_keyfile() {   # session | import
  executor_here
  local name; name="$([ "$1" = session ] && echo session.key || echo import.key)"
  executor_stop
  local out
  if ! out="$(exec_tool rotate-key.ts "$1")"; then
    [ "$EXEC_WAS_ACTIVE" = 1 ] && "$SYSTEMCTL" start valuescan-executor
    die "rotate-key.ts $1 failed (above) - nothing was replaced; the executor runs as before"
  fi
  printf '%s\n' "$out"
  local old; old="$(ls -1t "$EXECUTOR_DATA_DIR/$name".old-* 2>/dev/null | head -n 1)"
  journal "executor $name rotated"
  executor_start "sudo bash $HERE/rotate-secret.sh restore $old"
  if [ "$1" = session ]; then say "every follower's dashboard session ended: they sign once more (copies and algos run on)"; fi
  say "once all is well: sudo rm $old"
}

executor_kek() {
  executor_here
  local from=""
  for a in "$@"; do case "$a" in --kek-from=*) from="${a#--kek-from=}" ;; *) die "unknown argument $a" ;; esac; done
  if [ -n "$from" ]; then
    case "$from" in "$EXECUTOR_DATA_DIR"/kek.old-*) ;; *) die "--kek-from must be a $EXECUTOR_DATA_DIR/kek.old-<stamp> file" ;; esac
    [ -f "$from" ] || die "$from does not exist"
  fi
  # Before anything stops: every key must open under the kek in force (read-only check).
  exec_tool rotate-kek.ts check >&2 || die "not every sealed key opens under the kek in force - nothing was changed; look first (rotate-kek.ts check)"
  executor_stop
  local out args=(rotate)
  [ -n "$from" ] && args+=(--kek-from "$from")
  if ! out="$(exec_tool rotate-kek.ts "${args[@]}")"; then
    [ "$EXEC_WAS_ACTIVE" = 1 ] && "$SYSTEMCTL" start valuescan-executor
    die "rotate-kek.ts failed (above). The tool changes nothing unless every key is sealed again and checked; the executor was started again"
  fi
  printf '%s\n' "$out"
  local old; old="$(ls -1t "$EXECUTOR_DATA_DIR"/kek.old-* 2>/dev/null | head -n 1)"
  journal "executor kek rotated (old kept as $(basename "$old"))"
  executor_start "sudo bash $HERE/rotate-secret.sh executor-kek --kek-from=$old"
  exec_tool rotate-kek.ts check || die "after the start not every key opens under the new kek - ROLL BACK: sudo bash $HERE/rotate-secret.sh executor-kek --kek-from=$old"
  say "KEEP $old until no executor.db backup from before $STAMP is left (local: 7 nights, off-server: 30 days)"
  say "NOW make a new offline kek block: sudo bash $HERE/executor-secrets.sh export (the old block holds the old kek - keep it as long as $old)"
}

# --- server 1 session keys ------------------------------------------------------------------------
api_keyfile() {   # dir, what
  local dir="$1" what="$2" f="$1/session.key"
  [ -f "$f" ] || die "$f does not exist - the API makes it on first use; nothing to rotate"
  local id_old; id_old="$(secret_id "$f")"
  rm -f "$f.new"
  head -c 32 /dev/urandom > "$f.new"
  [ "$(stat -c %s "$f.new")" = 32 ] || die "could not make 32 random bytes"
  own_like "$f.new" "$f"
  cp -p "$f" "$f.old-$STAMP"
  mv -f "$f.new" "$f"
  say "$f replaced ($id_old -> $(secret_id "$f")); the old one is $f.old-$STAMP"
  journal "$what session.key rotated"
  "$SYSTEMCTL" restart valuescan-api
  wait_ok "$API_URL/api/health" "$HEALTH_WAIT" || die "the API does not answer $API_URL/api/health after the restart - journalctl --namespace=pii -u valuescan-api -n 80. ROLL BACK: sudo bash $HERE/rotate-secret.sh restore $f.old-$STAMP"
  say "the API is up; every $what sign-in ended - they sign once more. Once all is well: sudo rm $f.old-$STAMP"
}

# --- the builder terms key (server 1) ---------------------------------------------------------------
TERMS="$STATE_DIR/builder-terms.key"
terms_pub() {   # file -> "<publicKey> <keyId>" (public)
  "$NODE" -e '
    const c = require("node:crypto");
    const x = c.createPublicKey(c.createPrivateKey(require("node:fs").readFileSync(process.argv[1], "utf8"))).export({ format: "jwk" }).x;
    console.log(x + " " + c.createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex").slice(0, 8));
  ' "$1"
}
terms_key() {
  case "${1:-}" in
    new)
      [ -f "$TERMS" ] || die "$TERMS does not exist"
      [ ! -f "$TERMS.next" ] || die "$TERMS.next exists: a rotation is under way - finish or abort it"
      as_user "$API_USER" "$NODE" -e '
        const c = require("node:crypto");
        const { privateKey } = c.generateKeyPairSync("ed25519");
        require("node:fs").writeFileSync(process.argv[1], privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
      ' "$TERMS.next"
      own_like "$TERMS.next" "$TERMS"
      read -r pub_old id_old < <(terms_pub "$TERMS")
      read -r pub_new id_new < <(terms_pub "$TERMS.next")
      say "in force: keyId $id_old; the next one: keyId $id_new (public keys below - not secrets)"
      printf 'current %s %s\nnext %s %s\n' "$pub_old" "$id_old" "$pub_new" "$id_new"
      journal "builder terms key: next key $id_new made"
      ;;
    finish)
      [ -f "$TERMS.next" ] || die "there is no $TERMS.next - run terms-key new first"
      read -r _ id_new < <(terms_pub "$TERMS.next")
      cp -p "$TERMS" "$TERMS.old-$STAMP"
      mv -f "$TERMS.next" "$TERMS"
      journal "builder terms key: $id_new in force"
      say "$id_new is in force; the old key is $TERMS.old-$STAMP"
      local secret="" got="" i
      secret="$(sed -n 's/^VALUESCAN_ORIGIN_SECRET=//p' "$ETC_DIR/api.secret.env" 2>/dev/null | tr -d '\r' | tail -n 1 | cut -d, -f1)"
      for ((i = 0; i < HEALTH_WAIT; i++)); do
        got="$("$CURL" -fsS --max-time 3 -H @<(printf 'x-origin-verify: %s\n' "$secret") "$API_URL/api/vs/builder/terms?address=0x0000000000000000000000000000000000000001&nonce=rotationcheck$STAMP" 2>/dev/null \
          | sed -n 's/.*"keyId":"\([0-9a-f]\{8\}\)".*/\1/p')" || true
        [ "$got" = "$id_new" ] && break
        sleep 1
      done
      secret=""
      [ "$got" = "$id_new" ] || die "the API's terms do not come signed by $id_new (they say: ${got:-nothing}) - ROLL BACK: sudo bash $HERE/rotate-secret.sh restore $TERMS.old-$STAMP"
      say "the API signs terms with $id_new. Delete $TERMS.old-$STAMP once the web build pins only the new key"
      ;;
    abort)
      rm -f "$TERMS.next"; say "no rotation under way any more" ;;
    *) die "terms-key new | finish | abort" ;;
  esac
}

# --- the backup key ---------------------------------------------------------------------------------
backup_key() {
  local k="$OFFSITE_DIR/backup.key"
  [ -f "$k" ] || die "$k does not exist (offsite-setup.sh sender makes it)"
  case "${1:-}" in
    id) "$NODE" "$HERE/backup-crypt.mjs" id "$k" ;;
    rotate)
      local old_id new_id set_
      old_id="$("$NODE" "$HERE/backup-crypt.mjs" id "$k")"
      rm -f "$k.new"
      new_id="$("$NODE" "$HERE/backup-crypt.mjs" keygen "$k.new")"
      own_like "$k.new" "$k"
      cp -p "$k" "$k.old-$STAMP"
      mv -f "$k.new" "$k"
      journal "backup key rotated: $old_id -> $new_id"
      say "backup key $old_id -> $new_id; the old one is $k.old-$STAMP (copies made with it open only with it)"
      # shellcheck disable=SC1090
      [ -f "$OFFSITE_CONF" ] && . "$OFFSITE_CONF"
      set_="${OFFSITE_SETS%% *}"
      [ -n "$set_" ] || die "OFFSITE_SETS is empty ($OFFSITE_CONF): cannot test the new key"
      "$BACKUP_OFFSITE" push "$set_" >&2 || die "a copy with the new key failed - ROLL BACK: sudo bash $HERE/rotate-secret.sh restore $k.old-$STAMP"
      say "one $set_ copy went out with the new key"
      printf 'old %s\nnew %s\n' "$old_id" "$new_id"
      ;;
    *) die "backup-key id | rotate" ;;
  esac
}

# --- ssh key pairs between the servers -----------------------------------------------------------------
keypair() {   # path, comment, step
  local k="$1" comment="$2" step="$3"
  case "$step" in
    new)
      [ -f "$k" ] || die "$k does not exist - nothing to rotate (set it up first)"
      rm -f "$k.new" "$k.new.pub"
      ssh-keygen -q -t ed25519 -N '' -C "$comment-$STAMP" -f "$k.new"
      chmod 0600 "$k.new"
      say "made $k.new; its PUBLIC line:"
      cat "$k.new.pub"
      ;;
    old-pub) pub_of "$k" ;;
    finish)
      [ -f "$k.new" ] || die "there is no $k.new - run new first"
      cp -p "$k" "$k.old-$STAMP"
      [ -f "$k.pub" ] && cp -p "$k.pub" "$k.old-$STAMP.pub"
      mv -f "$k.new" "$k"
      mv -f "$k.new.pub" "$k.pub"
      journal "$k rotated (old kept as $k.old-$STAMP)"
      say "$k is the new key; the old one is $k.old-$STAMP"
      ;;
    abort) rm -f "$k.new" "$k.new.pub"; say "removed $k.new" ;;
    *) die "new | old-pub | test-new | finish | abort" ;;
  esac
}
offsite_ssh() {
  local k="$OFFSITE_DIR/id_ed25519"
  if [ "${1:-}" = test-new ]; then
    [ -f "$k.new" ] || die "there is no $k.new"
    # shellcheck disable=SC1090
    . "$OFFSITE_CONF"
    ssh -i "$k.new" -o IdentitiesOnly=yes -o BatchMode=yes -o "UserKnownHostsFile=$OFFSITE_DIR/known_hosts" -o StrictHostKeyChecking=yes \
      -o ConnectTimeout=20 -o LogLevel=ERROR "${OFFSITE_USER:-vsbackup}@$OFFSITE_HOST" "list ${OFFSITE_SETS%% *}" >/dev/null \
      || die "the new key is not accepted by ${OFFSITE_USER:-vsbackup}@$OFFSITE_HOST yet (offsite-receiver add there first)"
    say "the new key works for ${OFFSITE_USER:-vsbackup}@$OFFSITE_HOST"
    return
  fi
  keypair "$k" "valuedesk-offsite@$(short_host)" "${1:-}"
  if [ "${1:-}" = finish ]; then
    "$OFFSITE_SETUP" test >&2 || die "the test copy with the new key failed - ROLL BACK: sudo bash $HERE/rotate-secret.sh restore $k.old-$STAMP"
  fi
}
ledger_pull() {
  if [ "${1:-}" = test-new ]; then
    [ -f "$LEDGER_KEY.new" ] || die "there is no $LEDGER_KEY.new"
    local t; t="$(mktemp -d)"
    if ssh -i "$LEDGER_KEY.new" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 -o LogLevel=ERROR "$LEDGER_USER@$LEDGER_HOST" > "$t/db" \
      && [ "$(head -c 15 "$t/db")" = "SQLite format 3" ]; then
      rm -rf "$t"; say "the new key pulls the ledger from $LEDGER_HOST"; return 0
    fi
    rm -rf "$t"
    die "the new key does not pull the ledger from $LEDGER_HOST yet (authorized add --like=builder-snapshot.sh there first)"
  fi
  keypair "$LEDGER_KEY" "valuedesk-ledger-pull@$(short_host)" "${1:-}"
  if [ "${1:-}" = finish ]; then
    "$SYSTEMCTL" start valuescan-ledger-pull.service || die "the ledger pull with the new key failed - ROLL BACK: sudo bash $HERE/rotate-secret.sh restore $LEDGER_KEY.old-$STAMP"
    say "valuescan-ledger-pull.service ran with the new key"
  fi
}

# --- authorized_keys ---------------------------------------------------------------------------------
ak_file() {   # user
  if [ -n "${AUTH_KEYS_FILE:-}" ]; then printf '%s' "$AUTH_KEYS_FILE"; return; fi
  local home; home="$(getent passwd "$1" | cut -d: -f6)"
  [ -n "$home" ] || die "no user $1"
  printf '%s/.ssh/authorized_keys' "$home"
}
ak_write() {   # file, new content file
  local f="$1" n="$2"
  cp -p "$f" "$f.bak-$STAMP"
  if [ "$(id -u)" = 0 ]; then chown --reference="$f" "$n"; fi
  chmod 0600 "$n"
  mv -f "$n" "$f"
  command -v restorecon >/dev/null 2>&1 && restorecon "$f" 2>/dev/null || true
}
authorized() {
  local step="${1:-}"; shift || true
  local user="" like=""
  for a in "$@"; do
    case "$a" in --user=*) user="${a#--user=}" ;; --like=*) like="${a#--like=}" ;; *) die "unknown argument $a" ;; esac
  done
  [[ "$user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "--user=<name>"
  local f; f="$(ak_file "$user")"
  [ -f "$f" ] || die "$f does not exist"
  case "$step" in
    list)
      local line
      while IFS= read -r line || [ -n "$line" ]; do
        [ -n "$line" ] && [ "${line#\#}" = "$line" ] || continue
        printf '%s  %s\n' "$(fp_of_line "$line")" "$( [[ "$line" == *command=* ]] && echo "forced command: $(printf '%s' "$line" | sed -n 's/.*command="\([^"]*\)".*/\1/p')" || echo "login")"
      done < "$f"
      ;;
    add)
      local pub blob opts=""; pub="$(read_pub_line)"; blob="$(blob_of "$pub")"
      if grep -qF " $blob" "$f"; then say "that key is in $f already"; return 0; fi
      if [ -n "$like" ]; then
        local n; n="$(grep -cF -- "$like" "$f" || true)"
        [ "$n" -ge 1 ] || die "no line in $f contains '$like' - nothing to copy the options from"
        opts="$(options_of "$(grep -F -- "$like" "$f" | head -n 1)")"
        [[ "$opts" == *"$like"* ]] || die "'$like' is not in the options of that line"
      fi
      local t; t="$(mktemp "$f.XXXXXX")"
      cat "$f" > "$t"
      [ -z "$(tail -c 1 "$f")" ] || echo >> "$t"
      printf '%s%s\n' "${opts:+$opts }" "$pub" >> "$t"
      ak_write "$f" "$t"
      say "added $(fp_of_line "$pub") to $f$([ -n "$like" ] && echo " (with the options of the '$like' line)")"
      ;;
    remove)
      local gone keep="" gblob kblob=""
      gone="$(read_pub_line)"; gblob="$(blob_of "$gone")"
      if IFS= read -r keep && [ -n "$(printf '%s' "$keep" | tr -d '\r')" ]; then
        keep="$(printf '%s' "$keep" | tr -d '\r')"; kblob="$(blob_of "$keep")" || die "line 2 is not a public key line"
      fi
      [ "$gblob" != "$kblob" ] || die "the key to remove and the key to keep are the same"
      local t line hit=0 free=0 kept=0
      t="$(mktemp "$f.XXXXXX")"
      while IFS= read -r line || [ -n "$line" ]; do
        local b=""; b="$(blob_of "$line" 2>/dev/null)" || b=""
        if [ -n "$b" ] && [ "$b" = "$gblob" ]; then
          if [[ "$(options_of "$line")" == *command=* ]] && { [ -z "$like" ] || [[ "$(options_of "$line")" != *"$like"* ]]; }; then
            rm -f "$t"; die "that key is a forced-command line (not a login): name it with --like=<text of its command>"
          fi
          if [ -n "$like" ] && [[ "$(options_of "$line")" != *"$like"* ]]; then
            rm -f "$t"; die "that key's line does not contain '$like' - not removed"
          fi
          hit=$((hit + 1)); continue
        fi
        printf '%s\n' "$line" >> "$t"
        if [ -n "$b" ] && [[ "$(options_of "$line")" != *command=* ]]; then free=$((free + 1)); fi
        if [ -n "$kblob" ] && [ "$b" = "$kblob" ]; then kept=1; fi
      done < "$f"
      if [ "$hit" = 0 ]; then rm -f "$t"; say "that key is not in $f - nothing removed"; return 0; fi
      if [ -n "$kblob" ] && [ "$kept" != 1 ]; then rm -f "$t"; die "the key that must remain is not in $f - nothing removed"; fi
      if [ -z "$like" ] && [ "$free" = 0 ]; then rm -f "$t"; die "removing it would leave $f without any login key - nothing removed (that would lock everybody out)"; fi
      ak_write "$f" "$t"
      say "removed $(fp_of_line "$gone") from $f ($hit line(s)); $free login key(s) remain; the file before is $f.bak-$STAMP"
      ;;
    *) die "authorized list | add | remove" ;;
  esac
}

offsite_receiver() {
  [ "${1:-}" = add ] || die "offsite-receiver add --from=<ip>"
  local from="${2:-}"; from="${from#--from=}"
  [[ "$from" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "--from=<the sending server's IPv4 address>"
  local pub; pub="$(read_pub_line)"
  local f="${AUTH_KEYS_FILE:-/home/vsbackup/.ssh/authorized_keys}"
  [ -f "$f" ] || die "$f does not exist (offsite-setup.sh receiver first)"
  if grep -qF " $(blob_of "$pub")" "$f"; then say "the key is in place already"; return 0; fi
  local t; t="$(mktemp "$f.XXXXXX")"
  cat "$f" > "$t"
  printf 'restrict,from="%s",command="/opt/valuescan/bin/backup-receive.sh" %s\n' "$from" "$pub" >> "$t"
  ak_write "$f" "$t"
  say "vsbackup accepts the new key from $from beside the old one (offsite-setup.sh receiver --from=$from --pubkey='<new line>' keeps only the new one)"
}

# --- put an old copy back --------------------------------------------------------------------------------
restore() {
  local old="${1:-}"
  [[ "$old" == *.old-[0-9]*Z || "$old" == *.old-[0-9]*Z-[0-9]* ]] || die "restore <file>.old-<stamp>"
  [ -f "$old" ] || die "$old does not exist"
  local target="${old%.old-*}" svc="" url=""
  case "$target" in
    "$EXECUTOR_DATA_DIR/kek") die "not the kek: sudo bash $HERE/rotate-secret.sh executor-kek --kek-from=$old (the keys must be sealed again)" ;;
    "$EXECUTOR_DATA_DIR/session.key"|"$EXECUTOR_DATA_DIR/import.key") svc=valuescan-executor url="$EXECUTOR_URL/api/copy/v1/health" ;;
    "$FOLDERS_DIR/session.key"|"$FEEDBACK_AUTH_DIR/session.key") svc=valuescan-api url="$API_URL/api/health" ;;
    "$TERMS"|"$OFFSITE_DIR/backup.key") ;;
    "$OFFSITE_DIR/id_ed25519"|"$LEDGER_KEY") ;;
    *) die "$old is not one of the files this script rotates" ;;
  esac
  [ -n "$svc" ] && "$SYSTEMCTL" stop "$svc"
  if [ -f "$target" ]; then mv -f "$target" "$target.rolledback-$STAMP"; fi
  cp -p "$old" "$target"
  [ -f "$old.pub" ] && { [ -f "$target.pub" ] && mv -f "$target.pub" "$target.rolledback-$STAMP.pub"; cp -p "$old.pub" "$target.pub"; }
  journal "restored $target from $(basename "$old")"
  say "$target is the old one again (the one replaced: $target.rolledback-$STAMP)"
  if [ -n "$svc" ]; then
    "$SYSTEMCTL" start "$svc"
    wait_ok "$url" "$HEALTH_WAIT" || die "$svc does not answer its health check - journalctl --namespace=pii -u $svc -n 80"
    say "$svc is up"
  fi
}

status() {
  local f
  for f in "$EXECUTOR_DATA_DIR/kek" "$EXECUTOR_DATA_DIR/session.key" "$EXECUTOR_DATA_DIR/import.key" \
           "$FOLDERS_DIR/session.key" "$FEEDBACK_AUTH_DIR/session.key" "$TERMS" "$OFFSITE_DIR/backup.key" \
           "$OFFSITE_DIR/id_ed25519" "$LEDGER_KEY" "$ETC_DIR/alert.env" "$ETC_DIR/api.secret.env"; do
    [ -e "$f" ] || continue
    printf '%-52s %s %s  id %s\n' "$f" "$(stat -c '%a %U:%G' "$f")" "$(date -u -d "@$(stat -c %Y "$f")" +%F 2>/dev/null || echo '?')" "$(secret_id "$f")"
    ls -1 "$f".old-* "$f".next "$f".new 2>/dev/null | grep -v '\.pub$' | sed 's/^/    kept: /' || true
  done
}

cmd="${1:-}"; shift || true
case "$cmd" in
  status) status ;;
  executor-session) executor_keyfile session ;;
  executor-import) executor_keyfile import ;;
  executor-kek) executor_kek "$@" ;;
  executor-kek-check) executor_here; exec_tool rotate-kek.ts check ;;
  folders-session) api_keyfile "$FOLDERS_DIR" "knowledge folders" ;;
  feedback-session) api_keyfile "$FEEDBACK_AUTH_DIR" "feedback chat" ;;
  terms-key) terms_key "${1:-}" ;;
  backup-key) backup_key "${1:-}" ;;
  offsite-ssh) offsite_ssh "${1:-}" ;;
  offsite-receiver) offsite_receiver "$@" ;;
  ledger-pull) ledger_pull "${1:-}" ;;
  authorized) authorized "$@" ;;
  restore) restore "${1:-}" ;;
  *) sed -n '2,47p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
