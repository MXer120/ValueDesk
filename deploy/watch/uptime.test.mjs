// node --test deploy/watch/uptime.test.mjs
//
// The off-box watcher's decisions and probes, with a stand-in fetch: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, parseUrls, probe } from './uptime.mjs';

const H = 3600_000;
const up = { ok: true, note: '200 in 80 ms' };
const down = { ok: false, note: 'answered 502 (3 tries)' };

test('down, still down (no repeat), another one down, reminder after six hours, back up', () => {
  const t0 = 1_800_000_000_000;
  let s = {};
  let d = decide(s, { site: up, api: up, copy: up }, t0);
  assert.equal(d.message, null);
  s = d.next;
  d = decide(s, { site: up, api: down, copy: up }, t0 + 1 * 60_000);
  assert.match(d.message, /^ValueDesk DOWN \(seen from outside, GitHub\)\n- api: answered 502/);
  s = d.next;
  d = decide(s, { site: up, api: down, copy: up }, t0 + 31 * 60_000);
  assert.equal(d.message, null, 'no message every round');
  s = d.next;
  d = decide(s, { site: up, api: down, copy: down }, t0 + 61 * 60_000);
  assert.match(d.message, /DOWN[\s\S]*- api:[\s\S]*- copy:/, 'a second one down is news');
  s = d.next;
  d = decide(s, { site: up, api: down, copy: down }, t0 + 61 * 60_000 + 6 * H + 1);
  assert.match(d.message, /^ValueDesk STILL DOWN for 7 h/);
  s = d.next;
  d = decide(s, { site: up, api: up, copy: down }, t0 + 8 * H);
  assert.match(d.message, /partly back: api up again; still down:\n- copy/);
  s = d.next;
  d = decide(s, { site: up, api: up, copy: up }, t0 + 9 * H);
  assert.match(d.message, /^ValueDesk UP again \(seen from outside\): copy after \d+ min$/);
  assert.deepEqual(d.next.down, {});
});

test('a probe retries before it calls something down, and judges JSON health answers', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return { status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => ({ ok: true }) };
  };
  const r = await probe({ url: 'https://x.invalid/api/health' }, { fetchImpl: flaky, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.match(r.note, /try 3/);
  const sick = async () => ({ status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => ({ ok: false }) });
  const r2 = await probe({ url: 'https://x.invalid/api/health' }, { fetchImpl: sick, sleep: async () => {} });
  assert.equal(r2.ok, false);
  assert.match(r2.note, /ok:false \(3 tries\)/);
  const moved = async () => ({ status: 308, headers: new Map(), text: async () => '' });
  assert.equal((await probe({ url: 'https://x.invalid/' }, { fetchImpl: moved, sleep: async () => {} })).ok, false, 'a redirect is not the site');
});

test('the URL list: name=url, https only, the three production ones by default', () => {
  assert.deepEqual(parseUrls('').map((t) => t.name), ['site', 'api', 'copy']);
  assert.throws(() => parseUrls('a=http://example.com'), /not https/);
  assert.throws(() => parseUrls('nonsense'), /not name=url/);
});
