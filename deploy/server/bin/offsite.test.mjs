// node --disable-warning=ExperimentalWarning --test deploy/server/bin/offsite.test.mjs
//
// The off-server backups end to end, on this machine: backup-offsite.sh puts a set
// together and sends it - through OFFSITE_TRANSPORT=local straight into
// backup-receive.sh, as ssh's forced command would - and backup-restore.sh opens it
// again. Everything lives in a temporary directory; no ssh, no network, no unit.
// Needs bash with GNU tar, find, stat and sha256sum (Linux, or Git Bash on Windows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// A build machine without these tools (Vercel's, perhaps) skips this file and says so;
// CI (.github/workflows/ci.yml, Ubuntu) and the servers have them all.
const TOOLS = spawnSync("bash", ["-c", "command -v tar find stat sha256sum head >/dev/null && tar --version | grep -q GNU"], { encoding: "utf8" });
const SKIP = TOOLS.status === 0 ? false : "needs bash with GNU tar, find, stat and sha256sum";
// Bash on Windows wants /c/... paths; elsewhere a path is a path.
const sh = (p) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : p);

function world() {
  const root = mkdtempSync(join(tmpdir(), 'vs-offsite-'));
  const d = (...p) => {
    const x = join(root, ...p);
    mkdirSync(x, { recursive: true });
    return x;
  };
  const w = {
    root,
    state: d('state'), executor: d('executor'), etc: d('etc', 'valuescan'), offsite: d('etc', 'valuescan', 'offsite'),
    work: d('work'), receive: d('receive'), archive: d('archive'), indexBackups: d('index-backups'), open: join(root, 'open'),
  };
  const db = (file, rows) => {
    const x = new DatabaseSync(file);
    x.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (v TEXT)');
    for (const r of rows) x.prepare('INSERT INTO t (v) VALUES (?)').run(r);
    x.close();
  };
  db(join(w.state, 'builder.db'), ['ledger row 1', 'ledger row 2']);
  writeFileSync(join(w.state, 'builder-terms.key'), 'stand-in signing key\n', { mode: 0o600 });
  writeFileSync(join(w.state, 'builder-tiers.json'), '{"tiers":[]}\n');
  db(join(w.executor, 'executor.db'), ['copy 1']);
  // The executor's secrets: they must never travel.
  writeFileSync(join(w.executor, 'kek'), 'K'.repeat(32), { mode: 0o600 });
  writeFileSync(join(w.executor, 'session.key'), 'S'.repeat(32), { mode: 0o600 });
  writeFileSync(join(w.executor, 'import.key'), 'I'.repeat(32), { mode: 0o600 });
  writeFileSync(join(w.etc, 'api.env'), 'VALUESCAN_HOSTED=1\n');
  writeFileSync(join(w.etc, 'api.secret.env'), 'VALUESCAN_ORIGIN_SECRET=made-up-for-the-test\n', { mode: 0o600 });
  writeFileSync(join(w.etc, 'indexer.local.env.bak-20261027'), 'OLD=1\n');
  writeFileSync(join(w.archive, 'hl-positions.tsv.gz'), 'positions');
  writeFileSync(join(w.indexBackups, 'valuescan-index-20261027T032324Z.db.zst'), 'zstd bytes of the index');
  writeFileSync(join(w.indexBackups, 'valuescan-index-20261027T032324Z.db.zst.sha256'), 'abc  valuescan-index-20261027T032324Z.db\n');
  w.key = join(w.offsite, 'backup.key');
  w.receiveConf = join(root, 'receive.env');
  writeFileSync(w.receiveConf, [
    `RECEIVE_DIR=${sh(w.receive)}`,
    'RECEIVE_SETS="api-state folders executor index hl-archive"',
    'RECEIVE_KEEP_DAYS_api_state=14',
    'RECEIVE_KEEP_DAYS_folders=7',
    'RECEIVE_STRICT_SETS="folders"',
    'RECEIVE_MIN_FREE_GB=0',
    '',
  ].join('\n'));
  const r = spawnSync(process.execPath, [join(HERE, 'backup-crypt.mjs'), 'keygen', w.key], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return w;
}

function envOf(w, extra = {}) {
  return {
    ...process.env,
    OFFSITE_CONF: sh(join(w.root, 'no-such.env')),
    OFFSITE_LABEL: 'server-test',
    OFFSITE_TRANSPORT: 'local',
    OFFSITE_SNAPSHOT_AS: 'self',
    OFFSITE_RATE_MBPS: '0',
    OFFSITE_KEY: sh(w.key),
    OFFSITE_WORK: sh(w.work),
    OFFSITE_SETS: 'api-state executor',
    STATE_DIR: sh(w.state),
    EXECUTOR_DIR: sh(w.executor),
    ETC_DIR: sh(w.etc),
    CADDYFILE: sh(join(w.root, 'no-caddyfile')),
    ARCHIVE_DIR: sh(w.archive),
    BACKUP_DIR: sh(w.indexBackups),
    RECEIVE_CONF: sh(w.receiveConf),
    NODE_BIN_DIR: sh(dirname(process.execPath)),
    ALERT_TELEGRAM_TOKEN: '',
    ...extra,
  };
}

const bash = (script, args, env, input) => spawnSync('bash', [sh(join(HERE, script)), ...args], { encoding: 'utf8', env, input });
const stored = (w, set) => readdirSync(join(w.receive, set)).filter((f) => f.endsWith('.enc')).sort();

test('a set travels encrypted, arrives checked, opens again - and the executor\'s kek, session.key and import.key never leave', { skip: SKIP }, () => {
  const w = world();
  try {
    const p = bash('backup-offsite.sh', ['push', 'api-state'], envOf(w));
    assert.equal(p.status, 0, `${p.stdout}\n${p.stderr}`);
    assert.match(p.stdout, /api-state: stored on the other side as api-state-\d{8}T\d{6}Z\.tar\.enc/);
    const [name] = stored(w, 'api-state');
    const enc = readFileSync(join(w.receive, 'api-state', name));
    assert.equal(enc.subarray(0, 4).toString(), 'VDBK', 'what arrives is the encrypted format');
    assert.ok(!enc.includes(Buffer.from('ledger row')) && !enc.includes(Buffer.from('made-up-for-the-test')), 'nothing readable in transit or at rest');
    const marker = JSON.parse(readFileSync(join(w.state, 'offsite-api-state.json'), 'utf8'));
    assert.equal(marker.name, name);

    const o = bash('backup-restore.sh', ['open', sh(join(w.receive, 'api-state', name)), sh(w.key), sh(w.open)], envOf(w));
    assert.equal(o.status, 0, `${o.stdout}\n${o.stderr}`);
    assert.match(o.stdout, /ok {6}.*builder\.db .*integrity ok/);
    assert.match(o.stdout, /builder-terms\.key/);
    assert.match(o.stdout, /api\.secret\.env/);
    assert.doesNotMatch(o.stdout, /offsite\/backup\.key|\.bak-2026/, 'neither the backup key itself nor old .bak files go along');

    const e = bash('backup-offsite.sh', ['push', 'executor'], envOf(w));
    assert.equal(e.status, 0, `${e.stdout}\n${e.stderr}`);
    const [ename] = stored(w, 'executor');
    const eo = bash('backup-restore.sh', ['open', sh(join(w.receive, 'executor', ename)), sh(w.key), sh(join(w.root, 'open-exec'))], envOf(w));
    assert.equal(eo.status, 0, eo.stderr);
    assert.match(eo.stdout, /executor\.db/);
    assert.doesNotMatch(eo.stdout, /kek|session\.key|import\.key/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('a kek that turns up in a set is refused before anything is encrypted or sent', { skip: SKIP }, () => {
  const w = world();
  try {
    writeFileSync(join(w.etc, 'kek'), 'a kek someone copied here');
    const r = bash('backup-offsite.sh', ['push', 'executor'], envOf(w));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /REFUSED: the set would contain .*kek/);
    assert.equal(readdirSync(w.receive).length, 0, 'nothing arrived');
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('the timer\'s run sends a set again only when it changed (or is due), and the receiver keeps every copy apart', { skip: SKIP }, () => {
  const w = world();
  try {
    const env = envOf(w, { OFFSITE_SETS: 'api-state' });
    assert.equal(bash('backup-offsite.sh', ['run'], env).status, 0);
    const again = bash('backup-offsite.sh', ['run'], env);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /api-state: unchanged since the last copy/);
    assert.equal(stored(w, 'api-state').length, 1);
    const x = new DatabaseSync(join(w.state, 'builder.db'));
    x.prepare('INSERT INTO t (v) VALUES (?)').run('a new ledger row');
    x.close();
    // Names carry the second: wait for the next one.
    const until = Date.now() + 1100;
    while (Date.now() < until) { /* the clock */ }
    const changed = bash('backup-offsite.sh', ['run'], env);
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(stored(w, 'api-state').length, 2, 'a changed ledger is sent');
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('the weekly sets: the index backup and the archive, each sent once per new content', { skip: SKIP }, () => {
  const w = world();
  try {
    const r = bash('backup-offsite.sh', ['push', 'index'], envOf(w));
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(stored(w, 'index').length, 1);
    const a = bash('backup-offsite.sh', ['push', 'hl-archive'], envOf(w));
    assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
    const o = bash('backup-restore.sh', ['open', sh(join(w.receive, 'index', stored(w, 'index')[0])), sh(w.key), sh(w.open)], envOf(w));
    assert.equal(o.status, 0, o.stderr);
    assert.match(o.stdout, /valuescan-index-20261027T032324Z\.db\.zst /);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('the receiver refuses what does not match, never replaces a copy, and prunes by age but keeps the newest', { skip: SKIP }, () => {
  const w = world();
  try {
    const env = envOf(w);
    const data = 'x'.repeat(100);
    const sha = spawnSync('sha256sum', { input: data, encoding: 'utf8' }).stdout.slice(0, 64);
    const put = (cmd, input = data) => bash('backup-receive.sh', [], { ...env, SSH_ORIGINAL_COMMAND: cmd }, input);
    assert.match(put(`put api-state api-state-20261001T000000Z.tar.enc 100 ${'0'.repeat(64)}`).stderr, /SHA-256 of what arrived is not the one announced/);
    assert.match(put(`put api-state api-state-20261001T000000Z.tar.enc 101 ${sha}`).stderr, /100 bytes arrived, 101 were announced/);
    assert.match(put(`put journal journal-20261001T000000Z.journal.enc 100 ${sha}`).stderr, /does not take the set 'journal'/);
    assert.match(put(`put api-state ../../etc/passwd 100 ${sha}`).stderr, /unexpected characters|a backup name is/);
    assert.match(put(`put api-state api-state-20261001T000000Z.tar.enc 100 ${sha}; rm -rf /`).stderr, /unexpected characters/);
    assert.equal(put(`put api-state api-state-20261001T000000Z.tar.enc 100 ${sha}`).status, 0);
    assert.match(put(`put api-state api-state-20261001T000000Z.tar.enc 100 ${sha}`).stderr, /exists already/);
    assert.equal(put(`put api-state api-state-20261002T000000Z.tar.enc 100 ${sha}`).status, 0);
    assert.equal(put(`put folders folders-20261002T000000Z.tar.enc 100 ${sha}`).status, 0);
    // Both api-state copies 20 days old (retention 14), the folders one 8 days (retention 7, strict).
    const ago = (days) => (Date.now() - days * 86_400_000) / 1000;
    for (const f of stored(w, 'api-state')) utimesSync(join(w.receive, 'api-state', f), ago(20), ago(20));
    utimesSync(join(w.receive, 'folders', 'folders-20261002T000000Z.tar.enc'), ago(8), ago(8));
    const pr = put('prune');
    assert.equal(pr.status, 0, pr.stderr);
    assert.deepEqual(stored(w, 'api-state'), ['api-state-20261002T000000Z.tar.enc'], 'the newest stays: a dead sender never loses its last copy');
    assert.deepEqual(stored(w, 'folders'), [], 'strict: the folders\' copies go after 7 days, the newest too');
    const ls = put('list');
    assert.match(ls.stdout, /^api-state\/api-state-20261002T000000Z\.tar\.enc 100 /m);
    assert.match(put('shell').stderr, /unknown command/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('the drill opens the newest copy with a key from stdin and leaves nothing behind', { skip: SKIP }, () => {
  const w = world();
  try {
    assert.equal(bash('backup-offsite.sh', ['push', 'api-state'], envOf(w)).status, 0);
    const key = readFileSync(w.key, 'utf8');
    // The drill's scratch is /var/tmp/vs-drill.* (backup-restore.sh): none of it may stay. Not a count of
    // the shared temp directory - suites running beside this one fill it (Vercel's gate, 2026-10-29).
    const drills = () => (existsSync('/var/tmp') ? readdirSync('/var/tmp').filter((f) => f.startsWith('vs-drill.')) : []);
    const before = drills();
    const d = spawnSync('bash', [sh(join(HERE, 'backup-restore.sh')), 'drill', 'api-state', '--key-stdin'], { encoding: 'utf8', env: envOf(w), input: key });
    if (d.status !== 0 && /vs-drill/.test(d.stderr) && process.platform === 'win32') return; // no /var/tmp on this Windows
    assert.equal(d.status, 0, `${d.stdout}\n${d.stderr}`);
    assert.match(d.stdout, /DRILL PASSED/);
    assert.deepEqual(drills().filter((f) => !before.includes(f)), [], 'no drill scratch left behind');
    const wrong = spawnSync('bash', [sh(join(HERE, 'backup-restore.sh')), 'drill', 'api-state', '--key-stdin'], { encoding: 'utf8', env: envOf(w), input: `${'0'.repeat(64)}\n` });
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /another key|could not decrypt/);
    assert.deepEqual(drills().filter((f) => !before.includes(f)), [], 'nor after a wrong key');
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});
