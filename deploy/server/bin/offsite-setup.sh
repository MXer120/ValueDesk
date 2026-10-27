#!/usr/bin/env bash
# One-time setup of the off-server backups between the two servers (backup-offsite.sh
# sends, backup-receive.sh receives). Idempotent: run it again and it changes nothing
# that is in place. Never prints a private key or the backup key.
#
#   sudo bash offsite-setup.sh sender --to=<other server's IP>
#       On the SENDING server: /etc/valuescan/offsite/ with
#         backup.key    this server's backup key (made once, never replaced; KEEP A COPY
#                       OFFLINE - without it no copy can ever be opened)
#         id_ed25519    the ssh key the copies travel with (no passphrase; it can only run
#                       backup-receive.sh on the other side)
#         known_hosts   the other server's host key (ssh-keyscan; compare the fingerprint
#                       it prints with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
#                       run ON the other server)
#       and prints the PUBLIC key line to give to the receiver.
#
#   sudo bash offsite-setup.sh receiver --from=<sending server's IP> --pubkey='<line>'
#       On the RECEIVING server: the user vsbackup (no password, home /home/vsbackup so
#       SELinux labels its .ssh as ssh_home_t), /var/lib/vsbackup (0700), and ONE line in
#       its authorized_keys:
#         restrict,from="<IP>",command="/opt/valuescan/bin/backup-receive.sh" <key>
#       restrict = no pty, no forwarding of any kind; from = only that address; command =
#       whatever the client asks, this script runs (it reads SSH_ORIGINAL_COMMAND).
#       /etc/vsbackup/receive.env must be in place (apply-overlay.sh installs it).
#
#   sudo bash offsite-setup.sh test
#       On the SENDING server: one tiny encrypted test file to the other side (set
#       "api-state" must be one it takes), then `list` there.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${NODE_BIN_DIR:-/opt/node/current/bin}/node"
DIR=/etc/valuescan/offsite
die() { printf 'offsite-setup: %s\n' "$*" >&2; exit 1; }
say() { printf 'offsite-setup: %s\n' "$*" >&2; }
ip_re='^([0-9]{1,3}\.){3}[0-9]{1,3}$'

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
cmd="${1:-}"
shift || true
TO="" FROM="" PUBKEY=""
for arg in "$@"; do
  case "$arg" in
    --to=*) TO="${arg#--to=}" ;;
    --from=*) FROM="${arg#--from=}" ;;
    --pubkey=*) PUBKEY="${arg#--pubkey=}" ;;
    *) die "unknown argument $arg" ;;
  esac
done

case "$cmd" in
  sender)
    [[ "$TO" =~ $ip_re ]] || die "--to=<the other server's IPv4 address>"
    install -d -m 0700 -o root -g root "$DIR"
    if [ -f "$DIR/backup.key" ]; then
      say "backup key in place (id $("$NODE" "$HERE/backup-crypt.mjs" id "$DIR/backup.key"))"
    else
      id="$("$NODE" "$HERE/backup-crypt.mjs" keygen "$DIR/backup.key")"
      chmod 0600 "$DIR/backup.key"
      say "made a NEW backup key, id $id - copy it OFFLINE now (deploy/release/pull-backups.sh --fetch-keys, or by hand); it is never shown here"
    fi
    if [ ! -f "$DIR/id_ed25519" ]; then
      ssh-keygen -q -t ed25519 -N '' -C "valuedesk-offsite@$(hostname -s)" -f "$DIR/id_ed25519"
      say "made the ssh key the copies travel with"
    fi
    chmod 0600 "$DIR/id_ed25519"
    if ! { [ -f "$DIR/known_hosts" ] && ssh-keygen -F "$TO" -f "$DIR/known_hosts" >/dev/null; }; then
      ssh-keyscan -t ed25519 -T 10 "$TO" 2>/dev/null > "$DIR/known_hosts.new"
      [ -s "$DIR/known_hosts.new" ] || die "ssh-keyscan $TO found no ed25519 host key"
      mv -f "$DIR/known_hosts.new" "$DIR/known_hosts"
      chmod 0644 "$DIR/known_hosts"
      say "pinned the host key of $TO: $(ssh-keygen -lf "$DIR/known_hosts" | awk '{print $2}')"
      say "  check it ON $TO: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub  (must be the same)"
    fi
    say "give this PUBLIC key to the receiver (offsite-setup.sh receiver --from=<this server's IP> --pubkey='...'):"
    cat "$DIR/id_ed25519.pub"
    ;;

  receiver)
    [[ "$FROM" =~ $ip_re ]] || die "--from=<the sending server's IPv4 address>"
    [[ "$PUBKEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]{60,}(\ [A-Za-z0-9@._-]+)?$ ]] || die "--pubkey='ssh-ed25519 AAAA... comment' (the line offsite-setup.sh sender printed)"
    [ -f /etc/vsbackup/receive.env ] || die "/etc/vsbackup/receive.env is missing (deploy/contabo/apply-overlay.sh installs it)"
    getent group vsbackup >/dev/null || groupadd --system vsbackup
    # A shell is needed to run the forced command; the password stays locked, and
    # authorized_keys allows nothing but backup-receive.sh.
    getent passwd vsbackup >/dev/null || useradd --system --gid vsbackup --create-home --home-dir /home/vsbackup --shell /bin/bash vsbackup
    passwd -l vsbackup >/dev/null 2>&1 || true
    install -d -m 0700 -o vsbackup -g vsbackup /home/vsbackup/.ssh /var/lib/vsbackup
    line="restrict,from=\"$FROM\",command=\"/opt/valuescan/bin/backup-receive.sh\" $PUBKEY"
    ak=/home/vsbackup/.ssh/authorized_keys
    if [ -f "$ak" ] && grep -qxF "$line" "$ak"; then
      say "the key is in place"
    else
      # One sender per receiver: the file holds exactly this line.
      printf '%s\n' "$line" > "$ak.new"
      chown vsbackup:vsbackup "$ak.new"
      chmod 0600 "$ak.new"
      mv -f "$ak.new" "$ak"
      say "authorized_keys of vsbackup: one key, from $FROM only, backup-receive.sh only"
    fi
    command -v restorecon >/dev/null 2>&1 && restorecon -R /home/vsbackup/.ssh || true
    systemctl enable -q --now valuescan-offsite-prune.timer 2>/dev/null || say "valuescan-offsite-prune.timer is not installed yet (bootstrap.sh installs the units)"
    say "receiving into /var/lib/vsbackup; sudo -u vsbackup /opt/valuescan/bin/backup-receive.sh list"
    ;;

  test)
    # shellcheck disable=SC1091
    . /etc/valuescan/offsite.env
    [ -f "$DIR/backup.key" ] || die "no backup key: offsite-setup.sh sender first"
    ssh_() { ssh -i "$DIR/id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o "UserKnownHostsFile=$DIR/known_hosts" -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -o LogLevel=ERROR "${OFFSITE_USER:-vsbackup}@$OFFSITE_HOST" "$@"; }
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    printf 'offsite test %s\n' "$(date -u +%FT%TZ)" | "$NODE" "$HERE/backup-crypt.mjs" encrypt "$DIR/backup.key" > "$tmp/t.enc"
    name="api-state-$(date -u +%Y%m%dT%H%M%SZ).test.enc"
    ssh_ "put api-state $name $(stat -c %s "$tmp/t.enc") $(sha256sum "$tmp/t.enc" | cut -c1-64)" < "$tmp/t.enc"
    ssh_ "list api-state"
    ssh_ "df"
    say "the test copy $name stays there until it is pruned (14 days); it holds one line of text"
    ;;

  *)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
