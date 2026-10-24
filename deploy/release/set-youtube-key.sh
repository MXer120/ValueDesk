#!/usr/bin/env bash
# Set the YouTube Data API key (the Live Feed's news channels, /api/vs/live) for
# local testing and for production, in one interactive run:
#
#   deploy/release/set-youtube-key.sh            asks for the key, then for each place
#   deploy/release/set-youtube-key.sh --print    shows what it would do, changes nothing
#
# Get the key (free): https://console.cloud.google.com - create a project, then
# "APIs & Services" > "Library" > "YouTube Data API v3" > Enable, then
# "Credentials" > "Create credentials" > "API key"; restrict it to the YouTube
# Data API v3. No billing account is needed for the free quota (10,000 units a day).
#
# What it does, after checking the key against the YouTube Data API:
#   local testing  the repo-root .env (apps/server reads it at start, config.ts):
#                  its YOUTUBE_API_KEY line is replaced, or added. Restart the
#                  local API to pick it up.
#   production     /etc/valuescan/api.local.env on the instance (root, mode 0600,
#                  which systemd reads for valuescan-api): its YOUTUBE_API_KEY line
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

# Opened in a window of its own (a double click), the window would close on exit and take
# the reason with it: wait for Enter first, success or not. set-youtube-key.cmd pauses itself.
on_exit() {
  local rc=$?
  if [ "$rc" != 0 ]; then echo; echo "Stopped (exit $rc). Nothing past the step above was changed."; fi
  if [ -z "${VS_KEY_NO_PAUSE:-}" ] && [ -t 0 ] && [ -t 1 ]; then read -r -p "Press Enter to close. " _ || true; fi
}
trap on_exit EXIT

for arg in "$@"; do
  case "$arg" in
    --print) PRINT_ONLY=1 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

echo "YouTube Data API v3 key - from https://console.cloud.google.com (APIs & Services > Credentials)"
echo "In a Git Bash window paste with a right-click or Shift+Insert (Ctrl+V does not paste there)."
read -r -s -p "Paste the key and press Enter (it is not shown): " KEY || true; echo
KEY="$(printf '%s' "${KEY:-}" | tr -d '[:space:]')"
[ -n "$KEY" ] || die "no key came through - paste it with a right-click or Shift+Insert, then press Enter"
case "$KEY" in
  *[[:cntrl:]]*) die "the key came through with a control character (${#KEY} characters) - Ctrl+V does not paste in a Git Bash window: paste with a right-click or Shift+Insert" ;;
  *[\"\\]*) die "the key holds a quote or a backslash, which a Google API key does not - check what was copied" ;;
esac
echo "Got a key of ${#KEY} characters."

# The key against the API itself: one public video (1 unit). The URL, with the key,
# goes to curl on stdin - never on a command line.
if [ "$PRINT_ONLY" != 1 ]; then
  resp="$(printf 'url = "https://www.googleapis.com/youtube/v3/videos?part=id&id=aqz-KE-bpKQ&key=%s"\n' "$KEY" | curl -s -w '\n%{http_code}' --config - || true)"
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  case "$code" in
    200) echo "The YouTube Data API accepts the key." ;;
    400|403) die "Google refuses the key (HTTP $code) - is the YouTube Data API v3 enabled for its project? ${body:0:300}" ;;
    *) ask "Google answered HTTP ${code:-nothing}. Set the key anyway?" n || exit 1 ;;
  esac
fi

# --- local testing: the repo-root .env ----------------------------------------------------
if ask "Set it for local testing (the repo-root .env)?" y; then
  if [ "$PRINT_ONLY" = 1 ]; then
    echo "+ replace or add YOUTUBE_API_KEY in ./.env   (the key is not shown)"
  else
    touch .env
    tmp="$(mktemp)"
    grep -v '^YOUTUBE_API_KEY=' .env > "$tmp" || true
    printf 'YOUTUBE_API_KEY=%s\n' "$KEY" >> "$tmp"
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
if [ -f "$f" ]; then grep -v "^YOUTUBE_API_KEY=" "$f" > "$tmp" || true; fi
printf "YOUTUBE_API_KEY=%s\n" "$key" >> "$tmp"
install -m 0600 -o root -g root "$tmp" "$f"
rm -f "$tmp"
systemctl restart valuescan-api
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:8797/api/health; then echo "api up"; exit 0; fi
  sleep 1
done
echo "the API did not come back within 30 s" >&2
exit 5'
  note "[set the YouTube key] on $SSH_HOST"
  printf '+ ssh %s %q < (the key)   (the content is not shown)\n' "$SSH_HOST" 'sudo bash -c <replace YOUTUBE_API_KEY in /etc/valuescan/api.local.env; restart valuescan-api>' >&2
  if [ "$PRINT_ONLY" != 1 ]; then
    printf '%s\n' "$KEY" | ssh "${SSH_OPTS[@]}" "$SSH_HOST" "sudo bash -c $(printf '%q' "$remote")"
    # Caddy holds requests while the API restarts; give the first one a moment.
    sleep 3
    body="$(curl -s "$SITE/api/vs/live?channel=UCIALMKvObZNtJ6AmdCLP7Lg" || true)"
    case "$body" in
      *'"ok":true'*) echo "Production: the Live Feed's channels are found again ($SITE/api/vs/live answers)." ;;
      *not_available*) die "production still says the lookup is not configured - check /etc/valuescan/api.local.env on the instance" ;;
      *) echo "Production answered: ${body:0:200}" ;;
    esac
  fi
fi
unset KEY
echo "Done."
