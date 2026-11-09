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
# vercel.json git.deploymentEnabled keeps every other branch from starting a deployment at all
# (2026-11-02: 33 of 52 deployments in a day were copy-trading or cross-project pushes cancelled here,
# each on a build machine for its clone and this step); this step still splits main and beta.
#
# `ship` (2026-11-09): ship.sh's early web (deploy/release/vercel-web.mjs) - a staged production deployment of the
# tag's commit that ship.sh creates through Vercel's API while CI and the servers run, and promotes at the end. A push
# of `ship` deploys nothing (vercel.json: only main and beta); only that API call reaches here with it, in the main
# project only. It always builds: ship.sh asks for it only when the site changed.
ref="${VERCEL_GIT_COMMIT_REF:-}"
case "${VERCEL_URL:-}" in
  valuedesk-beta-*) want=beta ;;
  valuedesk-*) want="main ship" ;;
  *) want="main beta ship" ;;
esac
served=0
for w in $want; do [ "$ref" = "$w" ] && served=1; done
if [ "$served" = 0 ]; then
  echo "skipped: this project serves only '$want', not '$ref'"
  exit 0
fi

# main: only when the site itself changed since the last deployment that went live (owner 2026-11-09:
# cut hosting cost). Half the pushes of main change only the servers (16 of 32, 2026-11-05..11-08), and
# each rebuilt the same site: 2-2.5 build minutes and another 118 MB deployment kept. ship.sh waits for a
# Production deployment only when parts.mjs finds a web change, and web-changed.mjs builds on a wider set
# than that, so a skipped build is never one ship.sh waits for. Anything it cannot tell builds.
# `beta` always builds: ship-beta.sh waits for every beta push, and its pushes are rare.
# VERCEL_GIT_PREVIOUS_SHA: the commit of this branch's last successful deployment (set only for an
# Ignored Build Step); a skipped push leaves it where it was, so the next range still covers it.
# VS_ALWAYS_BUILD=1 (a Vercel environment variable) builds every push of main again.
prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
sha="${VERCEL_GIT_COMMIT_SHA:-}"
# main at the commit ship.sh already built as `ship` and promoted: the branch `ship-live` names it (ship.sh pushes it with
# main, atomically, only after Vercel read the promoted deployment back as production). That build is live; this one
# would be the same bytes (2-2.5 build minutes, another 118 MB kept). Skipping leaves VERCEL_GIT_PREVIOUS_SHA where it
# was, so main's next build compares a wider range: more builds, never fewer. No answer from GitHub: build.
if [ "$ref" = main ] && [ -n "$sha" ] && [ "${VS_ALWAYS_BUILD:-0}" != 1 ]; then
  live="$(git ls-remote origin refs/heads/ship-live 2>/dev/null | cut -f1 || true)"
  if [ -n "$live" ] && [ "$live" = "$sha" ]; then
    echo "skipped: ship.sh already built ${sha:0:8} and made it live (branch ship-live)"
    exit 0
  fi
fi
if [ "$ref" != main ] || [ -z "$prev" ] || [ -z "$sha" ] || [ "${VS_ALWAYS_BUILD:-0}" = 1 ]; then
  echo "building $ref"
  exit 1
fi
# Vercel clones shallow: fetch the previous commit alone when it is not here (a diff needs both trees only).
if ! git cat-file -e "$prev^{commit}" 2>/dev/null; then
  git fetch -q --no-tags --depth=1 origin "$prev" 2>/dev/null || true
fi
if ! git cat-file -e "$prev^{commit}" 2>/dev/null || ! command -v node >/dev/null 2>&1; then
  echo "building $ref (cannot compare with the last deployment ${prev:0:8})"
  exit 1
fi
if node deploy/vercel/web-changed.mjs "$prev" "$sha"; then
  echo "skipped: the site is the same as in the last deployment (${prev:0:8}), which stays live"
  exit 0
fi
echo "building $ref"
exit 1
