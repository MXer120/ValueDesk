#!/usr/bin/env bash
# The emergency brake on THIS server: stop trading without a rebuild, a deploy or a restart.
#
#   sudo bash brake.sh on "Investigating a fill problem."              everything: trading, copies, algos
#   sudo bash brake.sh on copies,algos "Executor maintenance."         only what is named
#   sudo bash brake.sh on --maintenance copies,algos "Updating ..."    planned work, not an emergency (ship.sh)
#   sudo bash brake.sh off                                             lift it
#   sudo bash brake.sh status                                          what it is now
#
# WHY IT IS ON ("cause" in the file; telegram.mjs LABELS). By hand it is an operator's emergency stop:
# "🛑 BRAKE · on (...)" on Telegram, and lifted "✅ RECOVERED · brake lifted". With --maintenance it is
# planned work: "🔧 MAINTENANCE · brake on / lifted" - and nothing at all while a maintenance window is open
# here (maint.sh), whose opener says it (ship.sh: started, done, stopped). The executor alerts only an
# operator's brake (apps/executor/src/brake.ts cause).
#
# From the laptop, both servers at once: bash deploy/release/brake.sh on "reason" (docs/INCIDENT-RUNBOOK.md).
#
# WHAT EACH SWITCH DOES
#   trading   the site (server 1's /api/health): every order from a browser is refused, closing included,
#             whatever the build says (VITE_ALLOW_MAINNET_TRADING does not override it). Open tabs follow
#             within 30 s; a banner says why.
#   copies    the executor (server 2) and the browser copier: no copy sends an order; new live copies and
#             resumes are refused. Stops already resting on SoDEX stay; followers can still pause, stop and
#             stop-and-close. Lifted, copies go on from their leader's next trade (what the leader did
#             meanwhile is not copied after the fact).
#   algos     the executor and browser algos: every live algo is held (nothing new is sent); its exits are
#             still placed; new live algos, resumes and size changes are refused. Lifted, they go on by
#             themselves.
#
# The file is /var/lib/valuescan/brake.json (world-readable, written atomically). Both services read it at
# most once a second. A file they cannot parse counts as a full brake, so a typo never leaves trading on.
# Every change is in the executor's audit log (kind 'brake') and, with /etc/valuescan/alert.env, on Telegram.
set -euo pipefail

FILE="${VALUEDESK_BRAKE_FILE:-/var/lib/valuescan/brake.json}"
MAINT_FILE="${VALUEDESK_MAINT_FILE:-/var/lib/valuescan/maintenance.json}"
ALERT_ENV="${ALERT_ENV:-/etc/valuescan/alert.env}"

die() { echo "brake: $*" >&2; exit 1; }

# The labels of telegram.mjs (LABELS): the brake does not depend on node to be heard.
label() {
  case "$1" in
    maintenance) printf '🔧 MAINTENANCE' ;;
    brake) printf '🛑 BRAKE' ;;
    recovered) printf '✅ RECOVERED' ;;
  esac
}

notify() {   # kind, text
  # Telegram, best effort: the brake never waits on it.
  [ -r "$ALERT_ENV" ] || return 0
  # shellcheck disable=SC1090
  ( set -a; . "$ALERT_ENV"; set +a
    [ -n "${ALERT_TELEGRAM_TOKEN:-}" ] && [ -n "${ALERT_TELEGRAM_CHAT_ID:-}" ] || exit 0
    curl --limit-rate 1M -fsS -m 10 -o /dev/null "https://api.telegram.org/bot${ALERT_TELEGRAM_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ALERT_TELEGRAM_CHAT_ID}" --data-urlencode "text=$(label "$1") · $2" ) || echo "brake: (Telegram not reached)" >&2
}

# A maintenance window open here (maint.sh): its time not up yet.
window_open() {
  [ -r "$MAINT_FILE" ] || return 1
  local until
  until="$(sed -n 's/.*"until": *\([0-9]*\).*/\1/p' "$MAINT_FILE" | head -1)"
  [ -n "$until" ] && [ "$until" -gt "$(date +%s%3N)" ]
}

write() {
  local tmp
  tmp="$(mktemp "$(dirname "$FILE")/.brake.XXXXXX")"
  printf '%s\n' "$1" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$FILE"
}

json_string() {
  # A JSON string of $1 (quotes, backslashes and control characters escaped).
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1" 2>/dev/null \
    || python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.argv[1]))' "$1"
}

case "${1:-}" in
  on)
    shift
    cause=operator
    if [ "${1:-}" = --maintenance ]; then cause=maintenance; shift; fi
    what="all"
    if [ $# -ge 2 ]; then what="$1"; shift; fi
    reason="${1:-}"
    [ -n "$reason" ] || die 'say why, in words followers will read: brake.sh on "Investigating a fill problem."'
    t=false; c=false; a=false
    IFS=',' read -ra parts <<<"$what"
    for p in "${parts[@]}"; do
      case "$p" in
        all) t=true; c=true; a=true ;;
        trading) t=true ;;
        copies) c=true ;;
        algos) a=true ;;
        *) die "unknown switch '$p' (all, trading, copies, algos)" ;;
      esac
    done
    [ "$(id -u)" = 0 ] || die "run it with sudo"
    mkdir -p "$(dirname "$FILE")"
    by="${SUDO_USER:-$USER}@$(hostname)"
    write "{\"trading\": $t, \"copies\": $c, \"algos\": $a, \"reason\": $(json_string "$reason"), \"since\": $(date +%s%3N), \"by\": $(json_string "$by"), \"cause\": \"$cause\"}"
    echo "brake ON on $(hostname) ($cause): trading=$t copies=$c algos=$a - $reason"
    if [ "$cause" = operator ]; then notify brake "on ($(hostname), by $by): trading=$t copies=$c algos=$a - $reason"
    elif window_open; then echo "brake: (no Telegram: a maintenance window is open here - its opener reports it)"
    else notify maintenance "brake on ($(hostname)): trading=$t copies=$c algos=$a - $reason"; fi
    ;;
  off)
    [ "$(id -u)" = 0 ] || die "run it with sudo"
    if [ ! -e "$FILE" ]; then echo "brake already off on $(hostname)"; exit 0; fi
    was=operator
    grep -q '"cause": *"maintenance"' "$FILE" 2>/dev/null && was=maintenance
    rm -f "$FILE"
    echo "brake off on $(hostname)"
    if [ "$was" = operator ]; then notify recovered "brake lifted ($(hostname)): trading goes on"
    elif window_open; then echo "brake: (no Telegram: a maintenance window is open here - its opener reports it)"
    else notify maintenance "brake lifted ($(hostname))"; fi
    ;;
  status)
    if [ -e "$FILE" ]; then cat "$FILE"; else echo "off (no $FILE)"; fi
    ;;
  *)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
