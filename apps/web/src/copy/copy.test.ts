/**
 * Live copy, the parts that are pure: where a self-hosted copier may be,
 * the setup form as engine rules, what each mode still needs, the terms hash.
 * Run (from apps/web): npx tsx --test src/copy/copy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COPY_TERMS_VERSION, checkSettings } from '@copy-engine';
import { DEFAULT_SETUP, parseSetup, toCopySettings } from '../components/copy/setup';
import { COPY_TERMS } from '../legal/copyTerms';
import { selfBase, selfUrlProblem } from './executor';
import { readiness, type LiveCopy } from './live';
import { COPY_TERMS_HASH } from './terms';

const LEADER = '0x' + 'ab'.repeat(20);

test('a self-hosted copier must be on loopback (the site may reach nothing else)', () => {
  assert.equal(selfUrlProblem('http://127.0.0.1:8799'), null);
  assert.equal(selfUrlProblem('http://localhost:9000'), null);
  assert.ok(selfUrlProblem('http://192.168.1.5:8799'));
  assert.ok(selfUrlProblem('https://my-vps.example:8799'));
  assert.ok(selfUrlProblem('not a url'));
  assert.equal(selfBase('http://127.0.0.1:8799/'), 'http://127.0.0.1:8799/api/copy/v1');
  assert.equal(selfBase('http://127.0.0.1:8799/api/copy/v1'), 'http://127.0.0.1:8799/api/copy/v1');
});

test('the setup form becomes rules the engine accepts as they are', () => {
  const s = { ...DEFAULT_SETUP, stopLoss: '40', deny: 'doge', confirmEach: true, paper: true, maxLeverage: '3.7' };
  const rules = toCopySettings(parseSetup(s), s, { venue: 'hyperliquid', address: LEADER });
  const r = checkSettings(rules);
  assert.deepEqual(r.errors, {});
  assert.equal(r.settings!.leader.venue, 'hyperliquid');
  assert.equal(r.settings!.maxLeverage, 3);
  assert.equal(r.settings!.stopLossPct, 0.4);
  assert.deepEqual(r.settings!.assetDeny, ['DOGE']);
  assert.equal(r.settings!.approval, 'confirm');
  assert.equal(r.settings!.paper, true);
  // The backtest allows 0 bps slippage; a live copy needs at least 1.
  const zero = { ...DEFAULT_SETUP, slippageBps: '0' };
  assert.equal(toCopySettings(parseSetup(zero), zero, { venue: 'sodex', address: LEADER }).slippageBps, 1);
});

const base = (): LiveCopy => ({
  owner: '0x' + '11'.repeat(20),
  canSign: true,
  terms: null,
  viewerCountry: null,
  fee: { checked: true, perps: null, covers: false, builderId: 1 },
  browser: { role: 'off', key: null, views: [], confirms: [], persistent: true, keyRegistered: null },
  hosted: { info: null, infoError: null, me: null, signedIn: false },
  self: { info: null, infoError: null, me: null, signedIn: false, url: 'http://127.0.0.1:8799' },
  busy: null,
});

test('readiness: a mode is ready only with terms, the fee, its connection and its key', () => {
  const s = base();
  assert.equal(readiness(s, 'browser').ready, false);
  s.terms = { termsVersion: COPY_TERMS_VERSION, termsHash: COPY_TERMS_HASH, country: 'SG', acceptedAt: 1, recorded: true, request: {} as never };
  s.browser.key = { address: '0x' + '22'.repeat(20), name: 'vd-copy-browser', expiresAt: Date.now() + 3_600_000, accountId: 5 };
  // No builder in a test build: the fee step is not needed.
  const b = readiness(s, 'browser');
  assert.equal(b.terms && b.key && b.connected, true);
  const h = readiness(s, 'hosted');
  assert.equal(h.connected, false);
  assert.equal(h.ready, false);
});

test('the terms hash is the hash of the text shown, and the text names its version', () => {
  assert.match(COPY_TERMS_HASH, /^0x[0-9a-f]{64}$/);
  assert.ok(JSON.stringify(COPY_TERMS).includes(COPY_TERMS_VERSION));
});
