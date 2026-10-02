#!/usr/bin/env bash
# Set up (or re-converge) the instance: upload deploy/server to the ops bucket and
# run its bootstrap.sh on the instance through SSM Run Command.
#
#   deploy/release/bootstrap-instance.sh           run it
#   deploy/release/bootstrap-instance.sh --print   show the AWS commands, run none
#
# Run it once after compute.yaml is deployed, and again whenever deploy/server
# changes (a unit, an env template, a pinned version) or the origin secret was
# rotated. It is idempotent, never restarts a running indexer, and prints what
# still needs a restart.
#
# It needs the compute stack to be up and <CONFIG_PREFIX>/origin-secret to exist
# in SSM Parameter Store (deploy/aws/deploy.sh secret --execute).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

for arg in "$@"; do
  case "$arg" in
    --print) PRINT_ONLY=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $arg" ;;
  esac
done
load_params
[ -n "${DOMAIN_NAME:-}" ] && [ -n "${ORIGIN_DOMAIN_NAME:-}" ] || die "DOMAIN_NAME and ORIGIN_DOMAIN_NAME must be set in deploy/aws/params.env"
case "$DOMAIN_NAME$ORIGIN_DOMAIN_NAME" in *__*) die "DOMAIN_NAME / ORIGIN_DOMAIN_NAME still hold a placeholder" ;; esac

# The instance runs these files exactly as they are uploaded. A carriage return (a
# checkout with Windows line endings) breaks every one of them: the scripts, the
# units, the environment files.
command -v node >/dev/null 2>&1 || die "node is needed (it also writes the SSM command file)"
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
