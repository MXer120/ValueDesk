#!/usr/bin/env bash
# Set up the Valuescan instance. IDEMPOTENT: run it again after changing a unit,
# an env template, a pinned version or the origin secret - it converges and only
# touches what differs.
#
# It is run as root on the instance, from the bootstrap bundle (this directory),
# normally by deploy/release/bootstrap-instance.sh through SSM Run Command:
#
#   SITE_DOMAIN=valuescan.example ORIGIN_DOMAIN=origin.valuescan.example \
#   OPS_BUCKET=<ops bucket> CONFIG_PREFIX=/valuescan/prod \
#   [ALERT_TOPIC_ARN=arn:...] [ACME_EMAIL=you@example.com] \
#     bash /opt/valuescan/bootstrap/bootstrap.sh
#
# Target: Amazon Linux 2023 (arm64 or x86_64). No inbound SSH is needed or left on.
#
# WHAT IT DOES
#   1. packages (tar, xz, zstd, xfsprogs), no SSH daemon
#   2. the `valuescan` system user (no login, no shell)
#   3. the data volume: formats it ONLY if it is blank, mounts it at /var/lib/valuescan
#   4. Node and Caddy at the pinned versions (versions.env), checksums verified
#   5. /opt/valuescan (bin scripts), /etc/valuescan (env files; the origin secret
#      from SSM Parameter Store), /etc/caddy/Caddyfile
#   6. systemd units and timers, journald retention (14 days)
#   7. starts Caddy and the timers; starts the API and the indexer if a release
#      is installed (the first release does that otherwise)
#
# WHAT IT NEVER DOES: restart a running indexer (a restart costs the Lighter
# stream minutes - it tells you when a restart is needed), delete data, or print
# the origin secret.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VS_HOME=/opt/valuescan
ETC=/etc/valuescan
DATA=/var/lib/valuescan
INDEX_DB="$DATA/index/valuescan-index.db"

log() { printf '[bootstrap] %s\n' "$*"; }
warn() { printf '[bootstrap] WARNING: %s\n' "$*" >&2; }
die() { printf '[bootstrap] error: %s\n' "$*" >&2; exit 1; }

NEEDS_RESTART=()   # units whose configuration changed while they were running

# Install a file only when its content differs. Returns 0 when it changed, 1 when
# it was already in place; a failure to install is fatal, never "unchanged".
install_if_changed() {
  local src="$1" dst="$2" mode="$3" owner="${4:-root:root}"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    { chown "$owner" "$dst" && chmod "$mode" "$dst"; } || die "could not set owner and mode of $dst"
    return 1
  fi
  install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "$dst" || die "could not install $dst"
  return 0
}

# --- inputs ----------------------------------------------------------------------------

[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$HERE/versions.env" ] || die "versions.env is missing next to this script: sync the whole deploy/server directory"
# shellcheck disable=SC1091
. "$HERE/versions.env"

# A previous run's answers are the defaults, so a re-run needs no arguments.
if [ -f "$ETC/bootstrap.env" ]; then
  while IFS='=' read -r k v; do
    case "$k" in SITE_DOMAIN|ORIGIN_DOMAIN|OPS_BUCKET|CONFIG_PREFIX|ALERT_TOPIC_ARN|ACME_EMAIL|DATA_DEVICE)
      [ -n "${!k:-}" ] || printf -v "$k" '%s' "$v" ;;
    esac
  done < "$ETC/bootstrap.env"
fi

: "${SITE_DOMAIN:?SITE_DOMAIN is required (the site, e.g. valuescan.example)}"
: "${ORIGIN_DOMAIN:?ORIGIN_DOMAIN is required (this instance, e.g. origin.valuescan.example)}"
: "${OPS_BUCKET:?OPS_BUCKET is required (network.yaml output OpsBucketName)}"
CONFIG_PREFIX="${CONFIG_PREFIX:-/valuescan/prod}"
ALERT_TOPIC_ARN="${ALERT_TOPIC_ARN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
DATA_DEVICE="${DATA_DEVICE:-/dev/sdf}"

# Everything below ends up in files and sed expressions: accept plain values only.
domain_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
[[ "$SITE_DOMAIN" =~ $domain_re ]] || die "SITE_DOMAIN is not a DNS name: $SITE_DOMAIN"
[[ "$ORIGIN_DOMAIN" =~ $domain_re ]] || die "ORIGIN_DOMAIN is not a DNS name: $ORIGIN_DOMAIN"
[ "$SITE_DOMAIN" != "$ORIGIN_DOMAIN" ] || die "the origin needs a name of its own, not the site's"
[[ "$OPS_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "OPS_BUCKET is not a bucket name: $OPS_BUCKET"
[[ "$CONFIG_PREFIX" =~ ^/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$ ]] || die "CONFIG_PREFIX is not a parameter path: $CONFIG_PREFIX"
[ -z "$ALERT_TOPIC_ARN" ] || [[ "$ALERT_TOPIC_ARN" =~ ^arn:[a-z-]+:sns:[a-z0-9-]+:[0-9]+:[A-Za-z0-9_-]+$ ]] || die "ALERT_TOPIC_ARN is not an SNS topic ARN"
[ -z "$ACME_EMAIL" ] || [[ "$ACME_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "ACME_EMAIL is not an address"

# The region comes from the instance itself (IMDSv2).
if [ -z "${AWS_REGION:-}" ]; then
  token="$(curl -fsS --max-time 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)"
  AWS_REGION="$(curl -fsS --max-time 3 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/region || true)"
fi
[[ "${AWS_REGION:-}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "could not determine the region (set AWS_REGION)"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

case "$(uname -m)" in
  aarch64) NODE_ARCH=arm64; NODE_SHA="$NODE_SHA256_ARM64"; CADDY_ARCH=arm64; CADDY_SHA="$CADDY_SHA512_ARM64" ;;
  x86_64) NODE_ARCH=x64; NODE_SHA="$NODE_SHA256_X64"; CADDY_ARCH=amd64; CADDY_SHA="$CADDY_SHA512_AMD64" ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
grep -q 'Amazon Linux' /etc/os-release 2>/dev/null || warn "this script is written for Amazon Linux 2023; continuing on $(. /etc/os-release && echo "$PRETTY_NAME")"

# --- 1. packages ------------------------------------------------------------------------------

log "packages"
missing=()
for pair in tar:tar xz:xz zstd:zstd mkfs.xfs:xfsprogs cmp:diffutils findmnt:util-linux; do
  command -v "${pair%%:*}" >/dev/null 2>&1 || missing+=("${pair##*:}")
done
if [ "${#missing[@]}" -gt 0 ]; then
  dnf install -y -q "${missing[@]}"
fi
command -v aws >/dev/null 2>&1 || die "the AWS CLI is missing (it is part of the standard Amazon Linux 2023 image)"

# No SSH: the security group has no port 22 and there is no key pair; do not leave
# a daemon listening for the day somebody opens the port. Access is SSM Session Manager.
if [ "${KEEP_SSHD:-0}" != 1 ] && systemctl list-unit-files sshd.service >/dev/null 2>&1; then
  systemctl disable --now sshd.service sshd.socket >/dev/null 2>&1 || true
fi

# --- 2. the service user -------------------------------------------------------------------------

log "user valuescan"
getent group valuescan >/dev/null || groupadd --system valuescan
getent passwd valuescan >/dev/null || useradd --system --gid valuescan --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin valuescan

# --- 3. the data volume ----------------------------------------------------------------------------

log "data volume at $DATA"
mkdir -p "$DATA"
if ! mountpoint -q "$DATA"; then
  root_source="$(findmnt -no SOURCE /)"
  root_disk="/dev/$(lsblk -no PKNAME "$root_source" | head -n 1)"
  if [ -e "$DATA_DEVICE" ]; then
    device="$(readlink -f "$DATA_DEVICE")"
  else
    # No /dev/sdf alias: the data volume is the one disk that is not the root disk.
    mapfile -t others < <(lsblk -dpno NAME,TYPE | awk '$2 == "disk" {print $1}' | grep -vx "$root_disk" || true)
    [ "${#others[@]}" = 1 ] || die "cannot identify the data volume (found: ${others[*]:-none}). Set DATA_DEVICE."
    device="${others[0]}"
  fi
  [ -b "$device" ] || die "$device is not a block device"
  [ "$device" != "$root_disk" ] || die "$device is the root disk - refusing"
  [ -z "$(lsblk -no MOUNTPOINT "$device" | tr -d '[:space:]')" ] || die "$device is mounted somewhere else - refusing"
  [ "$(lsblk -no NAME "$device" | wc -l)" = 1 ] || die "$device has partitions - refusing to guess"

  fstype="$(blkid -o value -s TYPE "$device" 2>/dev/null || true)"
  if [ -z "$fstype" ]; then
    # Format ONLY a volume that is verifiably blank: `blkid -p` exits 2 when it
    # finds no signature of any kind. Any other answer (0 = something is there,
    # 4 or 8 = it could not tell) is a reason to stop, never to format.
    probe=0
    blkid -p "$device" >/dev/null 2>&1 || probe=$?
    [ "$probe" = 2 ] || die "$device is not verifiably blank (blkid -p exit $probe) - refusing to format it"
    log "formatting the blank volume $device (xfs)"
    mkfs.xfs -q -L valuescan "$device"
  elif [ "$fstype" != xfs ]; then
    die "$device holds a $fstype filesystem, expected xfs or a blank volume - refusing"
  else
    log "$device already holds an xfs filesystem: mounting it as it is"
  fi
  uuid="$(blkid -o value -s UUID "$device")"
  [ -n "$uuid" ] || die "no filesystem UUID on $device"
  if ! grep -q "UUID=$uuid" /etc/fstab; then
    # nofail: a missing volume must not keep the instance (and SSM) from booting.
    printf 'UUID=%s %s xfs defaults,noatime,nofail,x-systemd.device-timeout=30s 0 0\n' "$uuid" "$DATA" >> /etc/fstab
    systemctl daemon-reload
  fi
  mount "$DATA"
fi
install -d -m 0755 -o root -g root "$DATA"
install -d -m 0750 -o valuescan -g valuescan "$DATA/index" "$DATA/state" "$DATA/backup"

# --- 4. Node and Caddy, pinned ---------------------------------------------------------------------

fetch_verified() {   # url, destination, algorithm (256|512), expected hex digest
  local url="$1" dst="$2" algo="$3" want="$4" got
  curl -fsSL --retry 3 --retry-delay 2 --max-time 300 -o "$dst" "$url"
  got="$("sha${algo}sum" "$dst" | awk '{print $1}')"
  [ "$got" = "$want" ] || die "checksum mismatch for $url (expected $want, got $got)"
}

node_dir="/opt/node/v$NODE_VERSION"
if [ ! -x "$node_dir/bin/node" ] || [ "$("$node_dir/bin/node" --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  log "installing Node $NODE_VERSION ($NODE_ARCH)"
  tmp="$(mktemp -d)"
  fetch_verified "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" "$tmp/node.tar.xz" 256 "$NODE_SHA"
  rm -rf "$node_dir"; mkdir -p "$node_dir"
  tar -xJf "$tmp/node.tar.xz" -C "$node_dir" --strip-components=1 --no-same-owner
  rm -rf "$tmp"
  [ -L /opt/node/current ] && NEEDS_RESTART+=(valuescan-indexer valuescan-api)
else
  log "Node $NODE_VERSION is installed"
fi
# The link moves only to a Node that is what it should be and can run the server.
[ "$("$node_dir/bin/node" --version 2>/dev/null)" = "v$NODE_VERSION" ] || die "$node_dir does not hold Node $NODE_VERSION"
"$node_dir/bin/node" --disable-warning=ExperimentalWarning -e "require('node:sqlite')" || die "Node $NODE_VERSION has no node:sqlite"
ln -sfn "$node_dir" /opt/node/current.new && mv -Tf /opt/node/current.new /opt/node/current

if [ ! -x /usr/local/bin/caddy ] || ! /usr/local/bin/caddy version 2>/dev/null | grep -q "^v$CADDY_VERSION "; then
  log "installing Caddy $CADDY_VERSION ($CADDY_ARCH)"
  tmp="$(mktemp -d)"
  fetch_verified "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_$CADDY_ARCH.tar.gz" "$tmp/caddy.tar.gz" 512 "$CADDY_SHA"
  tar -xzf "$tmp/caddy.tar.gz" -C "$tmp" --no-same-owner caddy
  install -m 0755 -o root -g root "$tmp/caddy" /usr/local/bin/caddy
  rm -rf "$tmp"
  NEEDS_RESTART+=(caddy)
else
  log "Caddy $CADDY_VERSION is installed"
fi
getent group caddy >/dev/null || groupadd --system caddy
getent passwd caddy >/dev/null || useradd --system --gid caddy --home-dir /var/lib/caddy --no-create-home --shell /usr/sbin/nologin caddy
install -d -m 0750 -o caddy -g caddy /var/lib/caddy /var/lib/caddy/data /var/lib/caddy/config
install -d -m 0755 -o root -g root /etc/caddy

# --- 5. layout, scripts, configuration ------------------------------------------------------------------

log "layout and scripts"
install -d -m 0755 -o root -g root "$VS_HOME" "$VS_HOME/bin" "$VS_HOME/releases" /var/cache/valuescan
install -d -m 0750 -o root -g valuescan "$ETC"
for f in "$HERE"/bin/*; do
  case "$f" in *.test.mjs) continue ;; esac
  install_if_changed "$f" "$VS_HOME/bin/$(basename "$f")" 0755 || true
done

log "env files in $ETC"
render() {   # template -> stdout, placeholders filled
  sed -e "s|__SITE_DOMAIN__|$SITE_DOMAIN|g" -e "s|__ORIGIN_DOMAIN__|$ORIGIN_DOMAIN|g" \
      -e "s|__AWS_REGION__|$AWS_REGION|g" -e "s|__OPS_BUCKET__|$OPS_BUCKET|g" \
      -e "s|__ALERT_TOPIC_ARN__|$ALERT_TOPIC_ARN|g" "$1"
}
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
render "$HERE/env/api.env.example" > "$work/api.env"
render "$HERE/env/indexer.env.example" > "$work/indexer.env"
render "$HERE/env/ops.env.example" > "$work/ops.env"
grep -l '__[A-Z_]*__' "$work"/*.env >/dev/null 2>&1 && die "a template placeholder was left unfilled in $(grep -l '__[A-Z_]*__' "$work"/*.env | tr '\n' ' ')"
install_if_changed "$work/api.env" "$ETC/api.env" 0640 root:valuescan && NEEDS_RESTART+=(valuescan-api)
install_if_changed "$work/indexer.env" "$ETC/indexer.env" 0640 root:valuescan && NEEDS_RESTART+=(valuescan-indexer)
install_if_changed "$work/ops.env" "$ETC/ops.env" 0640 root:valuescan || true

# What this run was given, for the next one (no secret in it).
{
  printf 'SITE_DOMAIN=%s\nORIGIN_DOMAIN=%s\nOPS_BUCKET=%s\nCONFIG_PREFIX=%s\n' "$SITE_DOMAIN" "$ORIGIN_DOMAIN" "$OPS_BUCKET" "$CONFIG_PREFIX"
  printf 'ALERT_TOPIC_ARN=%s\nACME_EMAIL=%s\nDATA_DEVICE=%s\n' "$ALERT_TOPIC_ARN" "$ACME_EMAIL" "$DATA_DEVICE"
} > "$work/bootstrap.env"
install_if_changed "$work/bootstrap.env" "$ETC/bootstrap.env" 0640 root:root || true

# The origin secret: SSM Parameter Store -> a root-owned file only the service group reads.
log "origin secret from SSM ($CONFIG_PREFIX/origin-secret)"
( umask 077
  secret="$(aws ssm get-parameter --region "$AWS_REGION" --name "$CONFIG_PREFIX/origin-secret" --with-decryption --query 'Parameter.Value' --output text)" \
    || die "could not read $CONFIG_PREFIX/origin-secret - create it first (deploy/aws/README.md) and check the instance role"
  [ "${#secret}" -ge 32 ] || die "the origin secret must be at least 32 characters"
  [[ "$secret" =~ ^[A-Za-z0-9._~-]+$ ]] || die "the origin secret may only contain A-Z a-z 0-9 . _ ~ -"
  printf 'VALUESCAN_ORIGIN_SECRET=%s\n' "$secret" > "$work/api.secret.env"
)
install_if_changed "$work/api.secret.env" "$ETC/api.secret.env" 0640 root:valuescan && NEEDS_RESTART+=(valuescan-api)
rm -f "$work/api.secret.env"

log "Caddyfile for $ORIGIN_DOMAIN"
email_line="# (no ACME contact address was given)"
[ -z "$ACME_EMAIL" ] || email_line="email $ACME_EMAIL"
sed -e "s|__ORIGIN_DOMAIN__|$ORIGIN_DOMAIN|g" -e "s|__ACME_EMAIL_LINE__|$email_line|" "$HERE/caddy/Caddyfile.template" > "$work/Caddyfile"
XDG_DATA_HOME="$work/caddy-data" XDG_CONFIG_HOME="$work/caddy-config" /usr/local/bin/caddy validate --config "$work/Caddyfile" >/dev/null 2>&1 \
  || { /usr/local/bin/caddy validate --config "$work/Caddyfile" || true; die "the generated Caddyfile is not valid"; }
install_if_changed "$work/Caddyfile" /etc/caddy/Caddyfile 0644 && NEEDS_RESTART+=(caddy)

# --- 6. systemd -------------------------------------------------------------------------------------------

log "systemd units"
units_changed=0
for f in "$HERE"/units/*.service "$HERE"/units/*.timer; do
  name="$(basename "$f")"
  if install_if_changed "$f" "/etc/systemd/system/$name" 0644; then
    units_changed=1
    case "$name" in valuescan-indexer.service|valuescan-api.service|caddy.service) NEEDS_RESTART+=("${name%.service}") ;; esac
  fi
done
if install_if_changed "$HERE/journald/valuescan.conf" /etc/systemd/journald.conf.d/valuescan.conf 0644; then
  systemctl restart systemd-journald
fi
[ "$units_changed" = 0 ] || systemctl daemon-reload
systemctl enable -q caddy.service valuescan-indexer.service valuescan-api.service valuescan-backup.timer valuescan-health.timer

# --- 7. start what may be started ----------------------------------------------------------------------------

restart_wanted() { local u; for u in "${NEEDS_RESTART[@]:-}"; do [ "$u" = "$1" ] && return 0; done; return 1; }

if systemctl is-active -q caddy.service && restart_wanted caddy; then
  log "restarting Caddy (its configuration changed)"
  systemctl restart caddy.service
else
  systemctl start caddy.service || warn "Caddy did not start: journalctl -u caddy -n 50"
fi
systemctl start valuescan-backup.timer valuescan-health.timer

pending=()
if [ -e "$VS_HOME/current/apps/server/src/index.ts" ]; then
  # The API restarts in seconds: apply its changes now. The indexer is never
  # restarted from here - its streams are expensive to lose.
  if systemctl is-active -q valuescan-api.service; then
    if restart_wanted valuescan-api; then log "restarting the API (its configuration changed)"; systemctl restart valuescan-api.service; fi
  else
    systemctl start valuescan-api.service || warn "the API did not start: journalctl -u valuescan-api -n 50"
  fi
  if systemctl is-active -q valuescan-indexer.service; then
    restart_wanted valuescan-indexer && pending+=(valuescan-indexer)
  else
    systemctl start valuescan-indexer.service || warn "the indexer did not start: journalctl -u valuescan-indexer -n 50"
  fi
else
  log "no release is installed yet: the API and the indexer start with the first release"
fi

# --- summary ---------------------------------------------------------------------------------------------------

echo
log "done."
log "  node      $("$node_dir/bin/node" --version)        caddy   $(/usr/local/bin/caddy version | awk '{print $1}')"
log "  data      $(df -h --output=source,size,avail "$DATA" | tail -n 1 | xargs)"
log "  index     $([ -f "$INDEX_DB" ] && du -h "$INDEX_DB" | awk '{print $1}' || echo 'not there yet (cold start, or restore a seed: restore.sh)')"
log "  release   $([ -L "$VS_HOME/current" ] && basename "$(readlink -f "$VS_HOME/current")" || echo none)"
log "  units     caddy=$(systemctl is-active caddy.service || true) api=$(systemctl is-active valuescan-api.service || true) indexer=$(systemctl is-active valuescan-indexer.service || true)"
if [ "${#pending[@]}" -gt 0 ]; then
  log "  RESTART NEEDED, at a time of your choosing: sudo systemctl restart ${pending[*]}"
  log "  (the indexer's configuration changed; restarting it costs the Lighter stream 3.5-8 minutes)"
fi
log "  certificate: Caddy needs $ORIGIN_DOMAIN to resolve to this instance and port 80 to be reachable;"
log "               watch it with: journalctl -u caddy -f"
