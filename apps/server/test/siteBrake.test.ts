/**
 * The site's emergency brake (ops/brake.ts): a file the operator writes, read
 * by /api/health. Off only when there is no file or every switch is false;
 * a typo or garbage is a full brake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSiteBrake, siteBrakeReader } from '../src/ops/brake.js';

test('site brake: every switch false is off; anything else is on, a broken file fully', () => {
  assert.equal(parseSiteBrake('{"trading": false, "copies": false, "algos": false}'), null);
  assert.deepEqual(parseSiteBrake('{"trading": true, "copies": false, "algos": false, "reason": "Investigating.", "since": 7}'), { trading: true, copies: false, algos: false, reason: 'Investigating.', since: 7 });
  const broken = parseSiteBrake('{"trading": fals');
  assert.ok(broken?.trading && broken.copies && broken.algos);
  assert.ok(parseSiteBrake('{}')?.trading, 'an empty object brakes everything');
  assert.ok(parseSiteBrake('null')?.trading);
});

test('site brake reader: follows the file as it is written and removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-site-brake-'));
  const file = join(dir, 'brake.json');
  const read = siteBrakeReader(file) as (now?: number) => ReturnType<typeof parseSiteBrake>;
  const t = Date.now();
  assert.equal(read(t), null);
  writeFileSync(file, '{"trading": true, "copies": true, "algos": true, "reason": "x"}');
  assert.equal(read(t + 500), null, 'read at most once a second');
  assert.equal(read(t + 1_500)?.reason, 'x');
  rmSync(file);
  assert.equal(read(t + 3_000), null);
  assert.equal(siteBrakeReader(null)(), null);
  rmSync(dir, { recursive: true, force: true });
});
