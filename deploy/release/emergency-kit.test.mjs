// node --disable-warning=ExperimentalWarning --test deploy/release/emergency-kit.test.mjs
//
// deploy/release/emergency-kit.sh with a fake HOME and a fake release worktree (made-up keys and
// env files): create, verify, open, the documented openssl command, and that no plaintext is
// left in the temporary directory or written next to the bundle. Needs bash, openssl, GNU tar
// and sha256sum (Linux, or Git Bash on Windows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = spawnSync('bash', ['-c', 'command -v openssl tar sha256sum >/dev/null && tar --version | grep -q GNU'], { encoding: 'utf8' });
const SKIP = TOOLS.status === 0 ? false : 'needs bash with openssl, GNU tar and sha256sum';
const sh = (p) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : p);
const PASS = 'correct horse battery staple ferry';

function world() {
  const root = mkdtempSync(join(tmpdir(), 'vs-kit-'));
  const home = join(root, 'home');
  const repo = join(root, 'vs-coh');
  const tmp = join(root, 'tmp');
  const usb = join(root, 'usb');
  const secrets = {};
  const put = (file, content) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { mode: 0o600 });
    secrets[file] = content;
  };
  mkdirSync(tmp, { recursive: true });
  put(join(home, '.ssh', 'valuescan-contabo'), `-----BEGIN OPENSSH PRIVATE KEY-----\n${randomBytes(48).toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`);
  put(join(home, '.ssh', 'valuescan-contabo.pub'), 'ssh-ed25519 AAAAC3made-up laptop\n');
  put(join(home, '.ssh', 'valuedesk-contabo.known_hosts'), '161.97.154.121 ssh-ed25519 AAAAhost1\n');
  put(join(home, '.ssh', 'valuedesk-contabo2.known_hosts'), '13.140.77.201 ssh-ed25519 AAAAhost2\n');
  put(join(home, '.ssh', 'known_hosts'), 'github.com ssh-ed25519 AAAAgh\n');
  put(join(home, '.valuescan', 'valuescan-test', 'origin-secret'), randomBytes(32).toString('hex'));
  put(join(home, 'ValueDesk-backups', 'keys', 'server1.backup.key'), `# key\n${randomBytes(32).toString('hex')}\n`);
  put(join(home, 'ValueDesk-backups', 'keys', 'server2.backup.key'), `# key\n${randomBytes(32).toString('hex')}\n`);
  put(join(home, 'ValueDesk-backups', 'keys', 'server1.backup.key.old-0123456789abcdef'), `# old\n${randomBytes(32).toString('hex')}\n`);
  for (const [n, name] of [['', 'contabo'], ['2', 'contabo2']]) {
    put(join(repo, 'deploy', 'aws', 'ec2', `ec2.contabo${n}.env`),
      `REGION=x\nNAME=${name}\nSSH_KEY_FILE=$HOME/.ssh/valuescan-contabo\nSSH_KNOWN_HOSTS=$HOME/.ssh/valuedesk-contabo${n}.known_hosts\nACME_EMAIL=owner-${randomBytes(4).toString('hex')}@example.org\nORIGIN_SECRET_DIR=$HOME/.valuescan/valuescan-test\n`);
    put(join(repo, 'deploy', 'aws', 'ec2', '.out', `state.contabo${n}.env`), `STATE_NAME=${name}\nPUBLIC_IP=1.2.3.${n || 1}\n`);
  }
  put(join(repo, 'deploy', 'release', 'web.env'), `VITE_SOMETHING=${randomBytes(8).toString('hex')}\n`);
  const kek = join(root, 'kek-block.txt');
  put(kek, `----- BEGIN VALUEDESK EXECUTOR SECRETS (s2) -----\n${randomBytes(60).toString('base64')}\n----- END VALUEDESK EXECUTOR SECRETS -----\n`);
  return { root, home, repo, tmp, usb, kek, secrets };
}

const run = (w, args, input = `${PASS}\n`) =>
  spawnSync('bash', [sh(join(HERE, 'emergency-kit.sh')), ...args], { encoding: 'utf8', input, env: { ...process.env, HOME: sh(w.home), TMPDIR: sh(w.tmp), PULL_DEST: '' } });
const bundleOf = (w) => join(w.usb, readdirSync(w.usb).find((f) => f.endsWith('.tar.enc')));

test('create: one encrypted bundle, its checksum and a RESTORE.txt without any secret; nothing left in the temporary directory', { skip: SKIP }, () => {
  const w = world();
  try {
    const r = run(w, ['create', `--out=${sh(w.usb)}`, `--from=${sh(w.repo)}`, `--kek-block=${sh(w.kek)}`, '--passphrase-stdin', '--contact=Jane Doe (envelope), +49 000 000']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(readdirSync(w.tmp), [], 'the staging directory is gone');
    const files = readdirSync(w.usb).sort();
    assert.equal(files.length, 3);
    assert.ok(files.includes('RESTORE.txt'));
    const bundle = bundleOf(w);
    const enc = readFileSync(bundle);
    assert.equal(enc.subarray(0, 8).toString(), 'Salted__', 'openssl enc format');
    const restore = readFileSync(join(w.usb, 'RESTORE.txt'), 'utf8');
    for (const [file, content] of Object.entries(w.secrets)) {
      const probe = String(content).trim().split('\n').find((l) => l.length > 20 && !l.startsWith('#') && !l.startsWith('-----') && !l.startsWith('REGION')) ?? String(content).trim();
      assert.ok(!enc.includes(Buffer.from(probe)), `${file} is not readable in the bundle`);
      if (/key|secret|kek|known_hosts|\.env$/.test(file)) assert.ok(!restore.includes(probe), `${file}'s content is not in RESTORE.txt`);
    }
    assert.ok(!restore.includes(PASS));
    assert.match(restore, /openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in/);
    assert.match(restore, /ssh\/valuescan-contabo\n/);
    assert.match(restore, /backup-keys\/server1\.backup\.key\.old-0123456789abcdef/);
    assert.match(restore, /executor\/kek-block\.txt/);
    assert.match(restore, /Jane Doe \(envelope\)/);
    assert.match(restore, /deploy\/contabo\/README\.md/);
    assert.match(restore, new RegExp(`SHA-256 of ${files.find((f) => f.endsWith('.tar.enc')).replace(/\./g, '\\.')}: [0-9a-f]{64}`));
    assert.ok(!(r.stdout + r.stderr).includes(PASS));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('verify lists every file and checks it; a wrong passphrase or a changed byte fails', { skip: SKIP }, () => {
  const w = world();
  try {
    assert.equal(run(w, ['create', `--out=${sh(w.usb)}`, `--from=${sh(w.repo)}`, `--kek-block=${sh(w.kek)}`, '--passphrase-stdin']).status, 0);
    const b = bundleOf(w);
    const v = run(w, ['verify', sh(b), '--passphrase-stdin']);
    assert.equal(v.status, 0, v.stderr);
    for (const p of ['ssh/valuescan-contabo', 'ssh/valuedesk-contabo2.known_hosts', 'repo/deploy/aws/ec2/ec2.contabo.env', 'repo/deploy/aws/ec2/.out/state.contabo2.env',
      'repo/deploy/release/web.env', 'origin-secret/valuescan-test/origin-secret', 'backup-keys/server2.backup.key', 'executor/kek-block.txt', 'WHERE.txt', 'RESTORE.txt']) {
      assert.match(v.stdout, new RegExp(`^OK +${p.replace(/\./g, '\\.')} +\\(\\d+ bytes\\)$`, 'm'), p);
    }
    assert.deepEqual(readdirSync(w.tmp), []);
    const bad = run(w, ['verify', sh(b), '--passphrase-stdin'], 'not the passphrase at all\n');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /wrong passphrase, or a damaged file/);
    const buf = readFileSync(b);
    buf[buf.length - 40] ^= 0x01;
    writeFileSync(b, buf);
    const d = run(w, ['verify', sh(b), '--passphrase-stdin']);
    assert.equal(d.status, 1, 'a damaged bundle does not pass');
    assert.match(d.stderr, /does not match .*.sha256/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('open restores every file byte for byte; the documented openssl command opens it without this script', { skip: SKIP }, () => {
  const w = world();
  try {
    assert.equal(run(w, ['create', `--out=${sh(w.usb)}`, `--from=${sh(w.repo)}`, `--kek-block=${sh(w.kek)}`, '--passphrase-stdin']).status, 0);
    const b = bundleOf(w);
    const dir = join(w.root, 'restored');
    const o = run(w, ['open', sh(b), sh(dir), '--passphrase-stdin']);
    assert.equal(o.status, 0, o.stderr);
    const kit = join(dir, 'kit');
    assert.equal(readFileSync(join(kit, 'ssh', 'valuescan-contabo'), 'utf8'), w.secrets[join(w.home, '.ssh', 'valuescan-contabo')]);
    assert.equal(readFileSync(join(kit, 'origin-secret', 'valuescan-test', 'origin-secret'), 'utf8'), w.secrets[join(w.home, '.valuescan', 'valuescan-test', 'origin-secret')]);
    assert.equal(readFileSync(join(kit, 'executor', 'kek-block.txt'), 'utf8'), w.secrets[w.kek]);
    assert.match(readFileSync(join(kit, 'WHERE.txt'), 'utf8'), /^ssh\/valuescan-contabo\t~\/\.ssh\/valuescan-contabo$/m);
    assert.equal(run(w, ['open', sh(b), sh(dir), '--passphrase-stdin']).status, 1, 'never into a folder that is not empty');
    const wrongDir = join(w.root, 'wrong');
    assert.equal(run(w, ['open', sh(b), sh(wrongDir), '--passphrase-stdin'], 'wrong wrong wrong wrong\n').status, 1);
    assert.ok(!existsSync(wrongDir), 'nothing kept from a failed open');

    // RESTORE.txt's command, word for word (the passphrase from the environment instead of the prompt).
    const by = join(w.root, 'by-hand');
    mkdirSync(by);
    const cmd = `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in "${sh(b)}" -out kit.tar -pass env:P && tar -xf kit.tar && cd kit && sha256sum -c --quiet MANIFEST.sha256`;
    const h = spawnSync('bash', ['-c', cmd], { cwd: by, encoding: 'utf8', env: { ...process.env, P: PASS } });
    assert.equal(h.status, 0, h.stderr);
    assert.equal(readFileSync(join(by, 'kit', 'backup-keys', 'server1.backup.key'), 'utf8'), w.secrets[join(w.home, 'ValueDesk-backups', 'keys', 'server1.backup.key')]);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('create refuses when an expected file is missing (unless --allow-missing), a short passphrase, and a kek block that is not one', { skip: SKIP }, () => {
  const w = world();
  try {
    rmSync(join(w.home, 'ValueDesk-backups', 'keys', 'server2.backup.key'));
    let r = run(w, ['create', `--out=${sh(w.usb)}`, `--from=${sh(w.repo)}`, `--kek-block=${sh(w.kek)}`, '--passphrase-stdin']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing: .*server2\.backup\.key/);
    assert.ok(!existsSync(w.usb) || readdirSync(w.usb).length === 0);
    assert.deepEqual(readdirSync(w.tmp), []);
    r = run(w, ['create', `--out=${sh(w.usb)}`, `--from=${sh(w.repo)}`, '--passphrase-stdin', '--allow-missing']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(w.usb, 'RESTORE.txt'), 'utf8'), /NOT IN THIS KIT[\s\S]*server2\.backup\.key[\s\S]*kek block/);
    r = run(w, ['create', `--out=${sh(join(w.root, 'usb2'))}`, `--from=${sh(w.repo)}`, '--passphrase-stdin', '--allow-missing'], 'short\n');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /16 characters/);
    writeFileSync(join(w.root, 'notkek.txt'), 'hello');
    r = run(w, ['create', `--out=${sh(join(w.root, 'usb3'))}`, `--from=${sh(w.repo)}`, `--kek-block=${sh(join(w.root, 'notkek.txt'))}`, '--passphrase-stdin', '--allow-missing']);
    assert.equal(r.status, 1);
    assert.deepEqual(readdirSync(w.tmp), []);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});
