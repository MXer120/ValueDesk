# Shared by the scripts in deploy/release. Sourced, not run.
#
# Loads deploy/aws/params.env, resolves what the stacks output (read-only AWS
# calls) and prints every AWS command before it runs.

# Git Bash rewrites arguments that start with "/" into Windows paths; S3 keys,
# SSM names and CloudFront paths start with "/". Off for everything below - which
# is also why these scripts only ever pass RELATIVE file names to the AWS CLI.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$RELEASE_DIR/../.." && pwd)"
# Everything runs from the repository root, with paths relative to it.
cd "$REPO_ROOT"
OUT_DIR="deploy/.out"

die() { echo "error: $*" >&2; exit 1; }
note() { echo "$*" >&2; }

PRINT_ONLY="${PRINT_ONLY:-0}"

# Print a command, then run it (unless --print).
run() {
  { printf '+'; printf ' %q' "$@"; printf '\n'; } >&2
  [ "$PRINT_ONLY" = 1 ] || "$@"
}

# A read-only lookup whose output is needed. With --print: the placeholder.
lookup() {
  local placeholder="$1"; shift
  { printf '+'; printf ' %q' "$@"; printf '\n'; } >&2
  if [ "$PRINT_ONLY" = 1 ]; then printf '%s' "$placeholder"; else "$@"; fi
}

# Read a KEY=value file into the environment. Carriage returns are dropped: a file
# saved with Windows line endings must not leave a "\r" at the end of every value
# (a region, a domain, a project id that then matches nothing).
load_env_file() {
  set -a
  eval "$(tr -d '\r' < "$1")"
  set +a
}

load_params() {
  local file="${PARAMS_FILE:-deploy/aws/params.env}"
  [ -f "$file" ] || die "missing $file - copy deploy/aws/params.env.example and fill it in"
  load_env_file "$file"
  : "${STACK_PREFIX:=valuescan}"
  : "${CONFIG_PREFIX:=/valuescan/prod}"
  [ -n "${REGION:-}" ] || die "REGION is empty in $file"
  case "$REGION" in *__*) die "REGION still holds a placeholder in $file" ;; esac
  EDGE_REGION=us-east-1
  command -v aws >/dev/null 2>&1 || [ "$PRINT_ONLY" = 1 ] || die "AWS CLI v2 is not on PATH"
}

stack_output() {   # stack, region, output key, placeholder for --print
  local value
  value="$(lookup "$4" aws cloudformation describe-stacks --region "$2" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue | [0]" --output text)"
  [ -n "$value" ] && [ "$value" != None ] || die "stack $1 in $2 has no output $3 - is it deployed?"
  printf '%s' "$value"
}

# Each of these honours a value already in the environment (or params.env).
ops_bucket() { [ -n "${OPS_BUCKET:-}" ] && printf '%s' "$OPS_BUCKET" || stack_output "$STACK_PREFIX-network" "$REGION" OpsBucketName '<ops-bucket>'; }
instance_id() { [ -n "${INSTANCE_ID:-}" ] && printf '%s' "$INSTANCE_ID" || stack_output "$STACK_PREFIX-compute" "$REGION" InstanceId '<instance-id>'; }
site_bucket() { [ -n "${SITE_BUCKET:-}" ] && printf '%s' "$SITE_BUCKET" || stack_output "$STACK_PREFIX-edge" "$EDGE_REGION" SiteBucketName '<site-bucket>'; }
distribution_id() { [ -n "${DISTRIBUTION_ID:-}" ] && printf '%s' "$DISTRIBUTION_ID" || stack_output "$STACK_PREFIX-edge" "$EDGE_REGION" DistributionId '<distribution-id>'; }

# Tags name S3 keys and directories on the instance.
valid_tag() {
  case "$1" in
    ''|.*|*[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
  esac
}

# The tag must exist (a release is always a tag, never "whatever is checked out").
require_tag() {
  valid_tag "$1" || die "not a usable tag name: $1 (letters, digits, dot, dash, underscore)"
  git rev-parse -q --verify "refs/tags/$1" >/dev/null || die "tag $1 does not exist (git tag $1 && git push origin $1)"
}

# The web is built from the working tree: it must be exactly the tag, with nothing uncommitted.
require_clean_checkout() {
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "refs/tags/$1^{commit}")" ] \
    || die "HEAD is not tag $1 - check the tag out first (the web is built from the working tree)"
  [ -z "$(git status --porcelain --untracked-files=no)" ] \
    || die "the working tree has uncommitted changes - a release is built from a clean tag"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Run a shell command on the instance through SSM Run Command and show its output.
# The command line is visible in SSM's history: never put a secret in it.
ssm_run() {   # instance id, comment, command
  local instance="$1" comment="$2" command="$3" id status
  mkdir -p "$OUT_DIR"
  local params="$OUT_DIR/ssm-command.$$.json"
  COMMAND="$command" node -e 'process.stdout.write(JSON.stringify({ commands: [process.env.COMMAND], executionTimeout: ["3600"] }))' > "$params"
  id="$(lookup '<command-id>' aws ssm send-command --region "$REGION" --instance-ids "$instance" \
    --document-name AWS-RunShellScript --comment "$comment" \
    --parameters "file://$params" --query 'Command.CommandId' --output text)"
  rm -f "$params"
  [ "$PRINT_ONLY" = 1 ] && return 0
  note "SSM command $id is running on $instance ..."
  while :; do
    status="$(aws ssm get-command-invocation --region "$REGION" --command-id "$id" --instance-id "$instance" --query 'Status' --output text 2>/dev/null || echo Pending)"
    case "$status" in Pending|InProgress|Delayed) sleep 5 ;; *) break ;; esac
  done
  aws ssm get-command-invocation --region "$REGION" --command-id "$id" --instance-id "$instance" --query 'StandardOutputContent' --output text
  aws ssm get-command-invocation --region "$REGION" --command-id "$id" --instance-id "$instance" --query 'StandardErrorContent' --output text >&2
  [ "$status" = Success ] || die "the command ended with status $status (full output: aws ssm get-command-invocation --command-id $id --instance-id $instance)"
}
