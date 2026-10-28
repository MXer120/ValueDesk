#!/usr/bin/env bash
# /opt/valuescan/bin/backup-receive.sh - the RECEIVING end of the off-server backups.
# The only thing the other server's backup key may run here: it is the forced command
# of the vsbackup user's authorized_keys line (offsite-setup.sh receiver), so that key
# gets no shell, no port forwarding, no pty, and only these verbs:
#
#   put <set> <name> <bytes> <sha256>   store <bytes> of stdin as <set>/<name> - only if the size
#                                       and the SHA-256 match, never over an existing file
#   list [<set>]                        what is stored: set/name, bytes, received (UTC)
#   prune                               remove what is older than the set's retention
#   df                                  free space where the copies are
#
# By hand, as an administrator: sudo -u vsbackup /opt/valuescan/bin/backup-receive.sh list
# (valuescan-offsite-prune.timer runs `prune` once a day the same way).
#
# WHAT ARRIVES IS ENCRYPTED (backup-crypt.mjs) with a key only the SENDING server and
# the owner have. This side cannot read it, and does not need to: it checks sizes and
# hashes, keeps what came, and throws away what is too old.
#
# RETENTION (receive.env): RECEIVE_KEEP_DAYS_<set> days, by the time a copy arrived
# (dashes in the set name become underscores). The newest copy of a set is always
# kept, so a sender that stopped sending (a dead server) never loses its last copy -
# except for the sets in RECEIVE_STRICT_SETS (the knowledge folders: the privacy
# policy promises their deleted text is gone from every copy within seven days).
# A sender that floods cannot push older copies out: nothing younger than its
# retention is removed; RECEIVE_MAX_TOTAL_GB and RECEIVE_MIN_FREE_GB stop it instead.
#
# Settings: /etc/vsbackup/receive.env (deploy/contabo/server*/backup-receive.env;
# readable by vsbackup, nothing secret in it). Every put is logged to the journal
# (valuescan-backup-receive).
set -euo pipefail
umask 077

CONF="${RECEIVE_CONF:-/etc/vsbackup/receive.env}"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
RECEIVE_DIR="${RECEIVE_DIR:-/var/lib/vsbackup}"
RECEIVE_SETS="${RECEIVE_SETS:-}"
RECEIVE_MIN_FREE_GB="${RECEIVE_MIN_FREE_GB:-10}"
RECEIVE_MAX_TOTAL_GB="${RECEIVE_MAX_TOTAL_GB:-60}"
RECEIVE_STRICT_SETS="${RECEIVE_STRICT_SETS:-}"

log() { command -v logger >/dev/null 2>&1 && logger -t valuescan-backup-receive -- "$*" 2>/dev/null || true; }
die() { printf 'backup-receive: %s\n' "$*" >&2; log "refused: $*"; exit 1; }

in_list() { local w; for w in $2; do [ "$w" = "$1" ] && return 0; done; return 1; }
var_of() { printf '%s' "$1" | tr '-' '_'; }
setting() {   # name prefix, set, default
  local v; v="$1_$(var_of "$2")"
  printf '%s' "${!v:-$3}"
}

prune_set() {   # set
  local set="$1" dir="$RECEIVE_DIR/$1" days newest f
  [ -d "$dir" ] || return 0
  days="$(setting RECEIVE_KEEP_DAYS "$set" 14)"
  case "$days" in ''|*[!0-9]*) die "RECEIVE_KEEP_DAYS_$(var_of "$set") is not a number" ;; esac
  newest="$(find "$dir" -maxdepth 1 -type f -name "$set-*.enc" -printf '%f\n' | sort | tail -n 1)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ "$f" = "$newest" ] && ! in_list "$set" "$RECEIVE_STRICT_SETS"; then continue; fi
    rm -f "$dir/$f" "$dir/$f.sha256"
    log "pruned $set/$f (older than $days days)"
  done < <(find "$dir" -maxdepth 1 -type f -name "$set-*.enc" -mmin +"$((days * 1440))" -printf '%f\n')
  # Pieces of a transfer that never finished.
  find "$dir" -maxdepth 1 -type f -name ".*.partial" -mmin +360 -delete 2>/dev/null || true
}

# The command: from ssh (the forced command), or the arguments when run by hand.
CMD="${SSH_ORIGINAL_COMMAND:-$*}"
case "$CMD" in *[!A-Za-z0-9\ ._:-]*) die "unexpected characters in the command" ;; esac
read -r verb a1 a2 a3 a4 extra <<< "$CMD" || true
[ -z "${extra:-}" ] || die "too many arguments"
[ -n "$RECEIVE_SETS" ] || die "RECEIVE_SETS is empty in $CONF: this server receives nothing"
mkdir -p "$RECEIVE_DIR"
# Run from a folder this user may enter: `sudo -u vsbackup ... list` from another
# user's home made find fail ("Failed to restore initial working directory").
cd "$RECEIVE_DIR"

case "${verb:-}" in
  put)
    set="${a1:-}" name="${a2:-}" bytes="${a3:-}" sha="${a4:-}"
    in_list "$set" "$RECEIVE_SETS" || die "this server does not take the set '$set' (RECEIVE_SETS: $RECEIVE_SETS)"
    [[ "$name" =~ ^${set}-[0-9]{8}T[0-9]{6}Z\.[a-z0-9.]{1,24}\.enc$ ]] || die "a backup name is <set>-<UTC time>.<kind>.enc"
    [[ "$bytes" =~ ^[0-9]{1,13}$ ]] && [ "$bytes" -gt 0 ] || die "the size is a positive number of bytes"
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "the hash is 64 hex characters"
    max_mb="$(setting RECEIVE_MAX_MB "$set" 2048)"
    [ "$bytes" -le $((max_mb * 1048576)) ] || die "$set: $((bytes / 1048576)) MB is over the $max_mb MB this set may have per copy"
    dir="$RECEIVE_DIR/$set"
    mkdir -p "$dir"
    [ ! -e "$dir/$name" ] || die "$set/$name exists already - a copy is never replaced"
    free_kb="$(df -Pk "$RECEIVE_DIR" | awk 'NR == 2 {print $4}')"
    [ $((free_kb / 1048576)) -ge $((RECEIVE_MIN_FREE_GB + bytes / 1073741824 + 1)) ] || die "not enough free space here ($((free_kb / 1048576)) GB free, $RECEIVE_MIN_FREE_GB GB must stay free)"
    used_kb="$(du -sk "$RECEIVE_DIR" | awk '{print $1}')"
    [ $(((used_kb + bytes / 1024) / 1048576)) -lt "$RECEIVE_MAX_TOTAL_GB" ] || die "the copies here would pass RECEIVE_MAX_TOTAL_GB ($RECEIVE_MAX_TOTAL_GB GB)"
    part="$dir/.$name.partial"
    trap 'rm -f "$part"' EXIT
    head -c "$bytes" > "$part"
    got="$(stat -c %s "$part")"
    [ "$got" = "$bytes" ] || die "$set/$name: $got bytes arrived, $bytes were announced"
    have="$(sha256sum "$part" | awk '{print $1}')"
    [ "$have" = "$sha" ] || die "$set/$name: the SHA-256 of what arrived is not the one announced"
    mv -f "$part" "$dir/$name"
    trap - EXIT
    printf '%s  %s\n' "$sha" "$name" > "$dir/$name.sha256"
    log "stored $set/$name ($bytes bytes)"
    echo "stored $set/$name $bytes"
    prune_set "$set"
    ;;
  list)
    for set in $RECEIVE_SETS; do
      [ -z "${a1:-}" ] || [ "$a1" = "$set" ] || continue
      [ -d "$RECEIVE_DIR/$set" ] || continue
      find "$RECEIVE_DIR/$set" -maxdepth 1 -type f -name "$set-*.enc" -printf "$set/%f %s %TY-%Tm-%TdT%TH:%TMZ\n" | sort
    done
    ;;
  prune)
    for set in $RECEIVE_SETS; do prune_set "$set"; done
    echo "pruned"
    ;;
  df)
    df -Ph "$RECEIVE_DIR" | awk 'NR == 2 {print $4 " free of " $2 " (" $5 " used)"}'
    du -sh "$RECEIVE_DIR" | awk '{print $1 " in copies"}'
    ;;
  *)
    die "unknown command (put, list, prune, df)"
    ;;
esac
