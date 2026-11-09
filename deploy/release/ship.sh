#!/usr/bin/env bash
# deploy/release/ship.sh - THE PIPELINE: ship what changed to where it runs, from this laptop.
#
#   bash deploy/release/ship.sh                  what changed since what is live: the plan, one question, then ship
#   bash deploy/release/ship.sh web api          only these parts: web, api, indexer, executor, status, feed (or all)
#   bash deploy/release/ship.sh --dry-run        the plan only - nothing is tagged, pushed or released
#   bash deploy/release/ship.sh --yes            no question (the owner's go is already given)
#   bash deploy/release/ship.sh --tag=v0.2.60    this tag instead of the next one (or the one HEAD already has)
#   bash deploy/release/ship.sh --no-notice      no maintenance notice (status page + the app's notification) for the restarts
#   bash deploy/release/ship.sh --yes --executor-ok   with --yes, the copy executor is restarted only with this too
#
# THE COPY EXECUTOR runs followers' live copies and algos with their keys, so its release has guards of its own
# (step 6b): its own yes (the plan shows its copies, algos and send queue); the new code installed and checked
# first while the old one runs; tools/preflight.ts - the new code reads a snapshot of today's database: every
# copy and algo loads, the audit chain holds, the counts are the running executor's - else nothing is
# switched; that snapshot, as taken, kept beside the live database (pre-release/, never deleted: the copy to
# go back to - not the backup service, whose rotation would drop an older backup sooner); a quiet moment (an empty send queue, up to a minute); the brake on copies
# and algos over the restart, so the new process sends nothing until it reports the same copies and algos and
# its SoDEX feed up - only then is the brake set back to what it was. Anything else rolls back with copies and
# algos still held, and they resume only on a healthy executor; if even that fails the brake stays on.
#
# THE STEPS, each only when it is needed; the first that fails stops it:
#   1. what runs where: the release each unit runs (server 1: indexer, API; server 2: executor) and main on
#      GitHub (Vercel builds the web from main). With no parts named, deploy/release/parts.mjs works out from
#      the commits since then which services run changed code - a change only the indexer imports restarts the
#      indexer, not the API;
#   2. the tag: the next vX.Y.Z (or the one HEAD has), pushed with this branch - main does not move yet;
#   3. the test gate (deploy/release/test-gate.sh): GitHub's CI for the tag, waited for - no release without it;
#   4. the server tarball (git archive of the tag, lib.sh server_tarball), uploaded within the laptop's cap
#      (scp -l 8000), its checksum checked on arrival;
#   5. the operations scripts (deploy/server/bin) from the tarball into /opt/valuescan/bin where they differ -
#      a release used to leave them to be installed by hand;
#   6. the maintenance notice (THE NOTICE below), then server 1: release.sh --units=<indexer,api - those that
#      changed>, waiting for the indexer to publish again; server 2: release.sh --units=executor. A
#      unit that does not come back healthy is rolled back to the release before at once, and ship.sh stops;
#   7. main moves to the tag (fast-forward) - Vercel builds and publishes the web - and, when the web changed,
#      it waits for GitHub to show that Production deployment as successful and the site answering.
#      The web goes last on purpose: what it calls already runs the new code when it appears.
# Each ship is a line in deploy/.out/ships.log.
#
# TELEGRAM: what a ship is, on the first line of each message (deploy/server/bin/telegram.mjs LABELS). Before
# it restarts anything, it opens a maintenance window on both servers (maint.sh on - they watch each other):
# their health checks hold the alerts of the parts being released, and the brake over the executor's restart is
# planned work (brake.sh on --maintenance), so neither the brake nor the executor says anything of it. Telegram
# gets two messages: "🔧 MAINTENANCE · vX started: ..." and "🔧 MAINTENANCE · vX done in N min: ..." - or,
# when it stopped half-way, "🚨 FAILURE · vX stopped: <why>" (the window closed, so what still fails alerts).
# The windows close after the server steps; one left open (the laptop died) ends by itself after 60 minutes.
# A ship that restarts nothing (web only, scripts only) sends nothing.
#
# THE NOTICE: a ship that restarts anything posts one maintenance on the status page (`status.sh ship`,
# apps/server/src/ops/shipNotice.ts), before the first restart: every part named down, partly down or not
# affected, and the expected end from the measurements below - an estimate, and the app says so. The app shows
# it blue while it runs (past the estimate: "taking longer than expected") and turns it green ONLY when ship.sh
# completes it `ok`: the restarts are over AND every restarted part passed the final checks (the API answers,
# the executor is healthy with its SoDEX feed up and the brake as it was, the indexer publishing). A
# rollback completes it `rolled_back` - amber in the app, never green - and so does a ship that stopped before
# it was finished with nothing broken. When something is left not working (a failed rollback, the executor
# held, no board build, a final check failing), it gets an update naming the parts still affected and stays
# open, blue: the owner completes it (status.sh resolve <id>). It stays in progress past its expected end until
# then (an hour at most on the status page). A web-only ship posts none.
#
# DOWNTIME (measured on v0.2.57, 2026-10-28):
#   web       none: Vercel switches atomically; an open tab whose files a deploy replaced reloads once (lazyPage.ts)
#   api       no failed request: the API is away ~6 s and Caddy holds each request meanwhile (lb_try_duration
#             15 s); the heatmap's WebSocket reconnects
#   executor  no failed request: back in seconds, Caddy holds its requests up to 20 s; copies and algos wait
#   indexer   the site keeps serving the last boards, which catch up over the next rebuild; the
#             streams' gap is read again (Lighter's re-subscribe 3.5-8 min); after midnight UTC the first
#             build took 5-8 min. The notice's expected end counts these (shipNotice.ts SHIP_EFFECTS).
#
# NOT DONE HERE: units, Caddy, env templates, bootstrap (deploy/server outside bin) - ship.sh says so and
# leaves them to bootstrap-instance.sh; the web's rollback (Vercel: promote the deployment before, or ship a revert).
#
# Hosts and key: VS_SERVER1 / VS_SERVER2 / VS_SSH_KEY (as brake.sh). Needs node (the ddx-tools Node is found by
# itself) and a GitHub token (GITHUB_TOKEN, else git's stored credential for github.com).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
. "$(dirname "${BASH_SOURCE[0]}")/test-gate.sh"
# lib.sh's, keeping the reason for the Telegram message of a ship that stopped (on_exit).
LAST_ERROR=""
die() { LAST_ERROR="$*"; echo "error: $*" >&2; exit 1; }

S1="${VS_SERVER1:-almalinux@161.97.154.121}"
S2="${VS_SERVER2:-almalinux@13.140.77.201}"
KEY="${VS_SSH_KEY:-$HOME/.ssh/valuescan-contabo}"
SITE="${VS_SITE:-https://www.valuedesk.so}"
INBOX=/var/cache/valuescan/inbox
SSH=(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o LogLevel=ERROR)
# The laptop's upload cap (~/.claude/CLAUDE.md: 10 Mbit/s up, one big transfer at a time).
SCP=(scp -q -l 8000 -i "$KEY" -o BatchMode=yes -o ConnectTimeout=20 -o LogLevel=ERROR)
G=(git -c windows.appendAtomically=false)

say() { printf '\n== %s\n' "$*" >&2; }
remote() { local host="$1"; shift; "${SSH[@]}" "$host" "$@"; }

# --- arguments ------------------------------------------------------------------------------------
PARTS=() DRY=0 YES=0 TAG="" NOTICE=1 EXEC_OK=0
for a in "$@"; do
  case "$a" in
    web|api|indexer|executor|status|feed) PARTS+=("$a") ;;
    all) PARTS+=(web api indexer executor status feed) ;;
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    --executor-ok) EXEC_OK=1 ;;
    --tag=*) TAG="${a#--tag=}" ;;
    --no-notice) NOTICE=0 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $a (parts: web api indexer executor status feed all)" ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME"/AppData/Local/ddx-tools/node-v*-win-x64; do [ -x "$d/node.exe" ] && PATH="$d:$PATH"; done
fi
command -v node >/dev/null 2>&1 || die "no node on PATH"
if [ -z "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]; then
  GITHUB_TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p' || true)"
  export GITHUB_TOKEN
fi
[ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ] || die "no GitHub token (GITHUB_TOKEN, or git's credential for github.com)"
REPO="$(git remote get-url origin | sed -E 's#^(https://([^@/]*@)?github\.com/|git@github\.com:)##; s#\.git$##')"
gh_api() { GH_PATH="$1" node --input-type=module -e '
  const r = await fetch(`https://api.github.com/repos/${process.env.GH_PATH}`, { headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN || process.env.GH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "valuedesk-ship" } }).catch(() => null);
  process.stdout.write(r && r.ok ? await r.text() : "null");'; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=null;try{v=JSON.parse(s||"null")}catch{};const f=new Function("v",`return (${process.argv[1]})`);const o=f(v);process.stdout.write(o==null?"":String(o))})' "$1"; }
# The executor's own health on server 2 (copies, algos, feed, brake, send queue), or "null".
exec_health() { remote "$S2" 'curl -fsS --max-time 5 http://127.0.0.1:8799/api/copy/v1/health' 2>/dev/null || echo null; }
counts() { printf '%s' "$1" | json 'v && typeof v.copies === "number" ? `${v.copies} copies, ${v.algos} algos` : "?"'; }

# --- 1. what runs where ---------------------------------------------------------------------------
say "what runs where"
"${G[@]}" fetch -q origin main --tags
HEAD_SHA="$(git rev-parse HEAD)"
# main as it is before this ship moves it: what Vercel's Ignored Build Step compares with (step 7).
OLD_MAIN="$(git rev-parse origin/main)"
BRANCH="$(git symbolic-ref --short -q HEAD || true)"
"${G[@]}" merge-base --is-ancestor origin/main HEAD || die "HEAD does not contain origin/main: bring this branch up to date with main first"
st1="$(remote "$S1" 'sudo /opt/valuescan/bin/release.sh --status' 2>/dev/null)" || die "server 1 ($S1) does not answer"
st2="$(remote "$S2" 'sudo /opt/valuescan/bin/release.sh --status' 2>/dev/null)" || die "server 2 ($S2) does not answer"
unit_tag() { printf '%s\n' "$1" | sed -n "s/^$2: *[a-z-]*, release //p" | head -1; }
LIVE_INDEXER="$(unit_tag "$st1" indexer)"; LIVE_API="$(unit_tag "$st1" api)"; LIVE_EXECUTOR="$(unit_tag "$st2" executor)"
# The status prober (valuescan-status.service on server 1); empty while server 1's release.sh does not report it yet.
LIVE_STATUS="$(unit_tag "$st1" status)"
# The shared market-data feed (valuescan-feed.service on server 2, 2026-11-03); empty while server 2 does not report it.
LIVE_FEED="$(unit_tag "$st2" feed)"
note "server 1: indexer ${LIVE_INDEXER:-?}, API ${LIVE_API:-?}   server 2: executor ${LIVE_EXECUTOR:-?}   web: main $(git rev-parse --short origin/main)"

# A part changed when parts.mjs finds files of it between what runs and HEAD (an unknown or gone release: changed).
changed_since() {   # part, live ref
  [ -n "$2" ] && [ "$2" != unknown ] && git rev-parse -q --verify "$2^{commit}" >/dev/null || { echo "?"; return; }
  node deploy/release/parts.mjs --from="$2" --to=HEAD --json | json "v.parts['$1'].length"
}
declare -A WHY
want() { local p; for p in "${PARTS[@]}"; do [ "$p" = "$1" ] && return 0; done; return 1; }
if [ ${#PARTS[@]} -eq 0 ]; then
  for p in web api indexer executor status feed; do
    case "$p" in web) from="origin/main" ;; api) from="$LIVE_API" ;; indexer) from="$LIVE_INDEXER" ;; executor) from="$LIVE_EXECUTOR" ;; status) from="$LIVE_STATUS" ;; feed) from="$LIVE_FEED" ;; esac
    # The status prober is compared only once server 1 reports it (release.sh --status, from this release on): before
    # that it would count as changed on every ship. It runs in the meantime; name `status` to restart it.
    # The shared feed likewise, once server 2 reports it (a server 2 without the unit installed reports none).
    if { [ "$p" = status ] || [ "$p" = feed ]; } && [ -z "$from" ]; then continue; fi
    n="$(changed_since "$p" "$from")"
    if [ "$n" != 0 ]; then PARTS+=("$p"); WHY[$p]="${n} file(s) since ${from}"; fi
  done
else
  for p in "${PARTS[@]}"; do WHY[$p]="named"; done
fi
# The operations scripts and the infrastructure, since the older release of the two servers.
oldest="$(printf '%s\n%s\n' "$st1" "$st2" | sed -n 's/^current: *//p' | grep -v '^$' | sort -V | head -1 || true)"
BIN=0 INFRA=""
if [ -n "$oldest" ] && git rev-parse -q --verify "$oldest^{commit}" >/dev/null; then
  pj="$(node deploy/release/parts.mjs --from="$oldest" --to=HEAD --json)"
  [ "$(printf '%s' "$pj" | json 'v.parts.bin.length')" = 0 ] || BIN=1
  INFRA="$(printf '%s' "$pj" | json 'v.parts.infra.join(", ")')"
fi

U1=() U2=()
want indexer && U1+=(indexer)
want api && U1+=(api)
want executor && U2+=(executor)
# The status prober restarts on server 1 with the units there, but is not one of them for the maintenance
# window and the notice: nobody notices its restart (it misses one round at most).
STA=0; want status && STA=1
# The shared feed on server 2 likewise: its own restart, after the executor's, outside the window and the notice
# (its readers open their own sockets while it is away).
FEED=0; want feed && FEED=1
WEB=0; want web && WEB=1
if [ ${#U1[@]} -eq 0 ] && [ ${#U2[@]} -eq 0 ] && [ "$STA" = 0 ] && [ "$FEED" = 0 ] && [ "$WEB" = 0 ] && [ "$BIN" = 0 ]; then
  note "nothing to ship: every part already runs HEAD's code"; exit 0
fi
# Moving main deploys the web as it is at HEAD - so main moves only when the web is shipped, or has not changed.
MOVE_MAIN=1
if [ "$WEB" = 0 ] && [ "$(changed_since web origin/main)" != 0 ]; then MOVE_MAIN=0; fi

# --- the plan -------------------------------------------------------------------------------------
if [ -z "$TAG" ]; then TAG="$(git describe --exact-match --tags --match 'v[0-9]*' HEAD 2>/dev/null || true)"; fi
NEW_TAG=0
if [ -z "$TAG" ]; then
  TAG="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -1 | awk -F. '{printf "%s.%s.%d", $1, $2, $3 + 1}')"
  NEW_TAG=1
fi
valid_tag "$TAG" || die "not a usable tag: $TAG"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && [ "$(git rev-parse "$TAG^{commit}")" != "$HEAD_SHA" ]; then die "$TAG already names another commit"; fi

cost() {
  case "$1" in
    web) echo "none (Vercel switches at once)" ;;
    api) echo "~6 s, requests held by Caddy - none fail" ;;
    executor) echo "seconds, requests held by Caddy; copies and algos wait" ;;
    indexer) echo "boards catch up over the next rebuild" ;;
    status) echo "a second; the status page misses one round at most" ;;
    feed) echo "seconds; its readers use their own sockets meanwhile" ;;
  esac
}
say "plan: $TAG ($(git rev-parse --short HEAD)$([ "$NEW_TAG" = 1 ] && echo ", new tag"))"
for p in indexer api status executor feed web; do
  want "$p" || continue
  where=""; case "$p" in indexer|api|status) where="server 1" ;; executor|feed) where="server 2" ;; web) where="Vercel" ;; esac
  printf '  %-9s %-9s %-30s %s\n' "$p" "$where" "${WHY[$p]:-}" "$(cost "$p")" >&2
done
[ "$BIN" = 0 ] || note "  bin       both      /opt/valuescan/bin from the tarball where it differs"
if [ ${#U1[@]} -gt 0 ] || [ ${#U2[@]} -gt 0 ]; then
  note "  telegram  MAINTENANCE started + done (a maintenance window on both servers over the restarts)"
  note "  notice    $([ "$NOTICE" = 1 ] && echo "status page + the app's notification: maintenance over the restarts, completed when done" || echo "off (--no-notice)")"
fi
if [ ${#U2[@]} -gt 0 ]; then
  EXEC0="$(exec_health)"
  note "  executor now: $(printf '%s' "$EXEC0" | json 'v ? `${v.copies} copies (${v.active} active), ${v.algos} algos running, ${v.queue ? v.queue.waiting + v.queue.inFlight : "?"} orders in the send queue, brake ${v.brake ? "ON" : "off"}${v.ok ? "" : " - NOT HEALTHY NOW"}` : "NOT ANSWERING"')"
  note "  executor guards: install + preflight on a snapshot (kept), quiet send queue, brake over the restart, same copies/algos before trading resumes"
fi
[ -z "$INFRA" ] || note "  NOT SHIPPED: $INFRA - units/Caddy/env need deploy/release/bootstrap-instance.sh"
[ "$MOVE_MAIN" = 1 ] || note "  main stays at $(git rev-parse --short origin/main): the web changed but is not shipped"
dirty="$(git status --porcelain -- apps packages deploy/server package.json package-lock.json | grep -v '^?? deploy/\.out/' || true)"
[ -z "$dirty" ] || note "  not in $TAG (uncommitted):
$(printf '%s\n' "$dirty" | sed 's/^/    /')"
[ "$DRY" = 0 ] || { note "dry run: nothing done"; exit 0; }
if [ "$YES" != 1 ]; then
  [ -t 0 ] || die "no terminal to ask: add --yes once the plan above is agreed"
  read -r -p "Ship $TAG? [y/N] " a
  case "$a" in y|Y|yes) ;; *) die "not shipped" ;; esac
  if [ ${#U2[@]} -gt 0 ]; then
    read -r -p "Restart the copy executor too (live copies and algos, guarded as above)? [y/N] " a
    case "$a" in y|Y|yes) ;; *) U2=(); note "the executor stays on ${LIVE_EXECUTOR:-its release}" ;; esac
  fi
elif [ ${#U2[@]} -gt 0 ] && [ "$EXEC_OK" != 1 ]; then
  die "the copy executor runs live copies and algos: add --executor-ok to restart it, or name the parts without it"
fi

START="$(date -u +%s)"
# The commit this ship took at its start: HEAD may have moved meanwhile (another session's commit).
log_ship() { mkdir -p "$OUT_DIR"; printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TAG" "${HEAD_SHA:0:7}" "$*" "${PARTS[*]}" >> "$OUT_DIR/ships.log"; }

# --- the maintenance window and Telegram (the header: TELEGRAM) -----------------------------------
MAINT_ON=() STARTED=0 DONE_NOTES=() WARNED=0
# One Telegram message, labelled on the server (maint.sh tell); by server 1, by server 2 when 1 does not answer.
tell() {   # kind, text
  local h
  for h in "$S1" "$S2"; do
    if printf '%s' "$2" | remote "$h" "sudo bash /opt/valuescan/bin/maint.sh tell $1 -" >/dev/null 2>&1; then return 0; fi
  done
  note "  (Telegram not reached - $1: ${2%%$'\n'*})"
}
maint_open() {   # parts (comma list)
  local h
  for h in "$S1" "$S2"; do
    if remote "$h" "sudo bash /opt/valuescan/bin/maint.sh on 60 '$TAG' $1" >&2; then MAINT_ON+=("$h")
    else note "!! no maintenance window on $h: its health check alerts about $TAG as about a failure"; fi
  done
}
maint_close() {
  local h
  for h in ${MAINT_ON[@]+"${MAINT_ON[@]}"}; do
    remote "$h" 'sudo bash /opt/valuescan/bin/maint.sh off' >&2 || note "!! the maintenance window on $h is still open (it ends by itself within the hour): sudo bash /opt/valuescan/bin/maint.sh off"
  done
  MAINT_ON=()
}
done_note() { DONE_NOTES+=("$*"); }
on_exit() {
  local rc=$?
  [ $rc = 0 ] || log_ship "FAILED (exit $rc)"
  if [ $rc != 0 ] && [ "$STARTED" = 1 ]; then
    maint_close
    # Stopped before it was done, nothing left broken (a check refused the switch): everything runs as
    # before - not "done" (never green): the update is not what runs.
    if [ "$NOTICE_OK" = 1 ]; then notice_done rolled_back "The update stopped before it was finished; everything runs as before."; fi
    tell failure "$TAG stopped: ${LAST_ERROR:-ship.sh ended with exit $rc}"
  fi
}
trap on_exit EXIT

# --- 2. the tag -----------------------------------------------------------------------------------
if [ "$NEW_TAG" = 1 ] || ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  say "tag $TAG"
  last="$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD 2>/dev/null || true)"
  msg="$TAG: $(git log --format='%s' ${last:+"$last.."}HEAD | head -1 | cut -c1-180)"
  ident=()
  if [ -z "$(git config user.email || true)" ]; then
    who="$(git for-each-ref --sort=-creatordate --count=1 refs/tags --format='%(taggername)|%(taggeremail:trim)' | tr -d '<>')"
    ident=(-c "user.name=${who%%|*}" -c "user.email=${who##*|}")
  fi
  "${G[@]}" ${ident[@]+"${ident[@]}"} tag -a "$TAG" -m "$msg" HEAD
fi
refs=("refs/tags/$TAG")
[ -z "$BRANCH" ] || [ "$BRANCH" = main ] || refs+=("HEAD:refs/heads/$BRANCH")
"${G[@]}" push -q origin "${refs[@]}"

# --- 3. the test gate -----------------------------------------------------------------------------
say "test gate"
# GitHub creates the tag's CI run a few seconds after the push; test_gate would take "no run" for "no CI".
for _ in $(seq 1 18); do
  [ "$(gh_api "$REPO/actions/runs?head_sha=$HEAD_SHA" | json 'v ? v.total_count : 0')" -gt 0 ] && break
  sleep 10
done
test_gate "$TAG"

# --- 4.-6. the servers ----------------------------------------------------------------------------
TARBALL=""
need_tarball() { [ -n "$TARBALL" ] || TARBALL="$(server_tarball "$TAG")"; }

upload() {   # host
  local b; b="$(basename "$TARBALL")"
  note "uploading $b to $1 (scp -l 8000)"
  "${SCP[@]}" "$TARBALL" "$TARBALL.sha256" "$1:/tmp/"
  remote "$1" "set -e; for f in $b $b.sha256; do sudo install -D -m 0640 /tmp/\$f $INBOX/\$f; rm -f /tmp/\$f; done; sudo bash -c 'cd $INBOX && sha256sum -c --quiet $b.sha256'"
}

# The tarball's deploy/server/bin into /opt/valuescan/bin, each file that differs (the one before kept as .prev);
# a rename, so a script that is running keeps its own copy.
sync_bin() {   # host
  remote "$1" "sudo bash -s -- $INBOX/$(basename "$TARBALL")" <<'EOF'
set -euo pipefail
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
tar -xzf "$1" -C "$tmp" --strip-components=1 --no-same-owner --wildcards '*/deploy/server/bin/*'
n=0
for f in "$tmp"/deploy/server/bin/*; do
  case "$f" in *.test.mjs|*.test.sh) continue ;; esac
  d="/opt/valuescan/bin/$(basename "$f")"
  if [ -f "$d" ] && cmp -s "$f" "$d"; then continue; fi
  if [ -f "$d" ]; then cp -p "$d" "$d.prev"; fi
  install -m 0755 -o root -g root "$f" "$d.new" && mv -f "$d.new" "$d"
  echo "  bin: $(basename "$f")"; n=$((n + 1))
done
echo "  bin: $n changed"
EOF
}

# The indexer's state in the index (meta indexer_status): when it last published, its last build, Lighter's subscriptions, streams down.
indexer_state() {
  remote "$S1" 'sudo /opt/node/current/bin/node --disable-warning=ExperimentalWarning -' <<'EOF'
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('/var/lib/valuescan/index/valuescan-index.db', { readOnly: true });
const r = d.prepare("select * from meta where key = 'indexer_status'").get();
const s = r ? JSON.parse(Object.values(r)[1]) : {};
const l = s.venues?.lighter?.subscribed;
const down = Object.entries(s.streams ?? {}).filter(([, v]) => v == null).map(([k]) => k);
console.log([s.at ?? 0, s.lastBuildMs ?? 0, l?.confirmed ?? -1, l?.markets ?? -1, down.join(',') || '-'].join(' '));
EOF
}

# --- the maintenance notice (the header: THE NOTICE) ------------------------------------------------
NOTICE_ID="" NOTICE_OK=1 NOTICE_STILL=""
status_cmd() { remote "$S1" "sudo bash /opt/valuescan/bin/status.sh $*"; }
notice_post() {
  [ "$NOTICE" = 1 ] || return 0
  local parts out
  parts="$(IFS=,; echo "${U1[*]}${U1[*]:+${U2[*]:+,}}${U2[*]}")"
  [ "$WEB" = 0 ] || parts="$parts,web"
  # A server 1 whose release has no `status.sh ship` yet (older than this code): the plain maintenance.
  out="$(status_cmd "ship '$TAG' --parts=$parts" 2>/dev/null)" \
    || out="$(status_cmd "maintenance 'Update $TAG' --start=now --end=+15m --components=$(IFS=,; echo "${U1[*]}${U1[*]:+${U2[*]:+,}}${U2[*]}") 'We are updating ValueDesk; it should take a few minutes. Copies and algo orders may pause for a moment, and leaderboards may be a few minutes behind.'" 2>/dev/null)" \
    || { note "!! no maintenance notice posted (status.sh on server 1)"; return 0; }
  NOTICE_ID="$(printf '%s' "$out" | grep -o '#[0-9]*' | head -1 | tr -d '#')"
  note "status page: maintenance #${NOTICE_ID:-?} posted ($parts)"
}
# One word for the remote shell: single-quoted, an apostrophe in it kept.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# Words on its timeline; it stays open.
notice_note() { [ -z "$NOTICE_ID" ] || status_cmd "update $NOTICE_ID $(sq "$*")" >/dev/null || note "!! notice #$NOTICE_ID not updated"; }
# Still affected: those parts' impact now (`executor:down,indexer:partial`) and why; it stays open, blue.
notice_affected() {   # parts, words
  [ -n "$NOTICE_ID" ] || return 0
  local parts="$1"; shift
  status_cmd "update $NOTICE_ID --parts=$parts $(sq "$*")" >/dev/null || notice_note "$*"
}
# Completed, and how: `ok` - every restarted part checked healthy (the app turns it green); `rolled_back` -
# undone, everything as before (amber, never green). A server 1 without outcomes (older than v0.2.74): a
# plain resolve for `ok`, words only for a rollback (it stays open for the owner).
notice_done() {   # outcome, words
  [ -n "$NOTICE_ID" ] || return 0
  local outcome="$1"; shift
  if status_cmd "resolve $NOTICE_ID --outcome=$outcome $(sq "$*")" >/dev/null 2>&1 \
    || { [ "$outcome" = ok ] && status_cmd "resolve $NOTICE_ID $(sq "$*")" >/dev/null; }; then
    note "status page: maintenance #$NOTICE_ID completed ($outcome)"; NOTICE_ID=""
  elif [ "$outcome" != ok ]; then notice_note "$*"; note "!! notice #$NOTICE_ID left open: sudo bash /opt/valuescan/bin/status.sh resolve $NOTICE_ID --outcome=$outcome"
  else note "!! notice #$NOTICE_ID not completed: sudo bash /opt/valuescan/bin/status.sh resolve $NOTICE_ID"; fi
}
# The checks before the notice may say "done" (it turns green only then): every restarted part healthy
# again. Prints the parts still affected (`api:down,executor:partial`), nothing when all is well.
final_checks() {
  local bad="" h
  if want api; then
    remote "$S1" 'curl -fsS --max-time 5 http://127.0.0.1:8797/api/health >/dev/null' 2>/dev/null || bad="${bad:+$bad,}api:down"
  fi
  if want indexer && [ -z "${built:-}" ]; then bad="${bad:+$bad,}indexer:partial"; fi
  if [ ${#U2[@]} -gt 0 ]; then
    h="$(exec_health)"
    if [ "$(exec_healthy "$h")" != 1 ]; then bad="${bad:+$bad,}executor:down"
    # The brake as it was before: off when it was off, on when it was on.
    elif [ "$(printf '%s' "$h" | json 'v && v.brake ? 1 : 0')" != "$([ -n "$BRAKE0" ] && echo 1 || echo 0)" ]; then bad="${bad:+$bad,}executor:partial"; fi
  fi
  printf '%s' "$bad"
}

release_on() {   # host, units (comma list)
  local host="$1" units="$2" cur
  note "release.sh $TAG --units=$units on $host"
  if remote "$host" "sudo /opt/valuescan/bin/release.sh $TAG --units=$units --from=$INBOX/$(basename "$TARBALL") && sudo rm -f $INBOX/$(basename "$TARBALL") $INBOX/$(basename "$TARBALL").sha256"; then
    return 0
  fi
  # Only a release that was switched to is rolled back: one that failed to install left the old one running.
  cur="$(remote "$host" 'sudo /opt/valuescan/bin/release.sh --status' | sed -n 's/^current: *//p')"
  if [ "$cur" = "$TAG" ]; then
    note "!! $units did not come back on $TAG - rolling back to the release before"
    if remote "$host" "sudo /opt/valuescan/bin/release.sh --rollback --units=$units"; then
      notice_done rolled_back "The update was rolled back; everything runs as before."
    else
      note "!! the rollback failed too - look at it now: deploy/release/remote.sh, docs/INCIDENT-RUNBOOK.md"
      NOTICE_OK=0
      # The status prober is no part of the status page: left out of what the notice names.
      local shown; shown="$(printf '%s' "$units" | tr ',' '\n' | grep -vx status | paste -sd, - || true)"
      [ -z "$shown" ] || notice_affected "${shown//,/:down,}:down" "The update did not go through and we are on it; these parts may not work normally until it is fixed."
    fi
  else
    note "!! $TAG did not install on $host; nothing was switched (current: $cur)"
    notice_done rolled_back "The update was not applied; everything runs as before."
  fi
  die "$units on $host: not shipped"
}

# THE FREEZE GATE (2026-11-08): v0.2.193 passed every check and then froze the API thread 4-11 s about 200 times an
# hour (two outages the next morning). A release that answers /api/health once is not proof; this watches the API's
# own stall log (loopWatch, "api thread stalled") for FREEZE_WATCH_S after the restart and rolls the server-1 parts
# back when it froze FREEZE_MAX_LONG times over 4 s, or twice over 8 s (the health check's limit). The first 60 s
# (start-up: caches, the index opening) do not count. Only shortened, never skipped: SHIP_FREEZE_WATCH_S >= 120.
FREEZE_WATCH_S="${SHIP_FREEZE_WATCH_S:-600}"
[ "$FREEZE_WATCH_S" -ge 120 ] 2>/dev/null || FREEZE_WATCH_S=120
FREEZE_MAX_LONG=3
freeze_count() {   # since (journalctl time) -> "<over 4 s> <over 8 s> <longest ms>"
  remote "$S1" "sudo journalctl --namespace=pii -u valuescan-api --since '$1' --no-pager -o cat 2>/dev/null | grep -o '\"stallMs\":[0-9]*' | cut -d: -f2" \
    | awk '{ if ($1 >= 4000) a++; if ($1 >= 8000) b++; if ($1 > m) m = $1 } END { printf "%d %d %d\n", a, b, m }'
}
freeze_gate() {   # units (comma list) on server 1
  local units="$1" since left n4 n8 longest
  # From the API's start plus the 60 s of start-up.
  since="$(remote "$S1" "date -u -d \"\$(systemctl show valuescan-api -p ActiveEnterTimestamp --value)\" +%s")"
  since="$(remote "$S1" "date -u -d '@$(( since + 60 ))' '+%F %T'")"
  note "freeze gate: watching the API's stalls for $FREEZE_WATCH_S s (from $since UTC)"
  left="$FREEZE_WATCH_S"
  while [ "$left" -gt 0 ]; do
    sleep 30; left=$(( left - 30 ))
    read -r n4 n8 longest < <(freeze_count "$since" || echo "0 0 0")
    if [ "${n4:-0}" -ge "$FREEZE_MAX_LONG" ] || [ "${n8:-0}" -ge 2 ]; then
      note "!! the API froze $n4 times over 4 s ($n8 over 8 s, longest ${longest} ms) after $TAG - rolling back $units"
      if remote "$S1" "sudo /opt/valuescan/bin/release.sh --rollback --units=$units"; then
        notice_done rolled_back "The update was rolled back; everything runs as before."
      else
        note "!! the rollback failed too - look at it now: deploy/release/remote.sh, docs/INCIDENT-RUNBOOK.md"
        NOTICE_OK=0
      fi
      die "$units on server 1: the API froze after the restart, not shipped"
    fi
  done
  done_note "freeze gate: $FREEZE_WATCH_S s, ${n4:-0} stalls over 4 s, longest ${longest:-0} ms"
}

if [ ${#U1[@]} -gt 0 ] || [ ${#U2[@]} -gt 0 ] || [ "$STA" = 1 ] || [ "$FEED" = 1 ] || [ "$BIN" = 1 ]; then need_tarball; fi

# Both servers' tarball and scripts first (one upload after the other: the laptop's cap): maint.sh and brake.sh
# are the tag's before anything restarts.
if [ ${#U1[@]} -gt 0 ] || [ "$STA" = 1 ] || [ "$BIN" = 1 ]; then
  say "server 1 ($S1): upload, scripts"
  upload "$S1"
  sync_bin "$S1" >&2
  [ ${#U1[@]} -gt 0 ] || [ "$STA" = 1 ] || remote "$S1" "sudo rm -f $INBOX/$(basename "$TARBALL") $INBOX/$(basename "$TARBALL").sha256"
fi
if [ ${#U2[@]} -gt 0 ] || [ "$FEED" = 1 ] || [ "$BIN" = 1 ]; then
  say "server 2 ($S2): upload, scripts"
  upload "$S2"
  sync_bin "$S2" >&2
  [ ${#U2[@]} -gt 0 ] || [ "$FEED" = 1 ] || remote "$S2" "sudo rm -f $INBOX/$(basename "$TARBALL") $INBOX/$(basename "$TARBALL").sha256"
fi
[ "$BIN" = 0 ] || done_note "scripts updated on both servers"

# The maintenance window over the restarts, and the first of the two messages.
if [ ${#U1[@]} -gt 0 ] || [ ${#U2[@]} -gt 0 ]; then
  say "maintenance window: $TAG"
  maint_open "$(IFS=,; echo "${U1[*]}${U1[*]:+${U2[*]:+,}}${U2[*]}")"
  STARTED=1
  where=""
  if [ ${#U1[@]} -gt 0 ]; then where="$(IFS=,; echo "${U1[*]}" | sed 's/,/, /g') on server 1"; fi
  if [ ${#U2[@]} -gt 0 ]; then where="${where:+$where; }executor on server 2"; fi
  if [ "$WEB" = 1 ]; then where="$where; then the web"; fi
  tell maintenance "$TAG started: $where. Health alerts about these are held until it is done (60 min at most); anything else alerts as always."
  notice_post
fi

if [ ${#U1[@]} -gt 0 ] || [ "$STA" = 1 ]; then
  S1U=("${U1[@]}"); [ "$STA" = 0 ] || S1U+=(status)
  say "server 1 ($S1): ${S1U[*]}"
  t0=0
  if want indexer; then t0="$(remote "$S1" 'date +%s%3N')"; fi
  release_on "$S1" "$(IFS=,; echo "${S1U[*]}")"
  # What the old process published before it stopped does not count.
  restarted=0
  if want indexer; then restarted="$(remote "$S1" 'date +%s%3N')"; fi
  if [ "$STA" = 1 ]; then done_note "status prober restarted"; fi
  if want api; then done_note "api back"; fi
  if want indexer; then
    # Back when it publishes fresh status again. Not its first board build: the boards keep showing
    # meanwhile, and that build took 40 to 110 min at midday on 2026-11-05. Waiting for it held the
    # website behind it and turned a healthy release into "not back to normal". A build that stays
    # old is the status page's to say (boards over an hour old count as degraded).
    note "waiting for the indexer to publish again on $TAG"
    built="" whole=""
    for i in $(seq 1 30); do
      read -r at ms conf markets down < <(indexer_state || echo "0 0 -1 -1 ?")
      if [ -z "$built" ] && [ "${at:-0}" -gt "$restarted" ]; then built="$at"; note "indexer publishing $(( (at - t0) / 1000 )) s after the restart"; fi
      if [ -n "$built" ] && [ "$down" = "-" ]; then whole=1; break; fi
      sleep 10
    done
    if [ -n "$built" ]; then
      done_note "indexer: publishing again $(( (built - t0) / 1000 )) s after the restart$([ -n "$whole" ] && echo ", every stream up" || echo ", streams still reconnecting: $down")"
      notice_note "Leaderboards and cohorts keep showing; their figures catch up over the next rebuild."
    else
      note "!! the indexer has not published in 5 minutes after the restart - check it (deploy/release/remote.sh logs indexer)"
      done_note "indexer: NOT publishing 5 minutes after the restart - check it (deploy/release/remote.sh logs indexer)"
      WARNED=1
    fi
  fi
  if want api; then freeze_gate "$(IFS=,; echo "${S1U[*]}")"; fi
fi

# --- 6b. the copy executor, guarded ---------------------------------------------------------------
BRAKE_FILE=/var/lib/valuescan/brake.json
BRAKE0=""
# The brake as it was before (the file's exact text; empty: off), put back as it was.
restore_brake() {
  if [ -z "$BRAKE0" ]; then remote "$S2" 'sudo bash /opt/valuescan/bin/brake.sh off' >&2
  else printf '%s\n' "$BRAKE0" | remote "$S2" "sudo bash -c 'cat > $BRAKE_FILE.ship && chmod 0644 $BRAKE_FILE.ship && mv -f $BRAKE_FILE.ship $BRAKE_FILE'"
  fi
}
exec_healthy() { printf '%s' "$1" | json 'v && v.ok && v.db && v.feeds && v.feeds.sodex ? 1 : 0'; }
exec_rollback() {   # why
  local cur h i
  note "!! executor on $TAG: $1 - rolling back; copies and algos stay held"
  cur="$(remote "$S2" 'sudo /opt/valuescan/bin/release.sh --status' | sed -n 's/^current: *//p')"
  if [ "$cur" = "$TAG" ]; then remote "$S2" 'sudo /opt/valuescan/bin/release.sh --rollback --units=executor' >&2 || true; fi
  for i in $(seq 1 30); do
    h="$(exec_health)"
    if [ "$(exec_healthy "$h")" = 1 ]; then
      restore_brake
      notice_done rolled_back "The copy executor's update was rolled back; copies and algo orders run as before."
      die "executor: $TAG rolled back - it runs the release before ($(counts "$h")), copies and algos resumed"
    fi
    sleep 2
  done
  # Held longer than an update now: an operator's brake (Telegram "🛑 BRAKE"), in words for followers.
  remote "$S2" "sudo bash /opt/valuescan/bin/brake.sh on copies,algos 'An update of the copy executor did not go through: copies and algos are held until it is fixed. Stops resting on SoDEX stay.'" >&2 || true
  NOTICE_OK=0
  notice_affected executor:down "The copy executor's update did not go through: copies and algo orders are held until it is fixed. Stops already on SoDEX stay."
  die "executor: $TAG rolled back but the executor is NOT healthy ($h). The brake stays ON: copies and algos are held. Now: docs/INCIDENT-RUNBOOK.md"
}
ship_executor() {
  local tb="$INBOX/$(basename "$TARBALL")" pre h h1="" i ok=""
  # a. the new code installed and checked; the old one keeps running
  remote "$S2" "sudo /opt/valuescan/bin/release.sh $TAG --install-only --from=$tb" >&2 || die "executor: $TAG did not install on server 2 - nothing switched"
  # b. the new code on a snapshot of today's data, against what the running executor reports; as the
  #    executor's own user, so nothing it touches beside the live database can end up root's. The snapshot
  #    as taken stays (c): the database as it stood before this release, beside the live one, never deleted.
  local keep="/var/lib/valuescan/executor/pre-release/executor-before-$TAG-$(date -u +%Y%m%dT%H%M%SZ).db"
  pre="$(remote "$S2" "sudo -u valuescan-executor bash -c 'cd /opt/valuescan/releases/$TAG/apps/executor && /opt/node/current/bin/node --disable-warning=ExperimentalWarning --import tsx tools/preflight.ts /var/lib/valuescan/executor/executor.db --keep=$keep'" || true)"
  # A whole copy of the executor's database: for its own user only (they were left readable by all).
  remote "$S2" "sudo bash -c 'chmod 600 /var/lib/valuescan/executor/pre-release/*.db 2>/dev/null || true'" >&2
  h="$(exec_health)"
  note "preflight: $pre"
  [ "$(printf '%s' "$pre" | json 'v && v.ok ? 1 : 0')" = 1 ] || die "executor: the new code does not read today's data - nothing switched"
  [ "$(counts "$pre")" = "$(counts "$h")" ] || die "executor: the new code sees $(counts "$pre"), the running one $(counts "$h") - nothing switched (a copy added meanwhile? run it again)"
  # c. (the snapshot above is the copy to go back to: $keep)
  # d. a quiet moment: nothing waiting in the send queue (up to a minute; the stop lets a step in flight finish anyway)
  for i in $(seq 1 30); do
    [ "$(exec_health | json 'v && v.queue ? v.queue.waiting + v.queue.inFlight : 0')" = 0 ] && break
    sleep 2
  done
  # e. the brake over the restart: the new process sends nothing until it is checked. Planned work
  #    (--maintenance): neither brake.sh nor the executor tells Telegram of it - this ship's messages do.
  BRAKE0="$(remote "$S2" "cat $BRAKE_FILE 2>/dev/null || true")"
  remote "$S2" "sudo bash /opt/valuescan/bin/brake.sh on --maintenance copies,algos 'Updating the copy executor: copies and algos go on within a minute.'" >&2
  # f. switch and restart
  remote "$S2" "sudo /opt/valuescan/bin/release.sh $TAG --units=executor --from=$tb && sudo rm -f $tb $tb.sha256" >&2 || exec_rollback "it did not come back healthy"
  # g. the same copies and algos and its SoDEX feed up, then trading as it was
  for i in $(seq 1 45); do
    h1="$(exec_health)"
    if [ "$(exec_healthy "$h1")" = 1 ] && [ "$(counts "$h1")" = "$(counts "$h")" ]; then ok=1; break; fi
    sleep 2
  done
  [ -n "$ok" ] || exec_rollback "after 90 s it reports $(counts "$h1") (before: $(counts "$h")), healthy: $(exec_healthy "$h1")"
  restore_brake
  note "executor on $TAG: $(counts "$h1"), the brake back as it was"
  done_note "executor: $(counts "$h1") as before, the brake back as it was$([ -n "$BRAKE0" ] && echo " (ON: it was on before)")"
}

if [ ${#U2[@]} -gt 0 ]; then
  say "server 2 ($S2): executor"
  ship_executor
fi
# The shared feed: after the executor (its release then is installed and current there: no tarball needed),
# or on its own (installed from the tarball, current switched, nothing else restarted).
if [ "$FEED" = 1 ]; then
  say "server 2 ($S2): shared feed"
  if [ ${#U2[@]} -gt 0 ]; then
    if remote "$S2" "sudo /opt/valuescan/bin/release.sh $TAG --units=feed" >&2; then done_note "shared feed restarted"
    else note "!! the shared feed did not come back on $TAG (journalctl -u valuescan-feed); its readers use their own sockets"; done_note "shared feed NOT back - check it"; WARNED=1; fi
  else
    release_on "$S2" feed
    done_note "shared feed restarted"
  fi
fi

# The restarts are over: what fails from here on is a failure.
maint_close
# Green only when every restarted part is healthy again (the header: THE NOTICE).
if [ ${#U1[@]} -gt 0 ] || [ ${#U2[@]} -gt 0 ]; then
  AFFECTED="$(final_checks)"
  if [ -n "$AFFECTED" ]; then
    NOTICE_OK=0 WARNED=1
    note "!! not healthy after the restarts: $AFFECTED"
    done_note "NOT healthy after the restarts: $AFFECTED"
  fi
  if [ "$NOTICE_OK" = 1 ]; then notice_done ok "Done: everything runs normally again.${NOTICE_STILL:+ $NOTICE_STILL}"
  elif [ -n "$AFFECTED" ]; then notice_affected "$AFFECTED" "The update is installed, but these parts are not back to normal yet; we are on it."
  else notice_note "The update is installed, but not everything is back to normal yet; we are on it."; fi
fi

# --- 7. the web -----------------------------------------------------------------------------------
if [ "$MOVE_MAIN" = 1 ]; then
  say "main -> $TAG"
  "${G[@]}" push -q origin "$HEAD_SHA:refs/heads/main"
  # Vercel builds main only when a file of the site changed (deploy/vercel/ignore-build.sh, web-changed.mjs):
  # `web` named with no such file means no deployment to wait for - the live site already is HEAD's.
  if [ "$WEB" = 1 ] && node deploy/vercel/web-changed.mjs "$OLD_MAIN" "$HEAD_SHA" >/dev/null 2>&1; then
    note "web: no file of the site changed since main ${OLD_MAIN:0:7}, so Vercel skips this build; the live site stays"
    WEB=0
  fi
  if [ "$WEB" = 1 ]; then
    note "waiting for Vercel's Production deployment of ${HEAD_SHA:0:7}"
    state=""
    for _ in $(seq 1 60); do
      # The main project's: "Production", or "Production – valuedesk" since a second Vercel project
      # (valuedesk-beta, docs/BETA.md) builds the same repository - never the beta project's.
      id="$(gh_api "$REPO/deployments?sha=$HEAD_SHA" | json '(Array.isArray(v) ? v : []).filter((d) => /^Production( – valuedesk)?$/.test(d.environment)).map((d) => d.id)[0] ?? ""')"
      if [ -n "$id" ]; then
        state="$(gh_api "$REPO/deployments/$id/statuses" | json 'v && v[0] ? v[0].state : ""')"
        case "$state" in success|failure|error) break ;; esac
      fi
      sleep 15
    done
    [ "$state" = success ] || die "the web's Production deployment is '${state:-not there}' after 15 minutes (Vercel dashboard)"
    # Into a file of our own: with MSYS_NO_PATHCONV (lib.sh) Windows curl takes /dev/null literally and fails (23).
    code="$(curl -s -o "$OUT_DIR/site-check.html" -w '%{http_code}' --limit-rate 2M --max-time 20 "$SITE/" || true)"
    rm -f "$OUT_DIR/site-check.html"
    [ "$code" = 200 ] || die "$SITE answers $code after the deployment"
    note "web live on $SITE"
    done_note "web live"
  fi
fi

log_ship "ok"
took="$(( ($(date -u +%s) - START) / 60 ))"
say "shipped $TAG in $took min: ${PARTS[*]:-}$([ "$BIN" = 1 ] && echo " bin")"
if [ "$STARTED" = 1 ]; then
  summary="$(printf '%s; ' ${DONE_NOTES[@]+"${DONE_NOTES[@]}"})"
  if [ "$WARNED" = 1 ]; then tell failure "$TAG shipped in $took min, but not all is well: ${summary%; }"
  else tell maintenance "$TAG done in $took min: ${summary%; }"; fi
fi
