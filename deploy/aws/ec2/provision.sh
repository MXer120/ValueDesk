#!/usr/bin/env bash
# The EC2 test environment of Valuescan - ONE instance, defined once, here.
#
#   deploy/aws/ec2/provision.sh up [--print]   create what is missing; --print: show the plan, change nothing
#   deploy/aws/ec2/provision.sh status         what exists (found by tag), the instance state, the origin name
#   deploy/aws/ec2/provision.sh stop           pause: the instance stops; nothing is deleted
#   deploy/aws/ec2/provision.sh start          resume
#   deploy/aws/ec2/provision.sh allow-ssh      port 22 for this machine's current address only
#   deploy/aws/ec2/provision.sh snapshot       an EBS snapshot of the data volume (a backup off the box)
#   deploy/aws/ec2/provision.sh grow           raise the data volume to DATA_VOLUME_GIB, online
#   deploy/aws/ec2/provision.sh check          can this profile do what `up` needs? (dry runs, read-only)
#
# Every command prints each AWS call before it makes it. Values: deploy/aws/ec2/ec2.env
# (copy ec2.env.example). What it found is written to deploy/aws/ec2/.out/state.env
# (ignored by git) for the scripts in deploy/release.
#
# WHY A SCRIPT AND NOT CLOUDFORMATION. The account's deploying user may launch EC2
# resources but may not use CloudFormation, IAM or SSM. This script is the
# environment's definition instead, built to the owner's rule for AWS test
# environments (~/.claude/rules/aws-latency-test-environment.md):
#   - defined ONCE: every resource is found by its tags (project=valuescan,
#     env=<NAME>, role=...) and created only when it is missing. Running `up` again
#     changes nothing that exists;
#   - it NEVER deletes, terminates or replaces anything. A resource that differs
#     from ec2.env is reported, not rebuilt. The launch carries a client token, so
#     even a retried launch cannot make a second instance;
#   - the free part (security group, key pair) is separate from what bills by the
#     hour (the instance; the Elastic IP and the volumes bill while stopped too);
#   - pausing is `stop`, never terminate; the instance has API termination
#     protection on; one region, one instance, no fan-out;
#   - `--dry-run` proves nothing about the account's launch gate (`check` uses it
#     for permissions only, and says so).
#
# WHAT IT CREATES (all in REGION, the default VPC, AVAILABILITY_ZONE):
#   key pair         <NAME>            ed25519; the private key goes to SSH_KEY_FILE (0600), never printed
#   security group   <NAME>-origin     in 443 + 80 from anywhere (TLS for the Vercel function, ACME HTTP-01),
#                                      22 from SSH_CIDR only; out 443 + 80 only
#   Elastic IP       <NAME>-origin     the origin's fixed address (the origin name and Caddy's certificate)
#   instance         <NAME>            INSTANCE_TYPE, AMI_ID, encrypted gp3 root, IMDSv2, no public IP of its own
#   data volume      <NAME>-data       encrypted gp3, DATA_VOLUME_GIB, attached as /dev/sdf
# Taking it down at the end of the campaign is by hand, deliberately: docs/deploy/EC2-VERCEL.md.
set -euo pipefail

# Git Bash rewrites arguments that start with "/" (a device name such as /dev/sdf)
# into Windows paths. Off for everything below.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
usage() { sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

ACTION="${1:-}"
[ -n "$ACTION" ] || usage 2
shift || true
PRINT_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --print) PRINT_ONLY=1 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $arg" >&2; usage 2 ;;
  esac
done
case "$ACTION" in -h|--help|help) usage 0 ;; esac

ENV_FILE="${EC2_ENV_FILE:-$HERE/ec2.env}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE - copy ec2.env.example and fill it in" >&2; exit 2; }
set -a
eval "$(tr -d '\r' < "$ENV_FILE")"
set +a

: "${REGION:?REGION is empty in ec2.env}"
: "${NAME:?NAME is empty in ec2.env}"
: "${AVAILABILITY_ZONE:?AVAILABILITY_ZONE is empty in ec2.env}"
: "${INSTANCE_TYPE:=t4g.medium}"
: "${CPU_CREDITS:=unlimited}"
: "${AMI_ID:?AMI_ID is empty in ec2.env}"
: "${ROOT_VOLUME_GIB:=16}"
: "${DATA_VOLUME_GIB:=150}"
: "${SSH_KEY_FILE:=$HOME/.ssh/$NAME.pem}"
: "${SSH_USER:=ec2-user}"
STATE_DIR="$HERE/.out"
STATE_FILE="$STATE_DIR/state.env"

[[ "$NAME" =~ ^[a-z][a-z0-9-]{2,40}$ ]] || { echo "NAME must be lower-case letters, digits and dashes" >&2; exit 2; }
[[ "$AMI_ID" =~ ^ami-[0-9a-f]{8,17}$ ]] || { echo "AMI_ID is not an image id" >&2; exit 2; }
case "$ROOT_VOLUME_GIB$DATA_VOLUME_GIB" in *[!0-9]*) echo "volume sizes are whole GiB" >&2; exit 2 ;; esac
case "$CPU_CREDITS" in unlimited|standard) ;; *) echo "CPU_CREDITS is unlimited or standard" >&2; exit 2 ;; esac

AWS=(aws)
[ -z "${AWS_PROFILE:-}" ] || AWS+=(--profile "$AWS_PROFILE")
AWS+=(--region "$REGION")

log() { printf '[provision] %s\n' "$*" >&2; }
die() { printf '[provision] error: %s\n' "$*" >&2; exit 1; }
show() { { printf '+'; printf ' %q' "$@"; printf '\n'; } >&2; }

# A write: printed, then made - or, with --print, only printed.
WOULD=0
write() {
  show "$@"
  if [ "$PRINT_ONLY" = 1 ]; then WOULD=$((WOULD + 1)); return 0; fi
  "$@"
}
# A read-only call whose answer is needed (also made with --print). The AWS CLI on
# Windows ends its lines with CR LF: the CR is dropped.
read_aws() { show "${AWS[@]}" "$@"; "${AWS[@]}" "$@" | tr -d '\r'; }
none() { [ -z "$1" ] || [ "$1" = None ] || [ "$1" = null ]; }

TAG_FILTERS=(Name=tag:project,Values=valuescan "Name=tag:env,Values=$NAME")
tagspec() {   # resource type, role, Name
  printf 'ResourceType=%s,Tags=[{Key=project,Value=valuescan},{Key=env,Value=%s},{Key=role,Value=%s},{Key=Name,Value=%s}]' "$1" "$NAME" "$2" "$3"
}
one() {   # what, values... -> the one value, or empty; more than one is an error (never guess)
  local what="$1"; shift
  local v=() x
  for x in "$@"; do none "$x" || v+=("$x"); done
  [ "${#v[@]}" -le 1 ] || die "more than one $what is tagged env=$NAME: ${v[*]} - resolve that by hand first"
  printf '%s' "${v[0]:-}"
}

# --- lookups (read-only) ----------------------------------------------------------------

find_instance() {
  # shellcheck disable=SC2046
  one instance $(read_aws ec2 describe-instances --filters "${TAG_FILTERS[@]}" Name=tag:role,Values=instance \
    Name=instance-state-name,Values=pending,running,stopping,stopped \
    --query 'Reservations[].Instances[].InstanceId' --output text)
}
find_volume() {
  # shellcheck disable=SC2046
  one 'data volume' $(read_aws ec2 describe-volumes --filters "${TAG_FILTERS[@]}" Name=tag:role,Values=data \
    --query 'Volumes[].VolumeId' --output text)
}
find_eip() {
  # shellcheck disable=SC2046
  one 'Elastic IP' $(read_aws ec2 describe-addresses --filters "${TAG_FILTERS[@]}" Name=tag:role,Values=origin-ip \
    --query 'Addresses[].AllocationId' --output text)
}
default_vpc() { read_aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text; }
find_sg() {   # vpc
  # shellcheck disable=SC2046
  one 'security group' $(read_aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$1" "Name=group-name,Values=$NAME-origin" \
    --query 'SecurityGroups[].GroupId' --output text)
}
key_exists() {
  local n
  n="$(read_aws ec2 describe-key-pairs --filters "Name=key-name,Values=$NAME" --query 'length(KeyPairs)' --output text)"
  [ "$n" = 1 ]
}
my_cidr() {
  if [ -n "${SSH_CIDR:-}" ]; then printf '%s' "$SSH_CIDR"; return; fi
  local ip
  ip="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '\r\n ')" || die "could not learn this machine's public address - set SSH_CIDR in ec2.env"
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "checkip.amazonaws.com answered something that is not an IPv4 address - set SSH_CIDR"
  printf '%s/32' "$ip"
}
origin_name() {   # public ip -> the origin's DNS name
  if [ -n "${ORIGIN_DOMAIN_NAME:-}" ]; then printf '%s' "$ORIGIN_DOMAIN_NAME"; else printf '%s.sslip.io' "${1//./-}"; fi
}

write_state() {   # instance, allocation, public ip, sg, volume
  mkdir -p "$STATE_DIR"
  {
    echo "# Written by deploy/aws/ec2/provision.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ). Found by tag env=$NAME; no secret."
    echo "INSTANCE_ID=$1"
    echo "ALLOCATION_ID=$2"
    echo "PUBLIC_IP=$3"
    echo "SECURITY_GROUP_ID=$4"
    echo "DATA_VOLUME_ID=$5"
    echo "ORIGIN_NAME=$( [ -n "$3" ] && origin_name "$3" )"
  } > "$STATE_FILE"
  log "state: $STATE_FILE"
}

# --- up -----------------------------------------------------------------------------------
#
# Each ensure_* sets one global (SG_ID, ALLOC_ID, INSTANCE_ID, VOLUME_ID) and runs in
# this shell, not in a $(...) subshell, so --print can count what it would do.

SG_ID=""
ALLOC_ID=""
INSTANCE_ID=""
VOLUME_ID=""

ensure_key() {
  if key_exists; then
    [ -f "$SSH_KEY_FILE" ] || die "the key pair $NAME exists in AWS but $SSH_KEY_FILE is not on this machine. The private key cannot be fetched again; find the file, or decide by hand what to do (this script never deletes a key pair)."
    log "key pair $NAME: exists, private key at $SSH_KEY_FILE"
    return
  fi
  [ ! -e "$SSH_KEY_FILE" ] || die "$SSH_KEY_FILE exists but AWS has no key pair $NAME - move the old file away first (it belongs to something else)"
  log "key pair $NAME: missing - creating it; the private key goes to $SSH_KEY_FILE and is never shown"
  show "${AWS[@]}" ec2 create-key-pair --key-name "$NAME" --key-type ed25519 --key-format pem \
    --tag-specifications "$(tagspec key-pair ssh-key "$NAME")" --query KeyMaterial --output text '>' "$SSH_KEY_FILE"
  if [ "$PRINT_ONLY" = 1 ]; then WOULD=$((WOULD + 1)); return; fi
  mkdir -p "$(dirname "$SSH_KEY_FILE")"
  ( umask 077
    "${AWS[@]}" ec2 create-key-pair --key-name "$NAME" --key-type ed25519 --key-format pem \
      --tag-specifications "$(tagspec key-pair ssh-key "$NAME")" --query KeyMaterial --output text | tr -d '\r' > "$SSH_KEY_FILE" )
  chmod 600 "$SSH_KEY_FILE" 2>/dev/null || true
  # On Windows the mode above is not enforced (NTFS, noacl): narrow the ACL to this user.
  if command -v icacls >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
    icacls "$(cygpath -w "$SSH_KEY_FILE")" /inheritance:r /grant:r "${USERNAME:-$USER}:F" >/dev/null \
      || log "WARNING: could not restrict the key file's ACL - do it by hand (Properties -> Security)"
  fi
  grep -q 'PRIVATE KEY' "$SSH_KEY_FILE" || die "the key file does not hold a private key - check $SSH_KEY_FILE (do not paste it anywhere)"
}

ensure_sg() {   # vpc
  local vpc="$1" cidr c found=0 open
  SG_ID="$(find_sg "$vpc")"
  cidr="$(my_cidr)"
  if [ -n "$SG_ID" ]; then
    log "security group $NAME-origin: exists ($SG_ID)"
    open="$(read_aws ec2 describe-security-groups --group-ids "$SG_ID" \
      --query "SecurityGroups[0].IpPermissions[?FromPort==\`22\`].IpRanges[].CidrIp" --output text)"
    for c in $open; do [ "$c" = "$cidr" ] && found=1; done
    [ "$found" = 1 ] || log "port 22 is not open to this machine ($cidr): run deploy/aws/ec2/provision.sh allow-ssh"
    return
  fi
  log "security group $NAME-origin: missing - creating it"
  local create=("${AWS[@]}" ec2 create-security-group --vpc-id "$vpc" --group-name "$NAME-origin"
    --description "Valuescan $NAME origin - 443 and 80 (ACME) open, 22 from the deploying machine"
    --tag-specifications "$(tagspec security-group origin-sg "$NAME-origin")" --query GroupId --output text)
  if [ "$PRINT_ONLY" = 1 ]; then write "${create[@]}"; SG_ID='<new-security-group>'
  else SG_ID="$(write "${create[@]}" | tr -d '\r')"; fi
  # Out: only what the reviewed network.yaml allows (443: exchanges, npm, ACME,
  # package mirrors; 80: package mirrors, OCSP). The new group's allow-all rule goes.
  write "${AWS[@]}" ec2 revoke-security-group-egress --group-id "$SG_ID" \
    --ip-permissions 'IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null
  write "${AWS[@]}" ec2 authorize-security-group-egress --group-id "$SG_ID" --ip-permissions \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description=HTTPS and WSS to exchanges npm ACME packages}]' \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description=HTTP to package mirrors and OCSP}]' >/dev/null
  write "${AWS[@]}" ec2 authorize-security-group-ingress --group-id "$SG_ID" --ip-permissions \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description=TLS for the edge - Caddy refuses requests without the origin secret}]' \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description=ACME HTTP-01 and the redirect to HTTPS}]' \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$cidr,Description=SSH from the deploying machine}]" >/dev/null
}

ensure_eip() {
  ALLOC_ID="$(find_eip)"
  if [ -n "$ALLOC_ID" ]; then log "Elastic IP: exists ($ALLOC_ID)"; return; fi
  log "Elastic IP: missing - allocating one (0.005 USD an hour, running or stopped)"
  local alloc=("${AWS[@]}" ec2 allocate-address --domain vpc --tag-specifications "$(tagspec elastic-ip origin-ip "$NAME-origin")"
    --query AllocationId --output text)
  if [ "$PRINT_ONLY" = 1 ]; then write "${alloc[@]}"; ALLOC_ID='<new-allocation>'
  else ALLOC_ID="$(write "${alloc[@]}" | tr -d '\r')"; fi
}

ensure_instance() {
  local subnet arch info image type state
  INSTANCE_ID="$(find_instance)"
  if [ -n "$INSTANCE_ID" ]; then
    info="$(read_aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].[ImageId,InstanceType,State.Name]' --output text)"
    read -r image type state <<< "$info"
    log "instance $NAME: exists ($INSTANCE_ID, $type, $state)"
    [ "$image" = "$AMI_ID" ] || log "NOTE: it runs $image, ec2.env says $AMI_ID. Nothing is replaced; set AMI_ID in ec2.env to what runs."
    [ "$type" = "$INSTANCE_TYPE" ] || log "NOTE: it is a $type, ec2.env says $INSTANCE_TYPE. A type change is stop, modify-instance-attribute, start - by hand (docs/deploy/EC2-VERCEL.md)."
    return
  fi
  subnet="$(read_aws ec2 describe-subnets --filters Name=default-for-az,Values=true "Name=availability-zone,Values=$AVAILABILITY_ZONE" \
    --query 'Subnets[0].SubnetId' --output text)"
  none "$subnet" && die "the default VPC has no default subnet in $AVAILABILITY_ZONE"
  arch="$(read_aws ec2 describe-images --image-ids "$AMI_ID" --query 'Images[0].Architecture' --output text)"
  none "$arch" && die "$AMI_ID does not exist in $REGION"
  log "instance $NAME: missing - launching it ($arch). THIS IS THE ONE LAUNCH OF THIS ENVIRONMENT."
  log "  If the account may not launch instances it fails here: do not retry in a loop, ask AWS Support."
  local launch=("${AWS[@]}" ec2 run-instances --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" --count 1
    --key-name "$NAME" --subnet-id "$subnet" --security-group-ids "$SG_ID" --no-associate-public-ip-address
    --credit-specification "CpuCredits=$CPU_CREDITS"
    --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":$ROOT_VOLUME_GIB,\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":true}}]"
    --disable-api-termination --instance-initiated-shutdown-behavior stop
    --tag-specifications "$(tagspec instance instance "$NAME")" "$(tagspec volume root "$NAME-root")"
    --client-token "$NAME-instance-1"
    --query 'Instances[0].InstanceId' --output text)
  # --client-token: the same token twice is the same launch - AWS answers with the
  # instance it already made instead of making another.
  if [ "$PRINT_ONLY" = 1 ]; then write "${launch[@]}"; INSTANCE_ID='<new-instance>'; return; fi
  INSTANCE_ID="$(write "${launch[@]}" | tr -d '\r')"
  [[ "$INSTANCE_ID" =~ ^i-[0-9a-f]+$ ]] || die "the launch did not return an instance id"
  write "${AWS[@]}" ec2 wait instance-running --instance-ids "$INSTANCE_ID"
}

ensure_volume() {
  local size attached=""
  VOLUME_ID="$(find_volume)"
  if [ -z "$VOLUME_ID" ]; then
    log "data volume $NAME-data: missing - creating it ($DATA_VOLUME_GIB GiB gp3, encrypted)"
    local create=("${AWS[@]}" ec2 create-volume --availability-zone "$AVAILABILITY_ZONE" --size "$DATA_VOLUME_GIB" --volume-type gp3
      --encrypted --tag-specifications "$(tagspec volume data "$NAME-data")" --client-token "$NAME-data-1"
      --query VolumeId --output text)
    if [ "$PRINT_ONLY" = 1 ]; then write "${create[@]}"; VOLUME_ID='<new-volume>'
    else
      VOLUME_ID="$(write "${create[@]}" | tr -d '\r')"
      write "${AWS[@]}" ec2 wait volume-available --volume-ids "$VOLUME_ID"
    fi
  else
    size="$(read_aws ec2 describe-volumes --volume-ids "$VOLUME_ID" --query 'Volumes[0].Size' --output text)"
    log "data volume $NAME-data: exists ($VOLUME_ID, $size GiB)"
    [ "$size" -ge "$DATA_VOLUME_GIB" ] || log "NOTE: ec2.env asks for $DATA_VOLUME_GIB GiB: deploy/aws/ec2/provision.sh grow"
  fi
  if [[ "$VOLUME_ID" == vol-* ]]; then
    attached="$(read_aws ec2 describe-volumes --volume-ids "$VOLUME_ID" --query 'Volumes[0].Attachments[0].InstanceId' --output text)"
    none "$attached" && attached=""
  fi
  if [ -z "$attached" ]; then
    log "attaching the data volume to the instance as /dev/sdf"
    write "${AWS[@]}" ec2 attach-volume --volume-id "$VOLUME_ID" --instance-id "$INSTANCE_ID" --device /dev/sdf >/dev/null
    [ "$PRINT_ONLY" = 1 ] || write "${AWS[@]}" ec2 wait volume-in-use --volume-ids "$VOLUME_ID"
  elif [ "$attached" != "$INSTANCE_ID" ]; then
    die "the data volume $VOLUME_ID is attached to $attached, not to $INSTANCE_ID - resolve that by hand"
  fi
}

ensure_association() {
  local current=""
  if [[ "$ALLOC_ID" == eipalloc-* ]]; then
    current="$(read_aws ec2 describe-addresses --allocation-ids "$ALLOC_ID" --query 'Addresses[0].InstanceId' --output text)"
    none "$current" && current=""
  fi
  if [ -z "$current" ]; then
    log "associating the Elastic IP with the instance"
    write "${AWS[@]}" ec2 associate-address --allocation-id "$ALLOC_ID" --instance-id "$INSTANCE_ID" >/dev/null
  elif [ "$current" != "$INSTANCE_ID" ]; then
    die "the Elastic IP $ALLOC_ID is associated with $current, not $INSTANCE_ID - resolve that by hand"
  fi
}

cmd_up() {
  local vpc ip
  vpc="$(default_vpc)"
  none "$vpc" && die "$REGION has no default VPC"
  ensure_key
  ensure_sg "$vpc"
  ensure_eip
  ensure_instance
  ensure_volume
  ensure_association
  if [ "$PRINT_ONLY" = 1 ]; then
    echo >&2
    if [ "$WOULD" = 0 ]; then log "--print: everything exists; up would change nothing."
    else log "--print: the $WOULD write(s) above would be made. Nothing was changed."; fi
    return
  fi
  ip="$(read_aws ec2 describe-addresses --allocation-ids "$ALLOC_ID" --query 'Addresses[0].PublicIp' --output text)"
  write_state "$INSTANCE_ID" "$ALLOC_ID" "$ip" "$SG_ID" "$VOLUME_ID"
  echo >&2
  log "the environment is up."
  log "  instance  $INSTANCE_ID ($INSTANCE_TYPE, $AVAILABILITY_ZONE)"
  log "  address   $ip    origin name: $(origin_name "$ip")"
  log "  data      $VOLUME_ID as /dev/sdf - bootstrap.sh formats it only if it is blank"
  log "next: deploy/release/bootstrap-instance.sh   (it reaches the instance over SSH as $SSH_USER)"
}

# --- status, stop, start --------------------------------------------------------------------

cmd_status() {
  local inst vol alloc vpc sg ip="" state="-"
  inst="$(find_instance)"; vol="$(find_volume)"; alloc="$(find_eip)"
  vpc="$(default_vpc)"; sg="$(none "$vpc" || find_sg "$vpc")"
  [ -z "$inst" ] || state="$(read_aws ec2 describe-instances --instance-ids "$inst" --query 'Reservations[0].Instances[0].[State.Name,InstanceType,ImageId]' --output text)"
  [ -z "$alloc" ] || ip="$(read_aws ec2 describe-addresses --allocation-ids "$alloc" --query 'Addresses[0].PublicIp' --output text)"
  echo "environment  $NAME ($REGION, $AVAILABILITY_ZONE)"
  echo "key pair     $(key_exists && echo "$NAME" || echo missing)    private key: $([ -f "$SSH_KEY_FILE" ] && echo "$SSH_KEY_FILE" || echo 'not on this machine')"
  echo "sec. group   ${sg:-missing}"
  echo "instance     ${inst:-missing}    ${state//	/ }"
  echo "data volume  ${vol:-missing}"
  echo "elastic ip   ${alloc:-missing}    ${ip:-}"
  [ -z "$ip" ] || echo "origin name  $(origin_name "$ip")"
  if [ -n "$vol" ]; then
    echo "snapshots of the data volume (newest last):"
    read_aws ec2 describe-snapshots --owner-ids self --filters "${TAG_FILTERS[@]}" Name=tag:role,Values=data-snapshot \
      --query 'sort_by(Snapshots,&StartTime)[].[StartTime,SnapshotId,VolumeSize,State]' --output text | sed 's/^/  /'
  fi
  if [ -n "$inst" ] && [ -n "$alloc" ]; then write_state "$inst" "$alloc" "$ip" "$sg" "$vol"; fi
}

cmd_power() {   # stop | start
  local inst
  inst="$(find_instance)"
  [ -n "$inst" ] || die "there is no instance tagged env=$NAME"
  if [ "$1" = stop ]; then
    log "stopping $inst: nothing is deleted. Billed while stopped: the volumes and the Elastic IP."
    write "${AWS[@]}" ec2 stop-instances --instance-ids "$inst" >/dev/null
    [ "$PRINT_ONLY" = 1 ] || write "${AWS[@]}" ec2 wait instance-stopped --instance-ids "$inst"
  else
    log "starting $inst: the units start by themselves; the indexer re-reads the gap"
    write "${AWS[@]}" ec2 start-instances --instance-ids "$inst" >/dev/null
    [ "$PRINT_ONLY" = 1 ] || write "${AWS[@]}" ec2 wait instance-running --instance-ids "$inst"
  fi
  [ "$PRINT_ONLY" = 1 ] || log "now: $(read_aws ec2 describe-instances --instance-ids "$inst" --query 'Reservations[0].Instances[0].State.Name' --output text)"
}

# --- allow-ssh, snapshot, grow ----------------------------------------------------------------

cmd_allow_ssh() {
  local vpc sg cidr open c
  vpc="$(default_vpc)"; sg="$(find_sg "$vpc")"
  [ -n "$sg" ] || die "there is no security group $NAME-origin yet: provision.sh up"
  cidr="$(my_cidr)"
  open="$(read_aws ec2 describe-security-groups --group-ids "$sg" \
    --query "SecurityGroups[0].IpPermissions[?FromPort==\`22\`].IpRanges[].CidrIp" --output text)"
  local found=0
  for c in $open; do [ "$c" = "$cidr" ] && found=1; done
  if [ "$found" = 0 ]; then
    write "${AWS[@]}" ec2 authorize-security-group-ingress --group-id "$sg" --ip-permissions \
      "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$cidr,Description=SSH from the deploying machine}]" >/dev/null
  else
    log "port 22 is already open to $cidr"
  fi
  # Port 22 is for the deploying machine only: an address it no longer has is closed.
  for c in $open; do
    [ "$c" = "$cidr" ] && continue
    log "closing port 22 to $c (not this machine's address any more)"
    write "${AWS[@]}" ec2 revoke-security-group-ingress --group-id "$sg" --ip-permissions \
      "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$c}]" >/dev/null
  done
}

cmd_snapshot() {
  local vol stamp
  vol="$(find_volume)"
  [ -n "$vol" ] || die "there is no data volume tagged env=$NAME"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  log "snapshot of $vol. It is crash-consistent, which SQLite in WAL mode recovers from like a power cut;"
  log "  it also carries the newest nightly backup (/var/lib/valuescan/backup/archive), a consistent copy."
  log "  Snapshots are never deleted by this script: 0.054 USD per GB-month of changed blocks."
  write "${AWS[@]}" ec2 create-snapshot --volume-id "$vol" --description "valuescan $NAME data volume $stamp" \
    --tag-specifications "$(tagspec snapshot data-snapshot "$NAME-data-$stamp")" --query SnapshotId --output text
}

cmd_grow() {
  local vol size
  vol="$(find_volume)"
  [ -n "$vol" ] || die "there is no data volume tagged env=$NAME"
  size="$(read_aws ec2 describe-volumes --volume-ids "$vol" --query 'Volumes[0].Size' --output text)"
  if [ "$size" -ge "$DATA_VOLUME_GIB" ]; then log "the data volume is $size GiB already (ec2.env: $DATA_VOLUME_GIB)"; return; fi
  log "growing $vol from $size to $DATA_VOLUME_GIB GiB, online. A volume can only grow, and once per 6 hours."
  write "${AWS[@]}" ec2 modify-volume --volume-id "$vol" --size "$DATA_VOLUME_GIB" >/dev/null
  log "then, when the modification is 'optimizing' or 'completed', grow the filesystem:"
  log "  deploy/release/remote.sh run 'xfs_growfs /var/lib/valuescan'"
}

# --- check: what may this profile do? ----------------------------------------------------------

cmd_check() {
  log "read-only lookups and DRY RUNS: nothing is created. A dry run tests the permission only -"
  log "it does not prove that the account may launch an instance (AWS's own gate)."
  local vpc sg inst vol alloc
  vpc="$(default_vpc)"; none "$vpc" && die "$REGION has no default VPC"
  sg="$(find_sg "$vpc")"; inst="$(find_instance)"; vol="$(find_volume)"; alloc="$(find_eip)"
  try() {   # label, args...
    local label="$1"; shift
    local out
    show "${AWS[@]}" "$@"
    out="$("${AWS[@]}" "$@" 2>&1 || true)"
    case "$out" in
      *DryRunOperation*) printf '  %-34s allowed\n' "$label" ;;
      *UnauthorizedOperation*|*AccessDenied*) printf '  %-34s DENIED\n' "$label" ;;
      *) printf '  %-34s not conclusive: %s\n' "$label" "$(printf '%s' "$out" | tr -d '\r' | head -n 1 | cut -c1-120)" ;;
    esac
  }
  try create-key-pair ec2 create-key-pair --dry-run --key-name "$NAME-permission-check" --key-type ed25519
  try create-security-group ec2 create-security-group --dry-run --vpc-id "$vpc" --group-name "$NAME-permission-check" --description check
  try allocate-address ec2 allocate-address --dry-run --domain vpc
  try create-volume ec2 create-volume --dry-run --availability-zone "$AVAILABILITY_ZONE" --size 1 --volume-type gp3 --encrypted
  if [ -n "$sg" ]; then
    try run-instances ec2 run-instances --dry-run --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" --subnet-id \
      "$(read_aws ec2 describe-subnets --filters Name=default-for-az,Values=true "Name=availability-zone,Values=$AVAILABILITY_ZONE" --query 'Subnets[0].SubnetId' --output text)" \
      --security-group-ids "$sg" --no-associate-public-ip-address
    try authorize-security-group-ingress ec2 authorize-security-group-ingress --dry-run --group-id "$sg" --protocol tcp --port 22 --cidr 192.0.2.1/32
    try revoke-security-group-ingress ec2 revoke-security-group-ingress --dry-run --group-id "$sg" --protocol tcp --port 22 --cidr 192.0.2.1/32
  else
    echo "  (security group, run-instances, rules: checkable once the security group exists)"
  fi
  if [ -n "$inst" ]; then
    try stop-instances ec2 stop-instances --dry-run --instance-ids "$inst"
    try start-instances ec2 start-instances --dry-run --instance-ids "$inst"
  fi
  if [ -n "$vol" ]; then
    try create-snapshot ec2 create-snapshot --dry-run --volume-id "$vol"
    try modify-volume ec2 modify-volume --dry-run --volume-id "$vol" --size "$DATA_VOLUME_GIB"
    [ -z "$inst" ] || try attach-volume ec2 attach-volume --dry-run --volume-id "$vol" --instance-id "$inst" --device /dev/sdf
  fi
  [ -z "$alloc" ] || [ -z "$inst" ] || try associate-address ec2 associate-address --dry-run --allocation-id "$alloc" --instance-id "$inst"
}

case "$ACTION" in
  up) cmd_up ;;
  status) cmd_status ;;
  stop|start) cmd_power "$ACTION" ;;
  allow-ssh) cmd_allow_ssh ;;
  snapshot) cmd_snapshot ;;
  grow) cmd_grow ;;
  check) cmd_check ;;
  *) usage 2 ;;
esac
