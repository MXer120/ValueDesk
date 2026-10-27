#!/usr/bin/env bash
# A consistent copy of the builder ledger on stdout, for the copy executor on its own server
# (it reads the copy fee tiers from it). Server 2 runs this over SSH with a key that may run
# only this command (~almalinux/.ssh/authorized_keys on server 1).
set -euo pipefail
src=/var/lib/valuescan/state/builder.db
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
chown valuescan "$tmp"
cat > "$tmp/snap.js" <<'JS'
const { DatabaseSync } = require('node:sqlite');
const [src, dst] = process.argv.slice(2);
new DatabaseSync(src, { readOnly: true }).exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
JS
sudo -u valuescan /opt/node/current/bin/node --disable-warning=ExperimentalWarning "$tmp/snap.js" "$src" "$tmp/builder.db"
cat "$tmp/builder.db"
