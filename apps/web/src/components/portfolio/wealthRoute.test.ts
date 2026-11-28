/** The Wealth page's own pages, read from the path (wealthRoute.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEALTH_PATH, parseWealthPath } from './wealthRoute';

test('every Wealth path names its page; anything else is the overview', () => {
  assert.deepEqual(parseWealthPath('/wealth'), { kind: 'home' });
  assert.deepEqual(parseWealthPath('/wealth/'), { kind: 'home' });
  assert.deepEqual(parseWealthPath('/wealth/fund/Morpho-Earn'), { kind: 'fund', id: 'Morpho-Earn' });
  assert.deepEqual(parseWealthPath('/wealth/indexes'), { kind: 'indexes' });
  assert.deepEqual(parseWealthPath('/wealth/index/new'), { kind: 'new' });
  assert.deepEqual(parseWealthPath('/wealth/index/us-core'), { kind: 'index', id: 'us-core' });
  assert.deepEqual(parseWealthPath('/wealth/index/c123456789/edit'), { kind: 'edit', id: 'c123456789' });
  assert.deepEqual(parseWealthPath('/wealth/index/a/b/c'), { kind: 'home' });
  assert.deepEqual(parseWealthPath('/trade'), { kind: 'home' });
  assert.deepEqual(parseWealthPath(WEALTH_PATH.fund('vQQQ')), { kind: 'fund', id: 'vQQQ' });
  assert.deepEqual(parseWealthPath('/wealth/fund/%E2%9C%93'), { kind: 'fund', id: '✓' });
});
