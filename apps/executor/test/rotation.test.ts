/**
 * Rotating the executor's secrets (src/rotation.ts, tools/rotate-kek.ts, tools/rotate-key.ts):
 * a real data directory made by the real code (Secrets makes kek, session.key, import.key;
 * ExecutorDb holds keys sealed by Secrets.newKey), rotated, and opened again by a fresh
 * Secrets - as the executor does on its next start.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ExecutorDb, sqlite } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { checkKek, rotateKek, rotateKeyFile, secretId } from '../src/rotation.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const NET = 'mainnet';

function world(nKeys = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'vs-rotate-'));
  const secrets = new Secrets(dir);
  const db = new ExecutorDb(join(dir, 'executor.db'));
  const owners: string[] = [];
  for (let i = 0; i < nKeys; i++) {
    const owner = `0x${randomBytes(20).toString('hex')}`;
    owners.push(owner);
    for (const slot of i === 0 ? (['active', 'pending'] as const) : (['active'] as const)) {
      const { address, sealed } = secrets.newKey(NET, owner);
      db.putKey({ owner, slot, address, name: `vd-${i}-${slot}`, sealed, createdAt: Date.now(), expiresAt: null, registered: true, checkedAt: null });
    }
  }
  db.audit('process', null, null, { event: 'start' });
  db.close();
  return { dir, owners, kek: readFileSync(join(dir, 'kek')) };
}

function keyRows(dir: string) {
  const db = new (sqlite().DatabaseSync)(join(dir, 'executor.db'), { readOnly: true });
  try {
    return db.prepare('SELECT owner, slot, address, name, sealed FROM keys ORDER BY owner, slot').all() as Array<{ owner: string; slot: string; address: string; name: string; sealed: string }>;
  } finally {
    db.close();
  }
}

/** Every row opens with a fresh Secrets on this directory - what the executor does at start. */
function allOpen(dir: string): number {
  const s = new Secrets(dir);
  const rows = keyRows(dir);
  for (const r of rows) {
    const ref = s.open(NET, r.owner, r.address, r.sealed, { name: r.name, expiresAt: null });
    assert.equal(ref.address?.toLowerCase(), r.address.toLowerCase());
  }
  return rows.length;
}

const auditOf = (dir: string) => {
  const db = new ExecutorDb(join(dir, 'executor.db'));
  try {
    return { rows: db.auditRows({ kind: 'secret' }), chain: db.verifyAudit() };
  } finally {
    db.close();
  }
};

test('a kek rotation seals every key again, the executor opens them all with the new kek, the old kek is kept, an audit row is written', () => {
  const w = world();
  try {
    const before = keyRows(w.dir);
    const r = rotateKek({ dir: w.dir, network: NET, now: Date.parse('2026-10-28T10:15:00Z') });
    assert.equal(r.rows, 4);
    assert.equal(r.resumed, false);
    const kekNow = readFileSync(join(w.dir, 'kek'));
    assert.equal(kekNow.length, 32);
    assert.ok(!kekNow.equals(w.kek), 'a new kek');
    assert.equal(r.oldId, secretId(w.kek));
    assert.equal(r.newId, secretId(kekNow));
    assert.equal(r.oldFile, join(w.dir, 'kek.old-20261028T101500Z'));
    assert.ok(readFileSync(r.oldFile).equals(w.kek), 'the old kek kept byte for byte');
    assert.ok(!existsSync(join(w.dir, 'kek.new')));
    assert.ok(r.snapshot && existsSync(r.snapshot), 'a copy of the database from before');

    const after = keyRows(w.dir);
    assert.equal(after.length, before.length);
    for (let i = 0; i < after.length; i++) {
      assert.equal(after[i]!.address, before[i]!.address);
      assert.notEqual(after[i]!.sealed, before[i]!.sealed, 'sealed again');
    }
    assert.equal(allOpen(w.dir), 4);
    assert.deepEqual(checkKek({ dir: w.dir, network: NET }).failed, []);
    // The old kek opens nothing in the database any more - but the snapshot, and old backups, still.
    assert.equal(checkKek({ dir: w.dir, network: NET, kekFile: r.oldFile }).failed.length, 4);

    const a = auditOf(w.dir);
    assert.equal(a.rows.length, 1);
    const data = JSON.parse(a.rows[0]!.data);
    assert.equal(data.action, 'rotate');
    assert.equal(data.rows, 4);
    assert.equal(data.oldId, r.oldId);
    assert.equal(data.newId, r.newId);
    assert.equal(a.rows[0]!.ref, 'kek');
    assert.equal(a.chain.brokenAt, null, 'the audit chain holds');
    const auditText = a.rows.map((x) => x.data).join('\n');
    assert.ok(!auditText.includes(w.kek.toString('hex')) && !auditText.includes(kekNow.toString('hex')) && !auditText.includes(kekNow.toString('base64')), 'no key in the audit log');
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('the rotation refuses while an executor holds the database, and changes nothing', () => {
  const w = world(1);
  const live = new ExecutorDb(join(w.dir, 'executor.db'));
  try {
    const before = keyRows(w.dir);
    assert.throws(() => rotateKek({ dir: w.dir, network: NET }), /already in use|already running/);
    assert.ok(readFileSync(join(w.dir, 'kek')).equals(w.kek));
    assert.deepEqual(keyRows(w.dir), before);
    assert.ok(!existsSync(join(w.dir, 'kek.new')));
  } finally {
    live.close();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('a key that does not open under the kek in force (or the wrong network) stops the rotation before anything changes', () => {
  const w = world(2);
  try {
    assert.throws(() => rotateKek({ dir: w.dir, network: 'testnet' }), /do not open under the kek in force.*Wrong network/);
    const db = new ExecutorDb(join(w.dir, 'executor.db'));
    const [first] = keyRows(w.dir);
    db.db.prepare('UPDATE keys SET sealed = ? WHERE owner = ? AND slot = ?').run('v1.AAAA.BBBB.CCCC', first!.owner, first!.slot);
    db.close();
    const before = keyRows(w.dir);
    assert.throws(() => rotateKek({ dir: w.dir, network: NET }), /1 of 3 sealed keys do not open/);
    assert.deepEqual(keyRows(w.dir), before);
    assert.ok(readFileSync(join(w.dir, 'kek')).equals(w.kek), 'the kek file is untouched');
    assert.deepEqual(readdirSync(w.dir).filter((f) => f.startsWith('kek')), ['kek'], 'no kek.new, no kek.old');
    assert.equal(auditOf(w.dir).rows.length, 0);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('a crash after the commit but before the swap is finished on the next run; a kek.new from before the commit is thrown away', () => {
  const w = world(2);
  try {
    // After the commit: the database is under the new kek, the kek file still the old one.
    const r = rotateKek({ dir: w.dir, network: NET, now: Date.parse('2026-10-28T10:00:00Z') });
    renameSync(join(w.dir, 'kek'), join(w.dir, 'kek.new'));
    renameSync(r.oldFile, join(w.dir, 'kek'));
    assert.equal(checkKek({ dir: w.dir, network: NET }).failed.length, 3, 'the executor could not open them now');
    const again = rotateKek({ dir: w.dir, network: NET, now: Date.parse('2026-10-28T10:05:00Z') });
    assert.equal(again.resumed, true);
    assert.equal(again.newId, r.newId, 'no third kek: the one the rows are sealed under');
    assert.ok(!existsSync(join(w.dir, 'kek.new')));
    assert.equal(allOpen(w.dir), 3);
    assert.ok(readFileSync(join(w.dir, 'kek.old-20261028T100500Z')).equals(w.kek));

    // Before the commit: kek.new exists, the rows still open under kek - start again.
    writeFileSync(join(w.dir, 'kek.new'), randomBytes(32), { mode: 0o600 });
    const third = rotateKek({ dir: w.dir, network: NET, now: Date.parse('2026-10-28T10:10:00Z') });
    assert.equal(third.resumed, false);
    assert.equal(allOpen(w.dir), 3);
    const kinds = auditOf(w.dir).rows.map((x) => JSON.parse(x.data).action).reverse();
    assert.deepEqual(kinds, ['rotate', 'rotate-finished', 'rotate']);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('undo: rotating back to the kept old kek (--kek-from) opens everything under it again', () => {
  const w = world(2);
  try {
    const r = rotateKek({ dir: w.dir, network: NET });
    const back = rotateKek({ dir: w.dir, network: NET, newKek: readFileSync(r.oldFile), now: Date.now() + 1000 });
    assert.equal(back.newId, secretId(w.kek));
    assert.ok(readFileSync(join(w.dir, 'kek')).equals(w.kek));
    assert.equal(allOpen(w.dir), 3);
    assert.throws(() => rotateKek({ dir: w.dir, network: NET, newKek: w.kek }), /the kek in force/);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('session.key and import.key: replaced, old kept, an audit row each, the executor starts with them', () => {
  const w = world(1);
  try {
    const s0 = new Secrets(w.dir);
    const token = s0.issueSession(w.owners[0]!, 60_000).token;
    const pub0 = s0.importPublicKey();
    const oldSession = readFileSync(join(w.dir, 'session.key'));

    const a = rotateKeyFile({ dir: w.dir, which: 'session', now: Date.parse('2026-10-28T11:00:00Z') });
    assert.equal(a.oldFile, join(w.dir, 'session.key.old-20261028T110000Z'));
    assert.ok(readFileSync(a.oldFile!).equals(oldSession));
    assert.equal(a.oldId, secretId(oldSession));
    const b = rotateKeyFile({ dir: w.dir, which: 'import', now: Date.parse('2026-10-28T11:00:00Z') });
    assert.ok(b.oldFile && existsSync(b.oldFile));

    const s1 = new Secrets(w.dir);
    assert.equal(s1.readSession(token), null, 'the old session token no longer reads');
    assert.ok(s1.readSession(s1.issueSession(w.owners[0]!, 60_000).token), 'new ones do');
    assert.notEqual(s1.importPublicKey(), pub0, 'a new import key');
    assert.equal(allOpen(w.dir), 2, 'the kek is untouched');
    const rows = auditOf(w.dir).rows;
    assert.deepEqual(rows.map((r) => r.ref).sort(), ['import.key', 'session.key']);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('the command line tools: check, rotate, check again; nothing secret on stdout or stderr', () => {
  const w = world(2);
  try {
    const run = (tool: string, ...a: string[]) =>
      spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join('tools', tool), ...a, '--dir', w.dir], { cwd: APP, encoding: 'utf8', env: { ...process.env, SODEX_NETWORK: 'mainnet' } });
    const c1 = run('rotate-kek.ts', 'check');
    assert.equal(c1.status, 0, c1.stderr);
    assert.match(c1.stdout, /ok: all 3 sealed keys open under kek [0-9a-f]{16}/);
    const r = run('rotate-kek.ts', 'rotate');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /3 sealed keys sealed again/);
    assert.match(r.stdout, /executor-secrets\.sh export/);
    const kekNow = readFileSync(join(w.dir, 'kek'));
    for (const out of [c1.stdout, c1.stderr, r.stdout, r.stderr]) {
      for (const k of [w.kek, kekNow]) {
        assert.ok(!out.includes(k.toString('hex')) && !out.includes(k.toString('base64')) && !out.includes(k.toString('base64url')));
      }
    }
    const old = readdirSync(w.dir).find((f) => f.startsWith('kek.old-'))!;
    const c2 = run('rotate-kek.ts', 'check', '--kek', join(w.dir, old));
    assert.equal(c2.status, 1, 'the old kek no longer opens the database');
    const s = run('rotate-key.ts', 'session');
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stdout, /session\.key replaced/);
    const live = new ExecutorDb(join(w.dir, 'executor.db'));
    try {
      const busy = run('rotate-kek.ts', 'rotate');
      assert.equal(busy.status, 1);
      assert.match(busy.stderr, /already/);
    } finally {
      live.close();
    }
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});
