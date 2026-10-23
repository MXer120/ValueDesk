#!/usr/bin/env bash
# What Vercel runs when it builds a commit of this repository itself (vercel.json,
# buildCommand) - a deployment from git instead of publish-vercel.sh's upload:
#
#   1. deploy/release/build-web.sh --checkout with deploy/vercel/production.settings:
#      typecheck + vite build, the CSP audit of the result, the legal-page check
#   2. deploy/vercel/package.mjs --out=. : .vercel/output (Build Output API v3) - the
#      site, its headers, the SPA fallback and the /api function (hnd1) to
#      https://$VALUESCAN_ORIGIN. Vercel deploys that directory as it is.
#
# The same steps, settings and output as a release (build-web.sh + publish-vercel.sh);
# only the place differs. Locally: bash deploy/vercel/build.sh (writes ./.vercel/output).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SETTINGS=deploy/vercel/production.settings
[ -f "$SETTINGS" ] || { echo "error: $SETTINGS is missing" >&2; exit 1; }
VALUESCAN_ORIGIN="$(sed -n 's/^VALUESCAN_ORIGIN=\([^[:space:]#]*\).*/\1/p' "$SETTINGS" | tail -n 1)"
[ -n "$VALUESCAN_ORIGIN" ] || { echo "error: $SETTINGS sets no VALUESCAN_ORIGIN" >&2; exit 1; }

sha="${VERCEL_GIT_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo local)}"
name="commit-${sha:0:12}"
echo "building $name (${VERCEL_GIT_COMMIT_REF:-local}) for https://$VALUESCAN_ORIGIN" >&2

WEB_ENV_FILE="$SETTINGS" bash deploy/release/build-web.sh "$name" --checkout
node deploy/vercel/package.mjs --dist=apps/web/dist "--origin=https://$VALUESCAN_ORIGIN" --out=.
