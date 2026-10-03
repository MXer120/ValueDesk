#!/usr/bin/env bash
# Set up (or re-converge) the instance: put deploy/server on it and run its
# bootstrap.sh there.
#
#   deploy/release/bootstrap-instance.sh           run it
#   deploy/release/bootstrap-instance.sh --print   show the AWS / SSH commands, run none
#
# Run it once after the instance exists, and again whenever deploy/server changes
# (a unit, an env template, a pinned version) or the origin secret changes. It is
# idempotent, never restarts a running indexer, and prints what still needs a
# restart.
#
# Two environments (deploy/release/lib.sh, "which environment"):
#   cfn  the CloudFormation instance: deploy/server goes through the ops bucket, the
#        command through SSM Run Command, the origin secret comes from SSM Parameter
#        Store (deploy/aws/deploy.sh secret --execute first).
#   ec2  the EC2 test instance (deploy/aws/ec2/provision.sh): no instance role, so
#        everything goes over SSH. The origin secret is generated HERE on the first
#        run, into <ORIGIN_SECRET_DIR>/origin-secret (0600, never printed, never in
#        git), and copied to a root-only file on the instance through stdin. The same
#        value goes into the Vercel project (docs/deploy/EC2-VERCEL.md).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

for arg in "$@"; do
  case "$arg" in
    --print) PRINT_ONLY=1 ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $arg" ;;
  esac
done
load_params
[ -n "${DOMAIN_NAME:-}" ] && [ -n "${ORIGIN_DOMAIN_NAME:-}" ] || die "the site and the origin name must be set (DOMAIN_NAME / ORIGIN_DOMAIN_NAME in params.env, SITE_DOMAIN in ec2.env)"
case "$DOMAIN_NAME$ORIGIN_DOMAIN_NAME" in *__*) die "DOMAIN_NAME / ORIGIN_DOMAIN_NAME still hold a placeholder" ;; esac

# The instance runs these files exactly as they are uploaded. A carriage return (a
# checkout with Windows line endings) breaks every one of them: the scripts, the
# units, the environment files.
command -v node >/dev/null 2>&1 || die "node is needed (it also writes the SSM command file and the secret)"
# (node, not grep: grep on Windows drops the carriage return from the pattern and then matches everything.)
crlf="$(node -e '
  const fs = require("fs"), path = require("path");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk("deploy/server")) if (fs.readFileSync(f).includes(13)) console.log(f.split(path.sep).join("/"));
')"
if [ -n "$crlf" ]; then
  printf '%s\n' "$crlf" >&2
  die "the files above have Windows line endings (CRLF). Convert them to LF - the repository's .gitattributes asks for LF, so a fresh checkout has it - and run this again"
fi

if [ "$VS_TARGET" = ec2 ]; then
  # --- the EC2 test instance, over SSH ---------------------------------------------------------
  REMOTE_SECRET=/root/.valuescan/origin-secret
  secret_file="$ORIGIN_SECRET_DIR/origin-secret"
  if [ ! -f "$secret_file" ] && [ "$PRINT_ONLY" != 1 ]; then
    note "no origin secret yet: generating one into $secret_file (64 hex characters; not shown)"
    mkdir -p "$ORIGIN_SECRET_DIR"
    ( umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$secret_file" )
    chmod 600 "$secret_file" 2>/dev/null || true
    if command -v icacls >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
      icacls "$(cygpath -w "$secret_file")" /inheritance:r /grant:r "${USERNAME:-$USER}:F" >/dev/null || note "WARNING: could not narrow the ACL of $secret_file"
    fi
    note "the Vercel function needs the same value (production only, marked sensitive):"
    note "  npx vercel@latest env add VALUESCAN_ORIGIN_SECRET production --sensitive < \"$secret_file\""
  fi

  note "copying deploy/server to $SSH_HOST:/opt/valuescan/bootstrap"
  printf '+ tar -C deploy/server -cf - . | ssh %s %q\n' "$SSH_HOST" 'sudo ... tar -xf - -C /opt/valuescan/bootstrap' >&2
  if [ "$PRINT_ONLY" != 1 ]; then
    tar -C deploy/server --exclude='*.test.mjs' -cf - . | ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
      'sudo rm -rf /opt/valuescan/bootstrap.new && sudo mkdir -p /opt/valuescan/bootstrap.new && sudo tar -xf - -C /opt/valuescan/bootstrap.new --no-same-owner && sudo rm -rf /opt/valuescan/bootstrap && sudo mv /opt/valuescan/bootstrap.new /opt/valuescan/bootstrap'
  fi

  # The secret, and while it is rotated the next one (deploy/release/rotate-origin-secret.sh).
  ssh_put_secret "$secret_file" "$REMOTE_SECRET"
  if [ -f "$secret_file.next" ]; then
    ssh_put_secret "$secret_file.next" "$REMOTE_SECRET.next"
  else
    ssh_run "no rotation" "rm -f $REMOTE_SECRET.next"
  fi

  # Values are plain names (validated by bootstrap.sh); no secret travels in this command.
  ssh_run "valuescan bootstrap" "SITE_DOMAIN='$DOMAIN_NAME' ORIGIN_DOMAIN='$ORIGIN_DOMAIN_NAME' OPS_BUCKET='' KEEP_SSHD=1 ORIGIN_SECRET_FILE='$REMOTE_SECRET' ALERT_TOPIC_ARN='' ACME_EMAIL='${ACME_EMAIL:-}' AWS_REGION='$REGION' bash /opt/valuescan/bootstrap/bootstrap.sh"
  note "bootstrap finished"
  exit 0
fi

# --- the CloudFormation instance, through the ops bucket and SSM ---------------------------------
OPS="$(ops_bucket)"
INSTANCE="$(instance_id)"
# The alert topic exists only when ALERT_EMAIL was given to compute.yaml.
TOPIC="${ALERT_TOPIC_ARN:-}"
if [ -z "$TOPIC" ] && [ -n "${ALERT_EMAIL:-}" ]; then
  TOPIC="$(lookup '<alert-topic-arn>' aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_PREFIX-compute" \
    --query "Stacks[0].Outputs[?OutputKey=='AlertTopicArn'].OutputValue | [0]" --output text)"
  [ "$TOPIC" != None ] || TOPIC=""
fi

note "uploading deploy/server to s3://$OPS/bootstrap/"
run aws s3 sync deploy/server "s3://$OPS/bootstrap/" --delete --exclude '*.test.mjs' --only-show-errors

# Values are plain names (validated by bootstrap.sh); no secret travels in this command.
command="set -euo pipefail
export AWS_DEFAULT_REGION='$REGION'
rm -rf /opt/valuescan/bootstrap
mkdir -p /opt/valuescan/bootstrap
aws s3 sync 's3://$OPS/bootstrap/' /opt/valuescan/bootstrap/ --only-show-errors
SITE_DOMAIN='$DOMAIN_NAME' ORIGIN_DOMAIN='$ORIGIN_DOMAIN_NAME' OPS_BUCKET='$OPS' CONFIG_PREFIX='$CONFIG_PREFIX' ALERT_TOPIC_ARN='$TOPIC' ACME_EMAIL='${ACME_EMAIL:-}' AWS_REGION='$REGION' bash /opt/valuescan/bootstrap/bootstrap.sh"
ssm_run "$INSTANCE" "valuescan bootstrap" "$command"
note "bootstrap finished"
