import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_NOT_CONFIRMED, keyLimit, sendKeyRegistration, type KeyEngine } from './keyRegistration';

test('a full futures key list names the keys, the expired one first, and where to remove one', () => {
  const now = Date.parse('2026-11-20T16:00:00Z');
  const rows = [
    { name: 'default', expiresAt: 0 }, { name: 'mobilekey', expiresAt: now + 5e8 }, { name: 'sodextra-1', expiresAt: now + 5e9 },
    { name: 'webkey', expiresAt: now + 6e8 }, { name: 'GRIDBOT', expiresAt: now + 3e9 }, { name: 'SODEX_API_KEY', expiresAt: now - 3e9 },
  ];
  const l = keyLimit(rows, 'vd-copy-tokyo', 'api key limit', now)!;
  assert.match(l.text, /holds 5 API keys on futures/);
  assert.match(l.text, /: SODEX_API_KEY \(expired\), /);
  assert.match(l.text, /Remove the expired key SODEX_API_KEY with the button below/);
  assert.match(l.text, /\(SoDEX said: api key limit\)$/);
  assert.equal(l.expired, 'SODEX_API_KEY', 'only an expired key is offered for removal');
  // None expired: sodex.com only, no key offered.
  const live = keyLimit(rows.map((r) => ({ ...r, expiresAt: r.name === 'SODEX_API_KEY' ? now + 1e9 : r.expiresAt })), 'vd-copy-tokyo', 'x', now)!;
  assert.equal(live.expired, null);
  assert.match(live.text, /Remove a key you no longer use on sodex\.com/);
  // Room left, or our own key among them (it is replaced): no limit.
  assert.equal(keyLimit(rows.slice(0, 5), 'vd-copy-tokyo', 'x', now), null);
  assert.equal(keyLimit([...rows.slice(0, 5), { name: 'vd-copy-tokyo', expiresAt: now + 1e9 }], 'vd-copy-tokyo', 'x', now), null);
});

class Unknown extends Error {}
const reqs = (...e: KeyEngine[]) => e.map((engine) => ({ engine }));
const isUnknown = (e: unknown) => e instanceof Unknown;
const never = async () => false;

test('every engine gets its request, spot first included (the 2026-11-20 bug sent only the first)', async () => {
  const got: KeyEngine[] = [];
  const r = await sendKeyRegistration(reqs('spot', 'perps'), async (x) => void got.push(x.engine), isUnknown, never);
  assert.deepEqual(got.sort(), ['perps', 'spot']);
  assert.deepEqual(r, { sent: ['spot', 'perps'], failed: [] });
});

test('a perps refusal stops the setup with SoDEX\'s reason', async () => {
  await assert.rejects(
    sendKeyRegistration(reqs('spot', 'perps'), async (x) => { if (x.engine === 'perps') throw new Error('refused'); }, isUnknown, never),
    /refused/,
  );
});

test('a spot refusal leaves a futures key: reported, not thrown', async () => {
  const r = await sendKeyRegistration(reqs('spot', 'perps'), async (x) => { if (x.engine === 'spot') throw new Error('refused'); }, isUnknown, never);
  assert.deepEqual(r, { sent: ['perps'], failed: ['spot'] });
});

test('no answer on perps: SoDEX is asked; listed is fine, not listed throws', async () => {
  const send = async (x: { engine: KeyEngine }) => { if (x.engine === 'perps') throw new Unknown('timeout'); };
  const asked: KeyEngine[] = [];
  const ok = await sendKeyRegistration(reqs('spot', 'perps'), send, isUnknown, async (e) => (asked.push(e), true));
  assert.deepEqual([ok.failed, asked], [[], ['perps']]);
  await assert.rejects(sendKeyRegistration(reqs('spot', 'perps'), send, isUnknown, never), new RegExp(KEY_NOT_CONFIRMED.slice(0, 30)));
});

test('a registration prepared without perps is refused before anything is sent', async () => {
  let sent = 0;
  await assert.rejects(sendKeyRegistration(reqs('spot'), async () => void sent++, isUnknown, never), /futures/);
  assert.equal(sent, 0);
});
