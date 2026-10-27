#!/usr/bin/env bash
# Point this server's alerts at a Telegram chat: writes /etc/valuescan/alert.env
# (root 0600) and sends a test message. Run it once on each server.
#
#   sudo bash /opt/valuescan/bin/telegram-setup.sh                      asks for the bot token (hidden),
#                                                                       finds the chat, writes, tests
#   sudo bash /opt/valuescan/bin/telegram-setup.sh --chat-id=<id>       the chat is known already (the
#                                                                       second server: the id the first printed)
#   ssh <server> 'sudo bash /opt/valuescan/bin/telegram-setup.sh --token-stdin --chat-id=<id>' < token.txt
#                                                                       the token from a file on your computer
#   ... --name="server 2 (Tokyo, executor)"                              how the test message names the server
#   ... --no-test                                                       write the file, send nothing
#
# BEFORE: the owner made a bot with @BotFather in Telegram (/newbot), has its token,
# and has written any message to the bot (or added it to a group and written there) -
# a bot may only write to a chat that wrote to it first. Without --chat-id this script
# asks Telegram which chats did (getUpdates) and waits up to five minutes for one.
#
# THE TOKEN is a secret: it is read from the terminal without echo (or from stdin),
# never from the command line, never printed, and passed to Node only through its
# environment. The chat id is not a secret; it is printed so the other server and the
# GitHub watcher (repository secret TELEGRAM_CHAT_ID) can use the same one.
#
# Who reads alert.env: valuescan-health.service (alerts) and valuescan-offsite.service
# (a failed off-server copy). Both read it at their next start - no restart needed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${NODE_BIN_DIR:-/opt/node/current/bin}/node"
TG="$HERE/telegram.mjs"
ALERT_ENV="${ALERT_ENV:-/etc/valuescan/alert.env}"

die() { printf 'telegram-setup: %s\n' "$*" >&2; exit 1; }
say() { printf 'telegram-setup: %s\n' "$*" >&2; }

TOKEN_STDIN=0
CHAT_ID=""
NAME="$(hostname)"
TEST=1
for arg in "$@"; do
  case "$arg" in
    --token-stdin) TOKEN_STDIN=1 ;;
    --chat-id=*) CHAT_ID="${arg#--chat-id=}" ;;
    --name=*) NAME="${arg#--name=}" ;;
    --no-test) TEST=0 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $arg (--help)" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -x "$NODE" ] || die "$NODE is missing"
[ -f "$TG" ] || die "$TG is missing next to this script"
[[ -z "$CHAT_ID" || "$CHAT_ID" =~ ^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$ ]] || die "--chat-id is a number (or @channelname)"

if [ "$TOKEN_STDIN" = 1 ]; then
  IFS= read -r TOKEN || true
else
  [ -t 0 ] || die "no terminal to ask for the token on: use ssh -t, or --token-stdin < file"
  printf 'Bot token from @BotFather (not shown): ' >&2
  IFS= read -rs TOKEN
  echo >&2
fi
TOKEN="$(printf '%s' "$TOKEN" | tr -d '\r\n[:space:]')"
[[ "$TOKEN" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]] || die "that does not look like a bot token (digits, a colon, then 30+ letters)"

if [ -z "$CHAT_ID" ]; then
  say "asking Telegram which chats wrote to the bot (write it any message now if you have not)"
  for i in $(seq 1 30); do
    out="" ; rc=0
    out="$(ALERT_TELEGRAM_TOKEN="$TOKEN" "$NODE" "$TG" chats)" || rc=$?
    if [ "$rc" = 0 ]; then
      n="$(printf '%s\n' "$out" | grep -c .)"
      if [ "$n" = 1 ]; then
        CHAT_ID="$(printf '%s' "$out" | cut -f1)"
        say "found the chat: $(printf '%s' "$out" | cut -f2-)  (id $CHAT_ID)"
        break
      fi
      printf '%s\n' "$out" >&2
      die "several chats wrote to the bot - run again with --chat-id=<the id of the one for alerts>"
    elif [ "$rc" = 3 ]; then
      [ "$i" = 1 ] && say "nobody wrote to the bot yet: open it in Telegram, press Start or send any text. Waiting (up to 5 minutes)..."
      sleep 10
    else
      die "Telegram refused the token, or cannot be reached (see above)"
    fi
  done
  [ -n "$CHAT_ID" ] || die "no message reached the bot within 5 minutes"
fi

install -d -m 0750 -o root -g valuescan /etc/valuescan 2>/dev/null || install -d -m 0750 /etc/valuescan
tmp="$(mktemp "${ALERT_ENV}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
( umask 077
  {
    echo "# Written by telegram-setup.sh on $(date -u +%Y-%m-%dT%H:%MZ). Root only (0600): systemd reads it"
    echo "# for valuescan-health.service and valuescan-offsite.service. Never commit, never print."
    printf 'ALERT_TELEGRAM_TOKEN=%s\n' "$TOKEN"
    printf 'ALERT_TELEGRAM_CHAT_ID=%s\n' "$CHAT_ID"
  } > "$tmp"
)
install -m 0600 -o root -g root "$tmp" "$ALERT_ENV"
rm -f "$tmp"
trap - EXIT
say "wrote $ALERT_ENV (root, 0600)"

if [ "$TEST" = 1 ]; then
  msg="ValueDesk: alerts from $NAME reach this chat (test from telegram-setup.sh, $(date -u +%Y-%m-%dT%H:%MZ))"
  ALERT_TELEGRAM_TOKEN="$TOKEN" ALERT_TELEGRAM_CHAT_ID="$CHAT_ID" "$NODE" "$TG" send "$msg" || die "the test message was not sent (see above); $ALERT_ENV is written anyway"
  say "test message sent - check Telegram"
fi
say "chat id: $CHAT_ID  (use it for the other server: --chat-id=$CHAT_ID, and as the GitHub secret TELEGRAM_CHAT_ID)"
