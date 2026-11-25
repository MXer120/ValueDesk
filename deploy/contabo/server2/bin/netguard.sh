#!/usr/bin/env bash
# Server 2 with no network at all (2026-11-25 11:19-12:51 UTC: nothing in or out until Contabo power-cycled it). Every minute:
# no reply from ANY of five addresses for 5 checks: the network is brought up again; for 15 checks: a reboot, at most one in 2 h.
# The executor can place nothing meanwhile, so a reboot costs no order. One answer clears the count.
set -u
N=/run/netguard.count; R=/var/lib/valuescan/state/netguard.reboot
ok() { timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }
for t in "1.1.1.1 443" "8.8.8.8 443" "9.9.9.9 443" "161.97.154.121 443" "13.140.76.1 179"; do
  # shellcheck disable=SC2086
  if ok $t; then rm -f "$N"; exit 0; fi
done
n=$(( $(cat "$N" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$N"
echo "no network: check $n"
if [ "$n" = 5 ]; then echo 'bringing the network up again'; nmcli networking off; sleep 2; nmcli networking on; fi
if [ "$n" -ge 15 ]; then
  last=$(cat "$R" 2>/dev/null || echo 0); now=$(date +%s)
  if [ $((now - last)) -gt 7200 ]; then echo "$now" > "$R"; echo 'reboot'; sync; systemctl reboot; fi
fi
