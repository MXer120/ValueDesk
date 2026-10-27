#!/usr/bin/env bash
# Rotate one secret of ValueDesk, from the owner's laptop. Prints the plan by default and
# changes NOTHING (no ssh either); --execute runs it, step by step, and stops at the first step
# that fails, saying how to roll back. docs/deploy/SECRETS.md has every secret, what a leak
# allows and what users notice.
#
#   deploy/release/rotate.sh list                              every secret and the command that rotates it
#   deploy/release/rotate.sh status                            (read-only ssh) what is in place on both servers
#   deploy/release/rotate.sh <what> [<step>] [--execute] [--yes]
#
#   origin-secret begin | finish      the Vercel <-> server secret (rotate-origin-secret.sh, both servers)
#   executor-session                  server 2 session.key: every follower signs in again
#   executor-import                   server 2 import.key: a key import under way fails once
#   executor-kek                      server 2 kek: every sealed follower key sealed again (tools/rotate-kek.ts)
#   folders-session | feedback-session    server 1 sign-in keys: the folders' owner / chat users sign again
#   telegram [--token-file=<f>] [--chat-id=<id>]   a new bot token onto both servers
#   backup-key server1 | server2      that server's off-server backup key
#   offsite-ssh server1 | server2     the ssh key that server's copies travel with
#   ledger-pull                       server 2's key that pulls builder.db from server 1
#   laptop-ssh                        ~/.ssh/valuescan-contabo: new key (passphrase), installed, tested, old removed
#   builder-terms begin | finish | abort   the builder terms signing key (the web build pins its public half)
#   sosovalue | youtube               API keys: the plan only (set-sosovalue-key.sh / set-youtube-key.sh do it)
#
# --yes  do not ask before running (needed without a terminal). Secrets never appear on a command
# line or in the output; they travel only on ssh's stdin. Download/upload: a few KB (the laptop's
# bandwidth cap is never close).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
S1="${RS_SERVER1:-161.97.154.121}"
S2="${RS_SERVER2:-13.140.77.201}"
SSH_USER="${SSH_USER:-almalinux}"
SSH_KEY="${SSH_KEY_FILE:-$HOME/.ssh/valuescan-contabo}"
SITE="${RS_SITE:-https://www.valuedesk.so}"
BIN=/opt/valuescan/bin
HELPER="sudo bash $BIN/rotate-secret.sh"
KEYS_DIR="${PULL_DEST:-$HOME/ValueDesk-backups}/keys"
ENV1=deploy/aws/ec2/ec2.contabo.env
ENV2=deploy/aws/ec2/ec2.contabo2.env
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

die() { echo "rotate: $*" >&2; exit 1; }
say() { echo "rotate: $*" >&2; }

usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; }

EXECUTE=0 YES=0 TOKEN_FILE="" CHAT_ID=""
POS=()
for a in "$@"; do
  case "$a" in
    --execute) EXECUTE=1 ;;
    --yes) YES=1 ;;
    --token-file=*) TOKEN_FILE="${a#--token-file=}" ;;
    --chat-id=*) CHAT_ID="${a#--chat-id=}" ;;
    -h|--help) usage; exit 0 ;;
    --*) die "unknown option $a (--help)" ;;
    *) POS+=("$a") ;;
  esac
done
WHAT="${POS[0]:-}"
ARG="${POS[1]:-}"
[ -n "$WHAT" ] || { usage; exit 2; }
[ "${#POS[@]}" -le 2 ] || die "too many arguments"

# --- ssh: the laptop's key, each server's own pinned host key ----------------------------------------
kh_of() { [ "$1" = "$S1" ] && echo "${RS_KNOWN_HOSTS_1:-$HOME/.ssh/valuedesk-contabo.known_hosts}" || echo "${RS_KNOWN_HOSTS_2:-$HOME/.ssh/valuedesk-contabo2.known_hosts}"; }
ssh_opts() {   # host, key, batch yes|no
  local kh; kh="$(kh_of "$1")"
  local o=(-i "$2" -o IdentitiesOnly=yes -o "BatchMode=$3" -o ConnectTimeout=20 -o LogLevel=ERROR -o StrictHostKeyChecking=yes)
  [ -f "$kh" ] && o+=(-o "UserKnownHostsFile=$kh")
  printf '%s\n' "${o[@]}"
}
on() {   # host, remote command  (stdin passes through)
  local host="$1"; shift
  local o; mapfile -t o < <(ssh_opts "$host" "$SSH_KEY" yes)
  ssh "${o[@]}" "$SSH_USER@$host" "$@"
}
on_key() {   # key, host, remote command - an interactive passphrase prompt is allowed
  local key="$1" host="$2"; shift 2
  local o; mapfile -t o < <(ssh_opts "$host" "$key" no)
  ssh "${o[@]}" "$SSH_USER@$host" "$@"
}
name_of() { [ "$1" = "$S1" ] && echo "server 1" || echo "server 2"; }

# --- plan / execute -----------------------------------------------------------------------------------
N=0
PLAN_TITLE=""
plan() { PLAN_TITLE="$1"; echo; echo "== $1 ==$([ "$EXECUTE" = 1 ] && echo '' || echo '   (plan only: nothing runs; add --execute)')"; }
info() { printf '   %s\n' "$@"; }
# A step: what it does, the command as it is shown, then the command (a function or a command) run.
step() {   # description, shown command, command...
  N=$((N + 1))
  local desc="$1" shown="$2"; shift 2
  printf ' %2d. %s\n     + %s\n' "$N" "$desc" "$shown"
  [ "$EXECUTE" = 1 ] || return 0
  "$@" || die "step $N failed: $desc${ROLLBACK:+ - ROLL BACK: $ROLLBACK}"
}
ROLLBACK=""
confirm() {
  [ "$EXECUTE" = 1 ] || return 0
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || die "no terminal to ask on: add --yes"
  printf '\nRun the steps above now? Type yes: ' >&2
  local a; IFS= read -r a
  [ "$a" = yes ] || die "not confirmed - nothing was done"
}
ask_done() {   # a step only the owner can do (Vercel, BotFather, GitHub): wait for "done"
  [ "$EXECUTE" = 1 ] || return 0
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || die "no terminal to ask on: add --yes once it is done"
  printf '     -> type done when it is: ' >&2
  local a; IFS= read -r a
  [ "$a" = done ] || die "stopped before: $1"
}
site_ok() {   # path
  curl --limit-rate 2M -fsS --max-time 20 "$SITE$1" | grep -q '"ok":true'
}
helper_present() {   # host
  on "$1" "test -x $BIN/rotate-secret.sh" || die "$BIN/rotate-secret.sh is not on $(name_of "$1") - install the scripts first: VS_EC2_ENV=$([ "$1" = "$S1" ] && echo $ENV1 || echo $ENV2) deploy/release/bootstrap-instance.sh"
}
# The server helper with stdout captured into a variable (plan mode: a placeholder).
capture() {   # var, placeholder, host, description, helper args
  local var="$1" ph="$2" host="$3" desc="$4"; shift 4
  N=$((N + 1))
  printf ' %2d. %s: %s\n     + %s\n' "$N" "$(name_of "$host")" "$desc" "$(shown_remote "$host" "$*")"
  if [ "$EXECUTE" != 1 ]; then printf -v "$var" '%s' "$ph"; return 0; fi
  local out; out="$(on "$host" "$HELPER $*")" || die "step $N failed on $(name_of "$host")${ROLLBACK:+ - ROLL BACK: $ROLLBACK}"
  printf -v "$var" '%s' "$out"
}
remote() { on "$1" "$HELPER $2"; }
pipe_remote() { printf '%s\n' "$1" | remote "$2" "$3"; }   # text for stdin, host, helper args
both_helpers() { helper_present "$S1" && helper_present "$S2"; }
both_login_old() { on "$S1" true && on "$S2" true; }
add_login() { remote "$1" "authorized add --user=$SSH_USER" < "$2"; }
receiver_only() {   # receiving host, sender ip, the new public line (checked by check_pub)
  check_pub "$3"
  on "$1" "sudo bash $BIN/offsite-setup.sh receiver --from=$2 --pubkey='$3'"
}
shown_remote() { printf "ssh %s@%s '%s'" "$SSH_USER" "$1" "$HELPER $2"; }
PUBRE='^ssh-ed25519 [A-Za-z0-9+/]{60,}={0,3}( [A-Za-z0-9@._:+-]+)?$'
check_pub() { [[ "$1" =~ $PUBRE ]] || die "what came back is not a public key line - stopped"; }

# --- the rotations -----------------------------------------------------------------------------------------
do_list() {
  cat <<'EOF'
secret                         where                                         rotate with
origin secret                  laptop, both servers, Vercel                  rotate.sh origin-secret begin|finish
executor kek                   server 2 /var/lib/valuescan/executor/kek      rotate.sh executor-kek
executor session.key           server 2 (same directory)                     rotate.sh executor-session
executor import.key            server 2 (same directory)                     rotate.sh executor-import
folders session.key            server 1 /var/lib/valuescan/state/folders     rotate.sh folders-session
feedback session.key           server 1 .../state/feedback-auth              rotate.sh feedback-session
builder terms key              server 1 .../state/builder-terms.key          rotate.sh builder-terms begin|finish
Telegram bot token             both /etc/valuescan/alert.env, GitHub secret  rotate.sh telegram
backup keys                    each server /etc/valuescan/offsite, laptop    rotate.sh backup-key server1|server2
offsite ssh keys               each sender /etc/valuescan/offsite/id_ed25519 rotate.sh offsite-ssh server1|server2
ledger pull key                server 2 /root/.ssh/ledger_pull               rotate.sh ledger-pull
laptop ssh key                 ~/.ssh/valuescan-contabo                      rotate.sh laptop-ssh
SoSoValue / YouTube API keys   server 1 /etc/valuescan/api.local.env         rotate.sh sosovalue | youtube
(docs/deploy/SECRETS.md: what each one protects, and what users notice)
EOF
}

do_status() {
  for h in "$S1" "$S2"; do
    echo "== $(name_of "$h") =="
    on "$h" "$HELPER status" || say "could not read $(name_of "$h")"
    echo "-- authorized_keys of $SSH_USER:"
    on "$h" "$HELPER authorized list --user=$SSH_USER" || true
  done
}

do_origin() {
  case "$ARG" in
    begin)
      plan "origin secret, part 1 of 2: both servers accept the old AND a new value"
      info "Users notice: nothing. A leak of the old value lets a caller skip Vercel and talk to the API directly." ""
      [ -f "$ENV1" ] && [ -f "$ENV2" ] || [ "$EXECUTE" != 1 ] || die "$ENV1 and $ENV2 are needed here (run this from the release worktree, e.g. ~/vs-coh)"
      confirm
      step "a new value into <ORIGIN_SECRET_DIR>/origin-secret.next; server 1 accepts both" "VS_EC2_ENV=$ENV1 deploy/release/rotate-origin-secret.sh begin" \
        env VS_EC2_ENV="$ENV1" deploy/release/rotate-origin-secret.sh begin
      step "server 2 (the executor checks it too) accepts both" "VS_EC2_ENV=$ENV2 deploy/release/bootstrap-instance.sh" \
        env VS_EC2_ENV="$ENV2" deploy/release/bootstrap-instance.sh
      step "the site still answers through Vercel (it sends the old value)" "curl --limit-rate 2M $SITE/api/health" site_ok /api/health
      echo
      info "NOW, in Vercel (the owner; the value goes from the file, never through a chat):" \
        "  npx vercel@latest env rm VALUESCAN_ORIGIN_SECRET production --yes" \
        "  npx vercel@latest env add VALUESCAN_ORIGIN_SECRET production --sensitive < <ORIGIN_SECRET_DIR>/origin-secret.next" \
        "  redeploy production (git push to main, or npx vercel@latest redeploy <production url>)" \
        "THEN: deploy/release/rotate.sh origin-secret finish --execute"
      ;;
    finish)
      plan "origin secret, part 2 of 2: only the new value is accepted"
      info "Before: the LIVE Vercel production deployment was made after the new value was set (npx vercel@latest ls valuedesk --prod)." \
        "Users notice: nothing - unless Vercel still sends the old value: then every /api call fails with 403 until the rollback." ""
      [ -f "$ENV1" ] && [ -f "$ENV2" ] || [ "$EXECUTE" != 1 ] || die "$ENV1 and $ENV2 are needed here (run this from the release worktree)"
      local dir=""
      if [ "$EXECUTE" = 1 ]; then
        dir="$(set -a; eval "$(tr -d '\r' < "$ENV1")"; printf '%s' "${ORIGIN_SECRET_DIR:-$HOME/.valuescan/contabo}")"
        [ -f "$dir/origin-secret.next" ] || die "no rotation under way ($dir/origin-secret.next does not exist)"
      fi
      ROLLBACK="cp <ORIGIN_SECRET_DIR>/origin-secret.old-$STAMP <ORIGIN_SECRET_DIR>/origin-secret.next, then bootstrap-instance.sh for both env files (both values accepted again)"
      confirm
      ask_done "the Vercel deployment with the new value is live"
      step "keep the old value on the laptop for a rollback" "cp <ORIGIN_SECRET_DIR>/origin-secret <ORIGIN_SECRET_DIR>/origin-secret.old-$STAMP" \
        keep_old_origin "$dir"
      step "the new value is the only one on server 1" "VS_EC2_ENV=$ENV1 deploy/release/rotate-origin-secret.sh finish" \
        env VS_EC2_ENV="$ENV1" deploy/release/rotate-origin-secret.sh finish
      step "and on server 2" "VS_EC2_ENV=$ENV2 deploy/release/bootstrap-instance.sh" env VS_EC2_ENV="$ENV2" deploy/release/bootstrap-instance.sh
      step "the site answers through Vercel (with the new value)" "curl --limit-rate 2M $SITE/api/health" site_ok /api/health
      step "copy trading answers through Vercel and server 1" "curl --limit-rate 2M $SITE/api/copy/v1/health" site_ok /api/copy/v1/health
      info "" "Then: delete <ORIGIN_SECRET_DIR>/origin-secret.old-$STAMP once all is well, and make a new emergency kit (deploy/release/emergency-kit.sh create)."
      ;;
    *) die "origin-secret begin | finish" ;;
  esac
}
keep_old_origin() {
  ( umask 077; cp -p "$1/origin-secret" "$1/origin-secret.old-$STAMP" )
  if command -v icacls >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
    icacls "$(cygpath -w "$1/origin-secret.old-$STAMP")" /inheritance:r /grant:r "${USERNAME:-$USER}:F" >/dev/null || say "WARNING: could not narrow the ACL"
  fi
}

do_executor() {   # session | import | kek
  local what="$1"
  case "$what" in
    session) plan "executor session.key (server 2)"
      info "Users notice: every follower's dashboard asks them to sign once more (one free signature). Copies and algos keep running." \
        "A leak lets someone read (not change) any follower's copies and activity, as long as their 12-hour tokens last." ;;
    import) plan "executor import.key (server 2)"
      info "Users notice: nothing, unless they are importing their own SoDEX key at that moment - it fails once; they press again." \
        "A leak, together with the site's traffic, would expose a key a follower imports." ;;
    kek) plan "executor kek (server 2): every follower's sealed trading key sealed again"
      info "Users notice: the executor stops for a few seconds (copies catch up, algos resume). Nothing else." \
        "A leak of the kek AND a copy of executor.db lets someone sign trades for every follower until their keys expire" \
        "or are revoked - if the kek was really exposed, followers must also revoke the ValueDesk key on SoDEX (rotation" \
        "alone does not help against a copy already taken)." ;;
  esac
  info ""
  ROLLBACK="the command the failing step printed (rotate-secret.sh restore ... / executor-kek --kek-from=...)"
  confirm
  step "the helper is installed on server 2" "ssh $SSH_USER@$S2 test -x $BIN/rotate-secret.sh" helper_present "$S2"
  if [ "$what" = kek ]; then
    step "every sealed key opens under the kek in force (read-only)" "$(shown_remote "$S2" executor-kek-check)" remote "$S2" executor-kek-check
  fi
  step "stop the executor, rotate, start it, check its health" "$(shown_remote "$S2" "executor-$what")" remote "$S2" "executor-$what"
  step "copy trading answers through the site" "curl --limit-rate 2M $SITE/api/copy/v1/health" site_ok /api/copy/v1/health
  if [ "$what" = kek ]; then
    echo
    info "NOW (the owner, interactive - a passphrase): a new offline kek block; the old block holds the OLD kek:" \
      "  ssh -t -i ~/.ssh/valuescan-contabo $SSH_USER@$S2 'sudo bash $BIN/executor-secrets.sh export' > kek-block-$STAMP.txt" \
      "Keep the OLD block and server 2's kek.old-<stamp> while executor.db backups from before today exist (30 days off-server)." \
      "Then a new emergency kit: deploy/release/emergency-kit.sh create --out=<usb> --kek-block=kek-block-$STAMP.txt"
  fi
}

do_api_session() {   # folders | feedback
  if [ "$1" = folders ]; then
    plan "knowledge folders session.key (server 1)"
    info "Users notice: the folders' owner (owner-only feature) signs in once more. A leak lets someone open the owner's folders."
  else
    plan "feedback chat session.key (server 1)"
    info "Users notice: people with a feedback chat on their wallet sign once more. A leak lets someone read and write those chats."
  fi
  info ""
  confirm
  step "the helper is installed on server 1" "ssh $SSH_USER@$S1 test -x $BIN/rotate-secret.sh" helper_present "$S1"
  step "a new key, restart the API, check its health" "$(shown_remote "$S1" "$1-session")" remote "$S1" "$1-session"
  step "the site answers" "curl --limit-rate 2M $SITE/api/health" site_ok /api/health
}

do_telegram() {
  plan "Telegram bot token (both servers' alerts, and the GitHub watcher)"
  info "First, in Telegram: @BotFather -> /revoke -> the bot -> it shows a NEW token; the old one stops at once" \
    "(alerts are silent until step 3). Save the token in a file of its own (--token-file=<f>, deleted afterwards)" \
    "or type it at the hidden prompt." "Users notice: nothing. A leak lets someone send messages as the bot and read what is sent to it." ""
  local TOKEN=""
  if [ "$EXECUTE" = 1 ]; then
    if [ -n "$TOKEN_FILE" ]; then
      [ -f "$TOKEN_FILE" ] || die "$TOKEN_FILE does not exist"
      IFS= read -r TOKEN < "$TOKEN_FILE" || true
    else
      [ -t 0 ] || die "no terminal to ask for the token on: --token-file=<file>"
      printf 'New bot token (not shown): ' >&2; IFS= read -rs TOKEN; echo >&2
    fi
    TOKEN="$(printf '%s' "$TOKEN" | tr -d '\r\n[:space:]')"
    [[ "$TOKEN" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]] || die "that does not look like a bot token"
    if [ -z "$CHAT_ID" ]; then
      CHAT_ID="$(on "$S1" "sudo sed -n 's/^ALERT_TELEGRAM_CHAT_ID=//p' /etc/valuescan/alert.env" | tr -d '\r' | tail -n 1)"
    fi
    [[ "$CHAT_ID" =~ ^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$ ]] || die "no usable chat id (from server 1's alert.env, or --chat-id=<id>)"
  fi
  confirm
  tg() { printf '%s\n' "$TOKEN" | on "$1" "sudo bash $BIN/telegram-setup.sh --token-stdin --chat-id=$CHAT_ID --name='$2'"; }
  step "server 1: the new token into alert.env, a test message" "printf <token> | ssh $SSH_USER@$S1 'sudo bash $BIN/telegram-setup.sh --token-stdin --chat-id=<id>'" tg "$S1" "server 1 (France)"
  step "server 2: the same" "printf <token> | ssh $SSH_USER@$S2 'sudo bash $BIN/telegram-setup.sh --token-stdin --chat-id=<id>'" tg "$S2" "server 2 (Tokyo)"
  TOKEN=""
  echo
  info "NOW the GitHub watcher (.github/workflows/uptime.yml) - repository secret TELEGRAM_TOKEN:" \
    "  gh secret set TELEGRAM_TOKEN --repo MXer120/valuescan        (it asks for the value, hidden)" \
    "  or GitHub -> Settings -> Secrets and variables -> Actions -> TELEGRAM_TOKEN -> Update." \
    "Then delete the token file, keep the token only where you keep such things, and make a new emergency kit if it holds the token."
}

do_backup_key() {
  local label="$ARG" host holder set_
  case "$label" in
    server1) host="$S1" holder="$S2" set_=api-state ;;
    server2) host="$S2" holder="$S1" set_=executor ;;
    *) die "backup-key server1 | server2" ;;
  esac
  plan "$label's off-server backup key"
  info "Users notice: nothing. A leak lets whoever also has a copy (held on the other server, or pulled to the laptop) read it." \
    "Copies made with the OLD key open only with the old key: it is KEPT (server: backup.key.old-<stamp>, laptop:" \
    "$KEYS_DIR/$label.backup.key.old-<id>) until the last copy made with it is gone - journal copies are kept 400 days." \
    "If the old key leaked, also delete the old copies on $(name_of "$holder") (/var/lib/vsbackup) that you do not need." ""
  local node; node="$(command -v node || echo node)"
  local crypt="deploy/server/bin/backup-crypt.mjs" old_id="" new_id=""
  confirm
  step "the helper is installed on $(name_of "$host")" "ssh $SSH_USER@$host test -x $BIN/rotate-secret.sh" helper_present "$host"
  capture old_id '<old-id>' "$host" "the server's current key id (public)" backup-key id
  step "the laptop holds the CURRENT key (else fetch it first: pull-backups.sh --fetch-keys)" "node $crypt id $KEYS_DIR/$label.backup.key  (= $old_id)" \
    laptop_key_is "$label" "$old_id"
  ROLLBACK="ssh $SSH_USER@$host '$HELPER restore /etc/valuescan/offsite/backup.key.old-<stamp>', and put $KEYS_DIR/$label.backup.key.old-<id> back"
  capture new_id 'old <old-id>\nnew <new-id>' "$host" "a new backup key (the old one kept); one copy goes out with it" backup-key rotate
  new_id="$(printf '%b' "$new_id" | sed -n 's/^new //p')"
  step "keep the laptop's old key under its id" "mv $KEYS_DIR/$label.backup.key $KEYS_DIR/$label.backup.key.old-$old_id" laptop_keep_old "$label" "$old_id"
  step "fetch the new key to the laptop" "deploy/release/pull-backups.sh --fetch-keys" env SSH_KEY_FILE="$SSH_KEY" deploy/release/pull-backups.sh --fetch-keys --no-pull --dest="${KEYS_DIR%/keys}"
  step "the laptop's new key is the server's" "node $crypt id $KEYS_DIR/$label.backup.key  (= ${new_id:-<new id>})" laptop_key_is "$label" "${new_id:-x}"
  step "the newest $set_ copy (made with the new key) opens on $(name_of "$holder")" "ssh $SSH_USER@$holder 'sudo $BIN/backup-restore.sh drill $set_ --key-stdin' < $KEYS_DIR/$label.backup.key" \
    drill "$holder" "$set_" "$KEYS_DIR/$label.backup.key"
  info "" "Then: a new emergency kit (it must hold the new AND the old key)."
}
laptop_key_is() {   # label, id
  local f="$KEYS_DIR/$1.backup.key"
  [ -f "$f" ] || { say "$f is missing - run deploy/release/pull-backups.sh --fetch-keys first"; return 1; }
  local got; got="$(node deploy/server/bin/backup-crypt.mjs id "$f")"
  [ "$got" = "$2" ] || { say "$f has id $got, the server's key is $2"; return 1; }
}
laptop_keep_old() {
  local f="$KEYS_DIR/$1.backup.key" o="$KEYS_DIR/$1.backup.key.old-$2"
  [ -f "$o" ] || mv "$f" "$o"
  [ ! -f "$f" ] || rm -f "$f"
}
drill() {   # holder, set, key file
  local out; out="$(on "$1" "sudo $BIN/backup-restore.sh drill $2 --key-stdin" < "$3")" || { printf '%s\n' "$out"; return 1; }
  printf '%s\n' "$out" | tail -n 3
  printf '%s' "$out" | grep -q 'DRILL PASSED'
}

do_offsite_ssh() {
  local sender recv sip
  case "$ARG" in
    server1) sender="$S1" recv="$S2" ;;
    server2) sender="$S2" recv="$S1" ;;
    *) die "offsite-ssh server1 | server2" ;;
  esac
  sip="$sender"
  plan "the ssh key $(name_of "$sender")'s copies travel to $(name_of "$recv") with"
  info "Users notice: nothing. A leak lets someone put files into (and list) $(name_of "$recv")'s /var/lib/vsbackup -" \
    "only from $(name_of "$sender")'s address, only through backup-receive.sh; never read the copies' contents." ""
  local NEWPUB=""
  confirm
  step "the helper is installed on both" "test -x $BIN/rotate-secret.sh" both_helpers
  ROLLBACK="ssh $SSH_USER@$sender '$HELPER offsite-ssh abort' (the old key works throughout)"
  capture NEWPUB 'ssh-ed25519 AAAA...new' "$sender" "a new key pair beside the old one (its PUBLIC line comes back)" offsite-ssh new
  [ "$EXECUTE" = 1 ] && check_pub "$NEWPUB"
  step "$(name_of "$recv") accepts the new key beside the old" "printf <new public line> | $(shown_remote "$recv" "offsite-receiver add --from=$sip")" \
    pipe_remote "$NEWPUB" "$recv" "offsite-receiver add --from=$sip"
  step "the new key works" "$(shown_remote "$sender" "offsite-ssh test-new")" remote "$sender" "offsite-ssh test-new"
  ROLLBACK="ssh $SSH_USER@$sender '$HELPER restore /etc/valuescan/offsite/id_ed25519.old-<stamp>' (the receiver still accepts the old key)"
  step "$(name_of "$sender") uses the new key (old kept as id_ed25519.old-<stamp>); a test copy" "$(shown_remote "$sender" "offsite-ssh finish")" remote "$sender" "offsite-ssh finish"
  step "$(name_of "$recv") accepts ONLY the new key" "ssh $SSH_USER@$recv 'sudo bash $BIN/offsite-setup.sh receiver --from=$sip --pubkey=<new public line>'" \
    receiver_only "$recv" "$sip" "$NEWPUB"
  step "a test copy with only the new key in place" "ssh $SSH_USER@$sender 'sudo bash $BIN/offsite-setup.sh test'" on "$sender" "sudo bash $BIN/offsite-setup.sh test"
}

do_ledger() {
  plan "server 2's ledger-pull key (it reads builder.db from server 1 every 5 minutes)"
  info "Users notice: nothing. A leak lets someone read the builder ledger (wallets' counted fee volume) - only from server 2's address." ""
  local NEWPUB="" OLDPUB=""
  confirm
  step "the helper is installed on both" "test -x $BIN/rotate-secret.sh" both_helpers
  capture OLDPUB 'ssh-ed25519 AAAA...old' "$S2" "the PUBLIC line of the key in use" ledger-pull old-pub
  [ "$EXECUTE" = 1 ] && check_pub "$OLDPUB"
  ROLLBACK="ssh $SSH_USER@$S2 '$HELPER ledger-pull abort' (the old key works throughout)"
  capture NEWPUB 'ssh-ed25519 AAAA...new' "$S2" "a new key pair beside the old one (its PUBLIC line comes back)" ledger-pull new
  [ "$EXECUTE" = 1 ] && check_pub "$NEWPUB"
  step "server 1 accepts the new key, with the old line's options (from=, builder-snapshot.sh only)" "printf <new public line> | $(shown_remote "$S1" "authorized add --user=$SSH_USER --like=builder-snapshot.sh")" \
    pipe_remote "$NEWPUB" "$S1" "authorized add --user=$SSH_USER --like=builder-snapshot.sh"
  step "the new key pulls the ledger" "$(shown_remote "$S2" "ledger-pull test-new")" remote "$S2" "ledger-pull test-new"
  ROLLBACK="ssh $SSH_USER@$S2 '$HELPER restore /root/.ssh/ledger_pull.old-<stamp>' (server 1 still accepts the old key)"
  step "server 2 uses the new key; one pull" "$(shown_remote "$S2" "ledger-pull finish")" remote "$S2" "ledger-pull finish"
  step "server 1 forgets the old key (that line only)" "printf <old line>\\\\n<new line> | $(shown_remote "$S1" "authorized remove --user=$SSH_USER --like=builder-snapshot.sh")" \
    pipe_remote "$OLDPUB"$'\n'"$NEWPUB" "$S1" "authorized remove --user=$SSH_USER --like=builder-snapshot.sh"
  step "one more pull, with only the new key in place" "ssh $SSH_USER@$S2 'sudo systemctl start valuescan-ledger-pull.service'" on "$S2" "sudo systemctl start valuescan-ledger-pull.service"
}

do_laptop_ssh() {
  local new="$SSH_KEY.new"
  plan "the laptop's ssh key ($SSH_KEY) for both servers"
  info "Never a lock-out: the old key is removed from a server only after the new key logged in to BOTH and ran sudo," \
    "and the old key file stays on the laptop as $SSH_KEY.old-$STAMP." \
    "ssh-keygen asks for a PASSPHRASE for the new key (twice). The release scripts use BatchMode: load the key into an" \
    "agent once per session - eval \"\$(ssh-agent -s)\"; ssh-add $SSH_KEY - or they cannot log in." \
    "Users notice: nothing. A leak lets someone log in to both servers as $SSH_USER (with sudo): everything." ""
  confirm
  step "the old key logs in to both servers now" "ssh $SSH_USER@<both> true" both_login_old
  step "the helper is installed on both" "test -x $BIN/rotate-secret.sh" both_helpers
  step "a new ed25519 key with a passphrase" "ssh-keygen -t ed25519 -a 100 -C valuedesk-laptop-$STAMP -f $new" make_laptop_key "$new"
  local h
  for h in "$S1" "$S2"; do
    step "$(name_of "$h") accepts the new key beside the old one" "ssh $SSH_USER@$h '$HELPER authorized add --user=$SSH_USER' < $new.pub" \
      add_login "$h" "$new.pub"
  done
  ROLLBACK="nothing was removed - the old key works; ssh $SSH_USER@<server> '$HELPER authorized remove --user=$SSH_USER' < $new.pub takes the new one out again"
  for h in "$S1" "$S2"; do
    step "the NEW key logs in to $(name_of "$h") and runs sudo" "ssh -i $new $SSH_USER@$h 'sudo -n true && echo vd-login-ok'" login_ok "$new" "$h"
  done
  for h in "$S1" "$S2"; do
    step "$(name_of "$h") forgets the old key (with the new key; refuses if the new one would not remain)" \
      "printf <old .pub>\\\\n<new .pub> | ssh -i $new $SSH_USER@$h '$HELPER authorized remove --user=$SSH_USER'" remove_old_login "$new" "$h"
    step "the new key still logs in to $(name_of "$h")" "ssh -i $new $SSH_USER@$h 'sudo -n true && echo vd-login-ok'" login_ok "$new" "$h"
  done
  ROLLBACK=""
  step "the laptop: the new key under the usual name, the old kept" "mv $SSH_KEY $SSH_KEY.old-$STAMP && mv $new $SSH_KEY (and .pub)" swap_laptop_key "$new"
  info "" "Then: Contabo's panel (Server -> SSH keys, used for a reinstall): put in $SSH_KEY.pub;" \
    "a new emergency kit (deploy/release/emergency-kit.sh create); delete $SSH_KEY.old-$STAMP once the kit is made."
}
make_laptop_key() {
  [ ! -e "$1" ] || die "$1 exists already (a rotation that did not finish?) - move it away first"
  if [ "${RS_TEST_NO_PASSPHRASE:-0}" = 1 ]; then ssh-keygen -q -t ed25519 -a 100 -N '' -C "valuedesk-laptop-$STAMP" -f "$1"
  else ssh-keygen -q -t ed25519 -a 100 -C "valuedesk-laptop-$STAMP" -f "$1"; fi
  if [ "${RS_TEST_NO_PASSPHRASE:-0}" != 1 ] && ssh-keygen -y -P '' -f "$1" >/dev/null 2>&1; then
    rm -f "$1" "$1.pub"; die "the new key has no passphrase - made again with one, please"
  fi
  narrow_acl "$1"
  [ -n "${SSH_AUTH_SOCK:-}" ] && ssh-add "$1" 2>/dev/null || true
}
login_ok() { on_key "$1" "$2" 'sudo -n true && echo vd-login-ok' | grep -q vd-login-ok; }
remove_old_login() {   # new key, host
  local old_pub; old_pub="$SSH_KEY.pub"
  [ -f "$old_pub" ] || { ssh-keygen -y -f "$SSH_KEY" > "$SSH_KEY.pub.tmp" && old_pub="$SSH_KEY.pub.tmp"; }
  { head -n 1 "$old_pub"; head -n 1 "$1.pub"; } | on_key "$1" "$2" "$HELPER authorized remove --user=$SSH_USER"
  rm -f "$SSH_KEY.pub.tmp"
}
swap_laptop_key() {
  mv "$SSH_KEY" "$SSH_KEY.old-$STAMP"
  [ -f "$SSH_KEY.pub" ] && mv "$SSH_KEY.pub" "$SSH_KEY.old-$STAMP.pub"
  mv "$1" "$SSH_KEY"
  mv "$1.pub" "$SSH_KEY.pub"
  narrow_acl "$SSH_KEY"
}
narrow_acl() {
  chmod 600 "$1" 2>/dev/null || true
  if command -v icacls >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
    icacls "$(cygpath -w "$1")" /inheritance:r /grant:r "${USERNAME:-$USER}:F" >/dev/null || say "WARNING: could not narrow the ACL of $1"
  fi
}

do_terms() {
  case "$ARG" in
    begin)
      plan "builder terms key, part 1 of 2: a new key on server 1, its PUBLIC half into the web build"
      info "What it signs: the fee terms (docs/BUILDER-TIERS.md §3) - a lower builder fee for one wallet, 10 minutes." \
        "A leak lets someone make the app accept a lower fee than the tiers give (lost fee income, no user funds at risk)." \
        "The web build pins the public key(s): VITE_BUILDER_TERMS_KEYS. With both pinned first, nobody notices the switch;" \
        "a tab still on a build that pins only the old key pays the default fee until it reloads." ""
      local OUT=""
      confirm
      step "the helper is installed on server 1" "ssh $SSH_USER@$S1 test -x $BIN/rotate-secret.sh" helper_present "$S1"
      capture OUT 'current <current-public-key> <id>\nnext <next-public-key> <id>' "$S1" "builder-terms.key.next (0600, owner valuescan); both PUBLIC keys come back" terms-key new
      local cur nxt
      cur="$(printf '%b\n' "$OUT" | sed -n 's/^current \([^ ]*\) .*/\1/p')"
      nxt="$(printf '%b\n' "$OUT" | sed -n 's/^next \([^ ]*\) .*/\1/p')"
      echo
      info "NOW (the owner): pin BOTH keys in the web build, commit, push to main (Vercel deploys it):" \
        "  deploy/vercel/production.settings:  VITE_BUILDER_TERMS_KEYS=$cur,$nxt" \
        "  deploy/release/web.env (if used):   the same line" \
        "Wait until that deployment is live (a day lets old tabs reload), THEN: deploy/release/rotate.sh builder-terms finish --execute" \
        "Changed your mind: deploy/release/rotate.sh builder-terms abort --execute"
      ;;
    finish)
      plan "builder terms key, part 2 of 2: the new key signs"
      info "Before: the LIVE web build pins the new key (VITE_BUILDER_TERMS_KEYS has both)." ""
      ROLLBACK="ssh $SSH_USER@$S1 '$HELPER restore /var/lib/valuescan/state/builder-terms.key.old-<stamp>'"
      confirm
      ask_done "the web build that pins both keys is live"
      step "the next key in force; the terms come signed by it" "$(shown_remote "$S1" "terms-key finish")" remote "$S1" "terms-key finish"
      info "" "Later (a day or more): take the OLD public key out of VITE_BUILDER_TERMS_KEYS, deploy; then delete" \
        "server 1's builder-terms.key.old-<stamp>. If the old key leaked, do that at once."
      ;;
    abort)
      plan "builder terms key: forget the next key"
      confirm
      step "remove builder-terms.key.next" "$(shown_remote "$S1" "terms-key abort")" remote "$S1" "terms-key abort"
      info "and take its public key out of VITE_BUILDER_TERMS_KEYS again if you added it."
      ;;
    *) die "builder-terms begin | finish | abort" ;;
  esac
}

do_apikey() {
  plan "$1 API key (server 1 /etc/valuescan/api.local.env)"
  info "Make a new key in the provider's console first, then revoke the old one there." \
    "  VS_EC2_ENV=$ENV1 deploy/release/set-$1-key.sh        (asks for the key, hidden; restarts the API; checks it)" \
    "Users notice: the widgets that use it pause for the API restart. A leak lets someone spend your quota."
}

case "$WHAT" in
  list) do_list ;;
  status) do_status ;;
  origin-secret) do_origin ;;
  executor-session) do_executor session ;;
  executor-import) do_executor import ;;
  executor-kek) do_executor kek ;;
  folders-session) do_api_session folders ;;
  feedback-session) do_api_session feedback ;;
  telegram) do_telegram ;;
  backup-key) do_backup_key ;;
  offsite-ssh) do_offsite_ssh ;;
  ledger-pull) do_ledger ;;
  laptop-ssh) do_laptop_ssh ;;
  builder-terms) do_terms ;;
  sosovalue|youtube) do_apikey "$WHAT" ;;
  *) die "unknown: $WHAT (deploy/release/rotate.sh list)" ;;
esac
if [ "$EXECUTE" = 1 ]; then echo; say "done: $WHAT${ARG:+ $ARG}"; fi
