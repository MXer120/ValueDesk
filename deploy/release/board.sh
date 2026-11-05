#!/usr/bin/env bash
# The kanban board on dev.valuedesk.so, from any session on the laptop: runs apps/server/tools/board.ts
# on server 1 against the live admin.db. Commands: see that file.
#   BOARD_SESSION=heatmap deploy/release/board.sh move 12 working
set -euo pipefail
KEY="${VS_SSH_KEY:-$HOME/.ssh/valuescan-contabo}"
HOST="${VS_BOARD_HOST:-almalinux@161.97.154.121}"
args=""
for a in "$@"; do args+=" $(printf '%q' "$a")"; done
exec ssh -i "$KEY" -o ConnectTimeout=10 -o BatchMode=yes "$HOST" \
  "cd /opt/valuescan/current/apps/server && sudo -u valuescan env VALUESCAN_ADMIN_DB=/var/lib/valuescan/state/admin.db BOARD_SESSION=$(printf '%q' "${BOARD_SESSION:-claude}") /opt/node/current/bin/node --disable-warning=ExperimentalWarning --import tsx tools/board.ts$args"
