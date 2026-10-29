#!/usr/bin/env bash
# A maintenance window on THIS server: what is done now is planned, so what it causes is not a failure.
#
#   sudo bash maint.sh on 60 "v0.2.63" indexer,api,executor   open it for at most 60 minutes, for these parts
#   sudo bash maint.sh off                                    close it (kept as maintenance.last.json)
#   sudo bash maint.sh status                                 what is open now
#   sudo bash maint.sh tell maintenance "v0.2.63 started"     one Telegram message, labelled (telegram.mjs LABELS);
#   ... | sudo bash maint.sh tell failure -                   the text may come on stdin
#
# ship.sh opens one on both servers before it restarts anything (the servers watch each other) and closes it
# when it is done or stopped; open one by hand around work of your own (a restart, a config change). While it
# is open:
#   - the health check holds the alerts of the parts named (healthcheck.mjs): a stale board while the indexer
#     restarts is not sent. Still failing once the window is closed, it is a FAILURE as always, and the message
#     says it came right after the maintenance. A check of anything else alerts as it always does;
#   - brake.sh says nothing for a brake set --maintenance: whoever opened the window says it (ship.sh: started,
#     done, or stopped).
# A window ends by itself at its time (120 minutes at most), so a ship that died cannot silence anything for good.
#
# The file is /var/lib/valuescan/maintenance.json, world-readable (the health check runs as valuescan),
# written atomically: {"what", "parts", "since", "until", "by"} (times in ms).
set -euo pipefail

FILE="${VALUEDESK_MAINT_FILE:-/var/lib/valuescan/maintenance.json}"
LAST="${FILE%.json}.last.json"
ALERT_ENV="${ALERT_ENV:-/etc/valuescan/alert.env}"
NODE="${NODE_BIN_DIR:-/opt/node/current/bin}/node"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAX_MIN=120

die() { echo "maint: $*" >&2; exit 1; }

json_string() {
  # A JSON string of $1 (quotes, backslashes and control characters escaped).
  "$NODE" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1" 2>/dev/null \
    || python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.argv[1]))' "$1"
}

write() {   # file, text
  local tmp
  tmp="$(mktemp "$(dirname "$1")/.maint.XXXXXX")"
  printf '%s\n' "$2" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$1"
}

case "${1:-}" in
  on)
    [ "$(id -u)" = 0 ] || die "run it with sudo"
    min="${2:-}" what="${3:-}" parts="${4:-}"
    [[ "$min" =~ ^[0-9]+$ ]] && [ "$min" -ge 1 ] && [ "$min" -le "$MAX_MIN" ] || die "minutes: 1 to $MAX_MIN (maint.sh on 60 \"v0.2.63\" indexer,api)"
    [ -n "$what" ] || die 'say what it is: maint.sh on 60 "v0.2.63" indexer,api'
    list=""
    IFS=',' read -ra ps <<<"$parts"
    for p in "${ps[@]}"; do
      case "$p" in
        indexer|api|executor|web) list="$list${list:+, }\"$p\"" ;;
        '') ;;
        *) die "unknown part '$p' (indexer, api, executor, web)" ;;
      esac
    done
    [ -n "$list" ] || die "name the parts it is for: indexer, api, executor, web (comma-separated)"
    mkdir -p "$(dirname "$FILE")"
    now="$(date +%s%3N)"
    write "$FILE" "{\"what\": $(json_string "$what"), \"parts\": [$list], \"since\": $now, \"until\": $((now + min * 60000)), \"by\": $(json_string "${SUDO_USER:-$USER}@$(hostname)")}"
    echo "maintenance window open on $(hostname) for $min min: $what ($parts)"
    ;;
  off)
    [ "$(id -u)" = 0 ] || die "run it with sudo"
    if [ -f "$FILE" ]; then
      # Kept with its end, so the health check can say a failure came right after it.
      ended="$("$NODE" -e '
        const fs = require("fs");
        let w = {};
        try { w = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
        w.ended = Date.now();
        process.stdout.write(JSON.stringify(w));' "$FILE")"
      write "$LAST" "$ended"
      rm -f "$FILE"
      echo "maintenance window closed on $(hostname)"
    else
      echo "no maintenance window open on $(hostname)"
    fi
    ;;
  status)
    if [ -f "$FILE" ]; then cat "$FILE"; else echo "none open (no $FILE)"; fi
    ;;
  tell)
    kind="${2:-}" text="${3:-}"
    case "$kind" in maintenance|brake|failure|recovered|info) ;; *) die "kind: maintenance, brake, failure, recovered or info" ;; esac
    if [ "$text" = - ]; then text="$(cat)"; fi
    [ -n "$text" ] || die "no text to tell"
    if [ ! -r "$ALERT_ENV" ]; then echo "maint: no $ALERT_ENV - not sent" >&2; exit 0; fi
    # Best effort: a ship never waits on Telegram.
    # shellcheck disable=SC1090
    ( set -a; . "$ALERT_ENV"; set +a
      printf '%s' "$text" | "$NODE" "$HERE/telegram.mjs" send --kind="$kind" - ) || echo "maint: (Telegram not reached)" >&2
    ;;
  *)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
