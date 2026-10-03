#!/usr/bin/env bash
# Start a NEW instance from an index you already have, instead of from nothing.
#
#   deploy/release/seed-index.sh <path to valuescan-index.db>
#   ... --work-dir=<dir>  where the snapshot is made (default: deploy/.out, or $SEED_WORK_DIR)
#   ... --print           show the AWS commands, run none (the local copy is still made)
#   ... --no-upload       make the snapshot and stop
#   ... --allow-synced    make it even though the work directory is in a synced folder
#
# WHY. A cold index needs a day for the 24h boards with the trade filter, a week
# for the 7d ones, a month for the 30d ones, and 90 days of daily snapshots for
# 90d / YTD (docs/INDEXER.md, "Cold start"). An index that has been running on a
# development machine carries all of that.
#
#   1. a consistent snapshot of the database (deploy/server/bin/backup-index.mjs:
#      read-only, VACUUM INTO - the local indexer may keep running);
#   2. compressed with zstd and uploaded to s3://<ops bucket>/seed/ - or, on the
#      EC2 test instance (no instance role), copied over SSH to
#      /var/lib/valuescan/backup/seed/ (after bootstrap-instance.sh: the data
#      volume must be mounted);
#   3. on the instance, BEFORE the first release:
#        deploy/release/remote.sh restore seed/<name>.db.zst --yes
#        deploy/release/remote.sh restore /var/lib/valuescan/backup/seed/<name>.db.zst --yes   (EC2)
#
# COST ON THE MACHINE IT READS FROM: the whole database is read once and a copy of
# the same size is written to the work directory (then its compressed form, about
# a third; the copy is removed). With a running indexer that competes for the disk
# for a few minutes and its WAL grows meanwhile. Pick a quiet moment.
#
# THE WORK DIRECTORY must not be in a folder that is synced somewhere (OneDrive,
# Dropbox, iCloud, Google Drive): the copy is gigabytes and would be uploaded
# there as well. The script refuses such a directory; name another one.
#
# The index holds public trading data only (addresses, fills, PnL) - no keys, no
# secrets. The seed expires from the bucket after 14 days.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SOURCE=""
UPLOAD=1
ALLOW_SYNCED=0
WORK="${SEED_WORK_DIR:-}"
for arg in "$@"; do
  case "$arg" in
    --print) PRINT_ONLY=1 ;;
    --no-upload) UPLOAD=0 ;;
    --allow-synced) ALLOW_SYNCED=1 ;;
    --work-dir=*) WORK="${arg#--work-dir=}" ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $arg" ;;
    *) SOURCE="$arg" ;;
  esac
done
[ -n "$SOURCE" ] || die "usage: deploy/release/seed-index.sh <path to valuescan-index.db> [--work-dir=<dir>] [--print] [--no-upload]"
[ -f "$SOURCE" ] || die "$SOURCE does not exist"

# node and aws are native programs on Windows and Git Bash's path conversion is
# off (lib.sh): hand them C:/... instead of /c/...
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

[ -n "$WORK" ] || WORK="$OUT_DIR"
mkdir -p "$WORK"
WORK="$(native "$(cd "$WORK" && pwd)")"
SOURCE="$(native "$(cd "$(dirname "$SOURCE")" && pwd)/$(basename "$SOURCE")")"

# Is the directory inside a folder a sync client uploads? By the folder names the
# clients use, and by the OneDrive roots Windows names in the environment.
in_synced_folder() {
  local p="/${1#/}/" root
  case "$p" in
    */OneDrive/*|*/"OneDrive - "*|*/Dropbox/*|*/iCloudDrive/*|*/"Mobile Documents"/*|*/"Google Drive"/*|*/"My Drive"/*) return 0 ;;
  esac
  for root in "${OneDrive:-}" "${OneDriveConsumer:-}" "${OneDriveCommercial:-}"; do
    [ -n "$root" ] || continue
    root="$(native "$root")"
    case "$p" in "/${root#/}/"*) return 0 ;; esac
  done
  return 1
}
if in_synced_folder "$WORK" && [ "$ALLOW_SYNCED" != 1 ]; then
  die "the work directory $WORK is in a synced folder: the copy (as large as the index) would be uploaded there too.
       Name a directory outside it:  --work-dir=<dir>   (or pass --allow-synced)"
fi

# Room for the copy and, for a moment, its compressed form next to it.
need_kb=$(( $(wc -c < "$SOURCE") / 1024 * 3 / 2 ))
free_kb="$(df -Pk "$WORK" | awk 'NR==2 {print $4}')"
case "$free_kb" in ''|*[!0-9]*) free_kb="" ;; esac
if [ -n "$free_kb" ] && [ "$free_kb" -lt "$need_kb" ]; then
  die "not enough room in $WORK: about $((need_kb / 1024)) MiB needed, $((free_kb / 1024)) MiB free"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="valuescan-index-seed-$stamp.db"
copy="$WORK/$name"

note "snapshot of $SOURCE -> $copy"
node --disable-warning=ExperimentalWarning deploy/server/bin/backup-index.mjs "$SOURCE" "$copy"
printf '%s  %s\n' "$(sha256_of "$copy")" "$name" > "$copy.zst.sha256"

note "compressing"
IN="$copy" OUT="$copy.zst" node --input-type=module -e '
  import { createReadStream, createWriteStream } from "node:fs";
  import { pipeline } from "node:stream/promises";
  import zlib from "node:zlib";
  if (typeof zlib.createZstdCompress !== "function") { console.error("this Node has no zstd (22.15+ needed)"); process.exit(1); }
  await pipeline(createReadStream(process.env.IN), zlib.createZstdCompress(), createWriteStream(process.env.OUT));
'
rm -f "$copy"
note "seed: $copy.zst ($(du -h "$copy.zst" | awk '{print $1}'))"

if [ "$UPLOAD" = 1 ]; then
  load_params
  if [ "$VS_TARGET" = ec2 ]; then
    remote="/var/lib/valuescan/backup/seed/$name.zst"
    ssh_put "$copy.zst" "$remote"
    ssh_put "$copy.zst.sha256" "$remote.sha256"
    note "copied. On the instance, before the first release:"
    note "  deploy/release/remote.sh restore $remote --yes"
  else
    OPS="$(ops_bucket)"
    run aws s3 cp "$copy.zst" "s3://$OPS/seed/$name.zst" --only-show-errors
    run aws s3 cp "$copy.zst.sha256" "s3://$OPS/seed/$name.zst.sha256" --only-show-errors
    note "uploaded. On the instance, before the first release:"
    note "  deploy/release/remote.sh restore seed/$name.zst --yes"
  fi
  note "Then delete the local seed: $copy.zst"
fi
