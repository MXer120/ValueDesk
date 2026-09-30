/**
 * Run: npx tsx --test src/components/scan/addressVenues.test.ts   (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderProfile, Venue } from '../../vsApi';
import {
  absent,
  accountStanding,
  cardFromProfile,
  chooserCards,
  inactiveVenue,
  nettedEquity,
  overviewCards,
  switchStanding,
  unknownCard,
  verdictOf,
} from './addressVenues';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const profile = (o: Partial<TraderProfile['summary']> = {}, positions: TraderProfile['positions'] = []): TraderProfile => ({
  summary: {
    venue: 'hyperliquid', address: '0x0', accountValue: null, pnl: {}, roi: {}, volume: {}, ...o,
  },
  positions,
  equity: {},
  updatedAt: 0,
  source: '',
});

const pos = (): TraderProfile['positions'][number] => ({
  symbol: 'BTC', side: 'long', size: 1, notional: 1, entryPx: 1, markPx: 1,
  liqPx: null, uPnl: 0, leverage: 1, marginMode: 'cross',
});

test('inactive: equity counts even with no timestamp; old or empty does not', () => {
  assert.equal(inactiveVenue(profile({ accountValue: 12 }), NOW), false);
  assert.equal(inactiveVenue(profile({ accountValue: 0, lastActive: null }), NOW), true);
  assert.equal(inactiveVenue(profile({ lastActive: NOW - 40 * DAY }), NOW), true);
  assert.equal(inactiveVenue(profile({ lastActive: NOW - DAY }), NOW), false);
  assert.equal(inactiveVenue(profile({ volume: { '30d': 5 } }), NOW), false);
  assert.equal(inactiveVenue(profile({}, [pos()]), NOW), false);
});

test('cardFromProfile: a null profile is absent; a shell exists but is inactive', () => {
  assert.equal(cardFromProfile('sodex', null, NOW).exists, false);
  const shell = cardFromProfile('sodex', profile({ accountValue: 0, venue: 'sodex' }), NOW);
  assert.equal(shell.exists, true);
  assert.equal(shell.inactive, true);
  assert.equal(shell.equity, 0);
  assert.equal(shell.lastActive, null);
  const rich = cardFromProfile('hyperliquid', profile({
    accountValue: 40,
    lastActive: NOW - 2 * DAY,
  }), NOW);
  assert.equal(rich.inactive, false);
  assert.equal(rich.lastActive, NOW - 2 * DAY);
});

test('cardFromProfile keeps an old last-active time on an inactive venue and draws a 30d curve', () => {
  const p = profile({ accountValue: 0, lastActive: NOW - 40 * DAY });
  p.equity = {
    '30d': [
      { t: 1, accountValue: 1, pnl: 0 },
      { t: 2, accountValue: 1, pnl: 4 },
    ],
  };
  const card = cardFromProfile('sodex', p, NOW);
  assert.equal(card.inactive, true);
  assert.equal(card.lastActive, NOW - 40 * DAY);
  assert.equal(card.curve?.change, 4);
  assert.equal(card.historyNote, undefined);
});

test('cardFromProfile: a flagged SoDEX history draws no curve and says why; live equity stays', () => {
  const p = profile({ accountValue: 250, venue: 'sodex' });
  p.equity = { '30d': [{ t: 1, accountValue: null, pnl: 0 }, { t: 2, accountValue: null, pnl: 4 }] };
  p.analyticsSuspect = 'no-deposits-recorded';
  const card = cardFromProfile('sodex', p, NOW);
  assert.equal(card.curve, null);
  assert.equal(card.equity, 250);
  assert.match(card.historyNote!, /Showing live equity only\.$/);
});

test('verdict: one venue goes straight, two ask, neither is none, a failed read does not count as none', () => {
  const sodex = cardFromProfile('sodex', profile({ accountValue: 1, venue: 'sodex' }), NOW);
  const hl = cardFromProfile('hyperliquid', profile({ accountValue: 2 }), NOW);
  assert.deepEqual(verdictOf([sodex, absent('hyperliquid')]), { kind: 'one', venue: 'sodex' });
  assert.equal(verdictOf([sodex, hl]).kind, 'many');
  assert.equal(verdictOf([absent('sodex'), absent('hyperliquid')]).kind, 'none');
  assert.equal(verdictOf([sodex, unknownCard('hyperliquid')]).kind, 'ask');
  assert.equal(verdictOf([unknownCard('sodex'), unknownCard('hyperliquid')]).kind, 'ask');
  const many = chooserCards([sodex, hl]);
  assert.deepEqual(many.map((c) => c.venue), ['sodex', 'hyperliquid'] as Venue[]);
  const ask = chooserCards([absent('sodex'), unknownCard('hyperliquid')]);
  assert.deepEqual(ask.map((c) => c.venue), ['hyperliquid']);
});

test('overview keeps an inactive venue and nets both equities', () => {
  const sodex = cardFromProfile('sodex', profile({ accountValue: 10, venue: 'sodex' }), NOW);
  const quiet = cardFromProfile('hyperliquid', profile({ accountValue: 0, lastActive: NOW - 40 * DAY }), NOW);
  const cards = overviewCards([sodex, quiet]);
  assert.deepEqual(cards.map((c) => c.venue), ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus']);
  assert.equal(cards[1]?.inactive, true);
  assert.equal(cards[1]?.exists, true);
  const net = nettedEquity([sodex, quiet]);
  assert.equal(net.equity, 10);
  assert.equal(net.unread, 0);
  const missing = nettedEquity([sodex, unknownCard('hyperliquid')]);
  assert.equal(missing.equity, 10);
  assert.equal(missing.unread, 1);
  const empty = nettedEquity([absent('sodex'), absent('hyperliquid')]);
  assert.equal(empty.equity, 0);
  assert.equal(empty.known, 5);
});

test('accountStanding and switchStanding: zero equity with no positions is inactive', () => {
  assert.equal(accountStanding({ exists: true, accountValue: 0 }, 0), 'inactive');
  assert.equal(accountStanding({ exists: true, accountValue: 8 }, 0), 'active');
  assert.equal(accountStanding({ exists: false, accountValue: 0 }, 1), 'active');
  assert.equal(accountStanding({ exists: false, accountValue: 0 }, 0), 'none');
  const empty = { data: null, loading: false, error: null, settled: true };
  assert.equal(switchStanding(empty), 'none');
  assert.equal(switchStanding({ data: profile({ accountValue: 3 }), loading: false, error: null, settled: true }, NOW), 'active');
  assert.equal(switchStanding({ data: profile({ lastActive: NOW - 40 * DAY }), loading: false, error: null, settled: true }, NOW), 'inactive');
  assert.equal(switchStanding({ data: null, loading: true, error: null, settled: false }), 'loading');
  assert.equal(switchStanding({ data: null, loading: false, error: 'down', settled: true }), 'unknown');
});
