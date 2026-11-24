import { test } from 'node:test';
import assert from 'node:assert/strict';
import { differing } from './deps-check.mjs';

test('a wrong version and a missing package are named; links and missing optional ones are not', () => {
  const lock = { packages: { '': {}, 'apps/web': { version: '1.0.0' }, 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0' }, 'node_modules/o': { version: '1.0.0', optional: true }, 'node_modules/l': { link: true }, 'apps/web/node_modules/c': { version: '3.0.0' } } };
  assert.deepEqual(differing(lock, { packages: { 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0' }, 'apps/web/node_modules/c': { version: '3.0.0' } } }), []);
  assert.deepEqual(differing(lock, { packages: { 'node_modules/a': { version: '1.0.1' }, 'node_modules/b': { version: '2.0.0' }, 'node_modules/o': { version: '9.0.0' } } }),
    ['node_modules/a 1.0.0 1.0.1', 'node_modules/o 1.0.0 9.0.0', 'apps/web/node_modules/c 3.0.0 missing']);
});
