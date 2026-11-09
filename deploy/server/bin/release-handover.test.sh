#!/usr/bin/env bash
# release.sh's indexer restart as a handover (restart_indexer, THE HANDOVER): run against a fake systemctl that plays the
# supervisor's state file, with the reloads and restarts recorded instead of made. release.test.mjs runs this; by hand:
# bash deploy/server/bin/release-handover.test.sh deploy/server/bin/release.sh
set -euo pipefail
SRC="$1"
T="$(mktemp -d)"
HANDOVER_STATE="$T/indexer-handover.json"
HANDOVER_WAIT_S=3
INDEXER_SETTLE_S=0
log() { printf '[release] %s\n' "$*"; }
die() { printf '[release] error: %s\n' "$*"; DIED=1; return 1; }
wait_active() { return 0; }
sleep() { :; }
# The functions under test, cut out of release.sh.
eval "$(sed -n '/^# THE HANDOVER/,/^restart_api() {/p' "$SRC" | sed '$d')"

SCEN=""; DONE=""
fake_systemctl() {
  case "$1" in
    is-active) [ "$SCEN" != stopped ] ;;
    show)
      if [ "$SCEN" = classic-unit ]; then echo ""; return 0; fi
      case "$3" in
        ExecReload) echo '{ path=/bin/kill ; argv[]=/bin/kill -HUP $MAINPID ; }' ;;
        ExecStart) echo '{ path=/opt/node/current/bin/node ; argv[]=node --import tsx src/indexer/supervisor.ts --max-old-space-size=8192 src/indexer/main.ts ; }' ;;
      esac ;;
    reload)
      DONE+="reload "
      local seq; seq=$(( $(handover_field seq || echo 0) + 1 ))
      case "$SCEN" in
        promoted) printf '{"seq":%d,"phase":"promoted","activePid":4242,"activeRelease":"v2","timings":{"requestToTakeoverMs":3100}}' "$seq" > "$HANDOVER_STATE" ;;
        failed) printf '{"seq":%d,"phase":"failed","reason":"the running indexer did not take the request in 60 s"}' "$seq" > "$HANDOVER_STATE" ;;
        silent) printf '{"seq":%d,"phase":"standby"}' "$seq" > "$HANDOVER_STATE" ;;
      esac ;;
    restart) DONE+="restart " ;;
  esac
}
SYSTEMCTL=fake_systemctl

pass=0; fail=0
check() {  # name, scenario, expected actions, expected log pattern[, env]
  SCEN="$2"; DONE=""; DIED=0
  local out; out="$(restart_indexer 2>&1; printf '\nDONE=%s' "$DONE")"
  local got; got="$(printf '%s' "$out" | sed -n 's/^DONE=//p' | xargs)"
  if [ "$got" = "$3" ] && printf '%s' "$out" | grep -q -- "$4"; then pass=$((pass+1)); echo "ok   $1: [$got]"
  else fail=$((fail+1)); echo "FAIL $1: got [$got] want [$3] / pattern '$4'"; printf '%s\n' "$out" | sed 's/^/     /'; fi
}
printf '{"seq":7,"phase":"promoted"}' > "$HANDOVER_STATE"
check "handover done" promoted "reload" "handover done in 1 s: pid 4242 (release v2)"
check "handover failed: classic restart" failed "reload restart" "handover failed after 1 s: the running indexer did not take"
check "no answer in time: classic restart" silent "reload restart" "not done in 3 s (last phase: standby)"
check "a unit without the supervisor: classic only" classic-unit "restart" "restarting the indexer"
VS_INDEXER_HANDOVER=0 check "handovers switched off: classic only" promoted "restart" "restarting the indexer"
rm -f "$HANDOVER_STATE"
check "first handover (no state file yet)" promoted "reload" "handover done"
rm -rf "$T"
echo "pass $pass fail $fail"
[ "$fail" = 0 ]
