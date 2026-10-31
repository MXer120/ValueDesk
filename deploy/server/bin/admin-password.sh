#!/usr/bin/env bash
# /opt/valuescan/bin/admin-password.sh - the password of the admin suite (https://dev.valuedesk.so), on
# SERVER 1, where the API keeps it: only its scrypt hash, in the state directory (admin-auth/password, 0600,
# the API's user). Signing in there takes the SoDEX builder wallet's signature AND this password.
#
#   sudo bash /opt/valuescan/bin/admin-password.sh            set or change it: typed twice, nothing is shown
#   sudo bash /opt/valuescan/bin/admin-password.sh --status   whether one is set
#   sudo bash /opt/valuescan/bin/admin-password.sh --off      turn the suite off (every admin route a 404 again)
#
# Run it in an SSH terminal. The password never goes in an argument, the environment or a file - the tool
# refuses a pipe. Setting, changing or turning it off signs every admin session out. No API restart needed:
# the API reads the hash at each sign-in (apps/server/src/admin/auth.ts).
set -euo pipefail

APP="${VALUESCAN_APP_DIR:-/opt/valuescan/current/apps/server}"
NODE="${NODE_BIN_DIR:-/opt/node/current/bin}/node"
STATE="${VALUESCAN_STATE_DIR:-/var/lib/valuescan/state}"
AS="${ADMIN_USER:-valuescan}"

die() { echo "admin-password: $*" >&2; exit 2; }

[ -d "$APP" ] || die "$APP does not exist (VALUESCAN_APP_DIR)"
[ -x "$NODE" ] || die "$NODE does not exist (NODE_BIN_DIR)"
[ -t 0 ] || die "run this in a terminal: the password is typed, never piped"
case "${1:-}" in ''|--status|--off) ;; *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;; esac

# As the API's own user, so the hash and admin.db stay that user's (the API reads them).
run() {
  local env=(VALUESCAN_ADMIN_PASSWORD_FILE="$STATE/admin-auth/password" VALUESCAN_ADMIN_DB="$STATE/admin.db")
  if [ "$(id -un)" = "$AS" ]; then
    (cd "$APP" && env "${env[@]}" "$NODE" --disable-warning=ExperimentalWarning --import tsx tools/admin-password.ts "$@")
  else
    (cd "$APP" && sudo -u "$AS" env "${env[@]}" "$NODE" --disable-warning=ExperimentalWarning --import tsx tools/admin-password.ts "$@")
  fi
}

run "$@"
