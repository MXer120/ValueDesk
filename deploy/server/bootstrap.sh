#!/usr/bin/env bash
# Set up the Valuescan instance. IDEMPOTENT: run it again after changing a unit,
# an env template, a pinned version or the origin secret - it converges and only
# touches what differs.
#
# It is run as root on the instance, from the bootstrap bundle (this directory),
# normally by deploy/release/bootstrap-instance.sh - through SSM Run Command on the
# CloudFormation instance, over SSH on the EC2 test instance:
#
#   SITE_DOMAIN=valuescan.example ORIGIN_DOMAIN=origin.valuescan.example \
#   OPS_BUCKET=<ops bucket> CONFIG_PREFIX=/valuescan/prod \
#   [ALERT_TOPIC_ARN=arn:...] [ACME_EMAIL=you@example.com] \
#     bash /opt/valuescan/bootstrap/bootstrap.sh
#
#   # an instance WITHOUT an instance role (no SSM, no S3): the EC2 test environment
#   SITE_DOMAIN=... ORIGIN_DOMAIN=... OPS_BUCKET= KEEP_SSHD=1 \
#   ORIGIN_SECRET_FILE=<root-only-file> \
#     bash /opt/valuescan/bootstrap/bootstrap.sh
#
# Target: Amazon Linux 2023 (arm64 or x86_64). On the CloudFormation instance no
# inbound SSH is needed or left on; on the EC2 test instance SSH is the way in
# (KEEP_SSHD=1, remembered for every later run).
#
# THE ORIGIN SECRET comes from SSM Parameter Store (<CONFIG_PREFIX>/origin-secret,
# and <CONFIG_PREFIX>/origin-secret-next while it is rotated), or from a root-only
# file the workstation wrote over SSH (ORIGIN_SECRET_FILE, and <that file>.next).
# When there are two, both are accepted: VALUESCAN_ORIGIN_SECRET=current,next
# (docs/deploy/DEPLOY.md, "Rotating the origin secret").
#
# WHAT IT DOES
#   1. packages (tar, xz, zstd, xfsprogs), no SSH daemon
#   2. the `valuescan` system user and the copy executor's own `valuescan-executor`
#      (no login, no shell)
#   3. the data volume: formats it ONLY if it is blank, mounts it at /var/lib/valuescan;
#      the executor's directory /var/lib/valuescan/executor (0700, its user only)
#   4. Node and Caddy at the pinned versions (versions.env), checksums verified
#   5. /opt/valuescan (bin scripts), /etc/valuescan (env files; the origin secret
#      from SSM Parameter Store), /etc/caddy/Caddyfile
#   6. systemd units and timers; journald: persistent, a year for the main journal,
#      90 days for the namespace "pii" (the API's and the executor's logs)
#   7. starts Caddy and the timers; starts the API, the indexer and the copy
#      executor if a release with them is installed (the first such release does
#      that otherwise)
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
    case "$k" in SITE_DOMAIN|ORIGIN_DOMAIN|ORIGIN_ALIASES|OPS_BUCKET|CONFIG_PREFIX|ALERT_TOPIC_ARN|ACME_EMAIL|DATA_DEVICE|KEEP_SSHD|ORIGIN_SECRET_FILE|EXECUTOR_UPSTREAM)
      [ -n "${!k:-}" ] || printf -v "$k" '%s' "$v" ;;
    esac
  done < "$ETC/bootstrap.env"
fi

: "${SITE_DOMAIN:?SITE_DOMAIN is required (the site, e.g. valuescan.example)}"
: "${ORIGIN_DOMAIN:?ORIGIN_DOMAIN is required (this instance, e.g. origin.valuescan.example)}"
# Empty on an instance without an instance role: releases arrive over SSH and
# backups stay on the data volume (env/ops.env.example).
OPS_BUCKET="${OPS_BUCKET:-}"
CONFIG_PREFIX="${CONFIG_PREFIX:-/valuescan/prod}"
ALERT_TOPIC_ARN="${ALERT_TOPIC_ARN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
DATA_DEVICE="${DATA_DEVICE:-/dev/sdf}"
KEEP_SSHD="${KEEP_SSHD:-0}"
ORIGIN_SECRET_FILE="${ORIGIN_SECRET_FILE:-}"
# Where Caddy sends /api/copy/*: the executor here, or https://<origin name> of a server of its own.
EXECUTOR_UPSTREAM="${EXECUTOR_UPSTREAM:-127.0.0.1:8799}"

# Everything below ends up in files and sed expressions: accept plain values only.
domain_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
[[ "$SITE_DOMAIN" =~ $domain_re ]] || die "SITE_DOMAIN is not a DNS name: $SITE_DOMAIN"
[[ "$ORIGIN_DOMAIN" =~ $domain_re ]] || die "ORIGIN_DOMAIN is not a DNS name: $ORIGIN_DOMAIN"
[ "$SITE_DOMAIN" != "$ORIGIN_DOMAIN" ] || die "the origin needs a name of its own, not the site's"
# More names Caddy serves (and gets certificates for) beside ORIGIN_DOMAIN, space
# separated: the old sslip.io name while the site moves to api.<site domain>.
ORIGIN_ALIASES="${ORIGIN_ALIASES:-}"
origin_addresses="$ORIGIN_DOMAIN"
for alias in $ORIGIN_ALIASES; do
  [[ "$alias" =~ $domain_re ]] || die "ORIGIN_ALIASES holds a name that is not a DNS name: $alias"
  [ "$alias" != "$SITE_DOMAIN" ] || die "ORIGIN_ALIASES may not name the site itself"
  origin_addresses+=", $alias"
done
[ -z "$OPS_BUCKET" ] || [[ "$OPS_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "OPS_BUCKET is not a bucket name: $OPS_BUCKET"
[[ "$KEEP_SSHD" =~ ^[01]$ ]] || die "KEEP_SSHD is 0 or 1"
[ "$EXECUTOR_UPSTREAM" = 127.0.0.1:8799 ] || [[ "$EXECUTOR_UPSTREAM" =~ ^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] \
  || die "EXECUTOR_UPSTREAM is 127.0.0.1:8799 or https://<name>: $EXECUTOR_UPSTREAM"
[ -z "$ORIGIN_SECRET_FILE" ] || [[ "$ORIGIN_SECRET_FILE" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "ORIGIN_SECRET_FILE is not an absolute path"
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
# The AWS CLI reads the secret from SSM and, with an ops bucket, moves releases and
# backups. An instance without a role uses none of that.
if [ -z "$ORIGIN_SECRET_FILE" ] || [ -n "$OPS_BUCKET" ]; then
  command -v aws >/dev/null 2>&1 || die "the AWS CLI is missing (it is part of the standard Amazon Linux 2023 image)"
fi

# No SSH on the CloudFormation instance: the security group has no port 22 and there
# is no key pair; do not leave a daemon listening for the day somebody opens the
# port. Access is SSM Session Manager. On an instance without a role SSH IS the way
# in (KEEP_SSHD=1, remembered in bootstrap.env): it stays, keys only (Amazon Linux
# 2023's default).
if [ "$KEEP_SSHD" != 1 ] && systemctl list-unit-files sshd.service >/dev/null 2>&1; then
  systemctl disable --now sshd.service sshd.socket >/dev/null 2>&1 || true
fi

# --- 2. the service user -------------------------------------------------------------------------

log "user valuescan"
getent group valuescan >/dev/null || groupadd --system valuescan
getent passwd valuescan >/dev/null || useradd --system --gid valuescan --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin valuescan

# The copy executor's own user (units/valuescan-executor.service says why): what it
# keeps - the followers' sealed keys and the key that seals them - must not be
# readable by the valuescan processes. A member of the group valuescan, to read the
# release, /etc/valuescan and the builder ledger (never to write them).
log "user valuescan-executor"
getent group valuescan-executor >/dev/null || groupadd --system valuescan-executor
getent passwd valuescan-executor >/dev/null || useradd --system --gid valuescan-executor --groups valuescan --home-dir "$DATA/executor" --no-create-home --shell /usr/sbin/nologin valuescan-executor
id -nG valuescan-executor | tr ' ' '\n' | grep -qx valuescan || usermod -a -G valuescan valuescan-executor

# --- 3. the data volume ----------------------------------------------------------------------------

log "data volume at $DATA"
mkdir -p "$DATA"
# DATA_DEVICE=none: a server with one disk (Contabo, 2026-10-25) keeps the data on it.
if [ "$DATA_DEVICE" = none ]; then
  log "no separate data volume: $DATA is on the root disk"
elif ! mountpoint -q "$DATA"; then
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
# A data volume made from another instance's snapshot (provision.sh: DATA_VOLUME_SNAPSHOT)
# carries that instance's numeric user ids. Where a directory belongs to other ids
# than its user has here, what belonged to those ids is handed over - and nothing
# else (chown --from: a root-owned seed stays root's, the executor's files stay its).
adopt() {   # directory, user
  local dir="$1" user="$2" have want
  [ -d "$dir" ] || return 0
  have="$(stat -c '%u:%g' "$dir")"
  want="$(id -u "$user"):$(getent group "$user" | cut -d: -f3)"
  [ "$have" != "$want" ] && [ "$have" != 0:0 ] || return 0
  log "$dir belongs to ids $have, $user is $want here (a volume from another instance): handing over what belonged to $have"
  chown -R --from="$have" "$user:$user" "$dir"
}
adopt "$DATA/index" valuescan
adopt "$DATA/state" valuescan
adopt "$DATA/backup" valuescan
adopt "$DATA/executor" valuescan-executor
adopt "$DATA/backup/executor" valuescan-executor
install -d -m 0750 -o valuescan -g valuescan "$DATA/index" "$DATA/state" "$DATA/backup"
# The executor's data (executor.db, kek, session.key) and its backups: its user only.
install -d -m 0700 -o valuescan-executor -g valuescan-executor "$DATA/executor" "$DATA/backup/executor"

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
  [ -L /opt/node/current ] && NEEDS_RESTART+=(valuescan-indexer valuescan-api valuescan-executor)
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
# What the copy executor tells followers about where their copies run.
case "$AWS_REGION" in
  ap-northeast-1) region_city=Tokyo ;;
  eu-central-1) region_city=Frankfurt ;;
  us-east-1) region_city="N. Virginia" ;;
  *) region_city="" ;;
esac
EXECUTOR_LOCATION="$AWS_REGION${region_city:+ ($region_city)}"
render() {   # template -> stdout, placeholders filled
  sed -e "s|__SITE_DOMAIN__|$SITE_DOMAIN|g" -e "s|__ORIGIN_DOMAIN__|$ORIGIN_DOMAIN|g" \
      -e "s|__AWS_REGION__|$AWS_REGION|g" -e "s|__OPS_BUCKET__|$OPS_BUCKET|g" \
      -e "s|__ALERT_TOPIC_ARN__|$ALERT_TOPIC_ARN|g" -e "s|__EXECUTOR_LOCATION__|$EXECUTOR_LOCATION|g" "$1"
}
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
render "$HERE/env/api.env.example" > "$work/api.env"
render "$HERE/env/indexer.env.example" > "$work/indexer.env"
render "$HERE/env/ops.env.example" > "$work/ops.env"
render "$HERE/env/executor.env.example" > "$work/executor.env"
grep -l '__[A-Z_]*__' "$work"/*.env >/dev/null 2>&1 && die "a template placeholder was left unfilled in $(grep -l '__[A-Z_]*__' "$work"/*.env | tr '\n' ' ')"
install_if_changed "$work/api.env" "$ETC/api.env" 0640 root:valuescan && NEEDS_RESTART+=(valuescan-api)
install_if_changed "$work/indexer.env" "$ETC/indexer.env" 0640 root:valuescan && NEEDS_RESTART+=(valuescan-indexer)
install_if_changed "$work/ops.env" "$ETC/ops.env" 0640 root:valuescan || true
install_if_changed "$work/executor.env" "$ETC/executor.env" 0640 root:valuescan-executor && NEEDS_RESTART+=(valuescan-executor)

# What this run was given, for the next one (no secret in it).
{
  printf 'SITE_DOMAIN=%s\nORIGIN_DOMAIN=%s\nOPS_BUCKET=%s\nCONFIG_PREFIX=%s\n' "$SITE_DOMAIN" "$ORIGIN_DOMAIN" "$OPS_BUCKET" "$CONFIG_PREFIX"
  printf 'ORIGIN_ALIASES=%s\n' "$ORIGIN_ALIASES"
  printf 'ALERT_TOPIC_ARN=%s\nACME_EMAIL=%s\nDATA_DEVICE=%s\n' "$ALERT_TOPIC_ARN" "$ACME_EMAIL" "$DATA_DEVICE"
  printf 'KEEP_SSHD=%s\nORIGIN_SECRET_FILE=%s\nEXECUTOR_UPSTREAM=%s\n' "$KEEP_SSHD" "$ORIGIN_SECRET_FILE" "$EXECUTOR_UPSTREAM"
} > "$work/bootstrap.env"
install_if_changed "$work/bootstrap.env" "$ETC/bootstrap.env" 0640 root:root || true

# The origin secret -> three root-owned files: api.secret.env (the API's group reads
# it), caddy.secret.env and executor.secret.env (only root - systemd hands them to
# Caddy and to the copy executor). Never printed, never on a command line.
#   current   SSM <CONFIG_PREFIX>/origin-secret, or ORIGIN_SECRET_FILE
#   next      SSM <CONFIG_PREFIX>/origin-secret-next, or <ORIGIN_SECRET_FILE>.next -
#             there only while the secret is rotated; then both are accepted.
check_secret() {   # value, which
  [ "${#1}" -ge 32 ] || die "the $2 origin secret must be at least 32 characters"
  [[ "$1" =~ ^[A-Za-z0-9._~-]+$ ]] || die "the $2 origin secret may only contain A-Z a-z 0-9 . _ ~ -"
}
secret_file_ok() {   # a file only root can read
  [ "$(stat -c '%u %a' "$1")" = "0 600" ] || die "$1 must belong to root with mode 600"
}
( umask 077
  current=""
  next=""
  if [ -n "$ORIGIN_SECRET_FILE" ]; then
    log "origin secret from $ORIGIN_SECRET_FILE"
    [ -f "$ORIGIN_SECRET_FILE" ] || die "$ORIGIN_SECRET_FILE does not exist - deploy/release/bootstrap-instance.sh writes it"
    secret_file_ok "$ORIGIN_SECRET_FILE"
    current="$(tr -d '\r\n' < "$ORIGIN_SECRET_FILE")"
    if [ -f "$ORIGIN_SECRET_FILE.next" ]; then
      secret_file_ok "$ORIGIN_SECRET_FILE.next"
      next="$(tr -d '\r\n' < "$ORIGIN_SECRET_FILE.next")"
    fi
  else
    log "origin secret from SSM ($CONFIG_PREFIX/origin-secret, and -next while it is rotated)"
    # get-parameters (plural) lists a missing name under InvalidParameters instead of
    # failing, so "no -next" is not an error; no answer at all is.
    pairs="$(aws ssm get-parameters --region "$AWS_REGION" --with-decryption \
      --names "$CONFIG_PREFIX/origin-secret" "$CONFIG_PREFIX/origin-secret-next" \
      --query 'Parameters[].[Name,Value]' --output text)" \
      || die "could not read $CONFIG_PREFIX/origin-secret - create it first (deploy/aws/README.md) and check the instance role"
    while IFS=$'\t' read -r name value; do
      case "$name" in
        "$CONFIG_PREFIX/origin-secret") current="$value" ;;
        "$CONFIG_PREFIX/origin-secret-next") next="$value" ;;
      esac
    done <<< "$pairs"
    [ -n "$current" ] || die "$CONFIG_PREFIX/origin-secret does not exist - create it first (deploy/aws/deploy.sh secret --execute)"
  fi
  check_secret "$current" current
  list="$current"
  second="$current"
  if [ -n "$next" ] && [ "$next" != "$current" ]; then
    check_secret "$next" next
    list="$current,$next"
    second="$next"
    log "a rotation is under way: the current and the next origin secret are both accepted"
  fi
  printf 'VALUESCAN_ORIGIN_SECRET=%s\n' "$list" > "$work/api.secret.env"
  # Caddy refuses, before the API, a request that carries neither value
  # (caddy/Caddyfile.template). Both names are always set - to the same value when
  # nothing is being rotated - so the matcher never has an empty value.
  printf 'VALUESCAN_ORIGIN_SECRET_1=%s\nVALUESCAN_ORIGIN_SECRET_2=%s\n' "$current" "$second" > "$work/caddy.secret.env"
  # The executor checks the same value(s) again behind Caddy (apps/executor/src/config.ts).
  printf 'EXECUTOR_ORIGIN_SECRET=%s\nEXECUTOR_ORIGIN_SECRET_2=%s\n' "$current" "$second" > "$work/executor.secret.env"
)
install_if_changed "$work/api.secret.env" "$ETC/api.secret.env" 0640 root:valuescan && NEEDS_RESTART+=(valuescan-api)
install_if_changed "$work/caddy.secret.env" "$ETC/caddy.secret.env" 0600 root:root && NEEDS_RESTART+=(caddy)
install_if_changed "$work/executor.secret.env" "$ETC/executor.secret.env" 0600 root:root && NEEDS_RESTART+=(valuescan-executor)
rm -f "$work/api.secret.env" "$work/caddy.secret.env" "$work/executor.secret.env"

log "Caddyfile for $origin_addresses"
email_line="# (no ACME contact address was given)"
[ -z "$ACME_EMAIL" ] || email_line="email $ACME_EMAIL"
# A remote executor is reached by its own name (its Caddy serves only that name).
host_line="# the executor runs here"
[ "$EXECUTOR_UPSTREAM" = 127.0.0.1:8799 ] || host_line="header_up Host {upstream_hostport}"
sed -e "s|__ORIGIN_SITE_ADDRESSES__|$origin_addresses|" -e "s|__ORIGIN_DOMAIN__|$ORIGIN_DOMAIN|g" -e "s|__ACME_EMAIL_LINE__|$email_line|" \
    -e "s|__EXECUTOR_UPSTREAM__|$EXECUTOR_UPSTREAM|" -e "s|__EXECUTOR_HOST_LINE__|$host_line|" "$HERE/caddy/Caddyfile.template" > "$work/Caddyfile"
# Validated with stand-in secrets: the real ones reach Caddy only through systemd.
stand_in="$(printf 'v%.0s' {1..40})"
caddy_check() {
  VALUESCAN_ORIGIN_SECRET_1="${stand_in}1" VALUESCAN_ORIGIN_SECRET_2="${stand_in}2" \
    XDG_DATA_HOME="$work/caddy-data" XDG_CONFIG_HOME="$work/caddy-config" /usr/local/bin/caddy validate --config "$work/Caddyfile" "$@"
}
caddy_check >/dev/null 2>&1 || { caddy_check || true; die "the generated Caddyfile is not valid"; }
install_if_changed "$work/Caddyfile" /etc/caddy/Caddyfile 0644 && NEEDS_RESTART+=(caddy)

# --- 6. systemd -------------------------------------------------------------------------------------------

log "systemd units"
units_changed=0
for f in "$HERE"/units/*.service "$HERE"/units/*.timer; do
  name="$(basename "$f")"
  if install_if_changed "$f" "/etc/systemd/system/$name" 0644; then
    units_changed=1
    case "$name" in valuescan-indexer.service|valuescan-api.service|valuescan-executor.service|caddy.service) NEEDS_RESTART+=("${name%.service}") ;; esac
  fi
done
if install_if_changed "$HERE/journald/valuescan.conf" /etc/systemd/journald.conf.d/valuescan.conf 0644; then
  # Storage=persistent: journald moves what it holds in /run to /var/log/journal.
  systemctl restart systemd-journald
  journalctl --flush 2>/dev/null || true
fi
# The namespace "pii" (LogNamespace=pii in the API's and the executor's units): 90 days.
if install_if_changed "$HERE/journald/journald@pii.conf" /etc/systemd/journald@pii.conf 0644; then
  if systemctl is-active -q systemd-journald@pii.service; then systemctl restart systemd-journald@pii.service; fi
fi
[ "$units_changed" = 0 ] || systemctl daemon-reload
# valuescan-executor-backup.service has no [Install]: valuescan-backup.service wants it.
systemctl enable -q caddy.service valuescan-indexer.service valuescan-api.service valuescan-executor.service valuescan-backup.timer valuescan-health.timer
# The off-server copies: each does nothing until its configuration exists
# (/etc/valuescan/offsite.env, /etc/vsbackup/receive.env - deploy/contabo/apply-overlay.sh).
systemctl enable -q valuescan-offsite.timer valuescan-offsite-prune.timer

# --- 7. start what may be started ----------------------------------------------------------------------------

restart_wanted() { local u; for u in "${NEEDS_RESTART[@]:-}"; do [ "$u" = "$1" ] && return 0; done; return 1; }

if systemctl is-active -q caddy.service && restart_wanted caddy; then
  log "restarting Caddy (its configuration changed)"
  systemctl restart caddy.service
else
  systemctl start caddy.service || warn "Caddy did not start: journalctl -u caddy -n 50"
fi
systemctl start valuescan-backup.timer valuescan-health.timer valuescan-offsite.timer valuescan-offsite-prune.timer

pending=()
if [ -e "$VS_HOME/current/apps/server/src/index.ts" ]; then
  # The API restarts in seconds: apply its changes now. The indexer is never
  # restarted from here - its streams are expensive to lose.
  if systemctl is-active -q valuescan-api.service; then
    if restart_wanted valuescan-api; then log "restarting the API (its configuration changed)"; systemctl restart valuescan-api.service; fi
  else
    systemctl start valuescan-api.service || warn "the API did not start: journalctl --namespace=pii -u valuescan-api -n 50"
  fi
  if systemctl is-active -q valuescan-indexer.service; then
    restart_wanted valuescan-indexer && pending+=(valuescan-indexer)
  else
    systemctl start valuescan-indexer.service || warn "the indexer did not start: journalctl -u valuescan-indexer -n 50"
  fi
else
  log "no release is installed yet: the API and the indexer start with the first release"
fi
if [ -e "$VS_HOME/current/apps/executor/src/main.ts" ]; then
  # The copy executor restarts in seconds, and a changed origin secret must reach it
  # before the edge sends the new one: apply its changes now, like the API's.
  if systemctl is-active -q valuescan-executor.service; then
    if restart_wanted valuescan-executor; then log "restarting the copy executor (its configuration changed)"; systemctl restart valuescan-executor.service; fi
  else
    systemctl start valuescan-executor.service || warn "the copy executor did not start: journalctl --namespace=pii -u valuescan-executor -n 50"
  fi
else
  log "the installed release has no copy executor (apps/executor): it starts with the first release that has one"
fi

# --- summary ---------------------------------------------------------------------------------------------------

echo
log "done."
log "  node      $("$node_dir/bin/node" --version)        caddy   $(/usr/local/bin/caddy version | awk '{print $1}')"
log "  data      $(df -h --output=source,size,avail "$DATA" | tail -n 1 | xargs)"
log "  index     $([ -f "$INDEX_DB" ] && du -h "$INDEX_DB" | awk '{print $1}' || echo 'not there yet (cold start, or restore a seed: restore.sh)')"
log "  release   $([ -L "$VS_HOME/current" ] && basename "$(readlink -f "$VS_HOME/current")" || echo none)"
log "  executor  $DATA/executor ($(stat -c '%U %a' "$DATA/executor")), database $([ -f "$DATA/executor/executor.db" ] && du -h "$DATA/executor/executor.db" | awk '{print $1}' || echo 'not there yet'), kek $([ -f "$DATA/executor/kek" ] && echo present || echo 'not there yet (made on its first start)')"
log "  units     caddy=$(systemctl is-active caddy.service || true) api=$(systemctl is-active valuescan-api.service || true) indexer=$(systemctl is-active valuescan-indexer.service || true) executor=$(systemctl is-active valuescan-executor.service || true)"
if [ "${#pending[@]}" -gt 0 ]; then
  log "  RESTART NEEDED, at a time of your choosing: sudo systemctl restart ${pending[*]}"
  log "  (the indexer's configuration changed; restarting it costs the Lighter stream 3.5-8 minutes)"
fi
log "  certificate: Caddy needs $ORIGIN_DOMAIN to resolve to this instance and port 80 to be reachable;"
log "               watch it with: journalctl -u caddy -f"
