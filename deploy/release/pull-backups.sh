#!/usr/bin/env bash
# Pull the small, critical off-server copies onto THIS computer (the owner's laptop): a
# third place, apart from both servers. Run it now and then (weekly is plenty).
#
#   deploy/release/pull-backups.sh                     the newest api-state copy (held on server 2) and
#                                                      the newest executor copy (held on server 1)
#   deploy/release/pull-backups.sh --sets=api-state,executor,folders,journal
#   deploy/release/pull-backups.sh --all-new           every copy of those sets not here yet, not only the newest
#   deploy/release/pull-backups.sh --verify            open each pulled copy with its key (needs the keys, below)
#   deploy/release/pull-backups.sh --fetch-keys        ONCE: copy both servers' backup keys to <dest>/keys (0600;
#                                                      never printed). Without them nothing here can be opened.
#   ... --dest=<dir>                                   default: ~/ValueDesk-backups
#   ... --no-pull                                      with --fetch-keys: the keys only, no copies (rotate.sh backup-key)
#
# THE BANDWIDTH CAP of this laptop (20 Mbit/s down): every copy comes with `scp -l 16000`
# (16 Mbit/s). api-state, executor and a day of journal are a few MB. The index (~4.6 GB,
# about 40 minutes) and the HL archive are refused unless named in --sets AND
# --big-ok is given - ask the owner first.
#
# HOW: over the usual SSH login (almalinux, ~/.ssh/valuescan-contabo). On the server
# holding the copies, `sudo` stages the chosen files in ~almalinux/backup-pull (they are
# encrypted - nothing readable is staged), scp fetches them, the staging is removed.
# Each file is checked against its .sha256 after the download.
#
# WHICH KEY OPENS WHAT: a copy is encrypted with the key of the server that SENT it -
# server1.backup.key for api-state, folders, index, hl-archive and server 1's journal
# (held on server 2); server2.backup.key for executor and server 2's journal (held on
# server 1). Open one: bash deploy/server/bin/backup-restore.sh open <file.enc> <key> <dir>
# (NODE_BIN_DIR=<the folder of node.exe>). Keep <dest>/keys off OneDrive or other sync,
# ideally in the password manager as well.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER1=161.97.154.121
SERVER2=13.140.77.201
SSH_KEY="${SSH_KEY_FILE:-$HOME/.ssh/valuescan-contabo}"
SSH_USER="${SSH_USER:-almalinux}"
DEST="${PULL_DEST:-$HOME/ValueDesk-backups}"
SETS="api-state,executor"
ALL_NEW=0 VERIFY=0 FETCH_KEYS=0 BIG_OK=0 NO_PULL=0

die() { echo "pull-backups: $*" >&2; exit 1; }
say() { echo "pull-backups: $*" >&2; }

for a in "$@"; do
  case "$a" in
    --sets=*) SETS="${a#--sets=}" ;;
    --all-new) ALL_NEW=1 ;;
    --verify) VERIFY=1 ;;
    --fetch-keys) FETCH_KEYS=1 ;;
    --big-ok) BIG_OK=1 ;;
    --no-pull) NO_PULL=1 ;;
    --dest=*) DEST="${a#--dest=}" ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $a (--help)" ;;
  esac
done
[ -f "$SSH_KEY" ] || die "no SSH key at $SSH_KEY"
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 -o LogLevel=ERROR)
on() { local host="$1"; shift; ssh "${SSH_OPTS[@]}" "$SSH_USER@$host" "$@"; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || NODE="/c/Users/$USERNAME/AppData/Local/ddx-tools/node-v24.22.1-win-x64/node"

# Which server holds which set, and which server's key opens it.
holder_of() { case "$1" in executor) echo "$SERVER1" ;; *) echo "$SERVER2" ;; esac; }
sender_of() { case "$1" in executor) echo server2 ;; *) echo server1 ;; esac; }

mkdir -p "$DEST"
( umask 077; mkdir -p "$DEST/keys" )

if [ "$FETCH_KEYS" = 1 ]; then
  for pair in "server1:$SERVER1" "server2:$SERVER2"; do
    label="${pair%%:*}" host="${pair#*:}" out="$DEST/keys/$label.backup.key"
    if [ -f "$out" ]; then say "$out is here already - not replaced"; continue; fi
    ( umask 077; on "$host" 'sudo cat /etc/valuescan/offsite/backup.key' > "$out.part" ) || { rm -f "$out.part"; die "could not read the backup key of $label"; }
    grep -qE '^[0-9a-f]{64}$' "$out.part" || { rm -f "$out.part"; die "what came from $label is not a backup key"; }
    mv "$out.part" "$out"
    chmod 600 "$out" 2>/dev/null || true
    if command -v icacls >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
      icacls "$(cygpath -w "$out")" /inheritance:r /grant:r "${USERNAME:-$USER}:F" >/dev/null || say "WARNING: could not narrow the ACL of $out"
    fi
    say "saved the backup key of $label (id $("$NODE" "$ROOT/deploy/server/bin/backup-crypt.mjs" id "$out")) to $out - also put it in the password manager"
  done
fi

[ "$NO_PULL" = 1 ] && { say "done: keys only (--no-pull)"; exit 0; }
IFS=',' read -r -a want <<< "$SETS"
for s in "${want[@]}"; do
  case "$s" in
    api-state|executor|folders|journal) ;;
    index|hl-archive) [ "$BIG_OK" = 1 ] || die "$s is big (index ~4.6 GB = ~40 minutes at the laptop's cap): add --big-ok, after asking the owner" ;;
    *) die "unknown set $s" ;;
  esac
done

pulled=()
for host in "$SERVER2" "$SERVER1"; do
  sets_here=()
  for s in "${want[@]}"; do
    if [ "$s" = journal ] || [ "$(holder_of "$s")" = "$host" ]; then sets_here+=("$s"); fi
  done
  [ "${#sets_here[@]}" -gt 0 ] || continue
  listing="$(on "$host" 'sudo -u vsbackup /opt/valuescan/bin/backup-receive.sh list')" || die "could not list the copies on $host"
  label="$([ "$host" = "$SERVER1" ] && echo server1 || echo server2)"
  files=()
  for s in "${sets_here[@]}"; do
    mapfile -t names < <(printf '%s\n' "$listing" | awk -v s="$s" '$1 ~ "^"s"/" {print $1}' | grep -v '\.test\.enc$' | sort)
    [ "${#names[@]}" -gt 0 ] || { say "$label holds no $s copy yet"; continue; }
    [ "$ALL_NEW" = 1 ] || names=("${names[-1]}")
    for n in "${names[@]}"; do
      [ -f "$DEST/held-on-$label/$n" ] || files+=("$n")
    done
  done
  [ "${#files[@]}" -gt 0 ] || { say "$label: nothing new"; continue; }
  say "$label: staging ${#files[@]} file(s)"
  list="$(printf '%s ' "${files[@]}")"
  case "$list" in *[!A-Za-z0-9._/\ -]*) die "unexpected characters in the file list" ;; esac
  on "$host" "set -e; sudo rm -rf ~/backup-pull; install -d -m 0700 ~/backup-pull; for f in $list; do sudo cp \"/var/lib/vsbackup/\$f\" \"/var/lib/vsbackup/\$f.sha256\" ~/backup-pull/; done; sudo chown -R \$(id -u):\$(id -g) ~/backup-pull"
  mkdir -p "$DEST/held-on-$label/tmp"
  # 16000 Kbit/s: under the laptop's 20 Mbit/s cap.
  scp -l 16000 -p -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o LogLevel=ERROR "$SSH_USER@$host:backup-pull/*" "$DEST/held-on-$label/tmp/"
  on "$host" 'rm -rf ~/backup-pull'
  for n in "${files[@]}"; do
    b="$(basename "$n")" set="${n%%/*}"
    (cd "$DEST/held-on-$label/tmp" && sha256sum -c --quiet "$b.sha256") || die "$b does not match its .sha256 - not kept"
    mkdir -p "$DEST/held-on-$label/$set"
    mv -f "$DEST/held-on-$label/tmp/$b" "$DEST/held-on-$label/tmp/$b.sha256" "$DEST/held-on-$label/$set/"
    pulled+=("held-on-$label/$set/$b")
    say "got $set/$b"
  done
  rmdir "$DEST/held-on-$label/tmp" 2>/dev/null || true
done

if [ "$VERIFY" = 1 ]; then
  for p in "${pulled[@]}"; do
    b="$(basename "$p")" set="${b%%-2*}"
    holder="${p#held-on-}"; holder="${holder%%/*}"
    key="$DEST/keys/$( [ "$set" = journal ] && { [ "$holder" = server1 ] && echo server2 || echo server1; } || sender_of "$set").backup.key"
    [ -f "$key" ] || { say "no key $key for $b (run once with --fetch-keys)"; continue; }
    if "$NODE" "$ROOT/deploy/server/bin/backup-crypt.mjs" decrypt "$key" < "$DEST/$p" > /dev/null; then say "verified: $b opens with $(basename "$key") and is complete"; else die "$b does NOT open with $(basename "$key")"; fi
  done
fi
say "done: ${#pulled[@]} new file(s) in $DEST"
