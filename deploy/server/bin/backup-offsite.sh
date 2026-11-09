#!/usr/bin/env bash
# /opt/valuescan/bin/backup-offsite.sh - copy this server's state, ENCRYPTED, to the
# other server. Until 2026-10 every backup sat on the disk it protects; a lost disk or
# a cancelled VPS took the backups with it.
#
#   backup-offsite.sh run          every set of OFFSITE_SETS whose turn it is (valuescan-offsite.timer,
#                                  every 15 minutes)
#   backup-offsite.sh push <set>   one set now, changed or not, whatever the hour
#   backup-offsite.sh status       the last copy of each set (the markers)
#
# THE SETS (which server sends which: OFFSITE_SETS in /etc/valuescan/offsite.env)
#   api-state   server 1: the builder fee ledger (builder.db, a consistent copy), the
#               builder-terms signing key, the fee tiers, the visitors' feedback chats and
#               error reports (feedback.db with feedback-images/, client-errors.db), the status page's
#               history and incidents (status-history.json), the admin suite's record and the
#               app's own analytics (admin.db, analytics.db), the small caches of the
#               state directory, /etc/valuescan (configuration and its secrets, without
#               offsite/) and the Caddyfile.            When it changed; at least daily.
#   folders     server 1: the knowledge folders (folders.db, their session key, the
#               uploaded files). Kept 7 days on the other side (the privacy policy).
#                                                       When it changed; at least daily.
#   executor    server 2: the copy executor's executor.db (copies, activity, the audit
#               log, the followers' SEALED keys) and /etc/valuescan.
#               NEVER the kek, session.key or import.key - see below.
#                                                       When it changed; at least daily.
#   journal     both: the system journal since the last copy (journalctl -o export),
#               without the API's and the executor's request logs (their own 14-day
#               journal namespace "pii": they hold IP and wallet addresses).
#                                                       Daily, in the quiet hours.
#   index       server 1: the newest nightly index backup (backup.sh, ~4.6 GB).
#               Rebuildable, but a cold start loses the 31 days of history.
#                                                       Weekly, in the quiet hours.
#   hl-archive  server 1: /var/lib/valuescan/archive (the Hyperliquid fills replay,
#               ~0.6 GB; 12-20 hours and paid S3 reads to make again).
#                                                       Weekly, when it changed.
#
# HOW: each set is put together in a work directory (SQLite files with VACUUM INTO,
# as their own user - backup-index.mjs), packed with a deterministic tar, and - when
# it differs from the last copy sent, or that copy is older than OFFSITE_FORCE_AFTER_H
# - encrypted with THIS server's backup key (backup-crypt.mjs: AES-256-GCM, zstd) and
# streamed at most OFFSITE_RATE_MBPS over ssh to the other server's vsbackup user,
# whose only command is backup-receive.sh (put: size and SHA-256 checked there). A
# marker /var/lib/valuescan/state/offsite-<set>.json records the copy; the health
# check fails when one is older than 36 hours. A failure is also sent to Telegram
# (alert.env), at most once in six hours per set.
#
# THE KEK NEVER LEAVES. Every follower's trading key in executor.db is sealed with
# /var/lib/valuescan/executor/kek. A copy of the database is harmless only while the
# kek is somewhere else - offline with the owner (executor-secrets.sh export). So
# nothing from the executor's directory but executor.db is ever read here, and a set
# that contains a file named kek, session.key or import.key from there is refused
# before it is encrypted.
#
# THE RECEIVER CANNOT READ ANY OF IT: the backup key is on this server (and offline
# with the owner), never on the other one. Restore: backup-restore.sh,
# docs/deploy/BACKUPS.md.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${OFFSITE_CONF:-/etc/valuescan/offsite.env}"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

NODE="${NODE_BIN_DIR:-/opt/node/current/bin}/node"
OFFSITE_LABEL="${OFFSITE_LABEL:-$(hostname -s)}"
OFFSITE_HOST="${OFFSITE_HOST:-}"
OFFSITE_USER="${OFFSITE_USER:-vsbackup}"
OFFSITE_SETS="${OFFSITE_SETS:-}"
OFFSITE_DIR="${OFFSITE_DIR:-/etc/valuescan/offsite}"
OFFSITE_KEY="${OFFSITE_KEY:-$OFFSITE_DIR/backup.key}"
OFFSITE_SSH_KEY="${OFFSITE_SSH_KEY:-$OFFSITE_DIR/id_ed25519}"
OFFSITE_KNOWN_HOSTS="${OFFSITE_KNOWN_HOSTS:-$OFFSITE_DIR/known_hosts}"
OFFSITE_WORK="${OFFSITE_WORK:-/var/lib/valuescan/backup/offsite}"
OFFSITE_RATE_MBPS="${OFFSITE_RATE_MBPS:-10}"
OFFSITE_HEAVY_HOURS="${OFFSITE_HEAVY_HOURS:-04 05}"
OFFSITE_FORCE_AFTER_H="${OFFSITE_FORCE_AFTER_H:-20}"
# ssh (production) or local (the tests: straight into backup-receive.sh).
OFFSITE_TRANSPORT="${OFFSITE_TRANSPORT:-ssh}"
# setpriv (production: SQLite copies as the file's owner) or self (the tests).
OFFSITE_SNAPSHOT_AS="${OFFSITE_SNAPSHOT_AS:-setpriv}"

STATE_DIR="${STATE_DIR:-/var/lib/valuescan/state}"
EXECUTOR_DIR="${EXECUTOR_DIR:-/var/lib/valuescan/executor}"
ETC_DIR="${ETC_DIR:-/etc/valuescan}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
ARCHIVE_DIR="${ARCHIVE_DIR:-/var/lib/valuescan/archive}"
INDEX_BACKUP_DIR="${BACKUP_DIR:-/var/lib/valuescan/backup/archive}"
MARKER_DIR="${OFFSITE_MARKER_DIR:-$STATE_DIR}"

log() { printf '[offsite] %s\n' "$*"; }
warn() { printf '[offsite] WARNING: %s\n' "$*" >&2; }
die() { printf '[offsite] error: %s\n' "$*" >&2; exit 1; }

now_s() { date -u +%s; }
stamp() { date -u +%Y%m%dT%H%M%SZ; }
in_list() { local w; for w in $2; do [ "$w" = "$1" ] && return 0; done; return 1; }
json_get() {   # file, key -> the value of a flat JSON string or number field
  [ -f "$1" ] || return 0
  sed -n "s/.*\"$2\":\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$1" | head -n 1
}
marker_age_h() {   # set -> hours since its last copy (large when there is none)
  local m="$MARKER_DIR/offsite-$1.json"
  [ -f "$m" ] || { echo 99999; return; }
  echo $(( ($(now_s) - $(stat -c %Y "$m")) / 3600 ))
}
heavy_hour() { in_list "$(date -u +%H)" "$OFFSITE_HEAVY_HOURS"; }

# --- telegram, at most every six hours per set ---------------------------------------------------
notify_failure() {   # set, reason
  local f="$OFFSITE_WORK/.failed-$1"
  if [ -f "$f" ] && [ $(( $(now_s) - $(stat -c %Y "$f") )) -lt 21600 ]; then return 0; fi
  : > "$f"
  if [ -n "${ALERT_TELEGRAM_TOKEN:-}" ] && [ -f "$HERE/telegram.mjs" ]; then
    "$NODE" "$HERE/telegram.mjs" send --kind=failure "backup - $OFFSITE_LABEL: the off-server copy '$1' to ${OFFSITE_HOST:-the other server} failed: $2 (journalctl -u valuescan-offsite)" || true
  fi
}

# --- putting a set together -------------------------------------------------------------------------
RUN=""
STAGE=""
cleanup() { [ -z "$RUN" ] || rm -rf "$RUN"; }
trap cleanup EXIT

new_run() {
  cleanup
  mkdir -p "$OFFSITE_WORK"; chmod 0711 "$OFFSITE_WORK" 2>/dev/null || true
  RUN="$(mktemp -d "$OFFSITE_WORK/run.XXXXXX")"
  chmod 0711 "$RUN" 2>/dev/null || true
  STAGE="$RUN/stage"
  mkdir -p "$STAGE"
}

# A consistent copy of a SQLite database into the stage, at its own path, taken as
# the file's owner (so a -shm it may create belongs to that owner, never to root).
add_db() {   # source path
  local src="$1" owner scratch rel
  [ -f "$src" ] || { warn "$src does not exist - left out"; return 0; }
  owner="$(stat -c %U "$src")"
  rel="${src#/}"
  mkdir -p "$STAGE/$(dirname "$rel")"
  if [ "$OFFSITE_SNAPSHOT_AS" = setpriv ] && [ "$owner" != root ]; then
    scratch="$RUN/as-$owner"
    install -d -m 0700 -o "$owner" -g "$(id -gn "$owner")" "$scratch"
    setpriv --reuid="$owner" --regid="$(id -gn "$owner")" --init-groups -- \
      "$NODE" --disable-warning=ExperimentalWarning "$HERE/backup-index.mjs" "$src" "$scratch/copy.db" >/dev/null
    mv "$scratch/copy.db" "$STAGE/$rel"
  else
    "$NODE" --disable-warning=ExperimentalWarning "$HERE/backup-index.mjs" "$src" "$STAGE/$rel" >/dev/null
  fi
}

# Files and directories, with their paths, modes and times (a missing one is left out).
add_path() {   # path [tar --exclude patterns...]
  local p="$1"
  shift
  [ -e "$p" ] || { warn "$p does not exist - left out"; return 0; }
  local ex=() e
  for e in "$@"; do ex+=("--exclude=$e"); done
  tar -C / ${ex[@]+"${ex[@]}"} -cf - "${p#/}" | tar -C "$STAGE" -xpf -
}

# The guard: nothing of the executor's directory but executor.db, and no kek anywhere.
guard_stage() {
  local bad
  bad="$(cd "$STAGE" && find . -type f \( -name kek -o -name import.key -o -path "./${EXECUTOR_DIR#/}/*" \) ! -path "./${EXECUTOR_DIR#/}/executor.db" -print)"
  [ -z "$bad" ] || die "REFUSED: the set would contain $(echo "$bad" | tr '\n' ' ')- the executor's keys never leave this server"
}

# A deterministic tar: the same content gives the same bytes (and so the same hash).
pack_stage() {   # -> $RUN/payload.tar
  guard_stage
  tar -C "$STAGE" --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --format=gnu -cf "$RUN/payload.tar" .
}

# --- encrypting and sending ---------------------------------------------------------------------------
# send <set> <kind> <fingerprint> [--zstd]: encrypts stdin, sends it, writes the marker.
send() {
  local set="$1" kind="$2" print="$3" z="${4:-}" name enc bytes sha out
  [ -f "$OFFSITE_KEY" ] || die "no backup key at $OFFSITE_KEY (offsite-setup.sh sender)"
  name="$set-$(stamp).$kind.enc"
  enc="$RUN/$name"
  "$NODE" "$HERE/backup-crypt.mjs" encrypt "$OFFSITE_KEY" ${z:+--zstd} --sha-out="$RUN/cipher.sha" > "$enc"
  bytes="$(stat -c %s "$enc")"
  sha="$(cut -c1-64 "$RUN/cipher.sha")"
  log "$set: sending $name ($(( bytes / 1048576 )) MiB) to ${OFFSITE_HOST:-local}"
  if [ "$OFFSITE_TRANSPORT" = local ]; then
    out="$("$NODE" "$HERE/backup-crypt.mjs" cat --rate="$OFFSITE_RATE_MBPS" < "$enc" | SSH_ORIGINAL_COMMAND="put $set $name $bytes $sha" bash "$HERE/backup-receive.sh")" || return 1
  else
    [ -n "$OFFSITE_HOST" ] || die "OFFSITE_HOST is not set ($CONF)"
    out="$("$NODE" "$HERE/backup-crypt.mjs" cat --rate="$OFFSITE_RATE_MBPS" < "$enc" | ssh -i "$OFFSITE_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes \
      -o "UserKnownHostsFile=$OFFSITE_KNOWN_HOSTS" -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 \
      -o LogLevel=ERROR "$OFFSITE_USER@$OFFSITE_HOST" "put $set $name $bytes $sha")" || return 1
  fi
  [ "$out" = "stored $set/$name $bytes" ] || { warn "$set: the other side answered: $out"; return 1; }
  mkdir -p "$MARKER_DIR"
  printf '{"at":"%s","set":"%s","name":"%s","bytes":%s,"sha256":"%s","fingerprint":"%s","to":"%s","keyId":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$set" "$name" "$bytes" "$sha" "$print" "${OFFSITE_HOST:-local}" \
    "$("$NODE" "$HERE/backup-crypt.mjs" id "$OFFSITE_KEY")" > "$RUN/marker.json"
  install -m 0640 "$RUN/marker.json" "$MARKER_DIR/offsite-$set.json"
  if id valuescan >/dev/null 2>&1; then chown valuescan:valuescan "$MARKER_DIR/offsite-$set.json" 2>/dev/null || true; fi
  rm -f "$OFFSITE_WORK/.failed-$set"
  log "$set: stored on the other side as $name"
}

# --- the sets ---------------------------------------------------------------------------------------------
# Each one: decide (unless forced), put together, send. Returns 0 also when there was
# nothing to do.
changed_or_due() {   # set, fingerprint, force
  [ "$3" = 1 ] && return 0
  [ "$(json_get "$MARKER_DIR/offsite-$1.json" fingerprint)" != "$2" ] && return 0
  [ "$(marker_age_h "$1")" -ge "$OFFSITE_FORCE_AFTER_H" ] && return 0
  return 1
}

tar_set() {   # set, force  (api-state, folders, executor)
  local set="$1" force="$2" print
  new_run
  case "$set" in
    api-state)
      add_db "$STATE_DIR/builder.db"
      # The client error reports (apps/server/src/ops), when the server keeps them.
      [ -f "$STATE_DIR/client-errors.db" ] && add_db "$STATE_DIR/client-errors.db"
      # The feedback chats (ops/feedbackThreads.ts) and their screenshots. Not the chats' wallet
      # session key (feedback-auth/): without it people only sign in once more.
      [ -f "$STATE_DIR/feedback.db" ] && add_db "$STATE_DIR/feedback.db"
      [ -d "$STATE_DIR/feedback-images" ] && add_path "$STATE_DIR/feedback-images"
      # The admin suite's record (apps/server/src/admin/store.ts: audit chain, ticket statuses, the fee
      # orders it keeps beyond the ledger's cap) and the app's own analytics (ops/analytics.ts). Not the
      # admin password's hash (admin-auth/): after a restore the owner sets it again.
      [ -f "$STATE_DIR/admin.db" ] && add_db "$STATE_DIR/admin.db"
      [ -f "$STATE_DIR/analytics.db" ] && add_db "$STATE_DIR/analytics.db"
      # Who has which username, and the signed changes (apps/server/src/profiles/store.ts).
      [ -f "$STATE_DIR/profiles.db" ] && add_db "$STATE_DIR/profiles.db"
      local f
      # status-history.json: the status page's finished days and incidents (apps/server/src/ops/status.ts writeHistory).
      for f in builder-terms.key builder-tiers.json etf-flows.json release-results.json device.key feedback.jsonl status-history.json; do
        [ -e "$STATE_DIR/$f" ] && add_path "$STATE_DIR/$f"
      done
      add_path "$ETC_DIR" "${ETC_DIR#/}/offsite" "${ETC_DIR#/}/*.bak*"
      [ -e "$CADDYFILE" ] && add_path "$CADDYFILE"
      ;;
    folders)
      [ -d "$STATE_DIR/folders" ] || { log "folders: $STATE_DIR/folders does not exist - nothing to send"; return 0; }
      add_db "$STATE_DIR/folders/folders.db"
      [ -e "$STATE_DIR/folders/session.key" ] && add_path "$STATE_DIR/folders/session.key"
      [ -d "$STATE_DIR/folders/files" ] && add_path "$STATE_DIR/folders/files"
      ;;
    executor)
      [ -f "$EXECUTOR_DIR/executor.db" ] || die "executor: $EXECUTOR_DIR/executor.db does not exist"
      add_db "$EXECUTOR_DIR/executor.db"
      add_path "$ETC_DIR" "${ETC_DIR#/}/offsite" "${ETC_DIR#/}/*.bak*"
      ;;
  esac
  pack_stage
  print="$(sha256sum "$RUN/payload.tar" | cut -c1-64)"
  if ! changed_or_due "$set" "$print" "$force"; then
    log "$set: unchanged since the last copy ($(marker_age_h "$set") h ago) - nothing sent"
    return 0
  fi
  send "$set" tar "$print" zstd < "$RUN/payload.tar"
}

journal_set() {   # force
  local cursor="$OFFSITE_WORK/journal.cursor" lines
  new_run
  command -v journalctl >/dev/null 2>&1 || die "journal: journalctl is not here"
  [ -f "$cursor" ] && cp "$cursor" "$RUN/cursor"
  # From the last copy on (all that is kept, the first time); --cursor-file writes the new
  # position into the run's copy, which replaces the real one only after the send.
  journalctl --cursor-file="$RUN/cursor" -o export --no-pager > "$RUN/journal.export"
  lines="$(stat -c %s "$RUN/journal.export")"
  if [ "$lines" -eq 0 ]; then log "journal: nothing new since the last copy"; return 0; fi
  send journal journal "$(sha256sum "$RUN/journal.export" | cut -c1-64)" zstd < "$RUN/journal.export"
  install -m 0600 "$RUN/cursor" "$cursor"
}

index_set() {   # force
  local newest
  newest="$(find "$INDEX_BACKUP_DIR" -maxdepth 1 -type f -name 'valuescan-index-*.db.zst' -printf '%f\n' 2>/dev/null | sort | tail -n 1)"
  [ -n "$newest" ] || { log "index: no nightly index backup in $INDEX_BACKUP_DIR yet"; return 0; }
  if [ "$1" != 1 ] && [ "$(json_get "$MARKER_DIR/offsite-index.json" fingerprint)" = "$newest" ]; then
    log "index: $newest was sent already"
    return 0
  fi
  new_run
  # Already compressed: tar it with its .sha256, encrypt without zstd.
  tar -C "$INDEX_BACKUP_DIR" -cf - "$newest" $( [ -f "$INDEX_BACKUP_DIR/$newest.sha256" ] && echo "$newest.sha256" ) | send index tar "$newest"
}

archive_set() {   # force
  local print
  [ -d "$ARCHIVE_DIR" ] || { log "hl-archive: $ARCHIVE_DIR does not exist"; return 0; }
  # Cheap: names, sizes and times - the archive is 0.6 GB and does not change often.
  print="$(find "$ARCHIVE_DIR" -maxdepth 1 -type f \( -name '*.tsv.gz' -o -name 'progress.json' \) -printf '%f %s %T@\n' | sort | sha256sum | cut -c1-64)"
  if [ "$1" != 1 ] && [ "$(json_get "$MARKER_DIR/offsite-hl-archive.json" fingerprint)" = "$print" ]; then
    log "hl-archive: unchanged since the last copy"
    return 0
  fi
  new_run
  (cd "$ARCHIVE_DIR" && find . -maxdepth 1 -type f \( -name '*.tsv.gz' -o -name 'progress.json' \) -printf '%f\n' | sort | tar -cf - -T -) | send hl-archive tar "$print"
}

one_set() {   # set, force
  case "$1" in
    api-state|folders|executor) tar_set "$1" "$2" ;;
    journal) journal_set "$2" ;;
    index) index_set "$2" ;;
    hl-archive) archive_set "$2" ;;
    *) die "unknown set '$1' (api-state, folders, executor, journal, index, hl-archive)" ;;
  esac
}

# Is it this set's turn (the timer, every 15 minutes)?
due() {   # set
  case "$1" in
    api-state|folders|executor) return 0 ;;                                   # tar_set decides by content
    journal) heavy_hour && [ "$(marker_age_h journal)" -ge 20 ] ;;
    index|hl-archive) heavy_hour && [ "$(marker_age_h "$1")" -ge 156 ] ;;     # 6.5 days
    *) return 0 ;;
  esac
}

lock() {
  mkdir -p "$OFFSITE_WORK"; chmod 0711 "$OFFSITE_WORK" 2>/dev/null || true
  if command -v flock >/dev/null 2>&1; then
    exec 9> "$OFFSITE_WORK/.lock"
    flock -n 9 || { log "another run is still going - this one stops"; exit 0; }
  fi
}

case "${1:-}" in
  run)
    [ -n "$OFFSITE_SETS" ] || die "OFFSITE_SETS is empty ($CONF)"
    lock
    failed=()
    for s in $OFFSITE_SETS; do
      due "$s" || continue
      # A process of its own per set: errexit stays in force inside it (it would not in an "if").
      if ! "$BASH" "$0" _one "$s" 0; then
        failed+=("$s")
        notify_failure "$s" "see the journal"
      fi
    done
    [ "${#failed[@]}" = 0 ] || die "failed: ${failed[*]}"
    ;;
  push)
    [ -n "${2:-}" ] || die "usage: backup-offsite.sh push <set>"
    lock
    if ! "$BASH" "$0" _one "$2" 1; then notify_failure "$2" "a push by hand failed"; die "$2 failed"; fi
    ;;
  _one)
    one_set "$2" "$3"
    ;;
  status)
    for s in ${OFFSITE_SETS:-api-state folders executor journal index hl-archive}; do
      m="$MARKER_DIR/offsite-$s.json"
      if [ -f "$m" ]; then printf '%-11s %s h ago  %s\n' "$s" "$(marker_age_h "$s")" "$(json_get "$m" name)"; else printf '%-11s never\n' "$s"; fi
    done
    ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
