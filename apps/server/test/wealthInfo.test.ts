/**
 * The fund info relay (routes/wealthInfo.ts): SoDEX's CMS text in the asked language with English behind it, keystone's
 * live holdings top by weight or SoDEX's own fallback, a vault's facts, USDC Earn's rules, ANT Believers Index from the
 * locale file, FAQ HTML turned into text and https links, and each source read once per its time. No network: the
 * payloads are trimmed copies of SoDEX's and keystone's real answers (2026-11-28).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { htmlToText, pick, wealthInfoRoutes } from '../src/routes/wealthInfo.js';

const CMS = {
  code: 0,
  data: {
    schemaVersion: 2,
    version: 3,
    homepageCategories: { curatedEtf: ['vqqq'], specialty: ['unitree'] },
    products: [
      {
        fundId: 'vQQQ', productKey: 'vqqq', visibility: 'listed', category: 'curatedEtf', sort: 5, fundType: 'clob', tradingMarket: 'US',
        dataSources: { keystone: { instrumentId: 4286, symbol: 'QQQ', fullSymbol: 'QQQ.US', name: 'Invesco QQQ Trust', currency: 'USD' } },
        detail: {
          displayName: { en: 'US Tech 100', de: 'US Tech 100' },
          highlight: { mode: 'text', title: { en: 'Capture the US tech sector.', de: '' }, subtitle: { en: 'Nasdaq Top100' }, phrases: [{ en: 'No forced liquidation' }] },
          keyFeatures: [{ en: 'Built on Invesco QQQ.', de: 'Auf Invesco QQQ aufgebaut.' }],
          about: { title: { en: 'US Tech 100' }, body: { en: 'One token.\n\nBacked 1:1.' } },
          topHoldingsFallback: [{ name: { en: 'NVIDIA Corp' }, ticker: 'NVDA', weightRatio: '0.0651' }],
          faq: [],
        },
      },
      {
        fundId: 'UNITREE', productKey: 'unitree', visibility: 'delisted', fundType: 'escrow_vault', tradingMarket: 'CN',
        detail: {
          displayName: { en: 'Unitree Vault' },
          topHoldingsFallback: [{ name: { en: 'UNITREE' }, ticker: 'UNITREE', weightRatio: '1' }],
          faq: [{ question: { en: 'Who is the issuer?' }, answerFormat: 'html', answer: { en: '<p>Issued by <a href="https://x.com/asiahardtech" target="_blank">AsiaHardTech</a> &amp; Tigris.</p><p>See <a href="javascript:alert(1)">this</a>.</p><script>x()</script>' } }],
          governance: { curatorDisplayName: { en: 'AsiaHardTech' } },
          socialMedia: [{ type: 'telegram', url: 'https://t.me/x' }, { type: 'x', url: 'http://insecure.example' }],
        },
      },
      {
        fundId: 'Morpho-Earn', fundType: 'bridged_vault',
        detail: {
          displayName: { en: 'USDC Earn' },
          stableEarn: {
            vaultDisplayName: { en: 'SoSoValue x Unified Labs USDC' },
            highlight: { title: { en: 'Earn variable yield on USDC' }, description: { en: 'Curated lending.' }, items: [{ text: { en: 'Variable USDC yield' } }] },
            keyFeatures: [{ en: 'Allocates USDC across lending markets.' }],
            tradingRules: { minimumSubscription: '5', minimumRedemption: '4', subscription: { submitDescription: { en: 'Submit any time' } }, redemption: {} },
            about: { overview: { en: 'Earn variable yield.' }, riskDisclaimer: { en: 'Value may fall.' } },
          },
        },
      },
    ],
  },
};
const HOLDINGS = {
  code: 0,
  data: {
    count: 3,
    holdings: [
      { held_name: 'MICROSOFT CORP', held_symbol: 'MSFT', weight: '0.0648', as_of: '2026-11-24' },
      { held_name: 'APPLE INC', held_symbol: 'AAPL', weight: '0.0909', as_of: '2026-11-24' },
      { held_name: 'NVIDIA CORP', held_symbol: 'NVDA', weight: '0.0659', as_of: '2026-11-24' },
    ],
    portfolio: { as_of: '2026-11-24', total_count: 102 },
  },
};
const QUOTE = { code: 0, data: { quote: { roi_inception_since: '1999-03-10', market_cap: '452600797500', high_52w: '762.86', low_52w: '554.41', currency: 'USD', class: 'etf' } } };
const VAULT = { code: 0, data: { issuerName: 'AsiaHardTech', inceptionDate: '2026-08-07', chainConfig: { minDeposit: '100', minRedeemShares: '0.001', mgmtFeeRate: '36500000000000000', perfFeeRate: '0' } } };
const LOCALE = { ant_index_about_tracking: 'Tracks companies that benefit from Anthropic’s growth.', antb_faq_token_question: 'What is ANTB.ssi?', antb_faq_token_answer: 'The index token.' };

const NOW = Date.UTC(2026, 10, 28, 12);

function app(seen: string[] = [], over: Record<string, unknown> = {}) {
  const a = Fastify();
  void a.register(wealthInfoRoutes({
    now: () => NOW,
    fetch: async (url) => {
      seen.push(url);
      const body = url in over ? over[url]
        : url.includes('/biz/config/wealth') ? CMS
        : url.endsWith('/4286/holdings') ? HOLDINGS
        : url.endsWith('/4286/quote') ? QUOTE
        : url.includes('/funds/UNITREE') ? VAULT
        : url.includes('/locales/') ? LOCALE
        : null;
      return { status: body ? 200 : 404, json: async () => body };
    },
  }));
  return a;
}

test('a CMS text in the asked language, English when it is missing or empty', () => {
  assert.equal(pick({ en: 'A', de: 'B' }, 'de'), 'B');
  assert.equal(pick({ en: 'A', de: '  ' }, 'de'), 'A');
  assert.equal(pick({ en: 'A' }, 'ja'), 'A');
  assert.equal(pick('plain', 'de'), 'plain');
  assert.equal(pick(null, 'de'), null);
});

test('HTML answers become text and https links only', () => {
  const t = htmlToText('<p>Issued by <a href="https://x.com/a">A</a> &amp; B.</p><p>See <a href="javascript:alert(1)">this</a>.</p><script>x()</script>');
  assert.deepEqual(t.paragraphs, ['Issued by A & B.', 'See this.'], 'a script\'s text goes with it');
  assert.deepEqual(t.links, [{ label: 'A', href: 'https://x.com/a' }]);
});

test('an ETF fund: SoDEX\'s text, the underlying, live holdings by weight, the underlying\'s launch', async () => {
  const r = await app().inject({ method: 'GET', url: '/api/vs/wealth/info?fund=vQQQ&lang=de-DE' });
  assert.equal(r.statusCode, 200);
  const { info } = r.json();
  assert.equal(info.lang, 'de');
  assert.equal(info.name, 'US Tech 100');
  assert.equal(info.headline.title, 'Capture the US tech sector.', 'an empty German title reads English');
  assert.deepEqual(info.features, ['Auf Invesco QQQ aufgebaut.']);
  assert.deepEqual(info.about.body, ['One token.', 'Backed 1:1.']);
  assert.equal(info.underlying.fullSymbol, 'QQQ.US');
  assert.equal(info.holdings.source, 'live');
  assert.deepEqual(info.holdings.rows.map((x: { ticker: string }) => x.ticker), ['AAPL', 'NVDA', 'MSFT']);
  assert.equal(info.holdings.total, 102);
  assert.equal(info.holdings.stale, false);
  assert.equal(info.underlyingQuote.since, '1999-03-10');
  assert.equal(info.underlyingQuote.marketCap, 452600797500);
  assert.equal(r.headers['cache-control'], 'public, max-age=300');
});

test('a vault: issuer, launch, fees as fractions a year, minimums, the FAQ cleaned, http links dropped', async () => {
  const { info } = (await app().inject({ method: 'GET', url: '/api/vs/wealth/info?fund=UNITREE' })).json();
  assert.deepEqual(info.vault, { issuer: 'AsiaHardTech', launched: '2026-08-07', managementFee: 0.0365, performanceFee: 0, minDeposit: '100', minRedeemShares: '0.001' });
  assert.equal(info.holdings.source, 'sodex');
  assert.equal(info.faq[0].a[0], 'Issued by AsiaHardTech & Tigris.');
  assert.deepEqual(info.faq[0].links, [{ label: 'AsiaHardTech', href: 'https://x.com/asiahardtech' }]);
  assert.deepEqual(info.social, [{ type: 'telegram', url: 'https://t.me/x', name: null }]);
  assert.equal(info.curator, 'AsiaHardTech');
});

test('USDC Earn: its rules and texts; ANT Believers Index from the locale file', async () => {
  const a = app();
  const earn = (await a.inject({ method: 'GET', url: '/api/vs/wealth/info?fund=Morpho-Earn' })).json().info;
  assert.equal(earn.earn.minIn, '5');
  assert.equal(earn.earn.minOut, '4');
  assert.equal(earn.headline.title, 'Earn variable yield on USDC');
  assert.deepEqual(earn.about.body, ['Earn variable yield.']);
  const ant = (await a.inject({ method: 'GET', url: '/api/vs/wealth/info?fund=antb' })).json().info;
  assert.equal(ant.name, 'ANT Believers Index');
  assert.deepEqual(ant.faq, [{ q: 'What is ANTB.ssi?', a: ['The index token.'], links: [] }]);
});

test('each source once per its time; unknown funds 404, bad input 400, SoDEX down 502', async () => {
  const seen: string[] = [];
  const a = app(seen);
  await a.inject({ method: 'GET', url: '/api/vs/wealth/info?fund=vQQQ&lang=en' });
  await a.inject({ method: 'GET', url: '/api/vs/wealth/info?fund=vQQQ&lang=en' });
  await a.inject({ method: 'GET', url: '/api/vs/wealth/info?fund=vQQQ&lang=ja' });
  assert.equal(seen.filter((u) => u.includes('/biz/config/wealth')).length, 1, 'the CMS once');
  assert.equal(seen.filter((u) => u.endsWith('/holdings')).length, 1, 'the holdings once');
  assert.equal((await a.inject({ method: 'GET', url: '/api/vs/wealth/info?fund=nope' })).statusCode, 404);
  assert.equal((await a.inject({ method: 'GET', url: '/api/vs/wealth/info?fund=../x' })).statusCode, 400);
  const down = app([], { 'https://alpha-biz.sodex.dev/biz/config/wealth': null });
  assert.equal((await down.inject({ method: 'GET', url: '/api/vs/wealth/info?fund=vQQQ' })).statusCode, 502);
});

test('USDC Earn history: the vault share price by day from Morpho, read once an hour; other funds 404', async () => {
  const seen: string[] = [];
  const morpho = { data: { vaultV2ByAddress: { historicalState: { sharePrice: [{ x: 1795737600, y: 1.0102 }, { x: 1795651200, y: 1.0101 }], apyDay: [{ x: 1700000000, y: 0.05 }, { x: 1795651200, y: 0.06 }], apyHour: [{ x: 1795737600, y: 0.0427 }] } } } };
  const a = Fastify();
  void a.register(wealthInfoRoutes({ now: () => NOW, fetch: async (url) => { seen.push(url); return { status: 200, json: async () => (url.includes('graphql') ? morpho : null) }; } }));
  const r = await a.inject({ method: 'GET', url: '/api/vs/wealth/history?fund=Morpho-Earn' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().points, [[1795651200000, 1.0101], [1795737600000, 1.0102]], 'oldest first, ms');
  assert.deepEqual(r.json().apy.map(([t, v]: [number, number]) => [t, Math.round(v * 100) / 100]), [[1700000000000, 5], [1795651200000, 6], [1795737600000, 4.27]], 'daily before the hourly part, in percent');
  await a.inject({ method: 'GET', url: '/api/vs/wealth/history?fund=Morpho-Earn' });
  assert.equal(seen.length, 1);
  assert.equal((await a.inject({ method: 'GET', url: '/api/vs/wealth/history?fund=vQQQ' })).statusCode, 404);
});

test('the listing: listed only when SoDEX says listed and puts it on a shelf', async () => {
  const r = await app().inject({ method: 'GET', url: '/api/vs/wealth/listing' });
  const f = r.json().funds;
  assert.equal(f.vQQQ.listed, true);
  assert.equal(f.UNITREE.listed, false, 'delisted');
  assert.equal(f['Morpho-Earn'].listed, false, 'on no shelf');
});
