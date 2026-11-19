#!/usr/bin/env bash
# What Vercel runs when it builds a commit of this repository itself (vercel.json,
# buildCommand) - a deployment from git instead of publish-vercel.sh's upload:
#
#   0. NO TEST RUN HERE BY DEFAULT: main only moves after ship.sh's test gate (GitHub CI for the
#      tag, every type check and offline test) has passed for that same commit, so running
#      deploy/ci/run-tests.mjs again on Vercel only bought billed build minutes, 2-4 per build
#      (owner 2026-11-02: "reduce cost as much as possible"). The web typecheck still runs in
#      step 1. VS_RUN_TESTS=1 (a Vercel environment variable) runs the suite here again.
#   1. deploy/release/build-web.sh --checkout with deploy/vercel/production.settings:
#      typecheck + vite build, the CSP audit of the result, the legal-page check
#   2. deploy/vercel/package.mjs --out=. : .vercel/output (Build Output API v3) - the
#      site, its headers, the SPA fallback and the /api function (hnd1) to
#      https://$VALUESCAN_ORIGIN. Vercel deploys that directory as it is.
#
#   THE BETA SITE: a commit of the git branch `beta` (Vercel's VERCEL_GIT_COMMIT_REF; VS_CHANNEL=beta
#   locally) is built for beta.valuedesk.so: production.settings with deploy/vercel/beta.settings over
#   it (VITE_CHANNEL=beta, the beta API's socket), and the function told to reach the beta API.
#
# The same steps, settings and output as a release (build-web.sh + publish-vercel.sh);
# only the place differs. Locally: bash deploy/vercel/build.sh (writes ./.vercel/output).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SETTINGS=deploy/vercel/production.settings
[ -f "$SETTINGS" ] || { echo "error: $SETTINGS is missing" >&2; exit 1; }
VALUESCAN_ORIGIN="$(sed -n 's/^VALUESCAN_ORIGIN=\([^[:space:]#]*\).*/\1/p' "$SETTINGS" | tail -n 1)"
[ -n "$VALUESCAN_ORIGIN" ] || { echo "error: $SETTINGS sets no VALUESCAN_ORIGIN" >&2; exit 1; }

CHANNEL=main
if [ "${VERCEL_GIT_COMMIT_REF:-}" = beta ] || [ "${VS_CHANNEL:-}" = beta ]; then
  CHANNEL=beta
  merged="$(mktemp)"
  cat "$SETTINGS" deploy/vercel/beta.settings > "$merged"
  SETTINGS="$merged"
fi

sha="${VERCEL_GIT_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo local)}"
name="commit-${sha:0:12}"
echo "building $name (${VERCEL_GIT_COMMIT_REF:-local}, channel $CHANNEL) for https://$VALUESCAN_ORIGIN" >&2

if [ "${VS_RUN_TESTS:-0}" != 1 ]; then
  echo "tests: not run here - ship.sh's gate (GitHub CI for the tag) passed this commit before main moved" >&2
else
  if ! node deploy/ci/run-tests.mjs --jobs="${VS_TEST_JOBS:-3}" --skip=web-typecheck; then
    echo "error: the tests failed - $name is not deployed (the failing suites are listed above)" >&2
    exit 1
  fi
fi

WEB_ENV_FILE="$SETTINGS" bash deploy/release/build-web.sh "$name" --checkout
# The Fed live widget's speech model, served from the site itself - from the build cache Vercel
# restores (package.mjs MODEL_CACHE), fetched from Hugging Face only when it is not there.
bash deploy/vercel/fetch-model.sh apps/web/dist .cache/valuedesk-model
node deploy/vercel/package.mjs --dist=apps/web/dist "--origin=https://$VALUESCAN_ORIGIN" --out=. "--channel=$CHANNEL"
