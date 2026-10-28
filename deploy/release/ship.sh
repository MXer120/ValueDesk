#!/usr/bin/env bash
# deploy/release/ship.sh - THE PIPELINE: ship what changed to where it runs, from this laptop.
#
#   bash deploy/release/ship.sh                  what changed since what is live: the plan, one question, then ship
#   bash deploy/release/ship.sh web api          only these parts: web, api, indexer, executor (or all)
#   bash deploy/release/ship.sh --dry-run        the plan only - nothing is tagged, pushed or released
#   bash deploy/release/ship.sh --yes            no question (the owner's go is already given)
#   bash deploy/release/ship.sh --tag=v0.2.60    this tag instead of the next one (or the one HEAD already has)
#   bash deploy/release/ship.sh --no-notice      no maintenance notice on the status page for an indexer restart
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
#   6. server 1: release.sh --units=<indexer,api - those that changed>. An indexer restart first posts a
#      maintenance notice on the status page (so its pause is not an incident) and completes it when the
#      indexer has built its boards again. Server 2: release.sh --units=executor. A unit that does not come
#      back healthy is rolled back to the release before at once, and ship.sh stops;
#   7. main moves to the tag (fast-forward) - Vercel builds and publishes the web - and, when the web changed,
#      it waits for GitHub to show that Production deployment as successful and the site answering.
#      The web goes last on purpose: what it calls already runs the new code when it appears.
# Each ship is a line in deploy/.out/ships.log.
#
# DOWNTIME (measured on v0.2.57, 2026-10-28):
#   web       none: Vercel switches atomically; an open tab whose files a deploy replaced reloads once (lazyPage.ts)
#   api       no failed request: the API is away ~6 s and Caddy holds each request meanwhile (lb_try_duration
#             15 s); the heatmap's WebSocket reconnects
#   executor  no failed request: back in seconds, Caddy holds its requests up to 20 s; copies and algos wait
#   indexer   the site keeps serving the last boards, ~2 min staler (start ~35 s, first build ~70 s); the
#             streams' gap is read again. Hence the maintenance notice.
#
# NOT DONE HERE: units, Caddy, env templates, bootstrap (deploy/server outside bin) - ship.sh says so and
# leaves them to bootstrap-instance.sh; the web's rollback (Vercel: promote the deployment before, or ship a revert).
#
# Hosts and key: VS_SERVER1 / VS_SERVER2 / VS_SSH_KEY (as brake.sh). Needs node (the ddx-tools Node is found by
# itself) and a GitHub token (GITHUB_TOKEN, else git's stored credential for github.com).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
. "$(dirname "${BASH_SOURCE[0]}")/test-gate.sh"

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
PARTS=() DRY=0 YES=0 TAG="" NOTICE=1
for a in "$@"; do
  case "$a" in
    web|api|indexer|executor) PARTS+=("$a") ;;
    all) PARTS+=(web api indexer executor) ;;
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    --tag=*) TAG="${a#--tag=}" ;;
    --no-notice) NOTICE=0 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $a (parts: web api indexer executor all)" ;;
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
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s||"null");const f=new Function("v",`return (${process.argv[1]})`);const o=f(v);process.stdout.write(o==null?"":String(o))})' "$1"; }

# --- 1. what runs where ---------------------------------------------------------------------------
say "what runs where"
"${G[@]}" fetch -q origin main --tags
HEAD_SHA="$(git rev-parse HEAD)"
BRANCH="$(git symbolic-ref --short -q HEAD || true)"
"${G[@]}" merge-base --is-ancestor origin/main HEAD || die "HEAD does not contain origin/main: bring this branch up to date with main first"
st1="$(remote "$S1" 'sudo /opt/valuescan/bin/release.sh --status' 2>/dev/null)" || die "server 1 ($S1) does not answer"
st2="$(remote "$S2" 'sudo /opt/valuescan/bin/release.sh --status' 2>/dev/null)" || die "server 2 ($S2) does not answer"
unit_tag() { printf '%s\n' "$1" | sed -n "s/^$2: *[a-z-]*, release //p" | head -1; }
LIVE_INDEXER="$(unit_tag "$st1" indexer)"; LIVE_API="$(unit_tag "$st1" api)"; LIVE_EXECUTOR="$(unit_tag "$st2" executor)"
note "server 1: indexer ${LIVE_INDEXER:-?}, API ${LIVE_API:-?}   server 2: executor ${LIVE_EXECUTOR:-?}   web: main $(git rev-parse --short origin/main)"

# A part changed when parts.mjs finds files of it between what runs and HEAD (an unknown or gone release: changed).
changed_since() {   # part, live ref
  [ -n "$2" ] && [ "$2" != unknown ] && git rev-parse -q --verify "$2^{commit}" >/dev/null || { echo "?"; return; }
  node deploy/release/parts.mjs --from="$2" --to=HEAD --json | json "v.parts['$1'].length"
}
declare -A WHY
want() { local p; for p in "${PARTS[@]}"; do [ "$p" = "$1" ] && return 0; done; return 1; }
if [ ${#PARTS[@]} -eq 0 ]; then
  for p in web api indexer executor; do
    case "$p" in web) from="origin/main" ;; api) from="$LIVE_API" ;; indexer) from="$LIVE_INDEXER" ;; executor) from="$LIVE_EXECUTOR" ;; esac
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
WEB=0; want web && WEB=1
if [ ${#U1[@]} -eq 0 ] && [ ${#U2[@]} -eq 0 ] && [ "$WEB" = 0 ] && [ "$BIN" = 0 ]; then
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
    indexer) echo "boards ~2 min staler; maintenance notice $( [ "$NOTICE" = 1 ] && echo on || echo off)" ;;
  esac
}
say "plan: $TAG ($(git rev-parse --short HEAD)$([ "$NEW_TAG" = 1 ] && echo ", new tag"))"
for p in indexer api executor web; do
  want "$p" || continue
  where=""; case "$p" in indexer|api) where="server 1" ;; executor) where="server 2" ;; web) where="Vercel" ;; esac
  printf '  %-9s %-9s %-30s %s\n' "$p" "$where" "${WHY[$p]:-}" "$(cost "$p")" >&2
done
[ "$BIN" = 0 ] || note "  bin       both      /opt/valuescan/bin from the tarball where it differs"
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
fi

START="$(date -u +%s)"
log_ship() { mkdir -p "$OUT_DIR"; printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TAG" "$(git rev-parse --short HEAD)" "$*" "${PARTS[*]}" >> "$OUT_DIR/ships.log"; }
trap 'rc=$?; [ $rc = 0 ] || log_ship "FAILED (exit $rc)"' EXIT

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

# The indexer's state in the index (meta indexer_status): last build, its pid, Lighter's subscriptions, streams down.
indexer_state() {
  remote "$S1" 'sudo /opt/node/current/bin/node --disable-warning=ExperimentalWarning -' <<'EOF'
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('/var/lib/valuescan/index/valuescan-index.db', { readOnly: true });
const r = d.prepare("select * from meta where key = 'indexer_status'").get();
const s = r ? JSON.parse(Object.values(r)[1]) : {};
const l = s.venues?.lighter?.subscribed;
const down = Object.entries(s.streams ?? {}).filter(([, v]) => v == null).map(([k]) => k);
console.log([s.lastBuildAt ?? 0, s.lastBuildMs ?? 0, l?.confirmed ?? -1, l?.markets ?? -1, down.join(',') || '-'].join(' '));
EOF
}

NOTICE_ID=""
status_cmd() { remote "$S1" "sudo bash /opt/valuescan/bin/status.sh $*"; }

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
    remote "$host" "sudo /opt/valuescan/bin/release.sh --rollback --units=$units" || note "!! the rollback failed too - look at it now: deploy/release/remote.sh, docs/INCIDENT-RUNBOOK.md"
  else
    note "!! $TAG did not install on $host; nothing was switched (current: $cur)"
  fi
  if [ -n "$NOTICE_ID" ]; then status_cmd "resolve $NOTICE_ID 'The update was rolled back; everything runs as before.'" >/dev/null || true; fi
  die "$units on $host: not shipped"
}

if [ ${#U1[@]} -gt 0 ] || [ ${#U2[@]} -gt 0 ] || [ "$BIN" = 1 ]; then need_tarball; fi

if [ ${#U1[@]} -gt 0 ] || [ "$BIN" = 1 ]; then
  say "server 1 ($S1): ${U1[*]:-bin only}"
  upload "$S1"
  sync_bin "$S1" >&2
  if [ ${#U1[@]} -gt 0 ]; then
    t0=0
    if want indexer; then
      t0="$(remote "$S1" 'date +%s%3N')"
      if [ "$NOTICE" = 1 ]; then
        NOTICE_ID="$(status_cmd "maintenance 'Indexer update' --start=now --end=+30m --components=indexer 'Leaderboards, cohorts and the heatmap stay up; their figures may be a few minutes behind while the indexer restarts.'" | grep -o '#[0-9]*' | head -1 | tr -d '#')"
        note "status page: maintenance #${NOTICE_ID:-?} posted"
      fi
    fi
    release_on "$S1" "$(IFS=,; echo "${U1[*]}")"
    if want indexer; then
      note "waiting for the indexer's first build on $TAG"
      # Up to 30 minutes for the first build, then up to 10 more for every stream to be whole.
      built="" whole="" since=0
      for i in $(seq 1 90); do
        read -r at ms conf markets down < <(indexer_state || echo "0 0 -1 -1 ?")
        if [ -z "$built" ] && [ "${at:-0}" -gt "$t0" ]; then built="$at"; since="$i"; note "boards built again $(( (at - t0) / 1000 )) s after the restart (that build: $(( ms / 1000 )) s)"; fi
        if [ -n "$built" ] && [ "$down" = "-" ]; then whole=1; break; fi
        if [ -n "$built" ] && [ $((i - since)) -ge 30 ]; then break; fi
        sleep 20
      done
      if [ -n "$NOTICE_ID" ]; then
        if [ -n "$whole" ]; then msg="Done: leaderboards and cohorts are current again."
        elif [ -n "$built" ]; then
          names="$(printf '%s' "$down" | sed 's/sodex/SoDEX/; s/hyperliquid/Hyperliquid/; s/tradexyz/trade.xyz/; s/arcus/Arcus/; s/,/, /g')"
          if [ "${markets:--1}" -gt 0 ]; then names="${names/lighter/Lighter ($conf of $markets markets)}"; else names="${names/lighter/Lighter}"; fi
          msg="Leaderboards and cohorts are current again. Still reconnecting: $names - their newest trades may show a few minutes late."
        else msg="The indexer restarted; its first rebuild is taking longer than usual."; fi
        status_cmd "resolve $NOTICE_ID '$msg'" >/dev/null && note "status page: maintenance #$NOTICE_ID completed"
      fi
      [ -n "$built" ] || note "!! no board build within 30 minutes of the restart - check the indexer (deploy/release/remote.sh logs indexer)"
    fi
  fi
fi

if [ ${#U2[@]} -gt 0 ] || [ "$BIN" = 1 ]; then
  say "server 2 ($S2): ${U2[*]:-bin only}"
  upload "$S2"
  sync_bin "$S2" >&2
  [ ${#U2[@]} -eq 0 ] || release_on "$S2" executor
fi

# --- 7. the web -----------------------------------------------------------------------------------
if [ "$MOVE_MAIN" = 1 ]; then
  say "main -> $TAG"
  "${G[@]}" push -q origin "$HEAD_SHA:refs/heads/main"
  if [ "$WEB" = 1 ]; then
    note "waiting for Vercel's Production deployment of $(git rev-parse --short HEAD)"
    state=""
    for _ in $(seq 1 60); do
      id="$(gh_api "$REPO/deployments?sha=$HEAD_SHA&environment=Production" | json 'v && v[0] ? v[0].id : ""')"
      if [ -n "$id" ]; then
        state="$(gh_api "$REPO/deployments/$id/statuses" | json 'v && v[0] ? v[0].state : ""')"
        case "$state" in success|failure|error) break ;; esac
      fi
      sleep 15
    done
    [ "$state" = success ] || die "the web's Production deployment is '${state:-not there}' after 15 minutes (Vercel dashboard)"
    code="$(curl -s -o /dev/null -w '%{http_code}' --limit-rate 2M --max-time 20 "$SITE/")"
    [ "$code" = 200 ] || die "$SITE answers $code after the deployment"
    note "web live on $SITE"
  fi
fi

log_ship "ok"
say "shipped $TAG in $(( ($(date -u +%s) - START) / 60 )) min: ${PARTS[*]:-}$([ "$BIN" = 1 ] && echo " bin")"
