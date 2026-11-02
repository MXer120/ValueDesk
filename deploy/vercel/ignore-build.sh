#!/usr/bin/env bash
# Vercel's Ignored Build Step (vercel.json ignoreCommand): exit 0 skips the build, exit 1 builds.
#
# Only two branches are ever served: `main` (www.valuedesk.so, the valuedesk project) and `beta`
# (beta.valuedesk.so, the valuedesk-beta project - deploy/release/ship-beta.sh). Every other push
# (copy-trading, worktree branches) built a preview nobody opened, each running the whole test
# gate on Vercel's build machine: 38 of the last 100 builds (2026-10-30..11-02), billed as build
# CPU minutes (owner 2026-11-02: "$18 for build cpu minutes"). ship.sh and CI test those commits.
# Each project serves one branch: valuedesk-beta (its deployment URLs start "valuedesk-beta-") only
# `beta`, valuedesk only `main` - the beta project started a build of every main push and cancelled it.
ref="${VERCEL_GIT_COMMIT_REF:-}"
case "${VERCEL_URL:-}" in
  valuedesk-beta-*) want=beta ;;
  valuedesk-*) want=main ;;
  *) want="main beta" ;;
esac
for w in $want; do
  [ "$ref" = "$w" ] && { echo "building $ref"; exit 1; }
done
echo "skipped: this project serves only '$want', not '$ref'"
exit 0
