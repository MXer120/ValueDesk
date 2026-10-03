#!/usr/bin/env bash
# Release the server (indexer + API) of one git tag to the instance.
#
#   deploy/release/release-server.sh <tag>              restart the indexer, then the API
#   deploy/release/release-server.sh <tag> --api-only   restart the API only
#   ... --print                                          show the AWS commands, run none
#
#   1. `git archive` of the TAG (never the working tree): the lockfile, the server
#      workspace, the other workspaces' package.json files (the lockfile names
#      them) and deploy/server;
#   2. the tarball and its .sha256 go to s3://<ops bucket>/releases/server/ - or,
#      on the EC2 test instance (no instance role), over SSH to
#      /var/cache/valuescan/inbox/;
#   3. /opt/valuescan/bin/release.sh <tag> runs on the instance (SSM Run Command, or
#      SSH): verify, unpack, `npm ci` for the server workspace, switch the
#      `current` link, restart in order, check /api/health.
#
# --api-only: when the release changes nothing the indexer runs. Restarting the
# indexer costs its Lighter stream 3.5-8 minutes; restarting the API costs seconds.
#
# Roll back: deploy/release/rollback.sh server
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TAG=""
API_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --api-only) API_ONLY=" --api-only" ;;
    --print) PRINT_ONLY=1 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $arg" ;;
    *) [ -z "$TAG" ] || die "one tag at a time"; TAG="$arg" ;;
  esac
done
[ -n "$TAG" ] || die "usage: deploy/release/release-server.sh <tag> [--api-only] [--print]"
require_tag "$TAG"
load_params

mkdir -p "$OUT_DIR"
tarball="$OUT_DIR/valuescan-server-$TAG.tar.gz"
note "archiving tag $TAG"
git archive --format=tar.gz --prefix="valuescan-$TAG/" -o "$tarball" "$TAG" -- \
  package.json package-lock.json apps/server apps/web/package.json 'packages/*/package.json' deploy/server \
  || die "git archive failed - does tag $TAG contain deploy/server?"
# Nothing that could carry a secret may be in a release.
if tar -tzf "$tarball" | grep -E '(^|/)\.env($|\.)|\.pem$|\.key$|keystore\.json$|local-api\.token$' | grep -v '\.env\.example$' >&2; then
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
