#!/usr/bin/env bash
# Regenerate test/vectors-sdk.json from the OFFICIAL SoDEX Go SDK.
#
# Run from packages/sodex-core:  bash tools/genvectors.sh [sdk-ref]
#
# - Clones github.com/sodex-tech/sodex-go-sdk-public into tools/.cache (git-ignored)
#   if it is not there yet, and checks out [sdk-ref] when given.
# - Copies tools/genvectors/main.go into the checkout and runs it.
# - Needs Go (>= the SDK's go.mod version) and network access for the first
#   `go run` (module download). It signs with a published throwaway test key and
#   sends NOTHING anywhere.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
cache="$here/.cache"
sdk="$cache/sodex-go-sdk-public"

mkdir -p "$cache"
if [ ! -d "$sdk/.git" ]; then
  git clone --depth 50 https://github.com/sodex-tech/sodex-go-sdk-public "$sdk"
fi
if [ "${1:-}" != "" ]; then
  git -C "$sdk" fetch --depth 50 origin "$1"
  git -C "$sdk" checkout "$1"
fi

mkdir -p "$sdk/tools/genvectors"
cp "$here/genvectors/main.go" "$sdk/tools/genvectors/main.go"

commit="$(git -C "$sdk" rev-parse HEAD)"
echo "generating vectors from sodex-go-sdk-public@$commit" >&2
(cd "$sdk" && go run ./tools/genvectors) > "$pkg/test/vectors-sdk.json.tmp"
mv "$pkg/test/vectors-sdk.json.tmp" "$pkg/test/vectors-sdk.json"
echo "$commit" > "$pkg/test/vectors-sdk.commit"
echo "wrote test/vectors-sdk.json" >&2
