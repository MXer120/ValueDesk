#!/usr/bin/env bash
# The knowledge folders' file storage in AWS, in one run - for the OWNER, with an AWS
# profile that may create S3 buckets and IAM roles (the `claude` profile manages EC2 only):
#
#   AWS_PROFILE=<admin profile> deploy/aws/folders-storage.sh           creates, attaches, asks before the instance
#   AWS_PROFILE=<admin profile> deploy/aws/folders-storage.sh --print   shows every command, changes nothing
#
# What it makes, in ap-northeast-1 (Tokyo), next to the instance. Idempotent: what exists
# already is kept, its settings applied again.
#
#   1. The bucket valuedesk-folders-tokyo (FOLDERS_BUCKET): private (Block Public Access on,
#      ownership enforced), encrypted at rest (SSE-S3), reachable over TLS only (its policy),
#      WITHOUT versioning - a deleted file is gone, as the privacy policy says - with CORS for
#      the site's origins (PUT from the browser's upload, GET and HEAD for opening a file;
#      the Content-Type header) and a lifecycle rule that drops unfinished multipart uploads
#      after a day. The bucket's name is in the site's Content-Security-Policy
#      (apps/web/index.html, deploy/smoke/prod-headers.mjs, deploy/aws/edge.yaml): another
#      name means a change there too.
#   2. The role valuedesk-folders-api, which only EC2 may assume, with ONE inline policy:
#      s3:PutObject, s3:GetObject and s3:DeleteObject on valuedesk-folders-tokyo/files/* -
#      no listing, no other bucket, nothing else in AWS. And its instance profile.
#   3. That profile attached to the Tokyo instance (its id from VS_EC2_ENV's state file). The
#      API reads the role's temporary keys through IMDSv2 (apps/server/src/folders/s3.ts); no
#      key is ever written anywhere.
#   4. On a yes: FOLDERS_S3_BUCKET in /etc/valuescan/api.local.env on the instance, over SSH.
#      The API uses it once it runs a release with S3 support (restarted by that release, or
#      `sudo systemctl restart valuescan-api`). Before that, nothing reads it.
#
# Afterwards: release the API (deploy/release/release-server.sh --api-only with
# VS_EC2_ENV=deploy/aws/ec2/ec2.tokyo.env), then push main (the web, and the Vercel function).
# Costs: S3 Standard storage (about 0.025 USD per GB a month in Tokyo) and traffic out of AWS
# (about 0.114 USD per GB after the first 100 GB a month); the API caps both (FOLDERS_MAX_TOTAL_GB,
# FOLDERS_DOWNLOAD_*). A billing alarm in the AWS console is worth setting once.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
# On a Windows PC whose AWS CLI is unpacked under %LOCALAPPDATA%\ddx-tools, not on PATH.
if ! command -v aws >/dev/null 2>&1 && [ -n "${LOCALAPPDATA:-}" ] && command -v cygpath >/dev/null 2>&1; then
  aws_dir="$(cygpath -u "$LOCALAPPDATA")/ddx-tools/awscli/Amazon/AWSCLIV2"
  [ -x "$aws_dir/aws.exe" ] && PATH="$aws_dir:$PATH"
fi
: "${VS_EC2_ENV:=deploy/aws/ec2/ec2.tokyo.env}"
export VS_EC2_ENV
. deploy/release/lib.sh

for arg in "$@"; do
  case "$arg" in
    --print) PRINT_ONLY=1 ;;
    -h|--help) sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

BUCKET="${FOLDERS_BUCKET:-valuedesk-folders-tokyo}"
AWS_REGION_FOLDERS="${FOLDERS_REGION:-ap-northeast-1}"
ROLE=valuedesk-folders-api
SITE_ORIGINS="${SITE_ORIGINS:-https://valuedeskapp.vercel.app,https://valuexplorer.vercel.app}"
[ -n "${AWS_PROFILE:-}" ] || [ "$PRINT_ONLY" = 1 ] || die "set AWS_PROFILE to a profile that may create S3 buckets and IAM roles (not 'claude': it manages EC2 only)"
[ "${AWS_PROFILE:-}" != claude ] || die "the 'claude' profile cannot create buckets or roles - use the owner's profile"

ask() {   # question, default (y|n)
  local reply
  [ "$PRINT_ONLY" = 1 ] && return 0
  read -r -p "$1 [$( [ "$2" = y ] && echo Y/n || echo y/N )] " reply || true
  reply="${reply:-$2}"
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

load_params
[ "$VS_TARGET" = ec2 ] || die "the folders' storage is for the EC2 instance (VS_EC2_ENV); this target is $VS_TARGET"
INSTANCE="${INSTANCE_ID:-}"
[ -n "$INSTANCE" ] || [ "$PRINT_ONLY" = 1 ] || die "no instance id in $EC2_ENV's state - run deploy/aws/ec2/provision.sh status"
: "${INSTANCE:=<instance-id>}"
note "bucket $BUCKET in $AWS_REGION_FOLDERS, role $ROLE, instance $INSTANCE"

# Relative paths for the AWS CLI's file:// (lib.sh: Git Bash would rewrite absolute ones).
REL="deploy/.out/folders-storage"
mkdir -p "$REL"

# --- 1. the bucket ------------------------------------------------------------------------

if [ "$PRINT_ONLY" != 1 ] && aws s3api head-bucket --bucket "$BUCKET" --region "$AWS_REGION_FOLDERS" >/dev/null 2>&1; then
  note "the bucket exists - its settings are applied again"
else
  run aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION_FOLDERS" \
    --create-bucket-configuration "LocationConstraint=$AWS_REGION_FOLDERS" --object-ownership BucketOwnerEnforced
fi
run aws s3api put-public-access-block --bucket "$BUCKET" --region "$AWS_REGION_FOLDERS" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
run aws s3api put-bucket-encryption --bucket "$BUCKET" --region "$AWS_REGION_FOLDERS" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'

origins_json="$(printf '%s' "$SITE_ORIGINS" | tr ',' '\n' | sed 's/.*/"&"/' | paste -sd, -)"
cat > "$REL/cors.json" <<EOF
{"CORSRules":[{"AllowedOrigins":[$origins_json],"AllowedMethods":["PUT","GET","HEAD"],"AllowedHeaders":["content-type"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3000}]}
EOF
run aws s3api put-bucket-cors --bucket "$BUCKET" --region "$AWS_REGION_FOLDERS" --cors-configuration "file://$REL/cors.json"

cat > "$REL/lifecycle.json" <<'EOF'
{"Rules":[{"ID":"abort-unfinished-multipart","Status":"Enabled","Filter":{},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}
EOF
run aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --region "$AWS_REGION_FOLDERS" --lifecycle-configuration "file://$REL/lifecycle.json"

cat > "$REL/bucket-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Sid":"TlsOnly","Effect":"Deny","Principal":"*","Action":"s3:*",
"Resource":["arn:aws:s3:::$BUCKET","arn:aws:s3:::$BUCKET/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}
EOF
run aws s3api put-bucket-policy --bucket "$BUCKET" --region "$AWS_REGION_FOLDERS" --policy "file://$REL/bucket-policy.json"

# --- 2. the role and its instance profile ------------------------------------------------------

cat > "$REL/trust.json" <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
cat > "$REL/role-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Sid":"FolderObjects","Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:DeleteObject"],
"Resource":"arn:aws:s3:::$BUCKET/files/*"}]}
EOF
if [ "$PRINT_ONLY" != 1 ] && aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  note "the role exists"
else
  run aws iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$REL/trust.json" \
    --description "ValueDesk API on the Tokyo instance: the knowledge folders' objects in S3, nothing else"
fi
run aws iam put-role-policy --role-name "$ROLE" --policy-name folders-objects --policy-document "file://$REL/role-policy.json"
if [ "$PRINT_ONLY" != 1 ] && aws iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then
  note "the instance profile exists"
else
  run aws iam create-instance-profile --instance-profile-name "$ROLE"
  run aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  # A new profile takes a few seconds before EC2 accepts it.
  [ "$PRINT_ONLY" = 1 ] || sleep 10
fi

# --- 3. attached to the instance ------------------------------------------------------------------

current="$(lookup '<none>' aws ec2 describe-iam-instance-profile-associations --region "$REGION" \
  --filters "Name=instance-id,Values=$INSTANCE" --query 'IamInstanceProfileAssociations[0].IamInstanceProfile.Arn' --output text)"
case "$current" in
  *"/$ROLE") note "the instance already has the profile" ;;
  None|'<none>'|'') run aws ec2 associate-iam-instance-profile --region "$REGION" --instance-id "$INSTANCE" --iam-instance-profile "Name=$ROLE" ;;
  *) die "the instance has another instance profile ($current): add the folders-objects policy to that role instead, or replace the association by hand" ;;
esac

# --- 4. the API's setting -------------------------------------------------------------------------------

if ask "Write FOLDERS_S3_BUCKET=$BUCKET into /etc/valuescan/api.local.env on the instance?" y; then
  ssh_run "set FOLDERS_S3_BUCKET" "set -e
f=/etc/valuescan/api.local.env
umask 077
tmp=\$(mktemp)
if [ -f \"\$f\" ]; then grep -v '^FOLDERS_S3_BUCKET=\\|^FOLDERS_S3_REGION=' \"\$f\" > \"\$tmp\" || true; fi
printf 'FOLDERS_S3_BUCKET=%s\nFOLDERS_S3_REGION=%s\n' '$BUCKET' '$AWS_REGION_FOLDERS' >> \"\$tmp\"
install -m 0600 -o root -g root \"\$tmp\" \"\$f\"
rm -f \"\$tmp\"
echo 'set; the API reads it at its next restart'"
fi
note "done. Next: release the API (release-server.sh --api-only), then push main."
