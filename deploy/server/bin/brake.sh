#!/usr/bin/env bash
# The emergency brake on THIS server: stop trading without a rebuild, a deploy or a restart.
#
#   sudo bash brake.sh on "Investigating a fill problem."              everything: trading, copies, algos
#   sudo bash brake.sh on copies,algos "Executor maintenance."         only what is named
#   sudo bash brake.sh off                                             lift it
#   sudo bash brake.sh status                                          what it is now
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
ALERT_ENV="${ALERT_ENV:-/etc/valuescan/alert.env}"

die() { echo "brake: $*" >&2; exit 1; }

notify() {
  # Telegram, best effort: the brake never waits on it.
  [ -r "$ALERT_ENV" ] || return 0
  # shellcheck disable=SC1090
  ( set -a; . "$ALERT_ENV"; set +a
    [ -n "${ALERT_TELEGRAM_TOKEN:-}" ] && [ -n "${ALERT_TELEGRAM_CHAT_ID:-}" ] || exit 0
    curl --limit-rate 1M -fsS -m 10 -o /dev/null "https://api.telegram.org/bot${ALERT_TELEGRAM_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ALERT_TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" ) || echo "brake: (Telegram not reached)" >&2
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
    write "{\"trading\": $t, \"copies\": $c, \"algos\": $a, \"reason\": $(json_string "$reason"), \"since\": $(date +%s%3N), \"by\": $(json_string "${SUDO_USER:-$USER}@$(hostname)")}"
    echo "brake ON on $(hostname): trading=$t copies=$c algos=$a - $reason"
    notify "ValueDesk BRAKE ON ($(hostname)): trading=$t copies=$c algos=$a - $reason"
    ;;
  off)
    [ "$(id -u)" = 0 ] || die "run it with sudo"
    rm -f "$FILE"
    echo "brake off on $(hostname)"
    notify "ValueDesk brake lifted ($(hostname))"
    ;;
  status)
    if [ -e "$FILE" ]; then cat "$FILE"; else echo "off (no $FILE)"; fi
    ;;
  *)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
