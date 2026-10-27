#!/usr/bin/env bash
# Put a Contabo server's own configuration in place - what deploy/server/bootstrap.sh
# does not do because it differs between the two servers, or because it hardens the
# Contabo image. IDEMPOTENT: it changes only what differs and says what it changed.
# It never restarts a Valuescan service.
#
#   sudo bash /opt/valuescan/overlay/apply-overlay.sh server1 [--dry-run] [--keep-rsyslog]
#   sudo bash /opt/valuescan/overlay/apply-overlay.sh server2 [--dry-run] [--keep-rsyslog]
#
# Upload this directory first (from the repository, on the workstation):
#   tar -C deploy/contabo -cf - . | ssh almalinux@<server> \
#     'sudo rm -rf /opt/valuescan/overlay && sudo mkdir -p /opt/valuescan/overlay && sudo tar -xf - -C /opt/valuescan/overlay --no-same-owner'
#
# WHAT IT DOES (deploy/contabo/README.md says why, item by item)
#   1. refuses to run on the wrong server (the address on eth0)
#   2. systemd: the server's drop-ins (server*/systemd/<unit>.d/*.conf) and units
#      (server2: the builder ledger pull), daemon-reload, enables the server's timers
#   3. /etc/valuescan/health.env, offsite.env and /etc/vsbackup/receive.env
#   4. sshd: keys only, almalinux and vsbackup only (common/sshd/10-valuedesk.conf),
#      validated with `sshd -t` before the reload; cloud-init kept from turning passwords on
#   5. firewalld: ssh, http, https in the public zone - nothing else
#   6. removes Contabo's /etc/cron.hourly/free, which empties the page cache every hour
#      (the 22 GB index then comes back from disk; a copy is kept in /root)
#   7. disables rpcbind (NFS's port mapper, listening on 111 for nothing)
#   8. disables rsyslog: the journal is persistent now (bootstrap.sh) and rsyslog only
#      copied it into /var/log/messages - API request lines with IP addresses for up to
#      five weeks; the pii namespace stays out of it (90 days in the privacy policy). --keep-rsyslog: leave it.
#
# NOT HERE: secrets (alert.env: telegram-setup.sh; the backup and ssh keys:
# deploy/server/bin/offsite-setup.sh; the origin secret: bootstrap-instance.sh), and the
# units, scripts and journald settings common to both servers (bootstrap.sh).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="${1:-}"
DRY=0
KEEP_RSYSLOG=0
for a in "${@:2}"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --keep-rsyslog) KEEP_RSYSLOG=1 ;;
    *) echo "apply-overlay: unknown option $a" >&2; exit 2 ;;
  esac
done

log() { printf '[overlay] %s\n' "$*"; }
die() { printf '[overlay] error: %s\n' "$*" >&2; exit 1; }
do_() { if [ "$DRY" = 1 ]; then log "would: $*"; else "$@"; fi; }

case "$SERVER" in
  server1) WANT_IP=161.97.154.121 ;;
  server2) WANT_IP=13.140.77.201 ;;
  *) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
SRC="$HERE/$SERVER"
[ -d "$SRC" ] || die "$SRC is missing - upload the whole deploy/contabo directory"

# --- 1. the right server ---------------------------------------------------------------------
ip -4 -o addr show dev eth0 | grep -q "inet $WANT_IP/" || die "this is not $SERVER ($WANT_IP is not on eth0) - refusing"
log "$SERVER ($WANT_IP)$([ "$DRY" = 1 ] && echo ', DRY RUN: nothing is changed')"

changed=0
put() {   # source, destination, mode, owner:group
  local src="$1" dst="$2" mode="$3" own="$4"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    [ "$DRY" = 1 ] || { chown "$own" "$dst"; chmod "$mode" "$dst"; }
    return 1
  fi
  log "install $dst"
  do_ install -D -m "$mode" -o "${own%%:*}" -g "${own##*:}" "$src" "$dst"
  changed=1
  return 0
}

# --- 2. systemd --------------------------------------------------------------------------------
reload=0
if [ -d "$SRC/systemd" ]; then
  while IFS= read -r f; do
    rel="${f#"$SRC/systemd/"}"
    put "$f" "/etc/systemd/system/$rel" 0644 root:root && reload=1 || true
  done < <(find "$SRC/systemd" -type f -name '*.conf' | sort)
fi
if [ -d "$SRC/units" ]; then
  for f in "$SRC"/units/*; do
    put "$f" "/etc/systemd/system/$(basename "$f")" 0644 root:root && reload=1 || true
  done
fi
[ "$reload" = 0 ] || do_ systemctl daemon-reload
if [ "$SERVER" = server2 ]; then
  # The copy executor runs here (server 1 holds it with the same file absent).
  [ -e /etc/valuescan/executor-here ] || { log "create /etc/valuescan/executor-here"; do_ install -m 0644 /dev/null /etc/valuescan/executor-here; }
  systemctl is-enabled -q valuescan-ledger-pull.timer 2>/dev/null || do_ systemctl enable --now valuescan-ledger-pull.timer
fi
if [ "$SERVER" = server1 ] && [ -e /etc/valuescan/executor-here ]; then
  log "WARNING: /etc/valuescan/executor-here exists on server 1 - the executor may start HERE as well as on server 2. Remove it unless the executor moved."
fi

# --- 3. this server's settings ----------------------------------------------------------------------
put "$SRC/health.env" /etc/valuescan/health.env 0640 root:valuescan || true
put "$SRC/offsite.env" /etc/valuescan/offsite.env 0640 root:root || true
[ -d /etc/vsbackup ] || do_ install -d -m 0755 -o root -g root /etc/vsbackup
put "$SRC/backup-receive.env" /etc/vsbackup/receive.env 0644 root:root || true

# --- 4. sshd and cloud-init -------------------------------------------------------------------------
if put "$HERE/common/sshd/10-valuedesk.conf" /etc/ssh/sshd_config.d/10-valuedesk.conf 0600 root:root; then
  if [ "$DRY" = 0 ]; then
    sshd -t || { rm -f /etc/ssh/sshd_config.d/10-valuedesk.conf; die "sshd -t refused the new settings - removed them again, nothing reloaded"; }
    # A reload keeps every open session (this one too).
    systemctl reload sshd
    log "sshd reloaded: $(sshd -T | grep -E '^(passwordauthentication|permitrootlogin|allowusers) ' | tr '\n' ' ')"
  fi
fi
put "$HERE/common/cloud/99-valuedesk.cfg" /etc/cloud/cloud.cfg.d/99-valuedesk.cfg 0644 root:root || true

# --- 5. firewalld -------------------------------------------------------------------------------------
if systemctl is-active -q firewalld; then
  for svc in ssh http https; do
    firewall-cmd -q --permanent --zone=public --query-service="$svc" || { log "firewalld: allow $svc"; do_ firewall-cmd -q --permanent --zone=public --add-service="$svc"; changed=1; }
  done
  for svc in $(firewall-cmd --permanent --zone=public --list-services); do
    case "$svc" in ssh|http|https) ;; *) log "firewalld: remove $svc"; do_ firewall-cmd -q --permanent --zone=public --remove-service="$svc"; changed=1 ;; esac
  done
  [ -z "$(firewall-cmd --permanent --zone=public --list-ports)" ] || log "WARNING: firewalld opens ports by number: $(firewall-cmd --permanent --zone=public --list-ports) - check them"
  do_ firewall-cmd -q --reload
else
  log "WARNING: firewalld is not running: sudo dnf install -y firewalld && sudo systemctl enable --now firewalld, then run this again"
fi

# --- 6. the hourly page-cache flush of the Contabo image -------------------------------------------------
if [ -f /etc/cron.hourly/free ]; then
  log "remove /etc/cron.hourly/free (it runs 'echo 1 > /proc/sys/vm/drop_caches' every hour; kept as /root/cron.hourly-free.removed)"
  do_ cp -p /etc/cron.hourly/free /root/cron.hourly-free.removed
  do_ rm -f /etc/cron.hourly/free
  changed=1
fi

# --- 7. rpcbind ------------------------------------------------------------------------------------------
if systemctl is-enabled -q rpcbind.service 2>/dev/null || systemctl is-active -q rpcbind.socket 2>/dev/null; then
  log "disable rpcbind (nothing here uses NFS)"
  do_ systemctl disable --now rpcbind.service rpcbind.socket
  changed=1
fi

# --- 8. rsyslog -----------------------------------------------------------------------------------------
if [ "$KEEP_RSYSLOG" = 0 ] && systemctl is-enabled -q rsyslog.service 2>/dev/null; then
  [ -d /var/log/journal ] || die "the journal is not persistent yet (/var/log/journal missing): run bootstrap.sh first, then this"
  log "disable rsyslog (the persistent journal has everything; /var/log/messages kept API lines with IP addresses for weeks)"
  do_ systemctl disable --now rsyslog.service
  log "  the old files stay: delete them once they are 90 days old -  sudo find /var/log -maxdepth 1 -name 'messages*' -mtime +90 -delete"
  changed=1
fi

log "done ($([ "$changed" = 1 ] && echo 'changes made' || echo 'everything was in place'))."
log "next, once per server: offsite-setup.sh sender/receiver, telegram-setup.sh (deploy/contabo/README.md, 'Apply')"
