#!/usr/bin/env bash
# /opt/valuescan/bin/backup.sh - one backup of the index database (or, with
# --executor, of the copy executor's database), to S3 or to the data volume.
#
#   backup.sh              the index (valuescan-backup.service, as the valuescan user)
#   backup.sh --executor   the executor's executor.db (valuescan-executor-backup.service,
#                          as valuescan-executor; it runs right after the index backup)
#
# Run by valuescan-backup.timer every night (I/O-throttled); the executor's unit
# comes with it. By hand:
#            sudo systemctl start valuescan-backup.service valuescan-executor-backup.service
#            journalctl -t valuescan-backup -t valuescan-executor-backup -n 50
#
#   1. a consistent copy with VACUUM INTO from a read-only connection - the
#      indexer (or the executor) keeps running (backup-index.mjs explains why not
#      ".backup");
#   2. the copy is integrity-checked;
#   3. zstd-compressed straight into s3://<ops bucket>/backups/ - or, on an
#      instance without an ops bucket (OPS_BUCKET empty: no instance role), into
#      BACKUP_DIR (the executor: EXECUTOR_BACKUP_DIR/archive) on the data volume -
#      with a .sha256 of the UNCOMPRESSED file next to it;
#   4. the staging copy is removed (or kept: BACKUP_KEEP_LOCAL=1, the index only).
#
# THE EXECUTOR: the database only. The files kek and session.key next to it are
# never copied - the followers' keys in the database are sealed with the kek, so a
# backup holds nothing a trade could be signed with. Those two files stay on the
# data volume and in its EBS snapshots.
#
# RETENTION. S3: the bucket's lifecycle rule (network.yaml BackupRetentionDays, 14
# days by default); this script and the instance role cannot delete a backup there.
# On the data volume: the newest BACKUP_KEEP (default 1) index backups and the
# newest EXECUTOR_BACKUP_KEEP (default 7) executor backups are kept, older ones
# removed here. What leaves the box in that case are EBS snapshots of the data
# volume, taken from the workstation (deploy/aws/ec2/provision.sh snapshot): they
# carry these files.
#
# RESTORE: the index with /opt/valuescan/bin/restore.sh (docs/deploy/DEPLOY.md,
# "Backups"); the executor's database by hand (docs/deploy/EC2-VERCEL.md, "The copy
# executor").
set -euo pipefail

WHAT=index
case "${1:-}" in
  '') ;;
  --executor) WHAT=executor ;;
  *) echo "[backup] error: usage: backup.sh [--executor]" >&2; exit 2 ;;
esac

OPS_BUCKET="${OPS_BUCKET:-}"
LEVEL="${BACKUP_ZSTD_LEVEL:-3}"
NODE="${NODE_BIN_DIR:-/opt/node/current/bin}/node"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$WHAT" = executor ]; then
  SOURCE_DB="${EXECUTOR_DB:-/var/lib/valuescan/executor/executor.db}"
  NAME=valuescan-executor
  STAGING="${EXECUTOR_BACKUP_DIR:-/var/lib/valuescan/backup/executor}"
  BACKUP_DIR="$STAGING/archive"
  BACKUP_KEEP="${EXECUTOR_BACKUP_KEEP:-7}"
  # The valuescan user may not read this directory, so the marker is kept here.
  MARKER_DIR="$STAGING"
  KEEP_LOCAL=0
else
  : "${VALUESCAN_INDEX_DB:?VALUESCAN_INDEX_DB is not set (see /etc/valuescan/ops.env)}"
  SOURCE_DB="$VALUESCAN_INDEX_DB"
  NAME=valuescan-index
  STAGING="${BACKUP_STAGING_DIR:-/var/lib/valuescan/backup}"
  BACKUP_DIR="${BACKUP_DIR:-/var/lib/valuescan/backup/archive}"
  BACKUP_KEEP="${BACKUP_KEEP:-1}"
  MARKER_DIR="${HEALTH_STATE_DIR:-/var/lib/valuescan/state}"
  KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-0}"
fi

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] error: %s\n' "$*" >&2; exit 1; }

case "$BACKUP_KEEP" in ''|*[!0-9]*|0) die "the number of backups to keep must be a whole number of at least 1" ;; esac
[ -f "$SOURCE_DB" ] || die "$SOURCE_DB does not exist"
command -v zstd >/dev/null 2>&1 || die "zstd is not installed"
[ -z "$OPS_BUCKET" ] || command -v aws >/dev/null 2>&1 || die "the AWS CLI is not installed"
mkdir -p "$STAGING"
[ -n "$OPS_BUCKET" ] || mkdir -p "$BACKUP_DIR"

# Room for the copy: the size of the database, with a margin.
db_bytes="$(stat -c %s "$SOURCE_DB")"
free_bytes="$(( $(stat -f -c '%a * %S' "$STAGING") ))"
[ "$free_bytes" -gt "$(( db_bytes + db_bytes / 10 ))" ] \
  || die "not enough free space in $STAGING for a copy of $(( db_bytes / 1048576 )) MiB (free: $(( free_bytes / 1048576 )) MiB)"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
copy="$STAGING/$NAME-$stamp.db"
key="backups/$NAME-$stamp.db.zst"

# A copy left behind by an interrupted run is of no use to anyone.
find "$STAGING" -maxdepth 1 -name "$NAME-*.db" -mmin +180 -delete 2>/dev/null || true
cleanup() { [ "$KEEP_LOCAL" = 1 ] || rm -f "$copy"; }
trap cleanup EXIT

log "copying $SOURCE_DB ($(( db_bytes / 1048576 )) MiB) to $copy"
report="$("$NODE" --disable-warning=ExperimentalWarning "$HERE/backup-index.mjs" "$SOURCE_DB" "$copy")"
log "copy verified: $report"

copy_bytes="$(stat -c %s "$copy")"
sha="$(sha256sum "$copy" | awk '{print $1}')"

if [ -n "$OPS_BUCKET" ]; then
  log "uploading to s3://$OPS_BUCKET/$key"
  zstd -T1 "-$LEVEL" -q -c "$copy" | aws s3 cp - "s3://$OPS_BUCKET/$key" --expected-size "$copy_bytes" --no-progress --only-show-errors
  printf '%s  %s-%s.db\n' "$sha" "$NAME" "$stamp" | aws s3 cp - "s3://$OPS_BUCKET/$key.sha256" --only-show-errors

  uploaded="$(aws s3api head-object --bucket "$OPS_BUCKET" --key "$key" --query ContentLength --output text)"
  [ "${uploaded:-0}" -gt 0 ] || die "the upload is not in the bucket"
else
  # No ops bucket: the data volume. Written under a temporary name and renamed, so
  # a half-written file never counts as the newest backup.
  key="$BACKUP_DIR/$NAME-$stamp.db.zst"
  log "compressing to $key"
  # Room for the compressed copy too (about a third of the database; a half is asked).
  free_bytes="$(( $(stat -f -c '%a * %S' "$BACKUP_DIR") ))"
  [ "$free_bytes" -gt "$(( copy_bytes / 2 ))" ] || die "not enough free space in $BACKUP_DIR for the compressed copy"
  zstd -T1 "-$LEVEL" -q -c "$copy" > "$key.partial"
  printf '%s  %s-%s.db\n' "$sha" "$NAME" "$stamp" > "$key.sha256"
  mv -f "$key.partial" "$key"
  uploaded="$(stat -c %s "$key")"
  [ "${uploaded:-0}" -gt 0 ] || die "the compressed copy is empty"
  # Keep the newest BACKUP_KEEP (names sort by their UTC time); remove the rest
  # and anything an interrupted run left half-written.
  find "$BACKUP_DIR" -maxdepth 1 -name "$NAME-*.db.zst.partial" -mmin +180 -delete 2>/dev/null || true
  ls -1 "$BACKUP_DIR" | grep -E "^$NAME-[0-9TZ]+\\.db\\.zst\$" | sort -r | tail -n +"$((BACKUP_KEEP + 1))" | while IFS= read -r old; do
    log "removing the older backup $old"
    rm -f "$BACKUP_DIR/$old" "$BACKUP_DIR/$old.sha256"
  done
fi

if [ "$KEEP_LOCAL" = 1 ]; then
  # Keep only the newest staged copy.
  find "$STAGING" -maxdepth 1 -name "$NAME-*.db" ! -name "$(basename "$copy")" -delete 2>/dev/null || true
fi

mkdir -p "$MARKER_DIR"
printf '{"at":"%s","key":"%s","bytes":%s,"compressedBytes":%s,"sha256":"%s"}\n' "$stamp" "$key" "$copy_bytes" "$uploaded" "$sha" > "$MARKER_DIR/last-backup.json"
log "done: $key ($(( uploaded / 1048576 )) MiB compressed from $(( copy_bytes / 1048576 )) MiB)"
