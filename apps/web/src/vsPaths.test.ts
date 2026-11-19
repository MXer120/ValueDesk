/**
 *   npx tsx --test src/vsPaths.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { vsPaths } from './vsPaths';
import { DEFAULT_VIEW, lbQuery } from './components/leaderboard/lbState';

test("mm-daily is asked from the UTC day's start: one URL per day, the server's own key (valuedesk/sodex/mmDaily.ts)", () => {
  const day = Date.UTC(2026, 10, 18);
  assert.equal(vsPaths.mmDaily(day + 13 * 3_600_000 + 1234), `/api/vs/sodex/mm-daily?from=${day}`);
  assert.equal(vsPaths.mmDaily(day), `/api/vs/sodex/mm-daily?from=${day}`);
  assert.equal(vsPaths.mmDaily(day - 1), `/api/vs/sodex/mm-daily?from=${day - 86_400_000}`);
});

test("the leaderboard's read is the bar's choices only, as the page asked before", () => {
  assert.equal(
    vsPaths.leaderboard(lbQuery(DEFAULT_VIEW, 2)),
    '/api/vs/leaderboard?venues=sodex%2Chyperliquid%2Ctradexyz%2Clighter%2Carcus&view=net&window=30d&sort=pnl&limit=100&offset=0&side=top&minTrades=2',
  );
  assert.equal(
    vsPaths.leaderboard(lbQuery({ venues: ['hyperliquid'], side: 'worst', mode: 'net', window: '7d' }, 0)),
    '/api/vs/leaderboard?venues=hyperliquid&window=7d&sort=pnl&limit=100&offset=0&side=worst',
    'one venue: no net/single; any trade count: no filter',
  );
});

test('the bots reads keep their old URLs', () => {
  assert.equal(vsPaths.botRegime('ALL', '24h'), '/api/vs/bots/regime?symbol=ALL&window=24h');
  assert.equal(vsPaths.botRegime('BTC-USD', '7d'), '/api/vs/bots/regime?symbol=BTC-USD&window=7d');
  assert.equal(vsPaths.botMarkets('24h'), '/api/vs/bots/markets?window=24h');
  assert.equal(vsPaths.cohortWallets(['sodex'], 'whale' as never, {}, { sort: 'equity', dir: 'desc', offset: 0, limit: 25, range: '7d' }),
    '/api/vs/cohorts/wallets?venues=sodex&cohort=whale&sort=equity&dir=desc&offset=0&limit=25&range=7d');
});
