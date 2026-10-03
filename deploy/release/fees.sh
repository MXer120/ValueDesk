#!/usr/bin/env bash
# Change the builder fees on the running server, without a restart or a release
# (apps/server/tools/builderTiers.ts, docs/BUILDER-TIERS.md section 4). The server reads
# the file again within 5 s; an app takes the new fee with its next signed terms
# (10 minutes at the latest). Fees are tenths of a basis point: 20 = 2 bp = 0.02 %.
#
#   deploy/release/fees.sh status                                      the tiers and hand-set fees in force
#   deploy/release/fees.sh status --address 0x...                      one wallet: counted volume, flags, its own fee
#   deploy/release/fees.sh set-tier --from-usd 100000 --perps 15 --spot 18
#                                                                      a milestone (or new fees for one): from that
#                                                                      counted volume a wallet pays these fees
#   deploy/release/fees.sh remove-tier --from-usd 100000
#   deploy/release/fees.sh set-fee --address 0x... --perps 5 --spot 10 [--note partner_x]
#                                                                      one wallet's own fee; it wins over the tiers
#   deploy/release/fees.sh clear-fee --address 0x...
#   ... --print                                                        show the command, run none
#
# Milestones need nothing from you: each verification of a wallet's volume puts it on the
# tier it reached, as often as it happens. The DEFAULT fee (--from-usd 0) is pinned in the
# web build as well (VITE_BUILDER_FEE_*): lowering it here works at once, raising it above
# the build's needs a new web build.
#
# A change that would make the file invalid (a fee above the default, a milestone out of
# order, ...) is refused and nothing is written - the answer says why.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }

[ "$#" -gt 0 ] || { usage; exit 2; }
args=()
for arg in "$@"; do
  case "$arg" in
    --print) PRINT_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      # Only what the tool takes: commands, flags, numbers, addresses, a short note without spaces.
      case "$arg" in *[!A-Za-z0-9._:@-]*|'') die "not a usable argument: '$arg' (a note is one word: use _ for spaces)" ;; esac
      args+=("$arg") ;;
  esac
done
case "${args[0]:-}" in
  status|set-tier|remove-tier|set-fee|clear-fee) ;;
  *) usage; die "unknown command: ${args[0]:-<none>}" ;;
esac
export PRINT_ONLY

exec "$(dirname "${BASH_SOURCE[0]}")/remote.sh" run "cd /opt/valuescan/current/apps/server && sudo -u valuescan env VALUETRADE_DEVICE_KEY=/var/lib/valuescan/state/device.key /opt/node/current/bin/node --import tsx tools/builderTiers.ts ${args[*]}"
