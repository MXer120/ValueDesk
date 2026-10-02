#!/usr/bin/env bash
# /opt/valuescan/bin/backup.sh - one backup of the index database to S3.
#
# Run by valuescan-backup.timer every night (as the valuescan user, I/O-throttled).
# By hand:   sudo systemctl start valuescan-backup.service
#            journalctl -u valuescan-backup.service -n 50
#
#   1. a consistent copy with VACUUM INTO from a read-only connection - the
#      indexer keeps running (backup-index.mjs explains why not ".backup");
#   2. the copy is integrity-checked;
#   3. zstd-compressed straight into s3://<ops bucket>/backups/, with a .sha256
#      of the UNCOMPRESSED file next to it;
#   4. the staging copy is removed (or kept: BACKUP_KEEP_LOCAL=1).
#
# RETENTION is the bucket's lifecycle rule (network.yaml BackupRetentionDays,
# 14 days by default). This script and the instance role cannot delete a backup.
#
# RESTORE: /opt/valuescan/bin/restore.sh (docs/deploy/DEPLOY.md, "Backups").
set -euo pipefail

: "${OPS_BUCKET:?OPS_BUCKET is not set (see /etc/valuescan/ops.env)}"
: "${VALUESCAN_INDEX_DB:?VALUESCAN_INDEX_DB is not set (see /etc/valuescan/ops.env)}"
STAGING="${BACKUP_STAGING_DIR:-/var/lib/valuescan/backup}"
STATE_DIR="${HEALTH_STATE_DIR:-/var/lib/valuescan/state}"
LEVEL="${BACKUP_ZSTD_LEVEL:-3}"
KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-0}"
NODE="${NODE_BIN_DIR:-/opt/node/current/bin}/node"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] error: %s\n' "$*" >&2; exit 1; }

[ -f "$VALUESCAN_INDEX_DB" ] || die "$VALUESCAN_INDEX_DB does not exist"
command -v zstd >/dev/null 2>&1 || die "zstd is not installed"
command -v aws >/dev/null 2>&1 || die "the AWS CLI is not installed"
mkdir -p "$STAGING"

# Room for the copy: the size of the database, with a margin.
db_bytes="$(stat -c %s "$VALUESCAN_INDEX_DB")"
free_bytes="$(( $(stat -f -c '%a * %S' "$STAGING") ))"
[ "$free_bytes" -gt "$(( db_bytes + db_bytes / 10 ))" ] \
  || die "not enough free space in $STAGING for a copy of $(( db_bytes / 1048576 )) MiB (free: $(( free_bytes / 1048576 )) MiB)"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
copy="$STAGING/valuescan-index-$stamp.db"
key="backups/valuescan-index-$stamp.db.zst"

# A copy left behind by an interrupted run is of no use to anyone.
find "$STAGING" -maxdepth 1 -name 'valuescan-index-*.db' -mmin +180 -delete 2>/dev/null || true
cleanup() { [ "$KEEP_LOCAL" = 1 ] || rm -f "$copy"; }
trap cleanup EXIT

log "copying $VALUESCAN_INDEX_DB ($(( db_bytes / 1048576 )) MiB) to $copy"
report="$("$NODE" --disable-warning=ExperimentalWarning "$HERE/backup-index.mjs" "$VALUESCAN_INDEX_DB" "$copy")"
log "copy verified: $report"

copy_bytes="$(stat -c %s "$copy")"
sha="$(sha256sum "$copy" | awk '{print $1}')"

log "uploading to s3://$OPS_BUCKET/$key"
zstd -T1 "-$LEVEL" -q -c "$copy" | aws s3 cp - "s3://$OPS_BUCKET/$key" --expected-size "$copy_bytes" --no-progress --only-show-errors
printf '%s  valuescan-index-%s.db\n' "$sha" "$stamp" | aws s3 cp - "s3://$OPS_BUCKET/$key.sha256" --only-show-errors

uploaded="$(aws s3api head-object --bucket "$OPS_BUCKET" --key "$key" --query ContentLength --output text)"
[ "${uploaded:-0}" -gt 0 ] || die "the upload is not in the bucket"

if [ "$KEEP_LOCAL" = 1 ]; then
  # Keep only the newest staged copy.
  find "$STAGING" -maxdepth 1 -name 'valuescan-index-*.db' ! -name "$(basename "$copy")" -delete 2>/dev/null || true
fi

mkdir -p "$STATE_DIR"
printf '{"at":"%s","key":"%s","bytes":%s,"compressedBytes":%s,"sha256":"%s"}\n' "$stamp" "$key" "$copy_bytes" "$uploaded" "$sha" > "$STATE_DIR/last-backup.json"
log "done: $key ($(( uploaded / 1048576 )) MiB compressed from $(( copy_bytes / 1048576 )) MiB)"
