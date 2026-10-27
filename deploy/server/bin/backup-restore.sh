#!/usr/bin/env bash
# /opt/valuescan/bin/backup-restore.sh - open, check and put back an off-server copy
# (backup-offsite.sh). The whole procedure, and the drill: docs/deploy/BACKUPS.md.
#
#   backup-restore.sh latest <set>                    the newest copy of <set> received HERE
#   backup-restore.sh open <file.enc> <keyfile> <dir> decrypt (checks the key and every byte),
#                                                     unpack into the NEW directory <dir>, check
#                                                     every SQLite file in it, list what is inside
#   backup-restore.sh apply <dir> [--with-etc] [--yes]
#                                                     put an opened api-state, folders or executor
#                                                     copy in place on THIS server. Without --yes:
#                                                     only the plan. With it: stops the unit that
#                                                     holds the files, moves the current ones aside
#                                                     (*.replaced-<time>, never deleted), copies,
#                                                     sets owners and modes, starts the unit again.
#                                                     --with-etc: /etc/valuescan and the Caddyfile
#                                                     too (a rebuilt server; bootstrap.sh rewrites
#                                                     the rendered *.env files on its next run).
#   backup-restore.sh drill <set> [--key=<file>|--key-stdin]
#                                                     THE RESTORE DRILL, on the server that HOLDS
#                                                     the copies: open the newest <set> into a
#                                                     scratch directory, check it, print a summary,
#                                                     delete the scratch. Touches nothing of the
#                                                     running services. The key comes on stdin and
#                                                     is deleted with the scratch directory.
#
# On the owner's laptop `open` works too (Git Bash and Node; backup-crypt.mjs needs no
# zstd binary), with the copies deploy/release/pull-backups.sh fetched.
#
# THE EXECUTOR'S COPY holds every follower's key SEALED with the kek of the server it
# came from. On another server (or after a disk loss) put the kek back first:
# executor-secrets.sh import < block (the owner's offline copy). `apply` refuses an
# executor copy where there is no kek, because the executor would make a NEW kek on
# start and the restored keys would never open.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${NODE_BIN_DIR:-/opt/node/current/bin}/node"
RECEIVE_CONF="${RECEIVE_CONF:-/etc/vsbackup/receive.env}"
# shellcheck disable=SC1090
[ -f "$RECEIVE_CONF" ] && . "$RECEIVE_CONF"
RECEIVE_DIR="${RECEIVE_DIR:-/var/lib/vsbackup}"
STATE_DIR="${STATE_DIR:-/var/lib/valuescan/state}"
EXECUTOR_DIR="${EXECUTOR_DIR:-/var/lib/valuescan/executor}"

log() { printf '[restore] %s\n' "$*"; }
die() { printf '[restore] error: %s\n' "$*" >&2; exit 1; }

latest() {   # set -> path
  local f
  # (*.test.enc: offsite-setup.sh test's one line of text, not a copy.)
  f="$(find "$RECEIVE_DIR/$1" -maxdepth 1 -type f -name "$1-*.enc" ! -name '*.test.enc' -printf '%f\n' 2>/dev/null | sort | tail -n 1)"
  [ -n "$f" ] || die "no copy of '$1' in $RECEIVE_DIR/$1"
  printf '%s\n' "$RECEIVE_DIR/$1/$f"
}

set_of() { basename "$1" | sed -n 's/^\([a-z-]*\)-[0-9]\{8\}T[0-9]\{6\}Z\..*$/\1/p'; }

open_copy() {   # file, keyfile, dir
  local file="$1" key="$2" dir="$3" set
  [ -f "$file" ] || die "$file does not exist"
  [ -f "$key" ] || die "$key does not exist"
  [ ! -e "$dir" ] || die "$dir exists - open into a new directory"
  set="$(set_of "$file")"
  [ -n "$set" ] || die "$(basename "$file") is not a backup name (<set>-<UTC time>.<kind>.enc)"
  if [ -f "$file.sha256" ]; then
    [ "$(sha256sum "$file" | cut -c1-64)" = "$(cut -c1-64 "$file.sha256")" ] || die "$file does not match its .sha256 (damaged in transit or on disk)"
  fi
  mkdir -p "$dir"
  log "decrypting $(basename "$file") ($set)"
  if ! "$NODE" "$HERE/backup-crypt.mjs" decrypt "$key" < "$file" > "$dir/.payload"; then
    rm -f "$dir/.payload"
    die "could not decrypt $(basename "$file") with $(basename "$key") (above: wrong key or damaged)"
  fi
  printf '%s\n' "$set" > "$dir/.set"
  basename "$file" > "$dir/.source"
  case "$set" in
    journal)
      mv "$dir/.payload" "$dir/journal.export"
      log "journal export: $(grep -ac '^__CURSOR=' "$dir/journal.export" || true) entries, $(( $(stat -c %s "$dir/journal.export") / 1048576 )) MiB"
      log "read it on a Linux machine: /usr/lib/systemd/systemd-journal-remote -o $dir/restored.journal $dir/journal.export && journalctl --file $dir/restored.journal"
      ;;
    *)
      mkdir -p "$dir/tree"
      tar -C "$dir/tree" --no-same-owner -xf "$dir/.payload"
      rm -f "$dir/.payload"
      check_tree "$dir"
      ;;
  esac
  log "opened into $dir"
}

check_tree() {   # dir
  local dir="$1" f bad=0
  if find "$dir/tree" -type f \( -name kek -o -name import.key \) | grep -q .; then
    die "the copy contains a kek or an import.key - it must never have been made; tell the owner"
  fi
  while IFS= read -r f; do
    if "$NODE" --disable-warning=ExperimentalWarning "$HERE/backup-index.mjs" --check "$f" >"$dir/.check" 2>&1; then
      log "ok      ${f#"$dir/tree/"}  ($(sed -n 's/.*"bytes":\([0-9]*\).*/\1/p' "$dir/.check") bytes, integrity ok)"
    else
      log "BROKEN  ${f#"$dir/tree/"}: $(head -c 300 "$dir/.check")"
      bad=1
    fi
  done < <(find "$dir/tree" -type f -name '*.db' | sort)
  rm -f "$dir/.check"
  while IFS= read -r f; do log "file    ${f#"$dir/tree/"}  ($(stat -c %s "$f") bytes)"; done < <(find "$dir/tree" -type f ! -name '*.db' | sort)
  [ "$bad" = 0 ] || die "a database in the copy failed its integrity check"
}

# Owner and group of a file under /etc/valuescan, by the rules bootstrap.sh follows
# (deploy/server/README.md, "What ends up where"); the mode comes from the copy.
etc_owner() {   # path, mode
  case "$(basename "$1")" in
    bootstrap.env|alert.env) echo root:root ;;
    executor.env|executor.local.env) echo root:valuescan-executor ;;
    *) [ "$2" = 600 ] && echo root:root || echo root:valuescan ;;
  esac
}

apply_copy() {   # dir, with_etc, yes
  local dir="$1" with_etc="$2" yes="$3" set unit t src dst rel mode own
  [ -f "$dir/.set" ] && [ -d "$dir/tree" ] || die "$dir is not an opened copy (backup-restore.sh open first)"
  set="$(cat "$dir/.set")"
  case "$set" in
    api-state|folders) unit=valuescan-api.service ;;
    executor) unit=valuescan-executor.service ;;
    *) die "apply knows api-state, folders and executor; a $set copy is put back by hand (docs/deploy/BACKUPS.md)" ;;
  esac
  [ "$(id -u)" = 0 ] || [ "$yes" != 1 ] || die "run as root"
  if [ "$set" = executor ] && [ ! -f "$EXECUTOR_DIR/kek" ]; then
    die "there is no $EXECUTOR_DIR/kek here: import the owner's offline copy first (executor-secrets.sh import < block). Without it the restored keys never open."
  fi
  t="$(date -u +%Y%m%dT%H%M%SZ)"
  mapfile -t files < <(cd "$dir/tree" && find . -type f | sed 's|^\./|/|' | sort)
  log "copy of $set from $(cat "$dir/.source"); unit $unit"
  local plan=()
  for dst in "${files[@]}"; do
    case "$dst" in
      /etc/*) [ "$with_etc" = 1 ] || { log "skip    $dst (no --with-etc)"; continue; } ;;
    esac
    plan+=("$dst")
    log "put     $dst$([ -e "$dst" ] && echo "   (the current one -> $dst.replaced-$t)")"
  done
  [ "$yes" = 1 ] || { log "this was the plan; nothing changed. Run again with --yes."; return 0; }

  log "stopping $unit"
  systemctl stop "$unit"
  for dst in "${plan[@]}"; do
    src="$dir/tree$dst"
    mkdir -p "$(dirname "$dst")"
    for x in "" -wal -shm; do
      [ -e "$dst$x" ] && mv -f "$dst$x" "$dst$x.replaced-$t"
    done
    mode="$(stat -c %a "$src")"
    case "$dst" in
      /etc/valuescan/*) own="$(etc_owner "$dst" "$mode")" ;;
      /etc/*) own=root:root ;;
      "$EXECUTOR_DIR"/*) own=valuescan-executor:valuescan-executor ;;
      *) own=valuescan:valuescan ;;
    esac
    install -m "$mode" -o "${own%%:*}" -g "${own##*:}" "$src" "$dst"
  done
  log "starting $unit"
  systemctl start "$unit"
  log "done. The replaced files are kept as *.replaced-$t; delete them once the restore is confirmed."
}

drill() {   # set, key option
  local set="$1" keyopt="${2:-}" file scratch key
  file="$(latest "$set")"
  scratch="$(mktemp -d /var/tmp/vs-drill.XXXXXX)"
  trap 'rm -rf "$scratch"' EXIT
  case "$keyopt" in
    --key=*) key="${keyopt#--key=}" ;;
    --key-stdin|'') key="$scratch/key"; cat > "$key"; chmod 600 "$key" ;;
    *) die "drill: --key=<file> or --key-stdin" ;;
  esac
  log "DRILL: $file ($(( $(stat -c %s "$file") / 1024 )) KiB, received $(date -u -r "$file" +%Y-%m-%dT%H:%MZ))"
  open_copy "$file" "$key" "$scratch/open"
  log "DRILL PASSED: the newest $set copy decrypts, is complete and its databases are intact. The scratch copy is deleted now."
}

case "${1:-}" in
  latest) latest "${2:?usage: latest <set>}" ;;
  open) open_copy "${2:?usage: open <file.enc> <keyfile> <dir>}" "${3:?keyfile}" "${4:?dir}" ;;
  apply)
    dir="${2:?usage: apply <dir> [--with-etc] [--yes]}"
    with_etc=0 yes=0
    for a in "${@:3}"; do
      case "$a" in --with-etc) with_etc=1 ;; --yes) yes=1 ;; *) die "unknown option $a" ;; esac
    done
    apply_copy "$dir" "$with_etc" "$yes"
    ;;
  drill) drill "${2:?usage: drill <set> [--key=<file>|--key-stdin]}" "${3:-}" ;;
  *) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
