#!/usr/bin/env bash
# Replace the origin secret of the EC2 test environment without a gap.
#
#   deploy/release/rotate-origin-secret.sh begin    a new value; the instance accepts both
#   deploy/release/rotate-origin-secret.sh finish   the new value is the only one
#   ... --print                                      show the commands, run none
#
# The secret is shared by the Vercel function (it sends X-Origin-Verify) and the
# instance (Caddy and the API accept it). The instance can accept two values at
# once (VALUESCAN_ORIGIN_SECRET=current,next - apps/server/src/hosted.ts), so:
#
#   1. rotate-origin-secret.sh begin
#        writes <ORIGIN_SECRET_DIR>/origin-secret.next (never printed) and runs
#        bootstrap-instance.sh: Caddy and the API now accept the old AND the new value.
#   2. put the new value into Vercel and deploy again (an environment variable
#      reaches only deployments made after it changed):
#        npx vercel@latest env rm VALUESCAN_ORIGIN_SECRET production --yes
#        npx vercel@latest env add VALUESCAN_ORIGIN_SECRET production --sensitive < <dir>/origin-secret.next
#        deploy/release/publish-vercel.sh <tag> --deploy      (or: npx vercel@latest redeploy <production url>)
#      Until the new deployment is live the old one sends the old value - accepted.
#   3. rotate-origin-secret.sh finish
#        the new value becomes origin-secret, the old one is gone, bootstrap-instance.sh
#        again: only the new value is accepted.
#
# The CloudFormation environment rotates with deploy/aws/deploy.sh secret --rotate
# (docs/deploy/DEPLOY.md, "Rotating the origin secret").
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

STEP=""
for arg in "$@"; do
  case "$arg" in
    begin|finish) STEP="$arg" ;;
    --print) PRINT_ONLY=1 ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $arg" ;;
  esac
done
[ -n "$STEP" ] || die "usage: deploy/release/rotate-origin-secret.sh begin|finish [--print]"
load_params
[ "$VS_TARGET" = ec2 ] || die "this is for the EC2 test environment; the CloudFormation one rotates with deploy/aws/deploy.sh secret --rotate"

current="$ORIGIN_SECRET_DIR/origin-secret"
next="$current.next"
[ -f "$current" ] || die "$current does not exist - the first bootstrap-instance.sh creates it"

if [ "$STEP" = begin ]; then
  [ ! -f "$next" ] || die "$next exists already: a rotation is under way - finish it (or remove that file if it was never used)"
  note "a new origin secret into $next (not shown)"
  if [ "$PRINT_ONLY" != 1 ]; then
    ( umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$next" )
    chmod 600 "$next" 2>/dev/null || true
    if command -v icacls >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
      icacls "$(cygpath -w "$next")" /inheritance:r /grant:r "${USERNAME:-$USER}:F" >/dev/null || note "WARNING: could not narrow the ACL of $next"
    fi
  fi
  args=(); [ "$PRINT_ONLY" = 1 ] && args=(--print)
  "$RELEASE_DIR/bootstrap-instance.sh" ${args[@]+"${args[@]}"}
  note "the instance accepts the old and the new value. Now put the new one into Vercel and deploy (step 2 in --help),"
  note "then: deploy/release/rotate-origin-secret.sh finish"
else
  [ -f "$next" ] || die "there is no rotation under way ($next does not exist)"
  note "make sure the Vercel production deployment that is LIVE was made after the new value was set:"
  note "  npx vercel@latest ls valuexplorer --prod     (its age), and the index pages load"
  if [ "$PRINT_ONLY" != 1 ]; then
    mv -f "$next" "$current"
  fi
  args=(); [ "$PRINT_ONLY" = 1 ] && args=(--print)
  "$RELEASE_DIR/bootstrap-instance.sh" ${args[@]+"${args[@]}"}
  note "done: only the new value is accepted."
fi
