/**
 * `expiresAt` IS A MILLISECOND TIMESTAMP.
 *
 * This file exists because 191 tests passed while enabling trading was broken
 * for every user. The signing layer was byte-identical to the Go SDK, the
 * permission mask was right, the request was well-formed - and the venue
 * rejected it with "expiresAt is invalid", because we sent Unix SECONDS into a
 * field the exchange reads as MILLISECONDS. 1.79e9 milliseconds is three weeks
 * after the epoch, so every key we requested had already expired in 1970.
 *
 * The unit is not inferred from documentation - the SoDEX API docs and the Go
 * SDK's `AddPermissionedAPIKeyRequest` both declare `expiresAt uint64` with no
 * comment. It is read off the venue's own keys on a live account:
 *
 *     webkey     1788193904811  ->  2026-08-31   (about 24h out)
 *     mobilekey  1786523374853  ->  2026-08-12
 *     default    0              ->  never expires
 *
 * Read as seconds those are the year 58635. `webkey` also settles a second
 * question: a 24-hour key is fine, so the TTL was never the problem.
 *
 * A unit error is invisible to a type checker - both units are `number` - and
 * invisible to a signing test, which only proves we sign whatever we are given.
 * The only thing that catches it is an assertion about MAGNITUDE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

/** Any plausible ms timestamp is >= this; any seconds timestamp is far below. */
const MS_FLOOR = 1_000_000_000_000; // 2001-09-09 in ms, year 33658 in seconds

test('a session key expires in milliseconds, roughly 24h out', () => {
  const src = read(join('routes', 'wallet.ts'));

  const ttl = /const SESSION_TTL_MS = ([^;]+);/.exec(src);
  assert.ok(ttl, 'SESSION_TTL_MS must exist - a *_SEC name is the bug this file guards');
  // eslint-disable-next-line no-eval
  const ttlMs = eval(ttl[1]!) as number;
  assert.equal(ttlMs, 86_400_000, '24 hours, expressed in milliseconds');

  // The value that actually goes on the wire.
  assert.match(
    src,
    /const expiresAt = Date\.now\(\) \+ SESSION_TTL_MS;/,
    'expiresAt must be built from Date.now() directly - dividing by 1000 first is exactly the bug',
  );

  const expiresAt = Date.now() + ttlMs;
  assert.ok(expiresAt > MS_FLOOR, 'expiresAt must be a millisecond timestamp');
  const hoursOut = (expiresAt - Date.now()) / 3_600_000;
  assert.ok(hoursOut > 23 && hoursOut < 25, `expected ~24h, got ${hoursOut}h`);
});

test('an elevation expires in milliseconds too', () => {
  const src = read('elevation.ts');
  assert.match(
    src,
    /const expiresAt = Date\.now\(\) \+ ELEVATION_TTL_SEC \* 1000;/,
    'elevation must convert its seconds TTL to a millisecond timestamp',
  );
});

test('nothing still compares an expiry against Unix seconds', () => {
  /*
   * The half-applied fix is worse than the bug: send milliseconds but keep
   * comparing against `Date.now() / 1000` and every live key reads as expired
   * on its first use, with no way to recover except restarting the backend.
   */
  for (const f of [join('sodex', 'rest.ts'), join('routes', 'wallet.ts'), 'elevation.ts']) {
    const src = read(f);
    for (const line of src.split('\n')) {
      if (!line.includes('expiresAt')) continue;
      assert.ok(
        !/Date\.now\(\)\s*\/\s*1000/.test(line),
        `${f}: expiresAt compared against seconds -> ${line.trim()}`,
      );
    }
  }
});
