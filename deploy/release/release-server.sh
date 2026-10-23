#!/usr/bin/env bash
# Release the server (indexer + API + copy executor) of one git tag to the instance.
#
#   deploy/release/release-server.sh <tag>                   restart what runs changed code (below)
#   deploy/release/release-server.sh <tag> --all             restart the indexer, the API, the executor
#   deploy/release/release-server.sh <tag> --api-only        restart the API only
#   deploy/release/release-server.sh <tag> --executor-only   restart the copy executor only
#   ... --print                                               show the AWS commands, run none
#   VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env ...               another EC2 environment (lib.sh)
#
#   1. `git archive` of the TAG (never the working tree): the lockfile, the server
#      workspace, the other workspaces' package.json files (the lockfile names
#      them), deploy/server - and, in a tag that has them, the copy executor
#      (apps/executor) with the two packages it runs from (packages/copy-engine,
#      packages/sodex-core);
#   2. the tarball and its .sha256 go to s3://<ops bucket>/releases/server/ - or,
#      on the EC2 test instance (no instance role), over SSH to
#      /var/cache/valuescan/inbox/;
#   3. /opt/valuescan/bin/release.sh <tag> runs on the instance (SSM Run Command, or
#      SSH): verify, unpack, `npm ci` for the server workspace, switch the
#      `current` link, restart in order (indexer, API, executor) the units whose
#      code differs from what they run now, check /api/health and /api/copy/v1/health.
#
# By default a unit whose code the tag does not change keeps running: a release
# that does not touch apps/executor, packages/copy-engine, packages/sodex-core or
# the installed dependencies never stops a live copy or algo.
#
# --api-only: when the release changes nothing the indexer runs. Restarting the
# indexer costs its Lighter stream 3.5-8 minutes; restarting the API costs seconds.
# --executor-only: when the release changes the copy executor only.
#
# Roll back: deploy/release/rollback.sh server
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TAG=""
API_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --all|--api-only|--executor-only) [ -z "$API_ONLY" ] || die "--all, --api-only and --executor-only exclude each other"; API_ONLY=" $arg" ;;
    --print) PRINT_ONLY=1 ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $arg" ;;
    *) [ -z "$TAG" ] || die "one tag at a time"; TAG="$arg" ;;
  esac
done
[ -n "$TAG" ] || die "usage: deploy/release/release-server.sh <tag> [--all|--api-only|--executor-only] [--print]"
require_tag "$TAG"
load_params

mkdir -p "$OUT_DIR"
tarball="$OUT_DIR/valuescan-server-$TAG.tar.gz"
note "archiving tag $TAG"
# The copy executor and what it imports, where the tag has them (older tags do not:
# git archive refuses a path that matches nothing).
executor_paths=()
if git cat-file -e "$TAG:apps/executor/src/main.ts" 2>/dev/null; then
  for p in apps/executor packages/copy-engine packages/sodex-core; do
    git cat-file -e "$TAG:$p" 2>/dev/null || die "tag $TAG has apps/executor but not $p, which it imports"
    executor_paths+=("$p")
  done
  note "with the copy executor (${executor_paths[*]})"
else
  note "tag $TAG has no apps/executor: a release without the copy executor"
fi
git archive --format=tar.gz --prefix="valuescan-$TAG/" -o "$tarball" "$TAG" -- \
  package.json package-lock.json apps/server apps/web/package.json 'packages/*/package.json' deploy/server \
  ${executor_paths[@]+"${executor_paths[@]}"} \
  || die "git archive failed - does tag $TAG contain deploy/server?"
# Nothing that could carry a secret may be in a release - a self-hosted copier's data
# directory (copier-data/: kek, session.key, executor.db) included.
if tar -tzf "$tarball" | grep -E '(^|/)\.env($|\.)|\.pem$|\.key$|keystore\.json$|local-api\.token$|(^|/)kek$|(^|/)copier-data/|executor\.db' | grep -v '\.env\.example$' >&2; then
  die "the archive of $TAG contains the files listed above - refusing to upload it"
fi
printf '%s  %s\n' "$(sha256_of "$tarball")" "$(basename "$tarball")" > "$tarball.sha256"
note "built $tarball ($(du -h "$tarball" | awk '{print $1}'))"

if [ "$VS_TARGET" = ec2 ]; then
  inbox="/var/cache/valuescan/inbox/valuescan-server-$TAG.tar.gz"
  ssh_put "$tarball" "$inbox"
  ssh_put "$tarball.sha256" "$inbox.sha256"
  ssh_run "valuescan release $TAG" "/opt/valuescan/bin/release.sh $TAG$API_ONLY --from=$inbox && rm -f $inbox $inbox.sha256"
else
  OPS="$(ops_bucket)"
  INSTANCE="$(instance_id)"
  run aws s3 cp "$tarball" "s3://$OPS/releases/server/valuescan-server-$TAG.tar.gz" --only-show-errors
  run aws s3 cp "$tarball.sha256" "s3://$OPS/releases/server/valuescan-server-$TAG.tar.gz.sha256" --only-show-errors
  ssm_run "$INSTANCE" "valuescan release $TAG" "/opt/valuescan/bin/release.sh $TAG$API_ONLY"
fi
note "released $TAG"
