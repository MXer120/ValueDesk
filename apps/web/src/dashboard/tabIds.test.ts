import assert from 'node:assert/strict';
import test from 'node:test';
import { assetOf, baseOf, copyOf, extraKey, isExtraKey, nextCopy } from './tabIds';

test('a duplicate is the next free copy of its tab', () => {
  assert.equal(nextCopy([], 'news'), 'news');
  assert.equal(nextCopy(['news'], 'news'), 'news#2');
  assert.equal(nextCopy(['news', 'news#2'], 'news#2'), 'news#3');
  assert.equal(nextCopy(['asset:SOL-USD'], 'asset:SOL-USD'), 'asset:SOL-USD#2');
});

test('ids read back: the widget, the copy number, the market', () => {
  assert.equal(baseOf('news#3'), 'news');
  assert.equal(copyOf('news#3'), 3);
  assert.equal(copyOf('news'), null);
  assert.equal(assetOf('asset:SOL-USD#2'), 'SOL-USD');
  assert.equal(assetOf('news'), null);
  assert.equal(extraKey('news#2'), 'x:news#2');
  assert.ok(isExtraKey('x:news') && !isExtraKey('positions'));
});
