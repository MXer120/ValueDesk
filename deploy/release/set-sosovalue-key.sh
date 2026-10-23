#!/usr/bin/env bash
# Set the SoSoValue OpenAPI key (the News widget, /api/vs/news) for local testing
# and for production, in one interactive run:
#
#   deploy/release/set-sosovalue-key.sh            asks for the key, then for each place
#   deploy/release/set-sosovalue-key.sh --print    shows what it would do, changes nothing
#
# Get the key at https://sosovalue.com/developer/dashboard (sign in, "Apply your
# Key", wait for approval; the dashboard then shows it).
#
# What it does, after checking the key against SoSoValue:
#   local testing  the repo-root .env (apps/server reads it at start, config.ts):
#                  its SOSOVALUE_API_KEY line is replaced, or added. Restart the
#                  local API to pick it up.
#   production     /etc/valuescan/api.local.env on the instance (root, mode 0600,
#                  which systemd reads for valuescan-api): its SOSOVALUE_API_KEY line
#                  is replaced, or added; then the API restarts and /api/vs/news is
#                  asked whether it answers.
#
# The key is read without echo and travels only on stdin - never on a command line,
# never printed, never in a log. Production is the Tokyo instance unless VS_EC2_ENV
# names another env file.
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
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

SITE="${SITE_URL:-https://valuedeskapp.vercel.app}"
ask() {   # question, default (y|n)
  local reply
  read -r -p "$1 [$( [ "$2" = y ] && echo Y/n || echo y/N )] " reply || true
  reply="${reply:-$2}"
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

echo "SoSoValue API key - from https://sosovalue.com/developer/dashboard"
read -r -s -p "Paste the key (it is not shown): " KEY; echo
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
[ -n "$KEY" ] || die "no key given"
case "$KEY" in *[!A-Za-z0-9._-]*) die "that does not look like a SoSoValue key (letters, digits, . _ - only)" ;; esac

# The key against SoSoValue itself: one news item. The header goes to curl on stdin.
# SoSoValue can refuse with HTTP 200 and a non-zero "code" in the body, so both count.
if [ "$PRINT_ONLY" != 1 ]; then
  resp="$(printf 'header = "x-soso-api-key: %s"\n' "$KEY" | curl -s -w '\n%{http_code}' --config - \
    'https://openapi.sosovalue.com/openapi/v1/news?page=1&page_size=1&language=en' || true)"
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  case "$code" in
    200)
      case "$body" in
        *'"code":0'*|*'"code": 0'*) echo "SoSoValue accepts the key." ;;
        *'"code":'*) ask "SoSoValue answered: ${body:0:200}. Set the key anyway?" n || exit 1 ;;
        *) echo "SoSoValue accepts the key." ;;
      esac ;;
    401|403) die "SoSoValue refuses the key (HTTP $code) - is it approved yet? ${body:0:200}" ;;
    429) echo "SoSoValue says too many requests right now (HTTP 429); the key looks valid, carrying on." ;;
    *) ask "SoSoValue answered HTTP ${code:-nothing}. Set the key anyway?" n || exit 1 ;;
  esac
fi

# --- local testing: the repo-root .env ----------------------------------------------------
if ask "Set it for local testing (the repo-root .env)?" y; then
  if [ "$PRINT_ONLY" = 1 ]; then
    echo "+ replace or add SOSOVALUE_API_KEY in ./.env   (the key is not shown)"
  else
    touch .env
    tmp="$(mktemp)"
    grep -v '^SOSOVALUE_API_KEY=' .env > "$tmp" || true
    printf 'SOSOVALUE_API_KEY=%s\n' "$KEY" >> "$tmp"
    cat "$tmp" > .env
    rm -f "$tmp"
    chmod 600 .env 2>/dev/null || true
    echo "Local: set in ./.env. Restart the local API (valuescan-server) to use it."
  fi
fi

# --- production: the instance's api.local.env ---------------------------------------------
if ask "Set it on production ($VS_EC2_ENV)?" y; then
  load_params
  [ "$VS_TARGET" = ec2 ] || die "production here is the EC2 instance (VS_EC2_ENV); this target is $VS_TARGET"
  # The remote side reads the key from stdin; its command line holds no secret.
  remote='set -e
f=/etc/valuescan/api.local.env
[ -d /etc/valuescan ] || { echo "no /etc/valuescan on this instance" >&2; exit 3; }
IFS= read -r key
[ -n "$key" ] || { echo "no key on stdin" >&2; exit 4; }
umask 077
tmp="$(mktemp)"
if [ -f "$f" ]; then grep -v "^SOSOVALUE_API_KEY=" "$f" > "$tmp" || true; fi
printf "SOSOVALUE_API_KEY=%s\n" "$key" >> "$tmp"
install -m 0600 -o root -g root "$tmp" "$f"
rm -f "$tmp"
systemctl restart valuescan-api
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:8797/api/health; then echo "api up"; exit 0; fi
  sleep 1
done
echo "the API did not come back within 30 s" >&2
exit 5'
  note "[set the SoSoValue key] on $SSH_HOST"
  printf '+ ssh %s %q < (the key)   (the content is not shown)\n' "$SSH_HOST" 'sudo bash -c <replace SOSOVALUE_API_KEY in /etc/valuescan/api.local.env; restart valuescan-api>' >&2
  if [ "$PRINT_ONLY" != 1 ]; then
    printf '%s\n' "$KEY" | ssh "${SSH_OPTS[@]}" "$SSH_HOST" "sudo bash -c $(printf '%q' "$remote")"
    # Caddy holds requests while the API restarts; give the first one a moment.
    sleep 3
    body="$(curl -s "$SITE/api/vs/news?limit=1" || true)"
    case "$body" in
      *'"ok":true'*) echo "Production: the News widget is live ($SITE/api/vs/news answers)." ;;
      *not_available*) die "production still says the feed is not configured - check /etc/valuescan/api.local.env on the instance" ;;
      *) echo "Production answered: ${body:0:200}" ;;
    esac
  fi
fi
unset KEY
echo "Done."
