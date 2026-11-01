#!/usr/bin/env bash
# /opt/valuescan/bin/release.sh - install a server release and switch to it.
#
#   sudo /opt/valuescan/bin/release.sh <tag>              install <tag>, restart what runs changed code
#   sudo /opt/valuescan/bin/release.sh <tag> --all        install <tag>, restart indexer, API, executor
#   sudo /opt/valuescan/bin/release.sh <tag> --api-only   install <tag>, restart the API only
#   sudo /opt/valuescan/bin/release.sh <tag> --executor-only   install <tag>, restart the copy executor only
#   sudo /opt/valuescan/bin/release.sh <tag> --units=indexer,api   install <tag>, restart exactly these (deploy/release/ship.sh;
#                                                                  also `status`: the status prober, valuescan-status.service)
#   sudo /opt/valuescan/bin/release.sh <tag> --install-only   install and check <tag>, switch nothing (ship.sh's executor preflight)
#   sudo /opt/valuescan/bin/release.sh --rollback [--all|--api-only|--executor-only|--units=..]   back to the release before
#   sudo /opt/valuescan/bin/release.sh --status           what is installed and running
#   sudo /opt/valuescan/bin/release.sh <tag> --from=<file.tar.gz>   the tarball is already here
#
# Normally started from your workstation by deploy/release/release-server.sh
# (through SSM Run Command, or over SSH on an instance without a role); it can be
# run by hand in a shell on the instance.
#
# WHAT A RELEASE IS. The tarball of one git tag, uploaded to
# s3://<ops bucket>/releases/server/valuescan-server-<tag>.tar.gz with its .sha256 -
# or copied onto the instance over SSH and named with --from (its .sha256 next to it).
# It is unpacked into /opt/valuescan/releases/<tag>, dependencies are installed
# from the committed lockfile (npm ci, the server workspace only, no install
# scripts), and /opt/valuescan/current is switched to it atomically. Running
# processes keep the release directory they started from, so nothing changes
# under a process that was not restarted.
#
# THE ORDER. The indexer first: it is the writer and applies schema changes when
# it opens the file. Then the API. Zero downtime is not a goal: the API is back
# in seconds, and while it is away CloudFront answers from its short cache or
# with an error the web shows as "index unavailable" - trading and Scan go
# browser-direct and are not affected.
# Then the copy executor (apps/executor, in the same tarball since it exists):
# back in seconds, its feeds reconnect, and the next read of each leader's and
# follower's positions settles a change it missed meanwhile. A release without
# apps/executor leaves a running executor alone.
#
# ONLY WHAT CHANGED (the default). A unit is restarted only when the code it runs
# differs from the new release's: the indexer and the API when apps/server or the
# installed dependencies differ, the copy executor when apps/executor,
# packages/copy-engine, packages/sodex-core or the dependencies differ (tests are
# not compared). So a release of web or API changes never stops a running copy
# or algo, and one that only touches the executor keeps the indexer's streams.
# A unit that is not running is started. --all restarts all three regardless.
# The comparison is of the two release directories on this disk (diff), so it
# needs no git and holds for a rollback too.
#
# WHICH UNITS THIS SERVER RUNS: VS_UNITS (ops.local.env), a comma list of indexer, api,
# executor - unset, all three. On a server that runs some of them (server 1: indexer,api;
# server 2: executor) the others are neither compared nor started. --units= names the
# units to restart outright, in the order indexer, API, executor; deploy/release/ship.sh
# passes it, having worked out from the commits which services run changed code.
#
# THE COST OF RESTARTING THE INDEXER: its trade streams reconnect. Hyperliquid
# and SoDEX are back in seconds; Lighter needs 3.5-8 minutes to re-subscribe its
# ~220 markets, and that gap has to be re-read for the traders on the boards.
# When a release changes nothing the indexer runs (routes, perf, hosted gate),
# use --api-only.
set -euo pipefail

VS_HOME="${VS_HOME:-/opt/valuescan}"
ETC="${VS_ETC:-/etc/valuescan}"
for f in "$ETC/ops.env" "$ETC/ops.local.env"; do
  if [ -f "$f" ]; then set -a; . "$f"; set +a; fi
done
NODE_BIN_DIR="${NODE_BIN_DIR:-/opt/node/current/bin}"
export PATH="$NODE_BIN_DIR:$PATH"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
API_URL="${API_URL:-http://127.0.0.1:8797}"
EXECUTOR_URL="${EXECUTOR_URL:-http://127.0.0.1:8799}"
RELEASES="$VS_HOME/releases"
CURRENT="$VS_HOME/current"
KEEP="${RELEASES_KEEP:-3}"
SERVICE_GROUP="${VS_SERVICE_GROUP:-valuescan}"

log() { printf '[release] %s\n' "$*"; }
die() { printf '[release] error: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

current_tag() { if [ -L "$CURRENT" ]; then basename "$(readlink -f "$CURRENT")"; fi; }
previous_tag() { if [ -f "$RELEASES/.previous" ]; then cat "$RELEASES/.previous"; fi; }

# Tags name directories and S3 keys: letters, digits, dot, dash, underscore.
valid_tag() {
  case "$1" in
    ''|.*|*[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
  esac
}

install_release() {
  local tag="$1" dir="$RELEASES/$1" inc="$RELEASES/.incoming"
  if [ -d "$dir" ]; then
    log "$tag is already installed"
    return 0
  fi
  rm -rf "$inc"
  mkdir -p "$inc/tree"
  local key="releases/server/valuescan-server-$tag.tar.gz"
  if [ -n "$FROM" ]; then
    key="$FROM"
    [ -f "$FROM" ] && [ -f "$FROM.sha256" ] || die "--from: $FROM and $FROM.sha256 must both exist"
    log "taking $FROM"
    cp "$FROM" "$inc/release.tar.gz"
    cp "$FROM.sha256" "$inc/release.sha256"
  else
    : "${OPS_BUCKET:?OPS_BUCKET is not set (see $ETC/ops.env) - without an ops bucket name the tarball with --from}"
    log "downloading s3://$OPS_BUCKET/$key"
    aws s3 cp "s3://$OPS_BUCKET/$key" "$inc/release.tar.gz" --only-show-errors
    aws s3 cp "s3://$OPS_BUCKET/$key.sha256" "$inc/release.sha256" --only-show-errors
  fi
  local want got
  want="$(awk '{print $1; exit}' "$inc/release.sha256")"
  got="$(sha256sum "$inc/release.tar.gz" | awk '{print $1}')"
  [ -n "$want" ] && [ "$want" = "$got" ] || die "checksum mismatch for $key (expected $want, got $got)"
  log "checksum matches"

  tar -xzf "$inc/release.tar.gz" -C "$inc/tree" --strip-components=1 --no-same-owner
  [ -f "$inc/tree/package-lock.json" ] && [ -f "$inc/tree/apps/server/src/index.ts" ] \
    || die "$key is not a ValueDesk server release"
  # The server loads <release>/.env if it exists; a release must never bring one.
  [ ! -e "$inc/tree/.env" ] || die "the release contains a .env file - refusing it"

  # The copy executor runs from the same tree (apps/executor with packages/copy-engine
  # and packages/sodex-core). Those two packages are workspaces whose @noble/* the
  # lockfile hoists to the ROOT node_modules - a version the server workspace alone
  # does not install (it keeps its own newer @noble nested under apps/server), so they
  # are installed with it: without them the executor's imports of @noble fail.
  # Should apps/executor become a workspace of its own, its dependencies come too.
  local ws=(--workspace apps/server)
  if [ -f "$inc/tree/apps/executor/src/main.ts" ]; then
    for p in packages/sodex-core packages/copy-engine; do
      [ -f "$inc/tree/$p/package.json" ] && ws+=(--workspace "$p")
    done
    if ( cd "$inc/tree" && node -e "const w = require('./package.json').workspaces || []; process.exit(w.includes('apps/executor') || w.includes('apps/*') ? 0 : 1)" ); then
      ws+=(--workspace apps/executor)
    fi
  fi
  log "installing dependencies from the lockfile (${ws[*]}, no install scripts)"
  ( cd "$inc/tree"
    npm_config_cache="${NPM_CACHE_DIR:-/var/cache/valuescan/npm}" npm_config_update_notifier=false \
      npm ci "${ws[@]}" --ignore-scripts --no-audit --no-fund )

  # Does it load at all? Importing the hosted gate starts nothing and touches no file.
  ( cd "$inc/tree/apps/server"
    node --disable-warning=ExperimentalWarning --import tsx --input-type=module \
      -e "const m = await import('./src/hosted.ts'); if (!m.HOSTED_ROUTES?.length) process.exit(1)" ) \
    || die "the release does not load under $(node --version)"
  # The executor likewise: importing its HTTP layer loads the engine and the signing
  # library (and their @noble imports), and starts nothing.
  if [ -f "$inc/tree/apps/executor/src/main.ts" ]; then
    ( cd "$inc/tree/apps/executor"
      node --disable-warning=ExperimentalWarning --import tsx --input-type=module \
        -e "const m = await import('./src/server.ts'); if (typeof m.createExecutorServer !== 'function') process.exit(1)" ) \
      || die "the release's copy executor (apps/executor) does not load under $(node --version)"
  else
    log "this release has no copy executor (apps/executor)"
  fi
  node --disable-warning=ExperimentalWarning -e "require('node:sqlite')" || die "this Node has no node:sqlite"

  printf '%s\n' "$tag" > "$inc/tree/.release"
  # Root owns the code; the service user may read it and nothing else.
  chown -R "root:$SERVICE_GROUP" "$inc/tree" 2>/dev/null || true
  chmod -R u=rwX,g=rX,o= "$inc/tree"
  mv "$inc/tree" "$dir"
  rm -rf "$inc"
  log "installed $tag"
}

activate() {
  local tag="$1" prev
  prev="$(current_tag)"
  if [ -n "$prev" ] && [ "$prev" != "$tag" ]; then printf '%s\n' "$prev" > "$RELEASES/.previous"; fi
  ln -sfn "$RELEASES/$tag" "$CURRENT.new"
  mv -Tf "$CURRENT.new" "$CURRENT"
  log "current -> $tag${prev:+ (was $prev)}"
}

wait_active() {
  local unit="$1" tries="${2:-30}"
  for _ in $(seq 1 "$tries"); do
    if "$SYSTEMCTL" is-active --quiet "$unit"; then return 0; fi
    sleep 1
  done
  return 1
}

wait_ok() {   # url, tries: until it answers {"ok":true...}
  for _ in $(seq 1 "${2:-60}"); do
    if curl -fsS --max-time 3 "$1" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    sleep 1
  done
  return 1
}
wait_health() { wait_ok "$API_URL/api/health" "${1:-60}"; }

# What each unit's code is made of, relative to a release. node_modules/.package-lock.json
# is npm's record of what it installed: it differs exactly when the installed
# dependencies do (a web-only dependency in the lockfile does not change it).
SERVER_CODE=(apps/server)
EXECUTOR_CODE=(apps/executor packages/copy-engine packages/sodex-core)
SHARED_CODE=(node_modules/.package-lock.json)

# True when every path is the same under release dirs <a> and <b> (absent in both
# counts as the same). Dependencies and tests are not compared.
same_tree() {
  local a="$1" b="$2" p; shift 2
  for p in "$@"; do
    if [ ! -e "$a/$p" ] && [ ! -e "$b/$p" ]; then continue; fi
    [ -e "$a/$p" ] && [ -e "$b/$p" ] || return 1
    diff -rq --no-dereference -x node_modules -x test -x '*.test.ts' -x '*.test.mjs' "$a/$p" "$b/$p" >/dev/null 2>&1 || return 1
  done
}

# True when <unit> must be restarted to run `current`: it is not running, its
# release is gone, or its code differs from current's in the given paths.
needs_restart() {
  local unit="$1" from; shift
  from="$(unit_release "$unit")"
  [ -n "$from" ] && [ -d "$RELEASES/$from" ] || return 0
  [ "$RELEASES/$from" -ef "$CURRENT" ] && return 1
  ! same_tree "$RELEASES/$from" "$CURRENT" "$@" "${SHARED_CODE[@]}"
}

restart_indexer_and_api() {
  local api_only="$1"
  if [ "$api_only" != 1 ]; then
    restart_indexer
  else
    log "API only: the indexer keeps running release $(indexer_release)"
  fi
  restart_api
}

restart_indexer() {
  log "restarting the indexer (its Lighter stream needs minutes to be whole again)"
  "$SYSTEMCTL" restart valuescan-indexer.service
  wait_active valuescan-indexer.service 30 || die "the indexer did not become active - journalctl -u valuescan-indexer -n 80"
  # Schema changes happen as it opens the database: let it get there before the API reads.
  sleep "${INDEXER_SETTLE_S:-5}"
  "$SYSTEMCTL" is-active --quiet valuescan-indexer.service || die "the indexer stopped again - journalctl -u valuescan-indexer -n 80"
}

restart_api() {
  log "restarting the API"
  "$SYSTEMCTL" restart valuescan-api.service
  wait_active valuescan-api.service 30 || die "the API did not become active - journalctl --namespace=pii -u valuescan-api -n 80"
  wait_health 60 || die "the API does not answer /api/health - journalctl --namespace=pii -u valuescan-api -n 80 ; roll back with: release.sh --rollback"
  log "the API answers /api/health"
}

# The copy executor, from the release `current` points to - if that release has one.
restart_executor() {
  if [ ! -e "$CURRENT/apps/executor/src/main.ts" ]; then
    if "$SYSTEMCTL" is-active --quiet valuescan-executor.service; then
      log "this release has no copy executor: the running one keeps release $(release_of valuescan-executor.service)"
    else
      log "this release has no copy executor (apps/executor): nothing to start"
    fi
    return 0
  fi
  log "restarting the copy executor (its feeds reconnect in seconds; the next position read settles what it missed)"
  "$SYSTEMCTL" restart valuescan-executor.service
  wait_active valuescan-executor.service 30 || die "the executor did not become active - journalctl --namespace=pii -u valuescan-executor -n 80"
  wait_ok "$EXECUTOR_URL/api/copy/v1/health" 60 || die "the executor does not answer /api/copy/v1/health - journalctl --namespace=pii -u valuescan-executor -n 80 ; roll back with: release.sh --rollback"
  log "the executor answers /api/copy/v1/health"
}

# The status page's prober (valuescan-status.service, apps/server/src/statusMain.ts, 2026-11-01): its
# own unit, so an API restart never leaves the status page blind. Restarted only when named (ship.sh
# names it when its own code changed: deploy/release/parts.mjs) or by --all - never with every API
# release; a restart costs it one round at most (its first round runs a second after it starts).
# A server without the unit installed has nothing to restart.
status_unit() { "$SYSTEMCTL" cat valuescan-status.service >/dev/null 2>&1; }
restart_status() {
  if ! status_unit; then log "the status prober (valuescan-status.service) is not installed here: nothing to restart"; return 0; fi
  if [ ! -e "$CURRENT/apps/server/src/statusMain.ts" ]; then
    log "this release has no status prober (apps/server/src/statusMain.ts): the running one keeps release $(release_of valuescan-status.service)"
    return 0
  fi
  log "restarting the status prober"
  "$SYSTEMCTL" restart valuescan-status.service
  wait_active valuescan-status.service 30 || die "the status prober did not become active - journalctl -u valuescan-status -n 80"
  log "the status prober runs release $(current_tag)"
}

here() { case ",${VS_UNITS:-indexer,api,executor}," in *,"$1",*) return 0 ;; *) return 1 ;; esac; }

restart_units() {   # auto | all | api | executor | units (the list in $UNITS)
  case "$1" in
    auto)
      local idx=0 api=0 exe=0
      if here indexer && needs_restart valuescan-indexer.service "${SERVER_CODE[@]}"; then idx=1; fi
      if here api && needs_restart valuescan-api.service "${SERVER_CODE[@]}"; then api=1; fi
      if here executor && [ -e "$CURRENT/apps/executor/src/main.ts" ] && needs_restart valuescan-executor.service "${EXECUTOR_CODE[@]}"; then exe=1; fi
      if [ "$idx" = 1 ] && here api; then
        restart_indexer_and_api 0
      elif [ "$idx" = 1 ]; then
        restart_indexer
      elif [ "$api" = 1 ]; then
        restart_indexer_and_api 1
      elif here indexer || here api; then
        log "the indexer (release $(indexer_release)) and the API (release $(release_of valuescan-api.service)) already run this server code: not restarted"
      fi
      if ! here executor; then
        :
      elif [ "$exe" = 1 ]; then
        restart_executor
      elif [ -e "$CURRENT/apps/executor/src/main.ts" ]; then
        log "the copy executor (release $(release_of valuescan-executor.service)) already runs this code: not restarted, copies and algos carry on"
      else
        restart_executor
      fi
      ;;
    units)
      case ",$UNITS," in *,indexer,*) restart_indexer ;; esac
      case ",$UNITS," in *,api,*) restart_api ;; esac
      case ",$UNITS," in *,status,*) restart_status ;; esac
      case ",$UNITS," in *,executor,*) restart_executor ;; esac
      local u
      for u in indexer api executor; do
        case ",$UNITS," in *,"$u",*) ;; *) if here "$u"; then log "$u not named: it keeps running release $(release_of "valuescan-$u.service")"; fi ;; esac
      done
      ;;
    all) restart_indexer_and_api 0; restart_status; restart_executor ;;
    api)
      restart_indexer_and_api 1
      if "$SYSTEMCTL" is-active --quiet valuescan-executor.service; then
        log "API only: the executor keeps running release $(release_of valuescan-executor.service)"
      fi
      ;;
    executor)
      log "executor only: the indexer keeps running release $(indexer_release), the API release $(release_of valuescan-api.service)"
      restart_executor
      ;;
  esac
}

# The release a running unit was started from (its working directory).
unit_release() {
  local pid
  pid="$("$SYSTEMCTL" show -p MainPID --value "$1" 2>/dev/null || true)"
  if [ -n "$pid" ] && [ "$pid" != 0 ] && [ -e "/proc/$pid/cwd" ]; then
    readlink -f "/proc/$pid/cwd" | sed -n "s#^$RELEASES/\([^/]*\)/.*#\1#p"
  fi
}
release_of() { local r; r="$(unit_release "$1")"; printf '%s' "${r:-unknown}"; }
indexer_release() { release_of valuescan-indexer.service; }

prune() {
  local cur prev n=0 d
  cur="$(current_tag)"; prev="$(previous_tag)"
  # Newest first; keep the current, the previous and whatever a unit still runs from.
  local running_api running_idx running_exec running_status
  running_api="$(unit_release valuescan-api.service)"; running_idx="$(unit_release valuescan-indexer.service)"
  running_exec="$(unit_release valuescan-executor.service)"; running_status="$(unit_release valuescan-status.service)"
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    n=$((n + 1))
    if [ "$n" -le "$KEEP" ] || [ "$d" = "$cur" ] || [ "$d" = "$prev" ] || [ "$d" = "$running_api" ] || [ "$d" = "$running_idx" ] || [ "$d" = "$running_exec" ] || [ "$d" = "$running_status" ]; then continue; fi
    log "removing old release $d"
    rm -rf "${RELEASES:?}/$d"
  done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %f\n' 2>/dev/null | sort -rn | awk '{print $2}')
}

status() {
  echo "current:   $(current_tag)"
  echo "previous:  $(previous_tag)"
  echo "installed: $(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f ' 2>/dev/null)"
  echo "indexer:   $("$SYSTEMCTL" is-active valuescan-indexer.service 2>/dev/null || true), release $(indexer_release)"
  local api; api="$(unit_release valuescan-api.service)"
  echo "api:       $("$SYSTEMCTL" is-active valuescan-api.service 2>/dev/null || true), release ${api:-unknown}"
  local exe; exe="$(unit_release valuescan-executor.service)"
  echo "executor:  $("$SYSTEMCTL" is-active valuescan-executor.service 2>/dev/null || true), release ${exe:-unknown}"
  local sta; sta="$(unit_release valuescan-status.service)"
  echo "status:    $("$SYSTEMCTL" is-active valuescan-status.service 2>/dev/null || true), release ${sta:-unknown}"
  echo "node:      $(node --version 2>/dev/null || echo missing)"
}

TAG=""
MODE=auto
UNITS=""
INSTALL_ONLY=0
ROLLBACK=0
FROM=""
ONE_MODE="--all, --api-only, --executor-only and --units exclude each other"
for arg in "$@"; do
  case "$arg" in
    --all) [ "$MODE" = auto ] || die "$ONE_MODE"; MODE=all ;;
    --api-only) [ "$MODE" = auto ] || die "$ONE_MODE"; MODE=api ;;
    --executor-only) [ "$MODE" = auto ] || die "$ONE_MODE"; MODE=executor ;;
    --units=*)
      [ "$MODE" = auto ] || die "$ONE_MODE"; MODE=units; UNITS="${arg#--units=}"
      for u in ${UNITS//,/ }; do case "$u" in indexer|api|executor|status) ;; *) die "--units: $u is not one of indexer, api, executor, status" ;; esac; done
      [ -n "${UNITS//,/}" ] || die "--units: name at least one of indexer, api, executor, status"
      ;;
    --from=*) FROM="${arg#--from=}" ;;
    --install-only) INSTALL_ONLY=1 ;;
    --rollback) ROLLBACK=1 ;;
    --status) status; exit 0 ;;
    -h|--help) usage 0 ;;
    -*) die "unknown option $arg" ;;
    *) [ -z "$TAG" ] || die "one tag at a time"; TAG="$arg" ;;
  esac
done

[ "$(id -u)" = 0 ] || [ -n "${VS_ALLOW_NON_ROOT:-}" ] || die "run as root (sudo)"
mkdir -p "$RELEASES"

if [ "$ROLLBACK" = 1 ]; then
  [ -z "$TAG" ] || die "--rollback takes no tag: it goes back to the release before the current one"
  [ -z "$FROM" ] || die "--rollback takes no --from"
  TAG="$(previous_tag)"
  [ -n "$TAG" ] || die "there is no previous release to roll back to"
  [ -d "$RELEASES/$TAG" ] || die "the previous release $TAG is no longer installed - release it again by tag"
  log "rolling back from $(current_tag) to $TAG"
else
  [ -n "$TAG" ] || usage 2
  valid_tag "$TAG" || die "not a usable tag name: $TAG"
  install_release "$TAG"
  if [ "$INSTALL_ONLY" = 1 ]; then
    log "$TAG is installed in $RELEASES/$TAG; nothing switched, nothing restarted"
    exit 0
  fi
fi

activate "$TAG"
restart_units "$MODE"
prune
status
