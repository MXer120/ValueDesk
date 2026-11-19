/** The chart library's one download (klineLib.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _resetKlineLib, klineLibEnv, loadKlineLib, preloadKlineLib } from './klineLib';

type Lib = Awaited<ReturnType<typeof klineLibEnv.importLib>>;

test('klineLib: the preload and the chart share one download', async () => {
  _resetKlineLib();
  let calls = 0;
  const lib = { init: () => null } as unknown as Lib;
  klineLibEnv.importLib = () => {
    calls++;
    return Promise.resolve(lib);
  };
  preloadKlineLib();
  const a = await loadKlineLib();
  const b = await loadKlineLib();
  assert.equal(calls, 1);
  assert.equal(a, lib);
  assert.equal(b, lib);
});

test('klineLib: a failed download is asked for again, not kept as a rejection', async () => {
  _resetKlineLib();
  let calls = 0;
  const lib = { init: () => null } as unknown as Lib;
  klineLibEnv.importLib = () => {
    calls++;
    return calls === 1 ? Promise.reject(new Error('Failed to fetch dynamically imported module')) : Promise.resolve(lib);
  };
  preloadKlineLib();
  await assert.rejects(loadKlineLib());
  // The rejection's own handler has run by now: the next call starts a new download.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await loadKlineLib(), lib);
  assert.equal(calls, 2);
});
