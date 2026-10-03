#!/usr/bin/env bash
# Publish a built web bundle to Vercel (the EC2 + Vercel test environment).
#
#   deploy/release/publish-vercel.sh <tag> --out=<dir>            prepare the deployment directory
#   deploy/release/publish-vercel.sh <tag> --out=<dir> --deploy   ... and deploy it to production
#   ... --origin=<host>     the instance's name (default: from deploy/aws/ec2: ORIGIN_DOMAIN_NAME,
#                           else <elastic-ip-with-dashes>.sslip.io)
#   ... --allow-synced      allow an --out inside a synced folder (OneDrive, Dropbox, ...)
#
# Input: deploy/.out/valuescan-web-<tag>.tar.gz from deploy/release/build-web.sh.
#
#   1. the tarball is checked against its .sha256, unpacked and audited against the
#      production CSP (deploy/smoke/audit-dist.mjs), as publish-web.sh does;
#   2. deploy/vercel/package.mjs writes <dir>/.vercel/output: the build, the routes
#      with the production headers, and the /api function (fra1) that forwards to
#      https://<origin> with the origin secret;
#   3. with --deploy:  npx vercel@latest deploy --prebuilt --prod --cwd <dir>
#      (the directory must be linked once: npx vercel@latest link --yes --project
#      <VERCEL_PROJECT> --scope <VERCEL_SCOPE> --cwd <dir>, which writes
#      <dir>/.vercel/project.json; packaging keeps that file).
#
# <dir> should be outside the repository's synced folder: the CLI uploads what is
# there, and it is rewritten on every publish. Nothing secret is ever written into
# it - the origin secret is a Vercel environment variable (production only):
#   npx vercel@latest env add VALUESCAN_ORIGIN_SECRET production --sensitive < <ORIGIN_SECRET_DIR>/origin-secret
# An environment variable reaches only deployments made after it was set.
#
# Rollback: npx vercel@latest rollback (the previous production deployment), or
# publish an older tag again.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TAG=""
OUT=""
ORIGIN=""
DEPLOY=0
ALLOW_SYNCED=0
for arg in "$@"; do
  case "$arg" in
    --out=*) OUT="${arg#--out=}" ;;
    --origin=*) ORIGIN="${arg#--origin=}" ;;
    --deploy) DEPLOY=1 ;;
    --allow-synced) ALLOW_SYNCED=1 ;;
    --print) PRINT_ONLY=1 ;;
    -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $arg" ;;
    *) [ -z "$TAG" ] || die "one tag at a time"; TAG="$arg" ;;
  esac
done
[ -n "$TAG" ] || die "usage: deploy/release/publish-vercel.sh <tag> --out=<dir> [--deploy] [--origin=<host>]"
valid_tag "$TAG" || die "not a usable tag name: $TAG"
[ -n "$OUT" ] || OUT="${VERCEL_DEPLOY_DIR:-}"
[ -n "$OUT" ] || die "name the deployment directory: --out=<dir> (outside the synced folder, e.g. --out=/c/Temp/valuedesk-deploy)"
command -v cygpath >/dev/null 2>&1 && OUT="$(cygpath -u "$OUT")"
# node and npx are native programs on Windows and Git Bash's path conversion is off
# (lib.sh): hand them C:/... instead of /c/...
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# The same test as seed-index.sh: a directory a sync client uploads.
case "/${OUT#/}/" in
  */OneDrive/*|*/"OneDrive - "*|*/Dropbox/*|*/iCloudDrive/*|*/"Google Drive"/*)
    [ "$ALLOW_SYNCED" = 1 ] || die "$OUT is in a synced folder - name another --out (or pass --allow-synced)" ;;
esac

VS_TARGET="${VS_TARGET:-ec2}"
if [ -z "$ORIGIN" ]; then
  load_params
  [ "$VS_TARGET" = ec2 ] || die "the Vercel edge belongs to the EC2 test environment (deploy/aws/ec2/ec2.env); or name --origin=<host>"
  ORIGIN="$ORIGIN_DOMAIN_NAME"
fi
[[ "$ORIGIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "the origin must be a DNS name, no scheme: $ORIGIN"
: "${VERCEL_PROJECT:=valuedesk}"
: "${VERCEL_SCOPE:=}"

tarball="$OUT_DIR/valuescan-web-$TAG.tar.gz"
if [ "$PRINT_ONLY" != 1 ]; then
  [ -f "$tarball" ] || die "$tarball does not exist - build it first: deploy/release/build-web.sh $TAG"
  [ -f "$tarball.sha256" ] || die "$tarball.sha256 is missing"
  [ "$(awk '{print $1; exit}' "$tarball.sha256")" = "$(sha256_of "$tarball")" ] || die "$tarball does not match its checksum"
fi

stage="$OUT/.stage-$TAG"
note "unpacking and auditing the build of $TAG"
if [ "$PRINT_ONLY" != 1 ]; then
  mkdir -p "$OUT"
  rm -rf "$stage"
  mkdir -p "$stage"
  tar -xzf "$tarball" -C "$stage"
  run node deploy/smoke/audit-dist.mjs "$(native "$stage")"
fi
run node deploy/vercel/package.mjs "--dist=$(native "$stage")" "--origin=https://$ORIGIN" "--out=$(native "$OUT")"
[ "$PRINT_ONLY" = 1 ] || rm -rf "$stage"

scope=(); [ -z "$VERCEL_SCOPE" ] || scope=(--scope "$VERCEL_SCOPE")
if [ ! -f "$OUT/.vercel/project.json" ]; then
  note "not linked to a Vercel project yet. Once:"
  note "  npx vercel@latest link --yes --project $VERCEL_PROJECT ${VERCEL_SCOPE:+--scope $VERCEL_SCOPE }--cwd \"$(native "$OUT")\""
  [ "$DEPLOY" = 0 ] || die "link the directory first (above), then run this again"
fi
if [ "$DEPLOY" = 1 ]; then
  run npx --yes vercel@latest deploy --prebuilt --prod --cwd "$(native "$OUT")" ${scope[@]+"${scope[@]}"}
  note "deployed. Check: node deploy/smoke/smoke.mjs --site=https://${DOMAIN_NAME:-$VERCEL_PROJECT.vercel.app} --origin=$ORIGIN --edge=vercel"
else
  note "ready in $OUT. Deploy with:"
  note "  npx vercel@latest deploy --prebuilt --prod --cwd \"$(native "$OUT")\"${VERCEL_SCOPE:+ --scope $VERCEL_SCOPE}"
fi
