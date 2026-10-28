#!/usr/bin/env bash
# The emergency brake on BOTH servers, from this laptop (docs/INCIDENT-RUNBOOK.md):
#
#   bash deploy/release/brake.sh on "Investigating a fill problem."            everything, everywhere
#   bash deploy/release/brake.sh on copies,algos "Executor maintenance."       only what is named
#   bash deploy/release/brake.sh off
#   bash deploy/release/brake.sh status
#
# Server 1 (France, the API the site reads) gets every switch; server 2 (Tokyo, the executor) the same file
# (it reads copies and algos). Each runs deploy/server/bin/brake.sh, installed as /opt/valuescan/bin/brake.sh.
# Hosts and key: VS_SERVER1 / VS_SERVER2 / VS_SSH_KEY, defaulting to the Contabo pair.
set -euo pipefail

S1="${VS_SERVER1:-almalinux@161.97.154.121}"
S2="${VS_SERVER2:-almalinux@13.140.77.201}"
KEY="${VS_SSH_KEY:-$HOME/.ssh/valuescan-contabo}"
BIN="${VS_BRAKE_BIN:-/opt/valuescan/bin/brake.sh}"

[ $# -ge 1 ] || { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

quoted=""
for a in "$@"; do quoted+=" $(printf '%q' "$a")"; done

rc=0
for host in "$S1" "$S2"; do
  echo "== $host"
  # Both are tried even when one fails: half a brake is better than none, and the output says which.
  ssh -i "$KEY" -o ConnectTimeout=10 -o BatchMode=yes "$host" "sudo bash $BIN$quoted" || { echo "!! $host: FAILED" >&2; rc=1; }
done
exit $rc
