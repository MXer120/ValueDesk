/**
 * The admin suite's user list (db.ts usersSummary, server.ts GET /internal/users): every
 * wallet the executor knows - a terms signer, a follower, an algo owner, a key holder -
 * once, with what it signed and runs; the route answers only server 1's internal token.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { ExecutorConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { createExecutorServer } from '../src/server.ts';
import type { ExecutorService } from '../src/service.ts';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);

function consent(owner: string, action: string, at: number, payload: object, viewerCountry: string | null) {
  return { owner, action, digest: `${owner}-${action}-${at}`, signature: '0x', chainId: 1, payload: JSON.stringify(payload), nonce: String(at), at, viewerCountry };
}

function seeded(): ExecutorDb {
  const db = new ExecutorDb(':memory:');
  db.addConsent(consent(A, 'accept-site-terms', 1_000, { country: 'de' }, 'DE'));
  db.addConsent(consent(A, 'accept-terms', 2_000, { country: 'DE' }, 'AT'));
  void db.saveSubscription({ id: 's1', owner: A, status: 'active' } as never);
  void db.saveSubscription({ id: 's2', owner: A, status: 'stopped' } as never);
  void db.saveAlgo({ id: 'a1', owner: B, status: 'running' } as never);
  void db.saveAlgo({ id: 'a2', owner: B, status: 'done' } as never);
  void db.addActivity({ id: 'x1', subId: 's1', owner: A, at: 5_000 } as never);
  db.putKey({ owner: C, slot: 'active', address: C, name: 'k', sealed: 'x', createdAt: 1, expiresAt: null, registered: true, checkedAt: 1 } as never);
  return db;
}

test('usersSummary: one row per wallet from every table, with its terms, copies, algos and keys', () => {
  const db = seeded();
  const rows = new Map(db.usersSummary().map((u) => [u.owner, u]));
  assert.deepEqual([...rows.keys()].sort(), [A, B, C]);
  assert.deepEqual(rows.get(A), {
    owner: A, firstAt: 1_000, lastSignedAt: 2_000, siteTermsAt: 1_000, copyTermsAt: 2_000, country: 'DE', viewerCountry: 'AT',
    copies: 2, activeCopies: 1, algos: 0, liveAlgos: 0, keys: 0, lastActivityAt: 5_000,
  });
  assert.equal(rows.get(B)!.algos, 2);
  assert.equal(rows.get(B)!.liveAlgos, 1, 'a done algo is not live');
  assert.equal(rows.get(B)!.firstAt, null, 'never signed');
  assert.equal(rows.get(C)!.keys, 1);
  db.close();
});

test('GET /internal/users: only with the internal token; without one configured the route is not there', async () => {
  const db = seeded();
  const svc = { db, audit() {} } as unknown as ExecutorService;
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const run = async (builderToken: string | null, headers: Record<string, string>) => {
    const cfg = { trustEdge: true, allowedOrigins: [], originSecrets: [], builderToken } as unknown as ExecutorConfig;
    const server = createExecutorServer(svc, cfg, silent);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy/v1/internal/users`, { headers });
      return { status: res.status, body: (await res.json()) as { users?: unknown[] } };
    } finally {
      await new Promise((r) => server.close(r));
    }
  };
  assert.equal((await run('tok', {})).status, 404);
  assert.equal((await run('tok', { 'x-internal-token': 'nope' })).status, 404);
  assert.equal((await run(null, { 'x-internal-token': '' })).status, 404);
  const ok = await run('tok', { 'x-internal-token': 'tok' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.users?.length, 3);
  db.close();
});
