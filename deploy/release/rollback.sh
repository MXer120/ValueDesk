#!/usr/bin/env bash
# Go back to a previous release. The web and the server roll back independently.
#
#   deploy/release/rollback.sh web <tag>             publish the stored build of <tag> again
#   deploy/release/rollback.sh server                the release before the current one
#   deploy/release/rollback.sh server --api-only     ... restarting the API only
#   deploy/release/rollback.sh status                what the instance runs
#   ... --print                                       show the AWS commands, run none
#
# WEB. Every published build is kept in the ops bucket (releases/web/). A rollback
# uploads that build's HTML and files again and invalidates CloudFront; the hashed
# assets of every release are still in the site bucket, so it takes a minute.
# On the EC2 test environment the web is on Vercel, where every deployment is kept:
# `npx vercel@latest rollback` (or publish-vercel.sh <older tag> --deploy).
#
# SERVER. The instance keeps the last few releases installed. A rollback switches
# the `current` link back and restarts in order (indexer, then API). To go back
# further than one release, release that tag again: release-server.sh <tag>.
#
# THE DATABASE IS NOT ROLLED BACK. Schema changes so far only add tables and
# columns, which older code ignores. If a release ever changes data in a way the
# previous code cannot read, its notes must say so, and going back then means
# restoring a backup taken before it (deploy/server/bin/restore.sh).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

WHAT="${1:-}"
[ -n "$WHAT" ] || { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
shift
TAG=""
API_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --api-only) API_ONLY=" --api-only" ;;
    --print) PRINT_ONLY=1 ;;
    -*) die "unknown option $arg" ;;
    *) TAG="$arg" ;;
  esac
done

case "$WHAT" in
  web)
    [ -n "$TAG" ] || die "usage: deploy/release/rollback.sh web <tag>"
    select_target
    [ "$VS_TARGET" != ec2 ] || die "the web of the EC2 test environment is on Vercel: npx vercel@latest rollback (the previous production deployment), or deploy/release/publish-vercel.sh $TAG --deploy"
    args=(--rollback "$TAG")
    [ "$PRINT_ONLY" = 1 ] && args+=(--print)
    exec "$RELEASE_DIR/publish-web.sh" "${args[@]}"
    ;;
  server)
    [ -z "$TAG" ] || die "a server rollback takes no tag (it goes back one release); to install a specific tag: release-server.sh $TAG"
    load_params
    remote_run "valuescan rollback" "/opt/valuescan/bin/release.sh --rollback$API_ONLY"
    ;;
  status)
    load_params
    remote_run "valuescan status" "/opt/valuescan/bin/release.sh --status"
    ;;
  *) die "unknown target $WHAT (web | server | status)" ;;
esac
