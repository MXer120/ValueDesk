import test from 'node:test';
import assert from 'node:assert/strict';
import { logoCandidates, resolveKey } from './logoKey';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHAIN_LOGOS, COIN_LOGOS } from './logoManifest';
import { SITE_COIN_LOGOS } from './logoManifestSites';
import { VENUE_COIN_LOGOS } from './logoManifestVenues';
import { coinLogo } from './logos';

test('every SoDEX spelling of a coin finds the icon sodex.com shows for it', () => {
  const same: Array<[string, string]> = [
    ['vBTC', 'BTC'], // ValueChain token
    ['BTC-USD', 'BTC'], // perps market
    ['vBTC_vUSDC', 'BTC'], // spot market (API)
    ['BTC/USDC', 'BTC'], // spot market (display)
    ['vUSDC', 'USDC'],
    ['vXAUt', 'XAUT'],
    ['vCRCLx', 'CRCLX'],
    ['aCXMT', 'CXMT'],
    ['vsMAG7.ssi', 'SMAG7.SSI'], // sodex.com keys the ValueChain SSI token by its s-name
    ['MAG7.ssi', 'MAG7.SSI'],
    ['vDEFI.ssi', 'DEFI.SSI'],
    ['sSOSO', 'SSOSO'], // staked SOSO has its own icon, not SOSO's
    ['WSOSO', 'WSOSO'],
    ['1000PEPE-USD', '1000PEPE'],
    ['STRC-USD', 'STRC'],
  ];
  for (const [name, key] of same) {
    assert.ok(COIN_LOGOS[key], `manifest has ${key}`);
    assert.equal(resolveKey(name, COIN_LOGOS), COIN_LOGOS[key], name);
  }
});

test('candidates run most specific first, the loose fallbacks last', () => {
  assert.deepEqual(logoCandidates('vsMAG7.ssi').slice(0, 3), ['VSMAG7.SSI', 'SMAG7.SSI', 'MAG7.SSI']);
  assert.deepEqual(logoCandidates('vBTC_vUSDC'), ['VBTC_VUSDC', 'BTC_VUSDC', 'VBTC', 'BTC']);
  assert.deepEqual(logoCandidates('BTC-USD'), ['BTC-USD', 'BTC']);
  assert.ok(logoCandidates('BTCUSDT').includes('BTC'), 'a pair written without a separator');
  assert.ok(logoCandidates('1000FOO').includes('FOO'), 'a 1000x unit falls back to the coin');
  assert.equal(resolveKey('kPEPE', COIN_LOGOS), COIN_LOGOS.PEPE, "Hyperliquid's 1000x unit");
  assert.deepEqual(logoCandidates(''), []);
  assert.deepEqual(logoCandidates(null), []);
  // A real coin that starts with an upper-case V is not a ValueChain prefix.
  assert.equal(logoCandidates('VET')[0], 'VET');
  assert.ok(!logoCandidates('VET').includes('ET'));
});

test('unknown names resolve to nothing (the component then draws a letter avatar)', () => {
  assert.equal(resolveKey('NOT-A-COIN-XYZ', COIN_LOGOS), undefined);
  assert.equal(resolveKey('SoDEX', COIN_LOGOS), undefined);
});

test('the manifest points only at files under public/logos, and every chain SoDEX routes through has one', () => {
  for (const [k, rel] of [...Object.entries(COIN_LOGOS), ...Object.entries(CHAIN_LOGOS)]) {
    assert.match(rel, /^(coins|tokens|chains)\/[A-Za-z0-9._-]+\.(png|svg|jpg|webp)$/, k);
  }
  for (const chain of ['VALUECHAIN', 'ETH', 'BASE_ETH', 'ARBITRUM_ETH', 'BSC_BNB', 'MATIC', 'AVAXC', 'SOL', 'BTC', 'HYPEREVM_HYPE', 'TON', 'SUI', 'XRP', 'DOGE', 'ADA', 'LTC', 'XLM', 'ZEC', 'ARC', 'ROBINHOOD_ETH']) {
    assert.ok(CHAIN_LOGOS[chain], chain);
  }
});

test('upper-cased Hyperliquid k-coins fall back to the base coin, other K tickers do not', () => {
  assert.ok(logoCandidates('KPEPE').includes('PEPE'));
  assert.ok(logoCandidates('KBONK').includes('BONK'));
  assert.ok(!logoCandidates('KAVA').includes('AVA'));
});

const LOGOS = fileURLToPath(new URL('../public/logos/', import.meta.url));
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}${e.name}/`) : [`${dir}${e.name}`]));

test('licence review 2026-10-28: no TradingView symbol logo ships, and every manifest path is on disk', () => {
  // TradingView's symbol logos are 18 x 18 px SVGs; its terms bar commercial use without an agreement.
  const tv = files(LOGOS).filter((f) => f.endsWith('.svg') && /<svg[^>]*\swidth="18"/.test(readFileSync(f, 'utf8').slice(0, 300)));
  assert.deepEqual(tv, []);
  for (const [k, rel] of [...Object.entries(COIN_LOGOS), ...Object.entries(SITE_COIN_LOGOS), ...Object.entries(VENUE_COIN_LOGOS)]) {
    assert.ok(existsSync(`${LOGOS}${rel}`), `${k} -> ${rel}`);
  }
  for (const rel of Object.values(SITE_COIN_LOGOS)) assert.match(rel, /^sites\/[a-z0-9._-]+\.(png|svg|jpg|webp|ico)$/);
});

test("a listing SoDEX has no icon for takes its owner's own (the site set), else a letter avatar", () => {
  assert.equal(coinLogo('aUNITREE'), '/logos/sites/unitree.com.svg');
  assert.equal(coinLogo('VOO-USD'), coinLogo('VT'), 'one issuer, one mark');
  assert.equal(coinLogo('CASHCAT'), null, 'the CoinGecko image is gone: letter avatar');
});
