// node --disable-warning=ExperimentalWarning --test deploy/release/rotate.test.mjs
//
// deploy/release/rotate.sh with a stubbed ssh (a fake on PATH records every call: its
// arguments and what came on stdin, and answers from a list of rules) and a stubbed curl. A fake
// HOME holds a real laptop key and real backup keys. Nothing reaches a server. Checks: the plan
// runs nothing; --execute runs the steps in order and stops at the first failure with its
// rollback; secrets go only over stdin, never on a command line or into the output; the laptop
// key is never removed from a server before the new one logged in to both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const TOOLS = spawnSync('bash', ['-c', 'command -v ssh-keygen sed grep >/dev/null'], { encoding: 'utf8' });
const SKIP = TOOLS.status === 0 ? false : 'needs bash and ssh-keygen';
const sh = (p) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : p);
const S1 = '161.97.154.121';
const S2 = '13.140.77.201';

function world() {
  const root = mkdtempSync(join(tmpdir(), 'vs-rotate-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const log = join(root, 'log');
  for (const d of [join(home, '.ssh'), join(home, 'ValueDesk-backups', 'keys'), bin, log]) mkdirSync(d, { recursive: true });
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'laptop-old', '-f', join(home, '.ssh', 'valuescan-contabo')]).status, 0);
  // The fake ssh: records, then answers from rules.json (first match: host and a piece of the command).
  writeFileSync(join(bin, 'ssh.mjs'), `
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const argv = process.argv.slice(2);
let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch {}
const dest = argv.find((a) => /^[^-].*@/.test(a)) ?? '';
const host = dest.split('@')[1] ?? '';
const cmd = argv[argv.indexOf(dest) + 1] ?? '';
const key = argv[argv.indexOf('-i') + 1] ?? '';
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, host, cmd, key, stdin }) + '\\n');
const rules = existsSync(process.env.FAKE_RULES) ? JSON.parse(readFileSync(process.env.FAKE_RULES, 'utf8')) : [];
for (const r of rules) {
  if (r.host && r.host !== host) continue;
  if (r.cmd && !cmd.includes(r.cmd)) continue;
  if (r.key && !key.endsWith(r.key)) continue;
  if (r.stdout) process.stdout.write(r.stdout);
  process.exit(r.exit ?? 0);
}
`);
  writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash\nexec "${sh(process.execPath)}" "${sh(join(bin, 'ssh.mjs'))}" "$@"\n`);
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\necho "$*" >> "${sh(join(log, 'curl.log'))}"\n[ "\${FAKE_CURL_FAIL:-0}" = 1 ] && exit 22\necho '{"ok":true}'\n`);
  chmodSync(join(bin, 'ssh'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  return { root, home, bin, log, rules: join(root, 'rules.json'), calls: join(log, 'ssh.jsonl') };
}

function run(w, args, { rules = [], env = {}, input = '' } = {}) {
  writeFileSync(w.rules, JSON.stringify(rules));
  return spawnSync('bash', [sh(join(HERE, 'rotate.sh')), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PATH: `${w.bin}${process.platform === 'win32' ? ';' : ':'}${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      HOME: sh(w.home),
      SSH_AUTH_SOCK: '',
      FAKE_LOG: w.calls,
      FAKE_RULES: w.rules,
      ...env,
    },
  });
}
const calls = (w) => (existsSync(w.calls) ? readFileSync(w.calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const curls = (w) => (existsSync(join(w.log, 'curl.log')) ? readFileSync(join(w.log, 'curl.log'), 'utf8').trim().split('\n') : []);

test('the plan of every rotation runs nothing: no ssh, no curl, no file changed', { skip: SKIP }, () => {
  const w = world();
  try {
    const before = readFileSync(join(w.home, '.ssh', 'valuescan-contabo'));
    for (const a of [['list'], ['origin-secret', 'begin'], ['origin-secret', 'finish'], ['executor-session'], ['executor-import'], ['executor-kek'], ['folders-session'], ['feedback-session'],
      ['telegram'], ['backup-key', 'server1'], ['backup-key', 'server2'], ['offsite-ssh', 'server1'], ['offsite-ssh', 'server2'], ['ledger-pull'], ['laptop-ssh'],
      ['builder-terms', 'begin'], ['builder-terms', 'finish'], ['builder-terms', 'abort'], ['sosovalue'], ['youtube']]) {
      const r = run(w, a);
      assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`);
      if (a[0] !== 'list') assert.match(r.stdout, /plan only: nothing runs; add --execute/, a.join(' '));
    }
    assert.deepEqual(calls(w), []);
    assert.deepEqual(curls(w), []);
    assert.ok(readFileSync(join(w.home, '.ssh', 'valuescan-contabo')).equals(before));
    assert.deepEqual(readdirSync(join(w.home, '.ssh')).sort(), ['valuescan-contabo', 'valuescan-contabo.pub']);
    assert.equal(run(w, ['nonsense']).status, 1);
    assert.equal(run(w, ['backup-key', 'server3']).status, 1);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('executor-kek --execute: the helper check, the read-only check, the rotation, the health through the site - in that order', { skip: SKIP }, () => {
  const w = world();
  try {
    const r = run(w, ['executor-kek', '--execute', '--yes']);
    assert.equal(r.status, 0, r.stderr);
    const c = calls(w);
    assert.deepEqual(c.map((x) => [x.host, x.cmd]), [
      [S2, 'test -x /opt/valuescan/bin/rotate-secret.sh'],
      [S2, 'sudo bash /opt/valuescan/bin/rotate-secret.sh executor-kek-check'],
      [S2, 'sudo bash /opt/valuescan/bin/rotate-secret.sh executor-kek'],
    ]);
    assert.ok(c.every((x) => x.argv.includes('BatchMode=yes') && x.argv.includes('StrictHostKeyChecking=yes')));
    assert.match(curls(w).join('\n'), /--limit-rate 2M .*\/api\/copy\/v1\/health/);
    assert.match(r.stdout, /executor-secrets\.sh export/);
    assert.match(r.stdout, /emergency-kit\.sh create/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('a failing step stops everything after it and names the rollback', { skip: SKIP }, () => {
  const w = world();
  try {
    const r = run(w, ['executor-session', '--execute', '--yes'], { rules: [{ cmd: 'rotate-secret.sh executor-session', exit: 1 }] });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /step 2 failed: stop the executor, rotate.* - ROLL BACK:/);
    assert.deepEqual(curls(w), [], 'no step after the failed one');
    const n = run(w, ['executor-session', '--execute']);
    assert.equal(n.status, 1, 'without a terminal --yes is needed');
    assert.match(n.stderr, /add --yes/);
    const h = run(w, ['folders-session', '--execute', '--yes'], { env: { FAKE_CURL_FAIL: '1' } });
    assert.equal(h.status, 1, 'unhealthy afterwards is a failure');
    assert.match(h.stderr, /step 3 failed: the site answers/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('telegram: the token travels only on ssh stdin - never on a command line, never in the output', { skip: SKIP }, () => {
  const w = world();
  try {
    const token = `123456789:${randomBytes(27).toString('base64url')}`;
    const tf = join(w.root, 'token.txt');
    writeFileSync(tf, `${token}\r\n`);
    const r = run(w, ['telegram', '--execute', '--yes', `--token-file=${sh(tf)}`], { rules: [{ host: S1, cmd: 'ALERT_TELEGRAM_CHAT_ID', stdout: '-1001234567890\n' }] });
    assert.equal(r.status, 0, r.stderr);
    const c = calls(w);
    const setups = c.filter((x) => x.cmd.includes('telegram-setup.sh'));
    assert.deepEqual(setups.map((x) => x.host), [S1, S2]);
    for (const s of setups) {
      assert.match(s.cmd, /--token-stdin --chat-id=-1001234567890 /);
      assert.equal(s.stdin, `${token}\n`);
    }
    for (const x of c) assert.ok(!x.argv.join(' ').includes(token), 'not on any command line');
    assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), 'not in the output');
    assert.match(r.stdout, /gh secret set TELEGRAM_TOKEN/);
    writeFileSync(tf, 'nope\n');
    assert.equal(run(w, ['telegram', '--execute', '--yes', `--token-file=${sh(tf)}`]).status, 1);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

function backupKeys(w) {
  const crypt = join(ROOT, 'deploy', 'server', 'bin', 'backup-crypt.mjs');
  const laptop = join(w.home, 'ValueDesk-backups', 'keys', 'server1.backup.key');
  const fresh = join(w.root, 'server1.new.key');
  // The laptop holds server 2's key as well (as after pull-backups.sh --fetch-keys): not fetched again.
  for (const f of [laptop, fresh, join(w.home, 'ValueDesk-backups', 'keys', 'server2.backup.key')]) assert.equal(spawnSync(process.execPath, [crypt, 'keygen', f]).status, 0);
  const id = (f) => spawnSync(process.execPath, [crypt, 'id', f], { encoding: 'utf8' }).stdout.trim();
  const hex = readFileSync(fresh, 'utf8').split('\n').find((l) => /^[0-9a-f]{64}$/.test(l));
  return { laptop, oldId: id(laptop), newId: id(fresh), newHex: hex };
}

test('backup-key: refuses when the laptop does not hold the current key; otherwise rotates, keeps the old key under its id, fetches the new one and drills with it', { skip: SKIP }, () => {
  const w = world();
  try {
    const k = backupKeys(w);
    const oldBytes = readFileSync(k.laptop);
    const wrong = run(w, ['backup-key', 'server1', '--execute', '--yes'], { rules: [{ host: S1, cmd: 'backup-key id', stdout: '0123456789abcdef\n' }] });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /step 3 failed: the laptop holds the CURRENT key/);
    assert.ok(!calls(w).some((x) => x.cmd.includes('backup-key rotate')), 'nothing rotated');

    rmSync(w.calls);
    const r = run(w, ['backup-key', 'server1', '--execute', '--yes'], {
      rules: [
        { host: S1, cmd: 'backup-key id', stdout: `${k.oldId}\n` },
        { host: S1, cmd: 'backup-key rotate', stdout: `old ${k.oldId}\nnew ${k.newId}\n` },
        { host: S1, cmd: 'cat /etc/valuescan/offsite/backup.key', stdout: `# ValueDesk backup key\n${k.newHex}\n` },
        { host: S2, cmd: 'backup-restore.sh drill api-state --key-stdin', stdout: 'ok\nDRILL PASSED\n' },
      ],
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const keys = join(w.home, 'ValueDesk-backups', 'keys');
    assert.ok(readFileSync(join(keys, `server1.backup.key.old-${k.oldId}`)).equals(oldBytes), 'the old key kept under its id');
    assert.match(readFileSync(join(keys, 'server1.backup.key'), 'utf8'), new RegExp(k.newHex));
    const drill = calls(w).find((x) => x.cmd.includes('drill'));
    assert.equal(drill.host, S2);
    assert.match(drill.stdin, new RegExp(k.newHex), 'the drill gets the NEW key, on stdin');
    assert.ok(!r.stdout.includes(k.newHex) && !r.stderr.includes(k.newHex));
    assert.ok(!calls(w).some((x) => x.cmd.includes('backup-receive.sh list')), 'keys only - no copies pulled');
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('laptop-ssh: the new key logs in to both before the old is removed anywhere; the remove sends old then new; the files are swapped', { skip: SKIP }, () => {
  const w = world();
  try {
    const oldPub = readFileSync(join(w.home, '.ssh', 'valuescan-contabo.pub'), 'utf8').trim();
    const r = run(w, ['laptop-ssh', '--execute', '--yes'], { env: { RS_TEST_NO_PASSPHRASE: '1' }, rules: [{ cmd: 'vd-login-ok', stdout: 'vd-login-ok\n' }] });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const c = calls(w);
    const idx = (pred) => c.findIndex(pred);
    const lastLoginBoth = Math.max(idx((x) => x.host === S1 && x.cmd.includes('vd-login-ok')), idx((x) => x.host === S2 && x.cmd.includes('vd-login-ok')));
    const firstRemove = idx((x) => x.cmd.includes('authorized remove'));
    assert.ok(firstRemove > lastLoginBoth, 'removal only after the new key worked on both');
    const adds = c.filter((x) => x.cmd.includes('authorized add'));
    assert.equal(adds.length, 2);
    const ssh = join(w.home, '.ssh');
    const newPub = readFileSync(join(ssh, 'valuescan-contabo.pub'), 'utf8').trim();
    assert.notEqual(newPub, oldPub);
    for (const a of adds) assert.equal(a.stdin.trim(), newPub);
    const removes = c.filter((x) => x.cmd.includes('authorized remove'));
    assert.deepEqual(removes.map((x) => x.host), [S1, S2]);
    for (const x of removes) {
      assert.ok(x.key.endsWith('valuescan-contabo.new'), 'removed with the NEW key');
      assert.deepEqual(x.stdin.trim().split('\n'), [oldPub, newPub]);
    }
    const old = readdirSync(ssh).find((f) => /^valuescan-contabo\.old-\d{8}T\d{6}Z$/.test(f));
    assert.ok(old, 'the old key kept on the laptop');
    assert.equal(readFileSync(join(ssh, `${old}.pub`), 'utf8').trim(), oldPub);
    assert.ok(!existsSync(join(ssh, 'valuescan-contabo.new')));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('laptop-ssh: when the new key does not log in to server 2, nothing is removed anywhere and the laptop keeps its key', { skip: SKIP }, () => {
  const w = world();
  try {
    const before = readFileSync(join(w.home, '.ssh', 'valuescan-contabo'));
    const r = run(w, ['laptop-ssh', '--execute', '--yes'], {
      env: { RS_TEST_NO_PASSPHRASE: '1' },
      rules: [{ host: S2, cmd: 'vd-login-ok', exit: 255 }, { cmd: 'vd-login-ok', stdout: 'vd-login-ok\n' }],
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the NEW key logs in to server 2 .*ROLL BACK: nothing was removed/);
    assert.ok(!calls(w).some((x) => x.cmd.includes('authorized remove')));
    assert.ok(readFileSync(join(w.home, '.ssh', 'valuescan-contabo')).equals(before));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('ledger-pull: server 1 gets the new key with the old line\'s options, the old one goes only after the new one pulled', { skip: SKIP }, () => {
  const w = world();
  try {
    const oldL = `ssh-ed25519 ${'A'.repeat(68)} valuedesk-ledger-old`;
    const newL = `ssh-ed25519 ${'B'.repeat(68)} valuedesk-ledger-new`;
    const r = run(w, ['ledger-pull', '--execute', '--yes'], {
      rules: [{ host: S2, cmd: 'ledger-pull old-pub', stdout: `${oldL}\n` }, { host: S2, cmd: 'ledger-pull new', stdout: `${newL}\n` }],
    });
    assert.equal(r.status, 0, r.stderr);
    const seq = calls(w).map((x) => `${x.host === S1 ? 's1' : 's2'} ${x.cmd.replace('sudo bash /opt/valuescan/bin/rotate-secret.sh ', '')}`);
    assert.deepEqual(seq.slice(2), [
      's2 ledger-pull old-pub',
      's2 ledger-pull new',
      's1 authorized add --user=almalinux --like=builder-snapshot.sh',
      's2 ledger-pull test-new',
      's2 ledger-pull finish',
      's1 authorized remove --user=almalinux --like=builder-snapshot.sh',
      's2 sudo systemctl start valuescan-ledger-pull.service',
    ]);
    const rm = calls(w).find((x) => x.cmd.includes('authorized remove'));
    assert.equal(rm.stdin, `${oldL}\n${newL}\n`);
    const bad = run(w, ['ledger-pull', '--execute', '--yes'], { rules: [{ host: S2, cmd: 'ledger-pull old-pub', stdout: 'nonsense\n' }] });
    assert.equal(bad.status, 1, 'what comes back must be a public key line');
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});
