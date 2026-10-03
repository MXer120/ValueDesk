#!/usr/bin/env bash
# Publish a built web bundle to the site bucket and invalidate CloudFront.
#
#   deploy/release/publish-web.sh <tag>              publish deploy/.out/valuescan-web-<tag>.tar.gz
#   deploy/release/publish-web.sh --rollback <tag>   fetch that tag's build from the ops bucket, publish it
#   ... --print                                       show the AWS commands, run none
#
# WHAT GOES WHERE, AND HOW IT IS CACHED (docs/deploy/SECURITY-HEADERS.md 1.1)
#   assets/*            content-hashed      public, max-age=31536000, immutable
#   logos/* addrbook/*  not hashed          public, max-age=86400, stale-while-revalidate=604800
#   *.html              the app shell       no-cache
#   everything else     favicon, robots     public, max-age=3600
#
# THE ORDER matters: hashed assets first, the HTML that points at them last. A
# visitor never gets an index.html whose scripts are not there yet. Old assets are
# NOT deleted: a visitor who still has the previous index.html keeps working, and a
# rollback is only the previous HTML again.
#
# CONTENT TYPES are set explicitly per extension. The AWS CLI guesses them from the
# operating system otherwise (on Windows, from the registry), and with
# "X-Content-Type-Options: nosniff" a script served as text/plain does not run.
# A file with an extension this script does not know stops the publish.
#
# The build that is published is also stored in the ops bucket
# (releases/web/valuescan-web-<tag>.tar.gz): that is what --rollback fetches.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TAG=""
ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --rollback) ROLLBACK=1 ;;
    --print) PRINT_ONLY=1 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $arg" ;;
    *) [ -z "$TAG" ] || die "one tag at a time"; TAG="$arg" ;;
  esac
done
[ -n "$TAG" ] || die "usage: deploy/release/publish-web.sh [--rollback] <tag> [--print]"
valid_tag "$TAG" || die "not a usable tag name: $TAG"
load_params
[ "$VS_TARGET" != ec2 ] || die "the EC2 test environment serves the web from Vercel: deploy/release/publish-vercel.sh $TAG"

OPS="$(ops_bucket)"
SITE="$(site_bucket)"
DIST_ID="$(distribution_id)"
mkdir -p "$OUT_DIR"
tarball="$OUT_DIR/valuescan-web-$TAG.tar.gz"
key="releases/web/valuescan-web-$TAG.tar.gz"

if [ "$ROLLBACK" = 1 ]; then
  note "fetching the build of $TAG from the ops bucket"
  run aws s3 cp "s3://$OPS/$key" "$tarball" --only-show-errors
  run aws s3 cp "s3://$OPS/$key.sha256" "$tarball.sha256" --only-show-errors
fi
if [ "$PRINT_ONLY" != 1 ]; then
  [ -f "$tarball" ] || die "$tarball does not exist - build it first: deploy/release/build-web.sh $TAG"
  [ -f "$tarball.sha256" ] || die "$tarball.sha256 is missing"
  [ "$(awk '{print $1; exit}' "$tarball.sha256")" = "$(sha256_of "$tarball")" ] || die "$tarball does not match its checksum"
fi

stage="$OUT_DIR/web-$TAG"
if [ "$PRINT_ONLY" != 1 ]; then
  rm -rf "$stage"
  mkdir -p "$stage"
  tar -xzf "$tarball" -C "$stage"
  [ -f "$stage/index.html" ] || die "the build has no index.html"
  [ -n "$(ls -A "$stage/assets" 2>/dev/null)" ] || die "the build has no assets/"
  run node deploy/smoke/audit-dist.mjs "$stage"
fi

content_type() {
  case "$1" in
    html) echo 'text/html; charset=utf-8' ;;
    js|mjs) echo 'text/javascript; charset=utf-8' ;;
    css) echo 'text/css; charset=utf-8' ;;
    json|map) echo 'application/json; charset=utf-8' ;;
    txt) echo 'text/plain; charset=utf-8' ;;
    xml) echo 'application/xml; charset=utf-8' ;;
    svg) echo 'image/svg+xml' ;;
    png) echo 'image/png' ;;
    jpg|jpeg) echo 'image/jpeg' ;;
    webp) echo 'image/webp' ;;
    avif) echo 'image/avif' ;;
    gif) echo 'image/gif' ;;
    ico) echo 'image/x-icon' ;;
    woff2) echo 'font/woff2' ;;
    woff) echo 'font/woff' ;;
    ttf) echo 'font/ttf' ;;
    otf) echo 'font/otf' ;;
    wasm) echo 'application/wasm' ;;
    webmanifest) echo 'application/manifest+json' ;;
    *) return 1 ;;
  esac
}

# The extensions (lower-case) of the files under a directory, optionally leaving sub-directories out.
extensions_in() {
  local dir="$1"; shift
  local prune=()
  for p in "$@"; do prune+=(-path "$dir/$p" -prune -o); done
  [ -d "$dir" ] || return 0
  find "$dir" ${prune[@]+"${prune[@]}"} -type f -print | while IFS= read -r f; do
    base="${f##*/}"
    case "$base" in
      *.*) printf '%s\n' "${base##*.}" ;;
      *) echo "NO-EXTENSION:$f" ;;
    esac
  done | sort -u
}
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Upload every file with one extension from a directory tree, with its type and cache policy.
upload() {   # local dir, s3 prefix ("" = root), extension, cache-control, mode (cp|sync), excluded sub-directories...
  local dir="$1" prefix="$2" ext="$3" cache="$4" mode="$5"; shift 5
  local type
  type="$(content_type "$(lower "$ext")")" || die "no content type is known for .$ext (under $dir) - add it to content_type() in $0"
  # The filter is case-sensitive, so it carries the extension exactly as the files have it.
  local filters=(--exclude '*' --include "*.$ext")
  for p in "$@"; do filters+=(--exclude "$p/*"); done
  if [ "$mode" = sync ]; then
    # Hashed names: a file that is already there is the same file.
    run aws s3 sync "$dir" "s3://$SITE/$prefix" "${filters[@]}" --size-only \
      --content-type "$type" --cache-control "$cache" --only-show-errors
  else
    run aws s3 cp "$dir" "s3://$SITE/$prefix" --recursive "${filters[@]}" \
      --content-type "$type" --cache-control "$cache" --only-show-errors
  fi
}

publish_group() {   # local dir, s3 prefix, cache-control, mode, only-html (0|1|skip), excluded sub-directories...
  local dir="$1" prefix="$2" cache="$3" mode="$4" html="$5"; shift 5
  local ext
  while IFS= read -r ext; do
    [ -n "$ext" ] || continue
    case "$ext" in NO-EXTENSION:*) die "a file without an extension cannot be given a content type: ${ext#NO-EXTENSION:}" ;; esac
    if [ "$html" = 1 ] && [ "$(lower "$ext")" != html ]; then continue; fi
    if [ "$html" = skip ] && [ "$(lower "$ext")" = html ]; then continue; fi
    upload "$dir" "$prefix" "$ext" "$cache" "$mode" "$@"
  done < <(extensions_in "$dir" "$@")
}

if [ "$PRINT_ONLY" = 1 ]; then
  note "(--print) the uploads depend on the files of the build; their shape is:"
  stage="<build>"
  run aws s3 sync "$stage/assets" "s3://$SITE/assets/" --exclude '*' --include '*.js' --size-only --content-type 'text/javascript; charset=utf-8' --cache-control 'public, max-age=31536000, immutable' --only-show-errors
  run aws s3 cp "$stage/logos" "s3://$SITE/logos/" --recursive --exclude '*' --include '*.svg' --content-type 'image/svg+xml' --cache-control 'public, max-age=86400, stale-while-revalidate=604800' --only-show-errors
  run aws s3 cp "$stage" "s3://$SITE/" --recursive --exclude '*' --include '*.html' --exclude 'assets/*' --content-type 'text/html; charset=utf-8' --cache-control 'no-cache' --only-show-errors
else
  note "1/4 hashed assets"
  publish_group "$stage/assets" "assets/" 'public, max-age=31536000, immutable' sync 0
  note "2/4 logos and address-book images"
  for d in logos addrbook; do
    [ -d "$stage/$d" ] && publish_group "$stage/$d" "$d/" 'public, max-age=86400, stale-while-revalidate=604800' cp 0
  done
  note "3/4 other files"
  publish_group "$stage" "" 'public, max-age=3600' cp skip assets logos addrbook
  note "4/4 HTML, last"
  publish_group "$stage" "" 'no-cache' cp 1 assets logos addrbook

  # The shell must point at a script that is really there, with a type a browser runs.
  entry="$(sed -n 's/.*<script[^>]*src="\/\(assets\/[^"]*\.js\)".*/\1/p' "$stage/index.html" | head -n 1)"
  [ -n "$entry" ] || die "index.html names no /assets/*.js entry script"
  type="$(aws s3api head-object --bucket "$SITE" --key "$entry" --query ContentType --output text)" \
    || die "the entry script $entry is not in the bucket"
  case "$type" in text/javascript*) ;; *) die "the entry script is stored as $type" ;; esac
  note "verified: $entry is in the bucket as $type"
fi

if [ "$ROLLBACK" != 1 ]; then
  note "storing the build for rollbacks"
  run aws s3 cp "$tarball" "s3://$OPS/$key" --only-show-errors
  run aws s3 cp "$tarball.sha256" "s3://$OPS/$key.sha256" --only-show-errors
fi

note "invalidating CloudFront"
inv="$(lookup '<invalidation-id>' aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' --query 'Invalidation.Id' --output text)"
run aws cloudfront wait invalidation-completed --distribution-id "$DIST_ID" --id "$inv"
# The unpacked copy has done its job (the tarball stays: it is what a later publish reads).
[ "$PRINT_ONLY" = 1 ] || rm -rf "$OUT_DIR/web-$TAG"
note "published $TAG to s3://$SITE and invalidated $DIST_ID"
note "check: curl -sI https://${DOMAIN_NAME:-<domain>}/ | grep -i -E 'content-security-policy|cache-control'"
