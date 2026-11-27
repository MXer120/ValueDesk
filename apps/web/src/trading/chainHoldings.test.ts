/**
 * The On-chain tab's reader: which chain an address is, amounts in base units, LI.FI's answer, the prices, the NFTs.
 * Run (from apps/web): npx tsx --test src/trading/chainHoldings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAddress, nftPicture, parseLifi, parseNfts, priceBase, units, NFT_CHAINS, chainOf } from './chainHoldings';

const fam = (a: string) => detectAddress(a).map((d) => d.family);

test('each address shape is its chain; 0x + 64 hex is Sui or Aptos', () => {
  assert.deepEqual(fam('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'), ['evm']);
  assert.deepEqual(fam('0x0000000000000000000000000000000000000000000000000000000000000005'), ['sui', 'apt']);
  assert.deepEqual(fam('bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97'), ['btc']);
  assert.deepEqual(fam('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), ['btc']);
  assert.deepEqual(fam('LTdsVS8VDw6syvfQADdhf2PHAm3rMGJvPX'), ['ltc']);
  assert.deepEqual(fam('DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'), ['doge']);
  assert.deepEqual(fam('TT1DyeqXaaJkt6UhVYFWUXBXknaXnBudTK'), ['trx']);
  assert.deepEqual(fam('rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh'), ['xrp']);
  assert.deepEqual(fam('GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM'), ['xlm']);
  assert.deepEqual(fam('EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N'), ['ton']);
  assert.deepEqual(fam('relay.aurora'.replace('aurora', 'near')), ['near']);
  assert.deepEqual(fam('osmo1clpqr4nrk4khgkxj78fcwwh6dl3uw4epasmvnj'), ['cosmos']);
  assert.deepEqual(fam('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'), ['sol']);
  assert.deepEqual(fam('not an address'), []);
  assert.equal(chainOf({ family: 'cosmos', address: 'osmo1clpqr4nrk4khgkxj78fcwwh6dl3uw4epasmvnj' }).label, 'Osmosis');
});

test('base units: exact past 2^53, any decimals', () => {
  assert.equal(units('5799554154377317710', 18), 5.79955415437731771);
  assert.equal(units('1000000', 6), 1);
  assert.equal(units('5', 6), 0.000005);
  assert.equal(units(9300003431681669, 9), 9300003.431681669);
  assert.equal(units(null, 6), 0);
});

test("LI.FI: every chain, its own price, the verified flag, Celo's double native coin once", () => {
  const rows = parseLifi('0xabc', {
    balances: {
      '8453': [
        { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'ETH', decimals: 18, amount: '2000000000000000000', priceUSD: '1664.5', verificationStatus: 'verified' },
        { address: '0xdead', symbol: 'SCAM', name: 'Claim reward', decimals: 18, amount: '1000000000000000000000', priceUSD: '3', verificationStatus: 'unverified' },
        { address: '0xbeef', symbol: 'ZERO', decimals: 6, amount: '0', priceUSD: '1', verificationStatus: 'verified' },
      ],
      '42220': [
        { address: '0x471ece3750da237f93b8e339c536989b8978a438', symbol: 'CELO', decimals: 18, amount: '1000000000000000000', priceUSD: '0.3', verificationStatus: 'verified' },
        { address: '0x471ece3750da237f93b8e339c536989b8978a438', symbol: 'CELO', decimals: 18, amount: '1000000000000000000', priceUSD: '0.3', verificationStatus: 'verified' },
      ],
      '777': [{ address: '0x1', symbol: 'X', decimals: 0, amount: '3', priceUSD: null, verificationStatus: 'verified' }],
    },
  });
  assert.equal(rows.length, 4);
  const eth = rows.find((r) => r.symbol === 'ETH')!;
  assert.equal(eth.chainLabel, 'Base');
  assert.equal(eth.token, '');
  assert.equal(eth.usd, 3329);
  assert.equal(eth.priceSource, 'LI.FI');
  assert.equal(rows.find((r) => r.symbol === 'SCAM')!.verified, false);
  assert.equal(rows.filter((r) => r.symbol === 'CELO').length, 1);
  const x = rows.find((r) => r.symbol === 'X')!;
  assert.equal(x.chainLabel, 'Chain 777');
  assert.equal(x.usd, null);
});

test("other chains' coins: SoDEX's price first, then Hyperliquid's, unverified never priced", () => {
  const base = { chain: 'SOL', chainLabel: 'Solana', chainIcon: 'SOL', owner: 'x', name: '', token: '' };
  const rows = priceBase(
    [{ ...base, symbol: 'SOL', amount: 2, verified: true }, { ...base, symbol: 'ATOM', amount: 10, verified: true }, { ...base, symbol: 'FAKE', amount: 5, verified: false }, { ...base, symbol: 'NOPE', amount: 1, verified: true }],
    new Map([['SOL', 150], ['FAKE', 9]]),
    new Map([['ATOM', 4], ['SOL', 151]]),
  );
  assert.deepEqual(rows.map((r) => [r.symbol, r.usd, r.priceSource]), [['SOL', 300, 'SoDEX'], ['ATOM', 40, 'Hyperliquid'], ['FAKE', null, null], ['NOPE', null, null]]);
});

const Q1 = 'QmP62BaaW6qitRgGyzBBakn96MM3KQQL5LHXwy9e3mvm55';
const Q2 = 'QmNxet7XDuRu63VXgMpzHnqutCmtXs7KesKHxN6E6BULvP';
const B1 = 'bafybeibtpk77xshht5dpxmcibeydt425zvuf3nvefyksszmuydeqqfk56e';

test('NFTs: named, scams out, ERC-1155 counted, linked to the explorer', () => {
  const vc = NFT_CHAINS[0]!;
  const out = parseNfts(vc, {
    items: [
      { id: '36', image_url: `https://ipfs.filebase.io/ipfs/${Q1}`, metadata: { name: 'Hypno Plush #36' }, token_type: 'ERC-721', value: '1', token: { address_hash: '0x01c2', name: 'Hypno Plush', type: 'ERC-721' } },
      { id: '7', image_url: `ipfs://${Q2}`, token_type: 'ERC-1155', value: '3', token: { address_hash: '0x02', name: null, symbol: 'PASS', type: 'ERC-1155' } },
      { id: '1', image_url: `ipfs://${Q2}`, token: { address_hash: '0x03', name: 'Free claim', reputation: 'scam' } },
      { id: '2', image_url: 'https://cdn.example/a.png', token: { address_hash: '0x0400000000000000000000000000000000000000', name: '' } },
    ],
  });
  assert.equal(out.length, 3);
  assert.equal(out[0]!.name, 'Hypno Plush #36');
  assert.equal(out[0]!.image, `https://ipfs.filebase.io/ipfs/${Q1}`);
  assert.equal(out[0]!.link, 'https://main-scan.valuechain.xyz/token/0x01c2/instance/36');
  assert.equal(out[1]!.count, 3);
  assert.equal(out[1]!.collection, 'PASS');
  assert.equal(out[2]!.image, null);
  assert.equal(out[2]!.collection, '0x0400…0000');
});

test('NFT pictures: only Blockscout thumbnails and IPFS through the one gateway (index.html img-src)', () => {
  const thumb = 'https://nft-prod.blockscout.com/optimism-mainnet/65508e0a_250x250.gif';
  assert.equal(nftPicture({ thumbnails: { '250x250': thumb }, image_url: 'https://dweb.link/ipfs/x' }), thumb);
  assert.equal(nftPicture({ image_url: `ipfs://${Q2}/7.png` }), `https://ipfs.filebase.io/ipfs/${Q2}/7.png`);
  assert.equal(nftPicture({ image_url: `ipfs://ipfs/${Q2}` }), `https://ipfs.filebase.io/ipfs/${Q2}`);
  assert.equal(nftPicture({ image_url: `https://gateway.pinatas.cloud/ipfs/${Q2}?filename=a.png` }), `https://ipfs.filebase.io/ipfs/${Q2}`);
  assert.equal(nftPicture({ image_url: `https://${B1}.ipfs.dweb.link/1.png` }), `https://ipfs.filebase.io/ipfs/${B1}/1.png`);
  assert.equal(nftPicture({ image_url: 'https://lh3.googleusercontent.com/abc' }), null);
  assert.equal(nftPicture({ image_url: null, media_type: 'video/mp4', media_url: `ipfs://${Q2}`, metadata: { image: `ipfs://${Q1}` } }), `https://ipfs.filebase.io/ipfs/${Q1}`);
});

test('the CSP lets every source and picture host through, and nothing more for pictures', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
  const connect = /connect-src([^;]+);/.exec(csp)?.[1] ?? '';
  const src = readFileSync(new URL('./chainHoldings.ts', import.meta.url), 'utf8');
  const hosts = new Set([...src.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/'`$?])/g)].map((m) => m[1]!));
  for (const h of ['nft-prod.blockscout.com', 'ipfs.filebase.io']) hosts.delete(h);
  const missing = [...hosts].filter((h) => !connect.includes(`https://${h}`));
  assert.deepEqual(missing, [], 'a host chainHoldings.ts reads is not in index.html connect-src');
  const img = /img-src([^;]+);/.exec(csp)?.[1] ?? '';
  assert.ok(img.includes('https://nft-prod.blockscout.com') && img.includes('https://ipfs.filebase.io'));
  assert.ok(!/\shttps:(\s|$)/.test(img), 'img-src stays a list of hosts');
});
