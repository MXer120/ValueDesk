/**
 *   npx tsx --test src/firstReadDefaults.test.ts
 *
 * The build's default first reads are byte for byte what each page asked for on a fresh profile (recorded 2026-11-18 on
 * production data, phone and desktop): a default that differs from the page's own read is a wasted request on the
 * line before the first paint.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { aheadReads, copyBoards, firstReadDefaults } from './firstReadDefaults';
import { pickFirstReads } from './serverFetch';

const ALL5 = 'sodex%2Chyperliquid%2Ctradexyz%2Clighter%2Carcus';
const board = (v: string, worst = false) => `/api/vs/leaderboard?venue=${v}&window=30d&sort=pnl&limit=100${worst ? '&side=worst' : ''}`;

test('each landing URL starts exactly what its page reads first', () => {
  assert.deepEqual(firstReadDefaults(), {
    // Their first data waits on SoDEX's reads: nothing early (measured: Explore's five early reads made it later).
    '/': [],
    '/trade': [],
    '/explore': [],
    '/explore?view=cohorts': [`/api/vs/cohorts?venues=${ALL5}`],
    '/leaderboard': [`/api/vs/leaderboard?venues=${ALL5}&view=net&window=30d&sort=pnl&limit=100&offset=0&side=top&minTrades=2`],
    '/copy': [],
    '/bots': ['/api/vs/bots/regime?symbol=ALL&window=24h'],
    '/blind-boxes': ['/api/vs/sodex/lottery/meta', '/api/vs/sodex/lottery/feed?limit=24'],
    '/wealth': ['/api/vs/sodex/wealth/maintenance'],
  });
});

test('a page that starts nothing on landing has its reads for intent: exactly what it asks for', () => {
  const venues = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
  assert.deepEqual(copyBoards(), [...venues.map((v) => board(v)), ...venues.map((v) => board(v, true))]);
  assert.deepEqual(aheadReads(), {
    '/': ['/api/vs/sodex/oi-excluded'],
    '/trade': ['/api/vs/sodex/oi-excluded'],
    '/explore': ['/api/vs/screener?view=assets', `/api/vs/cohorts/map?venues=${ALL5}`, '/api/vs/sodex/oi-excluded', board('sodex'), board('hyperliquid')],
    '/copy': copyBoards(),
  });
  for (const route of Object.keys(aheadReads())) assert.deepEqual(firstReadDefaults()[route], [], `${route}: nothing on landing`);
});

test('every default is one serverFetch may start early: our index, nothing personal, at most six a page', () => {
  for (const [route, paths] of Object.entries(firstReadDefaults())) {
    const picked = pickFirstReads(paths.map((p) => [p, 0]));
    assert.deepEqual(picked, paths.slice(0, 6), route);
  }
});
