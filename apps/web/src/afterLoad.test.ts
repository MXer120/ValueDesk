/**
 * Code split out of the first render is fetched after the load event, in an idle moment, once (afterLoad.ts);
 * with Save-Data only on intent.
 *   npx tsx --test src/afterLoad.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { afterLoad, afterLoadEnv, prefetchAfterLoad } from './afterLoad';

let loaded = false;
let onLoad: Array<() => void> = [];
let idle: Array<() => void> = [];
let save = false;
beforeEach(() => {
  loaded = false;
  onLoad = [];
  idle = [];
  save = false;
  afterLoadEnv.loaded = () => loaded;
  afterLoadEnv.onLoad = (fn) => { onLoad.push(fn); return () => { onLoad = onLoad.filter((f) => f !== fn); }; };
  afterLoadEnv.idle = (fn) => { idle.push(fn); return () => { idle = idle.filter((f) => f !== fn); }; };
  afterLoadEnv.saveData = () => save;
});
const fireLoad = () => { loaded = true; for (const f of onLoad.splice(0)) f(); };
const runIdle = () => { for (const f of idle.splice(0)) f(); };

test('before the load event nothing runs; after it, in the first idle moment, once', () => {
  let runs = 0;
  afterLoad(() => { runs++; });
  runIdle();
  assert.equal(runs, 0, 'not while the page is still loading');
  fireLoad();
  assert.equal(runs, 0, 'not in the load event itself');
  runIdle();
  assert.equal(runs, 1);
  runIdle();
  assert.equal(runs, 1);
});

test('a page that has loaded already: the next idle moment', () => {
  loaded = true;
  let runs = 0;
  afterLoad(() => { runs++; });
  assert.equal(onLoad.length, 0);
  runIdle();
  assert.equal(runs, 1);
});

test('cancelled (the component went away): never runs, before or after the load event', () => {
  let runs = 0;
  const cancelEarly = afterLoad(() => { runs++; });
  cancelEarly();
  fireLoad();
  runIdle();
  loaded = true;
  const cancelLate = afterLoad(() => { runs++; });
  cancelLate();
  runIdle();
  assert.equal(runs, 0);
});

test('prefetchAfterLoad: nothing with Save-Data; a failed load never throws into the page', async () => {
  loaded = true;
  save = true;
  let asked = 0;
  prefetchAfterLoad(() => { asked++; return Promise.resolve(); });
  runIdle();
  assert.equal(asked, 0, 'Save-Data: only on intent');
  save = false;
  prefetchAfterLoad(() => { asked++; return Promise.reject(new Error('offline')); });
  prefetchAfterLoad(() => { asked++; throw new Error('sync'); });
  runIdle();
  assert.equal(asked, 2);
  await new Promise((r) => setTimeout(r, 0)); // an unhandled rejection would fail the run here
});
