import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_NOT_CONFIRMED, sendKeyRegistration, type KeyEngine } from './keyRegistration';

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
