#!/usr/bin/env bash
# /opt/valuescan/bin/restore.sh - replace the index database with a backup.
#
#   sudo /opt/valuescan/bin/restore.sh latest                 # show what would be restored
#   sudo /opt/valuescan/bin/restore.sh latest --yes           # do it
#   sudo /opt/valuescan/bin/restore.sh backups/valuescan-index-20261002T031912Z.db.zst --yes
#   sudo /opt/valuescan/bin/restore.sh seed/valuescan-index-seed.db.zst --yes    # first start of a new instance
#   sudo /opt/valuescan/bin/restore.sh /var/lib/valuescan/backup/valuescan-index-....db --yes   # a staged copy
#
# WITHOUT --yes nothing is changed: the backup is downloaded, verified, and the
# plan is printed.
#
# WITH --yes:
#   1. the API and the indexer are stopped;
#   2. the current database is moved aside (<file>.replaced-<time>), never deleted;
#   3. the verified backup takes its place;
#   4. the indexer, then the API, are started again and the API is checked.
#
# What a restore means for the data: the index is back at the moment of the backup.
# The indexer re-reads the gap for the traders on the boards (docs/INDEXER.md,
# "Stream continuity and restarts"); the all-account activity counts have a gap
# for the time in between, listed under status.gaps.
set -euo pipefail

ETC="${VS_ETC:-/etc/valuescan}"
for f in "$ETC/ops.env" "$ETC/ops.local.env"; do
  if [ -f "$f" ]; then set -a; . "$f"; set +a; fi
done
: "${OPS_BUCKET:?OPS_BUCKET is not set (see $ETC/ops.env)}"
: "${VALUESCAN_INDEX_DB:?VALUESCAN_INDEX_DB is not set (see $ETC/ops.env)}"
STAGING="${BACKUP_STAGING_DIR:-/var/lib/valuescan/backup}"
NODE="${NODE_BIN_DIR:-/opt/node/current/bin}/node"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
API_URL="${API_URL:-http://127.0.0.1:8797}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[restore] %s\n' "$*"; }
die() { printf '[restore] error: %s\n' "$*" >&2; exit 1; }

SOURCE="${1:-}"
YES=0
[ "${2:-}" = "--yes" ] && YES=1
[ -n "$SOURCE" ] || { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ "$(id -u)" = 0 ] || [ -n "${VS_ALLOW_NON_ROOT:-}" ] || die "run as root (sudo)"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$STAGING"
candidate="$STAGING/restore-$stamp.db"
cleanup() { rm -f "$candidate" "$candidate.zst"; }
trap cleanup EXIT

if [ -f "$SOURCE" ]; then
  log "source: local file $SOURCE"
  case "$SOURCE" in
    *.zst) zstd -d -q -c "$SOURCE" > "$candidate" ;;
    *) cp --reflink=auto "$SOURCE" "$candidate" ;;
  esac
else
  key="$SOURCE"
  if [ "$key" = latest ]; then
    key="$(aws s3api list-objects-v2 --bucket "$OPS_BUCKET" --prefix backups/ \
      --query 'sort_by(Contents[?ends_with(Key, `.db.zst`)], &LastModified)[-1].Key' --output text)"
    [ -n "$key" ] && [ "$key" != None ] || die "no backup found under s3://$OPS_BUCKET/backups/"
  fi
  case "$key" in backups/*.db.zst|seed/*.db.zst) ;; *) die "expected a key under backups/ or seed/ ending in .db.zst, or a local file: $key" ;; esac
  log "source: s3://$OPS_BUCKET/$key"
  aws s3 cp "s3://$OPS_BUCKET/$key" - --only-show-errors | zstd -d -q -c > "$candidate"
  # The checksum is of the uncompressed database, written by backup.sh.
  want="$(aws s3 cp "s3://$OPS_BUCKET/$key.sha256" - --only-show-errors 2>/dev/null | awk '{print $1}' || true)"
  if [ -n "$want" ]; then
    got="$(sha256sum "$candidate" | awk '{print $1}')"
    [ "$want" = "$got" ] || die "checksum mismatch: the download is not the file that was backed up"
    log "checksum matches"
  else
    log "no .sha256 next to the backup: relying on the integrity check alone"
  fi
fi

report="$("$NODE" --disable-warning=ExperimentalWarning "$HERE/backup-index.mjs" --check "$candidate")" \
  || die "the backup failed its integrity check: $report"
log "verified: $report"

if [ "$YES" != 1 ]; then
  log "DRY RUN - nothing was changed. With --yes this would:"
  log "  stop valuescan-api and valuescan-indexer"
  log "  move $VALUESCAN_INDEX_DB aside as $VALUESCAN_INDEX_DB.replaced-$stamp"
  log "  put the verified backup in its place and start both services"
  exit 0
fi

log "stopping the API and the indexer"
"$SYSTEMCTL" stop valuescan-api.service valuescan-indexer.service

aside=""
if [ -f "$VALUESCAN_INDEX_DB" ]; then
  aside="$VALUESCAN_INDEX_DB.replaced-$stamp"
  log "moving the current database aside: $aside"
  mv "$VALUESCAN_INDEX_DB" "$aside"
  # The WAL belongs to the old file: without it that file is incomplete, with the new one it is poison.
  [ -f "$VALUESCAN_INDEX_DB-wal" ] && mv "$VALUESCAN_INDEX_DB-wal" "$aside-wal"
  rm -f "$VALUESCAN_INDEX_DB-shm"
fi

mkdir -p "$(dirname "$VALUESCAN_INDEX_DB")"
mv "$candidate" "$VALUESCAN_INDEX_DB"
chown valuescan:valuescan "$VALUESCAN_INDEX_DB" 2>/dev/null || true
chmod 0640 "$VALUESCAN_INDEX_DB"

kept() {
  [ -n "$aside" ] || return 0
  log "The previous database is kept at $aside (and -wal)."
  log "Delete it once the restore is confirmed - it takes as much space as the database."
}

# A seed on a new instance: nothing is installed yet, so there is nothing to start.
if [ ! -e "${VS_HOME:-/opt/valuescan}/current/apps/server/src/index.ts" ]; then
  log "restored. No release is installed yet: the indexer and the API start with the first release."
  kept
  exit 0
fi

log "starting the indexer, then the API"
"$SYSTEMCTL" start valuescan-indexer.service || log "the indexer did not start (is a release installed?)"
sleep "${INDEXER_SETTLE_S:-5}"
"$SYSTEMCTL" start valuescan-api.service || log "the API did not start (is a release installed?)"

ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "$API_URL/api/health" 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] && log "the API answers /api/health" || log "WARNING: the API does not answer yet - check: journalctl -u valuescan-api -n 50"

log "restored."
kept
