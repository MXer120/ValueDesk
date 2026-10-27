#!/usr/bin/env bash
# Deploy the ValueDesk CloudFormation stacks. Run it yourself, from any shell with
# bash and AWS CLI v2 (Git Bash on Windows works). See deploy/aws/README.md.
#
#   deploy/aws/deploy.sh validate              validate-template for all three (read-only)
#   deploy/aws/deploy.sh secret    --execute   create the origin secret in SSM, once     (REGION)
#   deploy/aws/deploy.sh secret --rotate --execute   a NEXT value beside it (a gapless rotation, DEPLOY.md 15)
#   deploy/aws/deploy.sh edge   --rotate --execute   CloudFront sends the next value
#   deploy/aws/deploy.sh secret --finish --execute   the next value becomes the only one
#   deploy/aws/deploy.sh network  [--execute]  VPC, subnet, security group, ops bucket   (REGION)
#   deploy/aws/deploy.sh compute  [--execute]  the instance, its volume, EIP, DNS        (REGION)
#   deploy/aws/deploy.sh edge     [--execute]  site bucket, CloudFront, cert, WAF, DNS   (us-east-1)
#   deploy/aws/deploy.sh stop     [--execute]  stop the instance  (nothing is deleted)
#   deploy/aws/deploy.sh start    [--execute]  start it again
#   deploy/aws/deploy.sh status                stack states and outputs
#
# WITHOUT --execute a change set is created for you to read, and nothing changes.
# WITH --execute the change set is applied.
#
#   --print     show the AWS commands and run none of them (no AWS call at all)
#
# Values come from deploy/aws/params.env (copy params.env.example). The origin
# secret is read from SSM Parameter Store at deploy time and never stored here.
set -euo pipefail

# Git Bash rewrites arguments that start with "/" into Windows paths; SSM parameter
# names and CloudFront paths start with "/". Switch that off for everything below,
# and use relative file names only.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

ACTION="${1:-}"
[ -n "$ACTION" ] || usage 2
shift || true
EXECUTE=0
PRINT_ONLY=0
ROTATE=0
FINISH=0
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    --print) PRINT_ONLY=1 ;;
    --rotate) ROTATE=1 ;;
    --finish) FINISH=1 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $arg" >&2; usage 2 ;;
  esac
done

PARAMS_FILE="${PARAMS_FILE:-params.env}"
if [ ! -f "$PARAMS_FILE" ]; then
  echo "missing $HERE/$PARAMS_FILE - copy params.env.example and fill it in" >&2
  exit 2
fi
# Carriage returns are dropped: a file saved with Windows line endings must not
# leave a "\r" at the end of every value.
set -a
eval "$(tr -d '\r' < "$PARAMS_FILE")"
set +a

: "${STACK_PREFIX:=valuescan}"
: "${CONFIG_PREFIX:=/valuescan/prod}"
: "${INSTANCE_TYPE:=t4g.large}"
: "${CPU_CREDITS:=unlimited}"
: "${DATA_VOLUME_SIZE_GIB:=40}"
: "${PRICE_CLASS:=PriceClass_All}"
: "${ENABLE_WAF:=true}"
: "${GEO_RESTRICTION_TYPE:=none}"
EDGE_REGION=us-east-1
NETWORK_STACK="$STACK_PREFIX-network"
COMPUTE_STACK="$STACK_PREFIX-compute"
EDGE_STACK="$STACK_PREFIX-edge"

die() { echo "error: $*" >&2; exit 1; }

require() {
  local name
  for name in "$@"; do
    local value="${!name:-}"
    [ -n "$value" ] || die "$name is empty in $PARAMS_FILE"
    case "$value" in *__*) die "$name still holds a placeholder ($value) in $PARAMS_FILE" ;; esac
  done
}

command -v aws >/dev/null 2>&1 || [ "$PRINT_ONLY" = 1 ] || die "AWS CLI v2 is not on PATH"

# Print a command, then run it (unless --print).
run() {
  printf '+'; printf ' %q' "$@"; printf '\n'
  [ "$PRINT_ONLY" = 1 ] || "$@"
}

# A read-only lookup whose output is needed. With --print: a placeholder.
lookup() {
  local placeholder="$1"; shift
  { printf '+'; printf ' %q' "$@"; printf '\n'; } >&2
  if [ "$PRINT_ONLY" = 1 ]; then printf '%s' "$placeholder"; else "$@"; fi
}

# Does the stack have resources and previous parameter values? A stack that only
# holds an unexecuted change set (REVIEW_IN_PROGRESS, after a first run without
# --execute) has neither, and counts as not existing.
stack_exists() {
  [ "$PRINT_ONLY" = 1 ] && return 1
  local status
  status="$(aws cloudformation describe-stacks --region "$2" --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null)" || return 1
  [ -n "$status" ] && [ "$status" != None ] && [ "$status" != REVIEW_IN_PROGRESS ]
}

# cloudformation deploy, as a change set only unless --execute.
deploy_stack() {
  local stack="$1" region="$2" template="$3"; shift 3
  local mode=(--no-execute-changeset)
  [ "$EXECUTE" = 1 ] && mode=()
  run aws cloudformation deploy \
    --region "$region" --stack-name "$stack" --template-file "$template" \
    --no-fail-on-empty-changeset --tags "project=$STACK_PREFIX" \
    ${mode[@]+"${mode[@]}"} "$@"
  if [ "$EXECUTE" = 1 ]; then
    # An accidental "delete-stack" must not take the environment with it.
    run aws cloudformation update-termination-protection --region "$region" --stack-name "$stack" --enable-termination-protection
  elif [ "$PRINT_ONLY" = 1 ]; then
    echo
    echo "--print: nothing was run."
  else
    echo
    echo "A change set was created and NOT executed. Read it (the command is printed above),"
    echo "then run the same command with --execute."
  fi
}

case "$ACTION" in
  validate)
    require REGION
    for t in network compute edge; do
      region="$REGION"; [ "$t" = edge ] && region="$EDGE_REGION"
      run aws cloudformation validate-template --region "$region" --template-body "file://$t.yaml" --query 'Description' --output text
    done
    ;;

  network)
    require REGION
    prefix_list="${CLOUDFRONT_PREFIX_LIST_ID:-}"
    if [ -z "$prefix_list" ]; then
      prefix_list="$(lookup '<pl-id>' aws ec2 describe-managed-prefix-lists --region "$REGION" \
        --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
        --query 'PrefixLists[0].PrefixListId' --output text)"
    fi
    case "$prefix_list" in pl-*|'<pl-id>') ;; *) die "could not resolve the CloudFront origin-facing prefix list in $REGION (got: $prefix_list)" ;; esac
    deploy_stack "$NETWORK_STACK" "$REGION" network.yaml \
      --parameter-overrides \
        "CloudFrontOriginPrefixListId=$prefix_list" \
        "AvailabilityZone=${AVAILABILITY_ZONE:-}"
    ;;

  compute)
    require REGION ORIGIN_DOMAIN_NAME
    overrides=(
      "NetworkStackName=$NETWORK_STACK"
      "InstanceType=$INSTANCE_TYPE"
      "CpuCredits=$CPU_CREDITS"
      "DataVolumeSizeGiB=$DATA_VOLUME_SIZE_GIB"
      "OriginDomainName=$ORIGIN_DOMAIN_NAME"
      "HostedZoneId=${HOSTED_ZONE_ID:-}"
      "ConfigPrefix=$CONFIG_PREFIX"
      "AlertEmail=${ALERT_EMAIL:-}"
    )
    if stack_exists "$COMPUTE_STACK" "$REGION"; then
      # The image stays what it was: a different id would REPLACE the instance.
      if [ -n "${AMI_ID:-}" ]; then overrides+=("AmiId=$AMI_ID"); fi
    else
      ami="${AMI_ID:-}"
      if [ -z "$ami" ]; then
        ami="$(lookup '<ami-id>' aws ssm get-parameter --region "$REGION" \
          --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
          --query 'Parameter.Value' --output text)"
        echo "Amazon Linux 2023 arm64 in $REGION is $ami - put AMI_ID=$ami into $PARAMS_FILE now and keep it." >&2
      fi
      overrides+=("AmiId=$ami")
      echo "NOTE: this creates the instance - the one RunInstances of this environment." >&2
      echo "      If the account cannot launch instances the stack rolls back; do not retry in a loop." >&2
    fi
    deploy_stack "$COMPUTE_STACK" "$REGION" compute.yaml --capabilities CAPABILITY_IAM --parameter-overrides "${overrides[@]}"
    ;;

  stop|start)
    require REGION
    state=running; [ "$ACTION" = stop ] && state=stopped
    # Every other parameter keeps its previous value.
    deploy_stack "$COMPUTE_STACK" "$REGION" compute.yaml --capabilities CAPABILITY_IAM --parameter-overrides "DesiredState=$state"
    ;;

  edge)
    require REGION DOMAIN_NAME ORIGIN_DOMAIN_NAME
    command -v node >/dev/null 2>&1 || die "node is needed to write the parameter file"
    # CloudFront sends the current value - or, with --rotate, the next one, which the
    # instance accepts once bootstrap-instance.sh has run after `secret --rotate`.
    secret_name="$CONFIG_PREFIX/origin-secret"
    [ "$ROTATE" = 1 ] && secret_name="$CONFIG_PREFIX/origin-secret-next"
    secret="$(lookup '<origin-secret>' aws ssm get-parameter --region "$REGION" --name "$secret_name" \
      --with-decryption --query 'Parameter.Value' --output text)" \
      || die "could not read $secret_name$([ "$ROTATE" = 1 ] && echo ' - start the rotation with: deploy.sh secret --rotate --execute')"
    [ "${#secret}" -ge 32 ] || [ "$PRINT_ONLY" = 1 ] || die "$secret_name must be at least 32 characters"
    # The secret goes through a 0600 file, not through the command line.
    mkdir -p .out
    params_json=".out/edge-params.$$.json"
    trap 'rm -f "$HERE/$params_json"' EXIT
    ( umask 077
      DOMAIN_NAME="$DOMAIN_NAME" HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}" ORIGIN_DOMAIN_NAME="$ORIGIN_DOMAIN_NAME" \
      ORIGIN_SECRET="$secret" PRICE_CLASS="$PRICE_CLASS" ENABLE_WAF="$ENABLE_WAF" WAF_RATE="${WAF_API_RATE_LIMIT:-2000}" \
      GEO_TYPE="$GEO_RESTRICTION_TYPE" GEO_COUNTRIES="${GEO_RESTRICTION_COUNTRIES:-}" \
      node -e '
        const e = process.env;
        const p = {
          DomainName: e.DOMAIN_NAME, HostedZoneId: e.HOSTED_ZONE_ID, ApiOriginDomainName: e.ORIGIN_DOMAIN_NAME,
          OriginVerifySecret: e.ORIGIN_SECRET, PriceClass: e.PRICE_CLASS, EnableWaf: e.ENABLE_WAF, WafApiRateLimit: e.WAF_RATE,
          GeoRestrictionType: e.GEO_TYPE, GeoRestrictionCountries: e.GEO_COUNTRIES,
        };
        process.stdout.write(JSON.stringify(Object.entries(p).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }))));
      ' > "$params_json"
    )
    deploy_stack "$EDGE_STACK" "$EDGE_REGION" edge.yaml --parameter-overrides "file://$params_json"
    ;;

  secret)
    # The origin secret lives in SSM Parameter Store: <CONFIG_PREFIX>/origin-secret, and
    # <CONFIG_PREFIX>/origin-secret-next while it is rotated. Values are generated here
    # (64 random hex characters), go to SSM through a 0600 file and are never printed.
    #
    #   secret --execute            create origin-secret; fails if it exists
    #   secret --rotate --execute   create origin-secret-next; fails if a rotation is under way.
    #                               The instance accepts both after bootstrap-instance.sh.
    #   secret --finish --execute   origin-secret := origin-secret-next, then -next is deleted.
    #                               Refused unless CloudFront already sends the next value.
    #
    # The whole rotation, without a moment where the edge and the instance disagree
    # (docs/deploy/DEPLOY.md, "Rotating the origin secret"):
    #   secret --rotate --execute; bootstrap-instance.sh; edge --rotate --execute;
    #   secret --finish --execute; bootstrap-instance.sh
    require REGION
    command -v node >/dev/null 2>&1 || die "node is needed to generate the secret"
    if [ "$EXECUTE" != 1 ] && [ "$PRINT_ONLY" != 1 ]; then
      die "this writes to SSM Parameter Store: add --execute"
    fi
    [ "$ROTATE" = 1 ] && [ "$FINISH" = 1 ] && die "--rotate or --finish, not both"
    mkdir -p .out
    secret_json=".out/origin-secret.$$.json"
    trap 'rm -f "$HERE/$secret_json"' EXIT
    current="$CONFIG_PREFIX/origin-secret"
    next="$CONFIG_PREFIX/origin-secret-next"

    if [ "$FINISH" = 1 ]; then
      value="$(lookup '<next-value>' aws ssm get-parameter --region "$REGION" --name "$next" --with-decryption \
        --query 'Parameter.Value' --output text)" || die "there is no rotation under way ($next does not exist)"
      # CloudFront must already send the next value, or the instance - once it accepts
      # only that value - would refuse the edge. Compared here, never printed.
      dist="$(lookup '<distribution-id>' aws cloudformation describe-stacks --region "$EDGE_REGION" --stack-name "$EDGE_STACK" \
        --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue | [0]" --output text)"
      sent="$(lookup '<sent-value>' aws cloudfront get-distribution-config --id "$dist" \
        --query "DistributionConfig.Origins.Items[?Id=='api'].CustomHeaders.Items[?HeaderName=='X-Origin-Verify'].HeaderValue | [0] | [0]" --output text)"
      if [ "$PRINT_ONLY" != 1 ] && [ "$sent" != "$value" ]; then
        die "CloudFront does not send the next value yet: deploy/aws/deploy.sh edge --rotate --execute first (and let it finish)"
      fi
      ( umask 077
        NAME="$current" VALUE="$value" node -e '
          process.stdout.write(JSON.stringify({
            Name: process.env.NAME, Type: "SecureString", Value: process.env.VALUE, Overwrite: true,
            Description: "Valuescan: X-Origin-Verify shared by CloudFront and the origin",
          }));
        ' > "$secret_json"
      )
      run aws ssm put-parameter --region "$REGION" --cli-input-json "file://$secret_json" --query 'Version' --output text
      run aws ssm delete-parameter --region "$REGION" --name "$next"
      echo
      echo "origin-secret now holds the new value; the next one is gone. Last step:"
      echo "  deploy/release/bootstrap-instance.sh       # the instance accepts only the new value"
      exit 0
    fi

    name="$current"
    [ "$ROTATE" = 1 ] && name="$next"
    ( umask 077
      NAME="$name" node -e '
        const value = require("node:crypto").randomBytes(32).toString("hex");
        process.stdout.write(JSON.stringify({
          Name: process.env.NAME, Type: "SecureString", Value: value, Overwrite: false,
          Description: "Valuescan: X-Origin-Verify shared by CloudFront and the origin",
        }));
      ' > "$secret_json"
    )
    run aws ssm put-parameter --region "$REGION" --cli-input-json "file://$secret_json" --query 'Version' --output text
    if [ "$ROTATE" = 1 ]; then
      echo
      echo "The next value is in SSM beside the current one; nothing uses it yet. Now, in this order"
      echo "(docs/deploy/DEPLOY.md, \"Rotating the origin secret\"):"
      echo "  deploy/release/bootstrap-instance.sh             # the instance accepts both values (the API restarts, seconds)"
      echo "  deploy/aws/deploy.sh edge --rotate --execute     # CloudFront sends the next value (several minutes)"
      echo "  deploy/aws/deploy.sh secret --finish --execute   # the next value becomes the only one in SSM"
      echo "  deploy/release/bootstrap-instance.sh             # the instance accepts only the new value"
    fi
    ;;

  status)
    require REGION
    for pair in "$NETWORK_STACK:$REGION" "$COMPUTE_STACK:$REGION" "$EDGE_STACK:$EDGE_REGION"; do
      run aws cloudformation describe-stacks --region "${pair##*:}" --stack-name "${pair%%:*}" \
        --query 'Stacks[0].{Stack:StackName,Status:StackStatus,Outputs:Outputs[].{Key:OutputKey,Value:OutputValue}}' --output yaml || true
    done
    ;;

  *) usage 2 ;;
esac
