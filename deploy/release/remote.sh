#!/usr/bin/env bash
# Run one operations command on the instance, through SSM Run Command: no SSH, no
# Session Manager plugin, nothing to install. The output comes back when it ends.
#
#   deploy/release/remote.sh health                   one health pass, now (the JSON line of healthcheck.mjs)
#   deploy/release/remote.sh status                   installed releases and what each unit runs
#   deploy/release/remote.sh logs <unit> [lines]      the journal of indexer | api | caddy | health | backup (default 60)
#   deploy/release/remote.sh restart api|indexer|caddy
#   deploy/release/remote.sh backup                   one index backup to S3, now
#   deploy/release/remote.sh restore <source>         DRY RUN: download, verify, print the plan
#   deploy/release/remote.sh restore <source> --yes   do it (latest | backups/<file>.db.zst | seed/<file>.db.zst)
#   deploy/release/remote.sh disk                     volumes, the index and its WAL
#   deploy/release/remote.sh run '<command>'          anything else, as root
#   ... --print                                       show the AWS commands, run none
#
# The command line is recorded in SSM's command history and in CloudTrail: never
# put a secret into `run`. SSM returns the first 24,000 characters of the output,
# so long logs are cut to their newest part here.
#
# For an interactive shell use Session Manager (needs its plugin for the AWS CLI):
#   aws ssm start-session --region <REGION> --target <instance id>
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; }

WHAT=""
A1=""
A2=""
YES=0
for arg in "$@"; do
  case "$arg" in
    --print) PRINT_ONLY=1 ;;
    --yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      if [ -z "$WHAT" ]; then WHAT="$arg"
      elif [ -z "$A1" ]; then A1="$arg"
      elif [ -z "$A2" ]; then A2="$arg"
      else die "too many arguments (quote the command: remote.sh run '<command>')"
      fi ;;
  esac
done
[ -n "$WHAT" ] || { usage; exit 2; }

unit_of() {
  case "$1" in
    api) echo valuescan-api ;;
    indexer) echo valuescan-indexer ;;
    caddy) echo caddy ;;
    health) echo valuescan-health ;;
    backup) echo valuescan-backup ;;
    *) die "unknown unit: ${1:-<none>} (indexer | api | caddy | health | backup)" ;;
  esac
}

# Newest part of a long output: SSM keeps only the first 24,000 characters.
CUT='tail -c 20000'

case "$WHAT" in
  health)
    # SuccessExitStatus=1 in the unit: an unhealthy pass is a result, not an error.
    command="systemctl start valuescan-health.service; sleep 1; journalctl -t valuescan-health -n 1 -o cat --no-pager"
    ;;
  status)
    command="/opt/valuescan/bin/release.sh --status"
    ;;
  logs)
    unit="$(unit_of "$A1")"
    lines="${A2:-60}"
    case "$lines" in ''|*[!0-9]*) die "lines must be a number: $lines" ;; esac
    [ "$lines" -le 2000 ] || die "at most 2000 lines (SSM returns 24,000 characters; use Session Manager for more)"
    command="journalctl -u $unit.service -n $lines --no-pager -o short-iso | $CUT"
    ;;
  restart)
    case "$A1" in api|indexer|caddy) ;; *) die "restart api | indexer | caddy" ;; esac
    unit="$(unit_of "$A1")"
    [ "$A1" != indexer ] || note "note: restarting the indexer costs its Lighter stream 3.5-8 minutes (docs/deploy/DEPLOY.md, \"Release\")"
    command="systemctl restart $unit.service && sleep 3 && systemctl is-active $unit.service && journalctl -u $unit.service -n 15 --no-pager -o short-iso | $CUT"
    ;;
  backup)
    command="systemctl start valuescan-backup.service; code=\$?; journalctl -t valuescan-backup -n 30 -o cat --no-pager | $CUT; exit \$code"
    ;;
  restore)
    case "$A1" in
      latest) ;;
      backups/*.db.zst|seed/*.db.zst)
        case "$A1" in *[!A-Za-z0-9._/-]*|*..*) die "not a usable key: $A1" ;; esac ;;
      *) die "restore <latest | backups/<file>.db.zst | seed/<file>.db.zst> [--yes]" ;;
    esac
    [ -z "$A2" ] || die "restore takes one source"
    if [ "$YES" = 1 ]; then
      note "this REPLACES the index on the instance (the old file is moved aside, not deleted) and restarts both services"
      command="/opt/valuescan/bin/restore.sh $A1 --yes"
    else
      command="/opt/valuescan/bin/restore.sh $A1"
    fi
    ;;
  disk)
    command="df -h / /var/lib/valuescan; echo; ls -l --block-size=M /var/lib/valuescan/index /var/lib/valuescan/backup 2>&1 | $CUT"
    ;;
  run)
    [ -n "$A1" ] && [ -z "$A2" ] || die "usage: remote.sh run '<command>' (one quoted argument)"
    command="$A1"
    ;;
  *) usage; die "unknown command: $WHAT" ;;
esac
[ "$WHAT" = restore ] || [ "$YES" = 0 ] || die "--yes belongs to restore"

load_params
ssm_run "$(instance_id)" "valuescan $WHAT" "$command"
