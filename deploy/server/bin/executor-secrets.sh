#!/usr/bin/env bash
# The copy executor's secret files, as one passphrase-encrypted text block to keep OFFLINE.
#
#   sudo bash executor-secrets.sh export            prints the block (asks for a passphrase twice)
#   sudo bash executor-secrets.sh import < block    writes kek, session.key and import.key back
#                                                   (asks for the passphrase; refuses to overwrite
#                                                   files that differ unless FORCE=1)
#
# WHY. Every follower's trading key in executor.db is sealed with `kek` (apps/executor/src/
# secrets.ts). backup.sh copies the database but, on purpose, never the kek: a database backup
# then holds nothing a trade could be signed with. That only works if the kek itself survives
# somewhere else. On AWS that was the volume snapshot; Contabo has none. Lose the disk without
# this block and every follower's key is gone: each one must register a new key on SoDEX with
# their wallet before any copy or algo order of theirs trades again.
#
# Keep the block apart from the database backups (a password manager, or paper in a safe), and
# the passphrase apart from both. Anyone with the block AND the passphrase AND a database backup
# can sign trades for every follower until their keys expire or are revoked.
#
# AES-256-CBC, key from the passphrase by PBKDF2-SHA256 with 600 000 iterations and a random salt
# (openssl enc). Nothing is written to disk on export; the passphrase is read from the terminal.
set -euo pipefail

DIR="${EXECUTOR_DATA_DIR:-/var/lib/valuescan/executor}"
FILES=(kek session.key import.key)
OWNER="${EXECUTOR_USER:-valuescan-executor}"

die() { echo "executor-secrets: $*" >&2; exit 1; }
command -v openssl >/dev/null || die "openssl is needed"

case "${1:-}" in
  export)
    for f in "${FILES[@]}"; do
      [ -f "$DIR/$f" ] || { [ "$f" = import.key ] && continue; die "$DIR/$f is missing"; }
    done
    present=()
    for f in "${FILES[@]}"; do [ -f "$DIR/$f" ] && present+=("$f"); done
    echo "----- BEGIN VALUEDESK EXECUTOR SECRETS ($(hostname), $(date -u +%Y-%m-%dT%H:%MZ)) -----"
    tar -C "$DIR" -cf - "${present[@]}" | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -salt -a -A
    echo
    echo "----- END VALUEDESK EXECUTOR SECRETS -----"
    echo "Keep this block offline, apart from the database backups; keep the passphrase apart from both." >&2
    ;;
  import)
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    sed -n '/BEGIN VALUEDESK EXECUTOR SECRETS/,/END VALUEDESK EXECUTOR SECRETS/p' | sed '1d;$d' | tr -d '\r\n' >"$tmp/block"
    [ -s "$tmp/block" ] || die "no secrets block on standard input"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -a -A -in "$tmp/block" | tar -C "$tmp" -xf - || die "wrong passphrase, or a damaged block"
    mkdir -p "$DIR"
    for f in "${FILES[@]}"; do
      [ -f "$tmp/$f" ] || continue
      if [ -f "$DIR/$f" ] && ! cmp -s "$tmp/$f" "$DIR/$f" && [ "${FORCE:-0}" != 1 ]; then
        die "$DIR/$f exists and differs; stop the executor and run again with FORCE=1 to replace it"
      fi
      install -m 0600 "$tmp/$f" "$DIR/$f"
      id "$OWNER" >/dev/null 2>&1 && chown "$OWNER:$OWNER" "$DIR/$f"
      echo "restored $DIR/$f" >&2
    done
    ;;
  *)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
