#!/usr/bin/env bash
# /opt/valuescan/bin/status.sh - the status page's incidents and maintenance (www.valuedesk.so/status),
# on SERVER 1, where the API keeps them (status.db in the state directory). The page, its banner
# in the app and the Atom feed (/api/vs/status/feed) show a change within about a minute.
#
#   sudo bash status.sh incident "Copies are delayed" --components=executor --impact=major "We are looking into it."
#   sudo bash status.sh update 7 identified "A SoDEX feed stalled. Restarting it."
#   sudo bash status.sh update 7 monitoring "Copies are going out again. Watching."
#   sudo bash status.sh resolve 7 "All copies are back to normal."
#   sudo bash status.sh maintenance "Database upgrade" --start="2026-10-28 02:00" --end=+1h --components=api,indexer \
#        "Leaderboards and cohorts may not load for a few minutes."
#   sudo bash status.sh update 8 --end=+30m "Taking a little longer than planned."
#   sudo bash status.sh resolve 8                      a maintenance completed early (it completes by itself at its end)
#   sudo bash status.sh list | show 7 | delete 7       delete: posted by mistake - gone from the page and the feed
#
#   sudo bash status.sh backfill --dry-run             uptime from before the status page's prober ran, from the
#   sudo bash status.sh backfill                       health check's journal (every minute since this server ran it);
#                                                      fills only minutes the page has no data for - safe to repeat
#   sudo bash status.sh restore <status-history.json>  the page's history from an off-server backup (api-state)
#
# Times are UTC: now, +30m, +2h, "2026-10-28 02:00", 2026-10-28T02:00, 02:00. Components: website, api,
# executor, indexer, all. Impact: minor, major, critical. Stages: investigating, identified, monitoring,
# resolved (an incident); scheduled, in_progress, verifying, completed (a maintenance). Text is plain text.
#
# The same from the owner's Telegram chat: /incident, /update, /resolve, /maint, /status, /show - the same
# words after the command (apps/server/src/ops/statusTelegram.ts).
set -euo pipefail

APP="${VALUESCAN_APP_DIR:-/opt/valuescan/current/apps/server}"
NODE="${NODE_BIN_DIR:-/opt/node/current/bin}/node"
DB="${VALUESCAN_STATUS_DB:-/var/lib/valuescan/state/status.db}"
AS="${STATUS_USER:-valuescan}"

die() { echo "status: $*" >&2; exit 2; }

[ -d "$APP" ] || die "$APP does not exist (VALUESCAN_APP_DIR)"
[ -x "$NODE" ] || die "$NODE does not exist (NODE_BIN_DIR)"
[ $# -gt 0 ] || { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

# As the API's own user, so status.db and its WAL files stay that user's.
tool() {
  if [ "$(id -un)" = "$AS" ]; then
    (cd "$APP" && VALUESCAN_STATUS_DB="$DB" "$NODE" --disable-warning=ExperimentalWarning --import tsx tools/status-post.ts "$@")
  else
    (cd "$APP" && sudo -u "$AS" VALUESCAN_STATUS_DB="$DB" "$NODE" --disable-warning=ExperimentalWarning --import tsx tools/status-post.ts "$@")
  fi
}

case "$1" in
  backfill)
    shift
    command -v journalctl >/dev/null 2>&1 || die "journalctl is not here"
    # The health check logs one JSON line a pass; the page keeps 120 days. Only the message is read.
    journalctl -u valuescan-health.service -o json --output-fields=MESSAGE --since=-120d --no-pager | tool backfill "$@"
    ;;
  restore)
    [ -n "${2:-}" ] && [ -r "$2" ] || die "usage: status.sh restore <status-history.json> (a readable file)"
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' EXIT
    cp "$2" "$tmp"
    chmod 0644 "$tmp"
    tool restore "$tmp"
    ;;
  *)
    tool "$@"
    ;;
esac
