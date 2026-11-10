// node --test deploy/release/vercel-web.test.mjs
//
// ship.sh's early web (deploy/release/vercel-web.mjs) against a fake Vercel API: the staged deployment is a PRODUCTION
// build without the domains, of the branch `ship`; a promote counts only once the project reads it back as its
// production deployment; a discard never touches a deployment that has domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, discard, promote, stage, stageBody, stateOf, waitFor } from './vercel-web.mjs';

const SHA = 'a'.repeat(40);
const noSleep = async () => {};

/** A fake api.vercel.com: routes by "METHOD path" (query left out), records each call. */
function fakeVercel(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    calls.push({ key, query: u.search, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization });
    const h = routes[key];
    const [status, body] = typeof h === 'function' ? h() : h ?? [404, { error: { message: 'not found' } }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, api: client({ token: 'tok', team: 'team_1', fetchImpl }) };
}

test('the staged deployment: production, no domains, the ship branch at the exact commit', async () => {
  assert.deepEqual(stageBody({ project: 'valuedesk', repo: 'MXer120/ValueDesk', sha: SHA, tag: 'v0.2.205' }), {
    name: 'valuedesk', project: 'valuedesk', target: 'production', autoAssignCustomDomains: false,
    gitSource: { type: 'github', org: 'MXer120', repo: 'ValueDesk', ref: 'ship', sha: SHA },
    meta: { shipTag: 'v0.2.205', shipStaged: '1' },
  });
  const v = fakeVercel({ 'POST /v13/deployments': [200, { id: 'dpl_1' }] });
  assert.equal(await stage(v.api, { project: 'valuedesk', repo: 'MXer120/ValueDesk', sha: SHA, tag: 'v0.2.205' }), 'dpl_1');
  assert.match(v.calls[0].query, /forceNew=1/);
  assert.match(v.calls[0].query, /teamId=team_1/);
  assert.equal(v.calls[0].auth, 'Bearer tok');
  const bad = fakeVercel({ 'POST /v13/deployments': [403, { error: { message: 'forbidden' } }] });
  await assert.rejects(stage(bad.api, { project: 'p', repo: 'o/r', sha: SHA }), /did not create the deployment \(403: forbidden\)/);
});

test('states', () => {
  assert.deepEqual(stateOf({ readyState: 'READY' }), { state: 'READY', aliased: false });
  assert.deepEqual(stateOf({ readyState: 'READY', aliasAssigned: 1731100000000 }), { state: 'READY', aliased: true });
  assert.equal(stateOf({ readyState: 'ERROR' }).state, 'ERROR');
  assert.equal(stateOf({ readyState: 'CANCELED' }).state, 'CANCELED');
  for (const s of ['QUEUED', 'INITIALIZING', 'BUILDING', undefined]) assert.equal(stateOf({ readyState: s }).state, 'BUILDING');
});

test('wait: until built, or the time is up', async () => {
  let n = 0;
  const v = fakeVercel({ 'GET /v13/deployments/dpl_1': () => [200, { readyState: ++n < 3 ? 'BUILDING' : 'READY' }] });
  assert.deepEqual(await waitFor(v.api, 'dpl_1', { seconds: 900, sleep: noSleep }), { state: 'READY', aliased: false });
  assert.equal(n, 3);
  const slow = fakeVercel({ 'GET /v13/deployments/dpl_1': [200, { readyState: 'BUILDING' }] });
  assert.equal((await waitFor(slow.api, 'dpl_1', { seconds: 30, every: 15, sleep: noSleep })).state, 'BUILDING');
});

test('promote: done only when the project reads it back as production', async () => {
  let reads = 0;
  const v = fakeVercel({
    'GET /v9/projects/valuedesk': [200, { id: 'prj_1' }],
    'POST /v10/projects/prj_1/promote/dpl_1': [201, {}],
    'GET /v9/projects/prj_1': () => [200, { id: 'prj_1', targets: { production: { id: ++reads < 2 ? 'dpl_old' : 'dpl_1' } } }],
  });
  assert.equal(await promote(v.api, 'valuedesk', 'dpl_1', { sleep: noSleep }), true);
  assert.deepEqual(v.calls.map((c) => c.key), ['GET /v9/projects/valuedesk', 'POST /v10/projects/prj_1/promote/dpl_1', 'GET /v9/projects/prj_1', 'GET /v9/projects/prj_1']);

  const never = fakeVercel({
    'GET /v9/projects/valuedesk': [200, { id: 'prj_1' }],
    'POST /v10/projects/prj_1/promote/dpl_1': [202, {}],
    'GET /v9/projects/prj_1': [200, { id: 'prj_1', targets: { production: { id: 'dpl_old' } } }],
  });
  await assert.rejects(promote(never.api, 'valuedesk', 'dpl_1', { seconds: 10, sleep: noSleep }), /not dpl_1 after 10 s/);
  const refused = fakeVercel({ 'GET /v9/projects/valuedesk': [200, { id: 'prj_1' }], 'POST /v10/projects/prj_1/promote/dpl_1': [409, { error: { message: 'conflict' } }] });
  await assert.rejects(promote(refused.api, 'valuedesk', 'dpl_1', { sleep: noSleep }), /refused the promote \(409: conflict\)/);
});

test('discard: cancel while building, delete when built, never one with domains', async () => {
  let v = fakeVercel({ 'GET /v13/deployments/d': [200, { readyState: 'BUILDING' }], 'PATCH /v12/deployments/d/cancel': [200, {}] });
  assert.equal(await discard(v.api, 'd'), 'cancelled');
  v = fakeVercel({ 'GET /v13/deployments/d': [200, { readyState: 'READY' }], 'DELETE /v13/deployments/d': [200, {}] });
  assert.equal(await discard(v.api, 'd'), 'deleted');
  v = fakeVercel({ 'GET /v13/deployments/d': [200, { readyState: 'READY', aliasAssigned: 1 }] });
  assert.equal(await discard(v.api, 'd'), 'kept (it has domains)');
  assert.deepEqual(v.calls.map((c) => c.key), ['GET /v13/deployments/d']);
});
