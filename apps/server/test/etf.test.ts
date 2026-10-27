/**
 * ETF flows: SoSoValue's ETF responses saved on 25 October 2026
 * (test/fixtures/etf), and the route's cache, budget and store against a fake
 * network and a temporary directory. Nothing here calls the network.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NotAvailable } from '../src/valuedesk/types.js';
import { resetNewsCache } from '../src/valuedesk/sosovalue/news.js';
import {
  buildFunds,
  daysIn,
  etfFlows,
  mergeDays,
  parseEtfAsset,
  parseEtfList,
  parseEtfRange,
  parseEtfSnapshot,
  parseEtfSummary,
  resetEtf,
  sosoData,
  type EtfDay,
} from '../src/valuedesk/sosovalue/etf.js';

const json = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/etf/${name}`, import.meta.url), 'utf8'));

test("the summary: settled days oldest first, SoSoValue's decimals as whole dollars", () => {
  const days = parseEtfSummary(json('summary-btc.json'));
  assert.equal(days.length, 20);
  assert.equal(days[0]!.date, '2026-09-25');
  assert.deepEqual(days.at(-1), { date: '2026-10-22', netInflow: -635_492_639, cumNetInflow: 57_320_800_663, totalNetAssets: 104_707_576_994, valueTraded: 2_555_720_648 });
  assert.deepEqual(days.at(-2), { date: '2026-10-21', netInflow: 528_400_237, cumNetInflow: 57_956_293_302, totalNetAssets: 109_308_814_724, valueTraded: 3_152_857_008 });
  // Trading days only: the weekend of 17-18 October is not there.
  assert.deepEqual(days.slice(-6).map((d) => d.date), ['2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']);
  const eth = parseEtfSummary(json('summary-eth.json'));
  assert.equal(eth.length, 20);
  assert.equal(eth.at(-1)!.date, '2026-10-22');
  // A row whose flows have not settled is left out; an error code is an error.
  assert.deepEqual(parseEtfSummary({ code: 0, data: [{ date: '2026-10-23', total_net_inflow: null, total_value_traded: 1 }] }), []);
  assert.throws(() => sosoData({ code: 400003, message: 'Invalid parameter: symbol' }), /400003: Invalid parameter/);
});

test('the fund list and a snapshot', () => {
  const list = parseEtfList(json('list-btc.json'));
  assert.deepEqual(list.map((f) => f.ticker), ['IBIT', 'FBTC', 'ARKB', 'BTCO', 'BTCW', 'BRRR', 'BITB', 'EZBC', 'HODL', 'GBTC', 'BTC', 'MSBT']);
  assert.deepEqual(list[0], { ticker: 'IBIT', name: 'iShares Bitcoin Trust', exchange: 'NASDAQ' });
  assert.deepEqual(parseEtfSnapshot(json('snapshot-ibit.json')), { ticker: 'IBIT', date: '2026-10-23', netInflow: -110_342_400, netAssets: 65_767_748_480, price: 45.96 });
});

test("the days kept: a re-read day replaces its copy, the range counts back from the newest", () => {
  const read = parseEtfSummary(json('summary-btc.json'));
  const old: EtfDay[] = [
    { date: '2026-06-01', netInflow: 1, cumNetInflow: null, totalNetAssets: null, valueTraded: null },
    { date: '2026-09-25', netInflow: 999, cumNetInflow: null, totalNetAssets: null, valueTraded: null },
  ];
  const all = mergeDays(old, read);
  assert.equal(all.length, 21);
  assert.equal(all[0]!.date, '2026-06-01');
  assert.notEqual(all[1]!.netInflow, 999);
  assert.equal(daysIn(all, '1m').length, 20);
  assert.equal(daysIn(all, '3m').length, 20);
  assert.equal(daysIn(all, '1y').length, 21);
  assert.equal(daysIn(all, 'all').length, 21);
  assert.equal(parseEtfAsset('eth'), 'ETH');
  assert.equal(parseEtfAsset('FOO'), 'BTC');
  assert.equal(parseEtfRange('1y'), '1y');
  assert.equal(parseEtfRange('5y'), '1m');
});

test("the funds: largest first, share of the day's total, null until a snapshot is read", () => {
  const list = parseEtfList(json('list-btc.json'));
  const days = parseEtfSummary(json('summary-btc.json'));
  const ibit = parseEtfSnapshot(json('snapshot-ibit.json'))!;
  // The snapshot (23 October) is a day ahead of the summary: no total to share against yet.
  let funds = buildFunds(list, new Map([['IBIT', ibit]]), days);
  assert.deepEqual(funds[0], { ticker: 'IBIT', name: 'iShares Bitcoin Trust', exchange: 'NASDAQ', netInflow: -110_342_400, netAssets: 65_767_748_480, share: null, price: 45.96, date: '2026-10-23' });
  assert.equal(funds[1]!.netAssets, null);
  // On a day the summary has: IBIT's share of the 22nd's 104.7 bn.
  funds = buildFunds(list, new Map([['IBIT', { ...ibit, date: '2026-10-22' }]]), days);
  assert.equal(funds[0]!.share, 0.6281);
  // Every fund at the same day: against their own sum.
  const two = list.slice(0, 2);
  funds = buildFunds(two, new Map([['IBIT', ibit], ['FBTC', { ticker: 'FBTC', date: '2026-10-23', netInflow: 5, netAssets: 34_232_251_520, price: 1 }]]), days);
  assert.deepEqual(funds.map((f) => [f.ticker, f.share]), [['IBIT', 0.6577], ['FBTC', 0.3423]]);
});

test('the route: no key is not_available; the summary read once per 30 minutes and kept on disk', async () => {
  const prev = process.env.SOSOVALUE_API_KEY;
  const dir = mkdtempSync(join(tmpdir(), 'vs-etf-'));
  try {
    delete process.env.SOSOVALUE_API_KEY;
    resetEtf();
    await assert.rejects(etfFlows('BTC', '1m', { dir, fetchImpl: async () => new Response('{}') }), NotAvailable);

    process.env.SOSOVALUE_API_KEY = 'test-key';
    resetNewsCache();
    resetEtf();
    const asked: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const u = new URL(String(url));
      assert.equal(new Headers(init?.headers).get('x-soso-api-key'), 'test-key');
      asked.push(u.pathname + u.search);
      if (u.pathname.endsWith('/etfs/summary-history')) return new Response(JSON.stringify(json('summary-btc.json')));
      if (u.pathname.endsWith('/etfs')) return new Response(JSON.stringify(json('list-btc.json')));
      if (u.pathname.endsWith('/IBIT/market-snapshot')) return new Response(JSON.stringify(json('snapshot-ibit.json')));
      return new Response('', { status: 404 });
    };
    const page = await etfFlows('BTC', '1m', { dir, fetchImpl, snapshots: false });
    assert.equal(page.asset, 'BTC');
    assert.equal(page.days.length, 20);
    assert.equal(page.days.at(-1)!.netInflow, -635_492_639);
    assert.equal(page.funds.length, 12);
    assert.deepEqual(page.assets, ['BTC', 'ETH', 'SOL', 'LTC', 'HBAR', 'XRP', 'DOGE', 'LINK', 'AVAX', 'DOT']);
    assert.ok(page.updatedAt > 0);
    assert.deepEqual(asked, ['/openapi/v1/etfs/summary-history?symbol=BTC&country_code=US&limit=300', '/openapi/v1/etfs?symbol=BTC&country_code=US']);
    await etfFlows('BTC', '3m', { dir, fetchImpl, snapshots: false });
    assert.equal(asked.length, 2, 'cached');
    assert.ok(existsSync(join(dir, 'etf-flows.json')));
    // A restart reads the days back from the file, even with SoSoValue down.
    resetEtf();
    const down: typeof fetch = async () => new Response('', { status: 503 });
    const kept = JSON.parse(readFileSync(join(dir, 'etf-flows.json'), 'utf8'));
    assert.equal(kept.days.BTC.length, 20);
    const fromFile = await etfFlows('BTC', '1m', { dir, fetchImpl: down, snapshots: false });
    assert.equal(fromFile.days.length, 20);
    assert.equal(fromFile.updatedAt, 0, 'not read from SoSoValue in this run');
    // With neither, the failure is the answer.
    resetEtf();
    await assert.rejects(etfFlows('ETH', '1m', { dir, fetchImpl: down, snapshots: false }), /HTTP 503/);

    // The snapshots fill in the background, one at a time.
    resetEtf();
    resetNewsCache();
    asked.length = 0;
    const one: typeof fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith('/etfs?symbol=BTC&country_code=US')) return new Response(JSON.stringify({ code: 0, data: json('list-btc.json').data.slice(0, 1) }));
      return fetchImpl(url, init);
    };
    await etfFlows('BTC', '1m', { dir, fetchImpl: one });
    for (let k = 0; k < 50 && !asked.some((a) => a.includes('market-snapshot')); k++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));
    const filled = await etfFlows('BTC', '1m', { dir, fetchImpl: one, snapshots: false });
    assert.deepEqual(filled.funds.map((f) => [f.ticker, f.netAssets, f.share]), [['IBIT', 65_767_748_480, 1]]);
  } finally {
    resetEtf();
    resetNewsCache();
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SOSOVALUE_API_KEY;
    else process.env.SOSOVALUE_API_KEY = prev;
  }
});
