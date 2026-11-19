/**
 * vsApi's venue reads through exchange/venuesLazy.ts: once a view has bound the module (its page carries it), a
 * read is the module's own call, at once, with the same arguments and the same answer or failure.
 *   npx tsx --test src/exchange/venuesLazy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindVenues, loadVenues, venues } from './venuesLazy';
import { VenueError } from './venueError';

const calls: Array<[string, unknown[]]> = [];
const fake = new Proxy({}, {
  // Not a thenable: loadVenues() resolves to it.
  get: (_t, k: string) => k === 'then' ? undefined : (...a: unknown[]) => {
    calls.push([k, a]);
    return k === 'balances' ? Promise.reject(new VenueError('no account', 'not_available')) : Promise.resolve({ k, a });
  },
}) as Parameters<typeof bindVenues>[0]['venues'];

test('bound: each read is the module\'s call, synchronously, with its arguments and its answer', async () => {
  bindVenues({ venues: fake });
  const p = venues.fills('hyperliquid', '0xabc', { limit: 5 });
  assert.deepEqual(calls.at(-1), ['fills', ['hyperliquid', '0xabc', { limit: 5 }]], 'called before any await');
  assert.deepEqual(await p, { k: 'fills', a: ['hyperliquid', '0xabc', { limit: 5 }] });
  await assert.rejects(venues.balances('sodex', '0xabc'), (e: unknown) => e instanceof VenueError && e.code === 'not_available');
  assert.equal(await loadVenues(), fake, 'nothing loads once bound');
});

// venues.ts itself is not imported here: it starts its venues' pacers, which keep a test run alive.
test('the venue error is one class: venues.ts throws the one vsApi.ts maps, and vsApi.ts never imports venues.ts', () => {
  const v = readFileSync(new URL('./venues.ts', import.meta.url), 'utf8');
  assert.match(v, /import \{ VenueError \} from '\.\/venueError';\nexport \{ VenueError \};/);
  assert.doesNotMatch(v, /class VenueError/);
  const api = readFileSync(new URL('../vsApi.ts', import.meta.url), 'utf8');
  assert.match(api, /from '\.\/exchange\/venueError'/);
  assert.doesNotMatch(api, /from '\.\/exchange\/venues'/, 'a static import would put the venue adapters back in every page');
});
