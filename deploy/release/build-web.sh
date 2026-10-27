#!/usr/bin/env bash
# Build the production web bundle of one tag. Local only: nothing is uploaded.
#
#   deploy/release/build-web.sh <tag>
#   deploy/release/build-web.sh <tag> --allow-dirty      build what is checked out now (smoke tests)
#   deploy/release/build-web.sh <tag> --public           a build for the public: the legal pages must be complete
#   deploy/release/build-web.sh <name> --checkout        build a checkout that has no tag or no .git (Vercel's
#                                                        build of a commit, deploy/vercel/build.sh): every
#                                                        release check except the tag's
#
# Output: deploy/.out/valuescan-web-<tag>.tar.gz (+ .sha256) - what
# publish-web.sh publishes and what a rollback re-publishes.
#
# The build-time settings come from deploy/release/web.env (copy web.env.example).
# EVERY documented VITE_* variable is exported to the build, set or empty, and the
# build stops if apps/web holds a .env file with a VITE_* variable this script
# does not know: a development value must never end up in a production bundle.
#
# Steps: typecheck + vite build (npm --prefix apps/web run build), the static
# audit of the result against the production CSP (deploy/smoke/audit-dist.mjs),
# the legal pages (apps/web/tools/check-legal.ts: no [[OWNER: ...]] placeholder may
# be left - a WARNING for a test deployment, an ERROR with --public), then the tarball.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TAG=""
ALLOW_DIRTY=0
PUBLIC=0
CHECKOUT=0
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --public) PUBLIC=1 ;;
    --checkout) CHECKOUT=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $arg" ;;
    *) [ -z "$TAG" ] || die "one tag at a time"; TAG="$arg" ;;
  esac
done
[ -n "$TAG" ] || die "usage: deploy/release/build-web.sh <tag> [--allow-dirty]"
if [ "$ALLOW_DIRTY" = 1 ]; then
  valid_tag "$TAG" || die "not a usable name: $TAG"
  note "building the working tree as it is, under the name $TAG (--allow-dirty: not a release)"
elif [ "$CHECKOUT" = 1 ]; then
  valid_tag "$TAG" || die "not a usable name: $TAG"
  note "building the checkout as it is, under the name $TAG (--checkout: a commit's build, release checks apply)"
else
  require_tag "$TAG"
  require_clean_checkout "$TAG"
fi

# The variables a production build knows. Keep in step with web.env.example.
VITE_VARS=(
  VITE_WALLETCONNECT_PROJECT_ID
  VITE_BUILDER_ID VITE_BUILDER_FEE_PERPS VITE_BUILDER_FEE_SPOT VITE_BUILDER_MAX_FEE
  VITE_BUILDER_REQUIRED VITE_BUILDER_TERMS_KEYS
  VITE_SODEX_NETWORK VITE_SODEX_GATEWAY
  VITE_ALLOW_MAINNET_TRADING VITE_TRADING_DISABLED VITE_TRADING_KEY_TTL_H
  VITE_CHART VITE_FEEDBACK_URL
)

WEB_ENV="${WEB_ENV_FILE:-deploy/release/web.env}"
if [ -f "$WEB_ENV" ]; then
  load_env_file "$WEB_ENV"
elif [ "$ALLOW_DIRTY" = 1 ]; then
  note "no $WEB_ENV: building with every VITE_* setting empty"
else
  die "missing $WEB_ENV - copy deploy/release/web.env.example and fill it in"
fi
for v in "${VITE_VARS[@]}"; do
  value="${!v:-}"
  case "$value" in *__*)
    [ "$ALLOW_DIRTY" = 1 ] || die "$v still holds a placeholder in $WEB_ENV"
    value="" ;;
  esac
  export "$v=$value"
done
# A public build never makes the builder fee optional (apps/web/src/trading/config.ts).
if [ "$PUBLIC" = 1 ] && [ "$VITE_BUILDER_REQUIRED" = 0 ]; then
  die "VITE_BUILDER_REQUIRED=0 (the fee optional) is for test builds only - not with --public"
fi
if [ -z "$VITE_WALLETCONNECT_PROJECT_ID" ]; then
  [ "$ALLOW_DIRTY" = 1 ] || die "VITE_WALLETCONNECT_PROJECT_ID is empty: wallets could not connect by WalletConnect in this build"
  note "VITE_WALLETCONNECT_PROJECT_ID is empty: this build cannot connect wallets by WalletConnect"
fi

# Vite also reads apps/web/.env, .env.local, .env.production and .env.production.local.
# Variables exported above win over those files; a VITE_* name we do not export would not.
known=" ${VITE_VARS[*]} "
for f in apps/web/.env apps/web/.env.local apps/web/.env.production apps/web/.env.production.local; do
  [ -f "$f" ] || continue
  while IFS= read -r name; do
    case "$known" in *" $name "*) ;; *) die "$f sets $name, which this script does not control - add it to web.env.example and VITE_VARS, or remove it" ;; esac
  done < <(sed -n 's/^[[:space:]]*\(VITE_[A-Z0-9_]*\)[[:space:]]*=.*/\1/p' "$f")
done

note "building apps/web for tag $TAG"
for v in "${VITE_VARS[@]}"; do
  shown="${!v}"; [ -n "$shown" ] || shown="(empty)"
  note "  $v=$shown"
done
run npm --prefix apps/web run build

DIST=apps/web/dist
[ -f "$DIST/index.html" ] || die "the build produced no $DIST/index.html"
run node deploy/smoke/audit-dist.mjs "$DIST"

# The legal pages: their drafts carry [[OWNER: ...]] placeholders until the owner
# fills them in. A test deployment may go out with them (a warning); a public one
# may not (--public: an error).
note "checking the legal pages for placeholders"
if (cd apps/web && npx --no-install tsx tools/check-legal.ts --dist dist); then
  :
else
  code=$?
  [ "$code" = 1 ] || die "the legal-page check could not run (exit $code): cd apps/web && npx tsx tools/check-legal.ts --dist dist"
  [ "$PUBLIC" != 1 ] || die "the legal pages still hold placeholders (listed above) - a public build cannot ship them (apps/web/src/legal)"
  note "WARNING: the legal pages still hold placeholders (listed above). Fine for a test deployment; build with --public before a launch."
fi

mkdir -p "$OUT_DIR"
tarball="$OUT_DIR/valuescan-web-$TAG.tar.gz"
run tar -czf "$tarball" -C "$DIST" .
printf '%s  %s\n' "$(sha256_of "$tarball")" "$(basename "$tarball")" > "$tarball.sha256"
note "built $tarball ($(du -h "$tarball" | awk '{print $1}')), sha256 $(awk '{print $1}' "$tarball.sha256")"
note "next: deploy/release/publish-web.sh $TAG"
