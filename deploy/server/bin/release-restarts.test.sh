#!/usr/bin/env bash
# release.sh decides which units a release restarts (restart_units auto): run against
# fake release trees, with the restarts recorded instead of made. release.test.mjs runs
# this; by hand: bash deploy/server/bin/release-restarts.test.sh deploy/server/bin/release.sh
set -euo pipefail
SRC="$1"
T="$(mktemp -d)"
RELEASES="$T/releases"; CURRENT="$T/current"
mkdir -p "$RELEASES"
mk() {  # tag: a release tree
  local d="$RELEASES/$1"
  mkdir -p "$d/apps/server/src" "$d/apps/server/test" "$d/apps/executor/src" "$d/packages/copy-engine/src" "$d/packages/sodex-core/src" "$d/apps/web/src" "$d/node_modules"
  echo server > "$d/apps/server/src/index.ts"; echo t > "$d/apps/server/test/a.test.ts"
  echo exe > "$d/apps/executor/src/main.ts"; echo eng > "$d/packages/copy-engine/src/index.ts"
  echo core > "$d/packages/sodex-core/src/index.ts"; echo web > "$d/apps/web/src/main.tsx"
  echo '{"deps":1}' > "$d/node_modules/.package-lock.json"
}
# The functions under test, cut out of release.sh.
eval "$(sed -n '/^# What each unit.s code is made of/,/^restart_indexer_and_api() {/p' "$SRC" | sed '$d')"
declare -A RUNS
unit_release() { printf '%s' "${RUNS[$1]:-}"; }
log() { printf '[release] %s\n' "$*"; }
indexer_release() { unit_release valuescan-indexer.service; }
release_of() { local r; r="$(unit_release "$1")"; printf '%s' "${r:-unknown}"; }
RESTARTED=""
restart_indexer_and_api() { if [ "$1" = 1 ]; then RESTARTED+="api "; else RESTARTED+="indexer api "; fi; }
restart_indexer() { RESTARTED+="indexer "; }
restart_api() { RESTARTED+="api "; }
restart_executor() { RESTARTED+="executor "; }
restart_status() { RESTARTED+="status "; }
restart_feed() { RESTARTED+="feed "; }
eval "$(sed -n '/^here() {/p' "$SRC")"
eval "$(sed -n '/^restart_units() {/,/^}/p' "$SRC")"

pass=0; fail=0
check() {  # name, expected restarts[, mode]
  RESTARTED=""; restart_units "${3:-auto}" >/dev/null
  if [ "$(echo $RESTARTED)" = "$2" ]; then pass=$((pass+1)); echo "ok   $1: [$2]"; else fail=$((fail+1)); echo "FAIL $1: got [$(echo $RESTARTED)] want [$2]"; fi
}
mk v1
CURRENT="$RELEASES/v1"
RUNS=([valuescan-indexer.service]=v1 [valuescan-api.service]=v1 [valuescan-executor.service]=v1)
check "same release" ""

cp -r "$RELEASES/v1" "$RELEASES/v2"; echo web2 > "$RELEASES/v2/apps/web/src/main.tsx"; echo t2 > "$RELEASES/v2/apps/server/test/a.test.ts"
CURRENT="$RELEASES/v2"
check "web and tests only" ""

cp -r "$RELEASES/v1" "$RELEASES/v3"; echo server3 > "$RELEASES/v3/apps/server/src/index.ts"
CURRENT="$RELEASES/v3"
check "server code" "indexer api"

cp -r "$RELEASES/v1" "$RELEASES/v4"; echo eng4 > "$RELEASES/v4/packages/copy-engine/src/index.ts"
CURRENT="$RELEASES/v4"
check "copy engine" "executor"

cp -r "$RELEASES/v1" "$RELEASES/v5"; echo '{"deps":2}' > "$RELEASES/v5/node_modules/.package-lock.json"
CURRENT="$RELEASES/v5"
check "dependencies" "indexer api executor"

CURRENT="$RELEASES/v3"
RUNS=([valuescan-indexer.service]=v3 [valuescan-api.service]=v1 [valuescan-executor.service]=v1)
check "api left behind by --executor-only" "api"

RUNS=([valuescan-indexer.service]=v3 [valuescan-api.service]=v3)
check "executor not running" "executor"

RUNS=([valuescan-indexer.service]=gone [valuescan-api.service]=v3 [valuescan-executor.service]=v1)
check "indexer release pruned" "indexer api"

cp -r "$RELEASES/v1" "$RELEASES/v6"; echo new > "$RELEASES/v6/apps/executor/src/extra.ts"
CURRENT="$RELEASES/v6"
RUNS=([valuescan-indexer.service]=v1 [valuescan-api.service]=v1 [valuescan-executor.service]=v1)
check "a new executor file" "executor"

# A server that runs some units (VS_UNITS): the others are not compared and not started.
CURRENT="$RELEASES/v5"
RUNS=([valuescan-indexer.service]=v1 [valuescan-api.service]=v1)
VS_UNITS=indexer,api check "server 1: dependencies, the executor is not its own" "indexer api"
RUNS=([valuescan-executor.service]=v1)
VS_UNITS=executor check "server 2: dependencies, the indexer and API are not its own" "executor"
CURRENT="$RELEASES/v3"
RUNS=([valuescan-indexer.service]=v1 [valuescan-api.service]=v1)
VS_UNITS=indexer check "a server with the indexer only" "indexer"

# --units: exactly the units named, in the order indexer, API, executor.
UNITS=api,indexer check "--units=api,indexer" "indexer api" units
UNITS=executor check "--units=executor" "executor" units
VS_UNITS=indexer,api UNITS=indexer check "--units=indexer on server 1" "indexer" units
# The status prober: only when named (ship.sh, when its own code changed) or --all - never with every API release.
UNITS=status check "--units=status" "status" units
UNITS=api check "--units=api leaves the status prober" "api" units
UNITS=indexer,api,status check "--units=indexer,api,status" "indexer api status" units
# The shared feed on server 2 likewise: only when named or --all - never with every executor release.
UNITS=feed check "--units=feed" "feed" units
UNITS=executor check "--units=executor leaves the shared feed" "executor" units
UNITS=executor,feed check "--units=executor,feed" "executor feed" units
check "--all" "indexer api status executor feed" all
CURRENT="$RELEASES/v1"
RUNS=([valuescan-indexer.service]=v1 [valuescan-api.service]=v1 [valuescan-executor.service]=v1)
UNITS=api check "--units=api with nothing changed" "api" units

rm -rf "$T"
echo "pass $pass fail $fail"
[ "$fail" = 0 ]
