// node --disable-warning=ExperimentalWarning --test deploy/server/bin/rotate-secret.test.mjs
//
// The server half of the secret rotations (rotate-secret.sh), on this machine: fake data
// directories in a temporary folder, a fake systemctl (records what it is asked), a fake curl
// (answers the health checks; the terms route answers with the keyId of the key file in
// place). The executor's directory is made by the real code (Secrets, ExecutorDb) and rotated
// by the real tools (apps/executor/tools/rotate-kek.ts, rotate-key.ts). No unit, no ssh, no
// network. Needs bash, sha256sum, stat and ssh-keygen (Linux, or Git Bash on Windows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const APP = join(ROOT, 'apps', 'executor');
const TOOLS = spawnSync('bash', ['-c', 'command -v sha256sum stat ssh-keygen head >/dev/null'], { encoding: 'utf8' });
const SKIP = TOOLS.status === 0 ? false : 'needs bash with sha256sum, stat, head and ssh-keygen';
const sh = (p) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : p);

function world() {
  const root = mkdtempSync(join(tmpdir(), 'vs-rotsec-'));
  const d = (...p) => {
    const x = join(root, ...p);
    mkdirSync(x, { recursive: true });
    return x;
  };
  const w = { root, etc: d('etc'), exec: d('executor'), state: d('state'), offsite: d('etc', 'offsite'), bin: d('fakebin'), log: join(root, 'systemctl.log') };
  w.folders = d('state', 'folders');
  w.feedback = d('state', 'feedback-auth');
  writeFileSync(join(w.etc, 'executor-here'), '');
  writeFileSync(join(w.etc, 'executor.env'), 'SODEX_NETWORK=mainnet\n');
  writeFileSync(join(w.etc, 'api.secret.env'), 'VALUESCAN_ORIGIN_SECRET=made-up-current,made-up-next\n');
  // systemctl: records every call; `is-active` says active; FAKE_FAIL_START=1 makes start fail.
  writeFileSync(join(w.bin, 'systemctl'), `#!/usr/bin/env bash\necho "$*" >> "${sh(w.log)}"\ncase "$1" in is-active) exit 0 ;; start) [ "\${FAKE_FAIL_START:-0}" = 1 ] && exit 1 ;; esac\nexit 0\n`);
  // curl: the health answers; the terms route answers with the keyId of the key in place.
  writeFileSync(join(w.bin, 'curl.mjs'), `
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
const url = process.argv.slice(2).find((a) => a.startsWith('http')) ?? '';
if (process.env.FAKE_CURL_FAIL === '1') process.exit(7);
if (url.includes('/api/vs/builder/terms')) {
  const x = createPublicKey(createPrivateKey(readFileSync(process.env.TERMS_KEY_WIN, 'utf8'))).export({ format: 'jwk' }).x;
  console.log(JSON.stringify({ ok: true, keyId: createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex').slice(0, 8) }));
} else console.log('{"ok":true}');
`);
  writeFileSync(join(w.bin, 'curl'), `#!/usr/bin/env bash\nexec "${sh(process.execPath)}" "${sh(join(w.bin, 'curl.mjs'))}" "$@"\n`);
  writeFileSync(join(w.bin, 'push'), `#!/usr/bin/env bash\necho "push $*" >> "${sh(w.log)}"\n[ "\${FAKE_FAIL_PUSH:-0}" = 1 ] && exit 1\nexit 0\n`);
  for (const f of ['systemctl', 'curl', 'push']) chmodSync(join(w.bin, f), 0o755);
  return w;
}

const envOf = (w, extra = {}) => ({
  ...process.env,
  ROTATE_ALLOW_NONROOT: '1',
  ROTATE_AS: 'self',
  NODE: sh(process.execPath),
  SYSTEMCTL: sh(join(w.bin, 'systemctl')),
  CURL: sh(join(w.bin, 'curl')),
  BACKUP_OFFSITE: sh(join(w.bin, 'push')),
  OFFSITE_SETUP: sh(join(w.bin, 'push')),
  ETC_DIR: sh(w.etc),
  EXECUTOR_DATA_DIR: sh(w.exec),
  EXECUTOR_APP: sh(APP),
  STATE_DIR: sh(w.state),
  OFFSITE_DIR: sh(w.offsite),
  OFFSITE_CONF: sh(join(w.etc, 'offsite.env')),
  HEALTH_WAIT: '2',
  TERMS_KEY_WIN: join(w.state, 'builder-terms.key'),
  ...extra,
});
const run = (w, args, extra, input) => spawnSync('bash', [sh(join(HERE, 'rotate-secret.sh')), ...args], { encoding: 'utf8', env: envOf(w, extra), input });
const calls = (w) => (existsSync(w.log) ? readFileSync(w.log, 'utf8').trim().split('\n') : []);

/** The executor's directory, made by the real code: three followers' keys sealed under a kek. */
function executorDir(w) {
  const fx = join(w.root, 'fixture.ts');
  const u = (p) => pathToFileURL(join(APP, 'src', p)).href;
  writeFileSync(fx, `
import { Secrets } from '${u('secrets.ts')}';
import { ExecutorDb } from '${u('db.ts')}';
import { randomBytes } from 'node:crypto';
const dir = process.argv[2];
const s = new Secrets(dir);
const db = new ExecutorDb(dir + '/executor.db');
for (let i = 0; i < 3; i++) {
  const owner = '0x' + randomBytes(20).toString('hex');
  const { address, sealed } = s.newKey('mainnet', owner);
  db.putKey({ owner, slot: 'active', address, name: 'vd-' + i, sealed, createdAt: Date.now(), expiresAt: null, registered: true, checkedAt: null });
}
db.close();
`);
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', fx, w.exec], { cwd: APP, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('executor-kek: stops the executor, seals every key again, starts it, checks it - and reminds of the kek block', { skip: SKIP }, () => {
  const w = world();
  try {
    executorDir(w);
    const kek0 = readFileSync(join(w.exec, 'kek'));
    const r = run(w, ['executor-kek']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const kek1 = readFileSync(join(w.exec, 'kek'));
    assert.ok(!kek1.equals(kek0));
    const old = readdirSync(w.exec).filter((f) => f.startsWith('kek.old-'));
    assert.equal(old.length, 1);
    assert.ok(readFileSync(join(w.exec, old[0])).equals(kek0));
    assert.deepEqual(calls(w), ['is-active -q valuescan-executor', 'stop valuescan-executor', 'start valuescan-executor']);
    assert.match(r.stdout, /3 sealed keys sealed again/);
    assert.match(r.stdout, /ok: all 3 sealed keys open under kek/, 'checked again after the start');
    assert.match(r.stderr, /executor-secrets\.sh export/);
    for (const k of [kek0, kek1]) assert.ok(!(r.stdout + r.stderr).includes(k.toString('hex')) && !(r.stdout + r.stderr).includes(k.toString('base64')));

    // Undo: back to the old kek.
    const u = run(w, ['executor-kek', `--kek-from=${sh(join(w.exec, old[0]))}`]);
    assert.equal(u.status, 0, u.stderr);
    assert.ok(readFileSync(join(w.exec, 'kek')).equals(kek0));
    assert.equal(run(w, ['executor-kek', '--kek-from=/etc/passwd']).status, 1, 'only a kek.old-* of the data directory');
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('executor-session: a new session.key with an audit row; an executor that does not come back is a failure that names the rollback', { skip: SKIP }, () => {
  const w = world();
  try {
    executorDir(w);
    const s0 = readFileSync(join(w.exec, 'session.key'));
    const r = run(w, ['executor-session']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!readFileSync(join(w.exec, 'session.key')).equals(s0));
    assert.match(r.stderr, /sign once more/);
    const bad = run(w, ['executor-import'], { FAKE_CURL_FAIL: '1' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /ROLL BACK: sudo bash .*rotate-secret\.sh restore .*import\.key\.old-\d{8}T\d{6}Z/);
    const old = readdirSync(w.exec).find((f) => f.startsWith('import.key.old-'));
    const back = run(w, ['restore', sh(join(w.exec, old))]);
    assert.equal(back.status, 0, back.stderr);
    assert.ok(readdirSync(w.exec).some((f) => f.startsWith('import.key.rolledback-')));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('executor rotations refuse on the server that does not run the executor; restore refuses the kek', { skip: SKIP }, () => {
  const w = world();
  try {
    executorDir(w);
    rmSync(join(w.etc, 'executor-here'));
    const r = run(w, ['executor-kek']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not run on this server/);
    assert.deepEqual(calls(w), [], 'nothing stopped');
    writeFileSync(join(w.exec, 'kek.old-20261028T000000Z'), randomBytes(32));
    const k = run(w, ['restore', sh(join(w.exec, 'kek.old-20261028T000000Z'))]);
    assert.equal(k.status, 1);
    assert.match(k.stderr, /executor-kek --kek-from=/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('folders-session: new key, old kept, the API restarted and checked; restore puts the old one back', { skip: SKIP }, () => {
  const w = world();
  try {
    const k0 = randomBytes(32);
    writeFileSync(join(w.folders, 'session.key'), k0, { mode: 0o600 });
    const r = run(w, ['folders-session']);
    assert.equal(r.status, 0, r.stderr);
    const k1 = readFileSync(join(w.folders, 'session.key'));
    assert.equal(k1.length, 32);
    assert.ok(!k1.equals(k0));
    const old = readdirSync(w.folders).find((f) => f.startsWith('session.key.old-'));
    assert.ok(readFileSync(join(w.folders, old)).equals(k0));
    assert.deepEqual(calls(w), ['restart valuescan-api']);
    assert.ok(!(r.stdout + r.stderr).includes(k0.toString('hex')) && !(r.stdout + r.stderr).includes(k1.toString('hex')));
    const back = run(w, ['restore', sh(join(w.folders, old))]);
    assert.equal(back.status, 0, back.stderr);
    assert.ok(readFileSync(join(w.folders, 'session.key')).equals(k0));
    assert.equal(run(w, ['feedback-session']).status, 1, 'no feedback key yet: nothing to rotate');
    assert.equal(run(w, ['restore', '/etc/shadow.old-20261028T000000Z']).status, 1);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('terms-key: new prints only public keys; finish puts it in force and sees the API sign with it; abort', { skip: SKIP }, () => {
  const w = world();
  try {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    writeFileSync(join(w.state, 'builder-terms.key'), pem, { mode: 0o600 });
    const n = run(w, ['terms-key', 'new']);
    assert.equal(n.status, 0, n.stderr);
    assert.match(n.stdout, /^current [A-Za-z0-9_-]{43} [0-9a-f]{8}\nnext [A-Za-z0-9_-]{43} [0-9a-f]{8}\n$/);
    assert.ok(!n.stdout.includes('PRIVATE') && !n.stderr.includes('PRIVATE'));
    const nextPem = readFileSync(join(w.state, 'builder-terms.key.next'), 'utf8');
    assert.equal(run(w, ['terms-key', 'new']).status, 1, 'one rotation at a time');
    const f = run(w, ['terms-key', 'finish']);
    assert.equal(f.status, 0, f.stderr);
    assert.equal(readFileSync(join(w.state, 'builder-terms.key'), 'utf8'), nextPem);
    assert.ok(readdirSync(w.state).some((x) => x.startsWith('builder-terms.key.old-')));
    assert.match(f.stderr, /the API signs terms with [0-9a-f]{8}/);
    assert.equal(run(w, ['terms-key', 'finish']).status, 1, 'nothing to finish');
    assert.equal(run(w, ['terms-key', 'new']).status, 0);
    assert.equal(run(w, ['terms-key', 'abort']).status, 0);
    assert.ok(!existsSync(join(w.state, 'builder-terms.key.next')));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('backup-key rotate: the old key kept, a new one, one set pushed with it; a failed push names the rollback', { skip: SKIP }, () => {
  const w = world();
  try {
    const key = join(w.offsite, 'backup.key');
    assert.equal(spawnSync(process.execPath, [join(HERE, 'backup-crypt.mjs'), 'keygen', key]).status, 0);
    writeFileSync(join(w.etc, 'offsite.env'), 'OFFSITE_SETS="api-state folders"\n');
    const id = run(w, ['backup-key', 'id']).stdout.trim();
    assert.match(id, /^[0-9a-f]{16}$/);
    const r = run(w, ['backup-key', 'rotate']);
    assert.equal(r.status, 0, r.stderr);
    const m = /^old ([0-9a-f]{16})\nnew ([0-9a-f]{16})\n$/.exec(r.stdout);
    assert.ok(m, r.stdout);
    assert.equal(m[1], id);
    assert.notEqual(m[2], id);
    assert.deepEqual(calls(w), ['push push api-state']);
    const old = readdirSync(w.offsite).find((f) => f.startsWith('backup.key.old-'));
    assert.equal(spawnSync(process.execPath, [join(HERE, 'backup-crypt.mjs'), 'id', join(w.offsite, old)], { encoding: 'utf8' }).stdout.trim(), id);
    const bad = run(w, ['backup-key', 'rotate'], { FAKE_FAIL_PUSH: '1' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /ROLL BACK: .*restore .*backup\.key\.old-/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

function keyLine(w, name) {
  const f = join(w.root, name);
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', f]).status, 0);
  return readFileSync(`${f}.pub`, 'utf8').trim();
}

test('authorized: add copies a forced-command line\'s options; remove never leaves no login key and never takes a forced-command line by accident', { skip: SKIP }, () => {
  const w = world();
  try {
    const laptopOld = keyLine(w, 'laptop-old');
    const laptopNew = keyLine(w, 'laptop-new');
    const ledgerOld = keyLine(w, 'ledger-old');
    const ledgerNew = keyLine(w, 'ledger-new');
    const opts = 'from="13.140.77.201",command="/opt/valuescan/bin/builder-snapshot.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding';
    const ak = join(w.root, 'authorized_keys');
    writeFileSync(ak, `${laptopOld}\n${opts} ${ledgerOld}\n`, { mode: 0o600 });
    const A = { AUTH_KEYS_FILE: sh(ak) };
    const auth = (args, input) => run(w, ['authorized', ...args, '--user=almalinux'], A, input);

    let r = auth(['add', '--like=builder-snapshot.sh'], `${ledgerNew}\n`);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(ak, 'utf8').includes(`${opts} ${ledgerNew}\n`), 'the new ledger key gets exactly the old line\'s options');
    r = auth(['remove'], `${ledgerOld}\n`);
    assert.equal(r.status, 1, 'a forced-command line is not removed without --like');
    r = auth(['remove', '--like=builder-snapshot.sh'], `${ledgerOld}\n${ledgerNew}\n`);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!readFileSync(ak, 'utf8').includes(ledgerOld.split(' ')[1]));

    r = auth(['remove'], `${laptopOld}\n`);
    assert.equal(r.status, 1, 'the only login key is never removed');
    assert.match(r.stderr, /lock everybody out/);
    r = auth(['remove'], `${laptopOld}\n${laptopNew}\n`);
    assert.equal(r.status, 1, 'the key that must remain is not there yet');
    assert.equal(auth(['add'], `${laptopNew}\n`).status, 0);
    assert.equal(auth(['add'], `${laptopNew}\n`).status, 0, 'adding twice is a no-op');
    assert.equal(readFileSync(ak, 'utf8').split(laptopNew.split(' ')[1]).length, 2, 'once only');
    r = auth(['remove'], `${laptopOld}\n${laptopNew}\n`);
    assert.equal(r.status, 0, r.stderr);
    const final = readFileSync(ak, 'utf8');
    assert.ok(final.includes(laptopNew) && !final.includes(laptopOld.split(' ')[1]) && final.includes(`${opts} ${ledgerNew}`));
    assert.equal(auth(['add'], 'not a key\n').status, 1);
    assert.equal(auth(['add'], `${opts} ${ledgerNew}\n`).status, 1, 'options on stdin are refused: a bare public line only');
    const l = auth(['list']);
    assert.equal(l.status, 0, l.stderr);
    assert.match(l.stdout, /^SHA256:\S+ {2}login$/m);
    assert.match(l.stdout, /^SHA256:\S+ {2}forced command: \/opt\/valuescan\/bin\/builder-snapshot\.sh$/m);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('offsite-ssh new / finish / abort: a key pair beside the old; finish keeps the old one and runs the test copy', { skip: SKIP }, () => {
  const w = world();
  try {
    const k = join(w.offsite, 'id_ed25519');
    assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', k]).status, 0);
    const old = readFileSync(k);
    const n = run(w, ['offsite-ssh', 'new']);
    assert.equal(n.status, 0, n.stderr);
    assert.match(n.stdout, /^ssh-ed25519 [A-Za-z0-9+/]+ valuedesk-offsite@\S+-\d{8}T\d{6}Z\n$/);
    assert.ok(!n.stdout.includes('PRIVATE'));
    const f = run(w, ['offsite-ssh', 'finish']);
    assert.equal(f.status, 0, f.stderr);
    assert.ok(!readFileSync(k).equals(old));
    assert.ok(readdirSync(w.offsite).some((x) => /^id_ed25519\.old-\d{8}T\d{6}Z$/.test(x)));
    assert.deepEqual(calls(w), ['push test']);
    assert.equal(run(w, ['offsite-ssh', 'new']).status, 0);
    assert.equal(run(w, ['offsite-ssh', 'abort']).status, 0);
    assert.ok(!existsSync(`${k}.new`));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('status names files, modes and ids - never contents', { skip: SKIP }, () => {
  const w = world();
  try {
    executorDir(w);
    const r = run(w, ['status']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /executor\/kek\s+\d+ \S+ \S+\s+id [0-9a-f]{16}/);
    const kek = readFileSync(join(w.exec, 'kek'));
    assert.ok(!r.stdout.includes(kek.toString('hex')));
    assert.ok(!r.stdout.includes('made-up-current'));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});
