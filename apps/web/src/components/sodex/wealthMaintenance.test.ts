/** The maintenance read against mocks. Nothing leaves the machine. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEALTH_MAINTENANCE_PATH, fetchMaintenance } from './wealthMaintenance';

test('maintenance: only an answer that says so is maintenance; a failed read is unknown', async () => {
  const answer = (ok: boolean, body: { status?: unknown; message?: unknown } | null) => async (path: string) => {
    assert.equal(path, WEALTH_MAINTENANCE_PATH);
    return { ok, body };
  };
  assert.deepEqual(await fetchMaintenance(undefined, answer(true, { status: 'NORMAL', message: '' })), { state: 'normal', message: null });
  assert.deepEqual(await fetchMaintenance(undefined, answer(true, { status: 'MAINTENANCE', message: 'Back at 14:00' })), { state: 'maintenance', message: 'Back at 14:00' });
  assert.deepEqual(await fetchMaintenance(undefined, answer(false, null)), { state: 'unknown', message: null });
  assert.deepEqual(await fetchMaintenance(undefined, answer(true, { status: 'ODD' })), { state: 'unknown', message: null });
  assert.deepEqual(await fetchMaintenance(undefined, async () => { throw new Error('offline'); }), { state: 'unknown', message: null });
});
