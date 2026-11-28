/**
 * ValueChain NFT floors (valuedesk/nftFloors.ts): a listing's price, tiers from metadata, floors per collection and tier.
 * Run (from apps/server): npx tsx --test test/nftFloors.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { buildFloors, listingOf, offerOf, priceTokens, tierOf } from '../src/valuedesk/nftFloors.js';
import { nftFloorsRoutes } from '../src/routes/nftFloors.js';

const BOX = '0x371c4F7F68bE3e558b89cC1f0fB113851C76E750';
const order = (token: string, id: string, parts: string[], o: { end?: string; start?: string; units?: string; itemType?: number } = {}) => ({
  params: {
    offer: [{ token, itemType: o.itemType ?? 2, identifierOrCriteria: id, startAmount: o.units ?? '1' }],
    consideration: parts.map((a) => ({ token: '0x0000000000000000000000000000000000000000', itemType: 0, startAmount: a })),
    startTime: o.start ?? '0', endTime: o.end ?? '1803637294',
  },
});

test('a listing costs its buyer everything they pay (seller and fee), per unit; closed or odd orders are none', () => {
  const now = 1_764_300_000;
  assert.deepEqual(listingOf(order(BOX, '197906', ['7020000000000000000', '180000000000000000']), now), { collection: BOX.toLowerCase(), tokenId: '197906', price: 7.2 });
  assert.equal(listingOf(order(BOX, '1', ['1000000000000000000'], { end: String(now - 1) }), now), null);
  assert.equal(listingOf(order(BOX, '1', ['1000000000000000000'], { start: String(now + 60) }), now), null);
  assert.equal(listingOf(order(BOX, '1', ['6000000000000000000'], { itemType: 3, units: '3' }), now)?.price, 2);
  assert.equal(listingOf(order(BOX, '1', [], {}), now), null);
  assert.equal(listingOf({ params: { offer: [{ token: BOX, itemType: 1 }] } }, now), null, 'an ERC-20 offer is not an NFT listing');
});

test('the tier is the first of Tier, Rarity, Level, Grade', () => {
  assert.deepEqual(tierOf([{ trait_type: 'Design', value: 'X' }, { trait_type: 'Tier', value: 'Epic' }]), { trait: 'Tier', value: 'Epic' });
  assert.deepEqual(tierOf([{ trait_type: 'level', value: 'Rare' }]), { trait: 'level', value: 'Rare' });
  assert.equal(tierOf([{ trait_type: 'Status', value: 'Alive' }]), null);
  assert.equal(tierOf(null), null);
});

test('floors: the collection as valuemint.store says, each tier the lowest open listing of it', () => {
  const d = buildFloors(
    { collections: [{ address: BOX, name: 'SoDEXTreasureBox', symbol: 'SOBOX', floorWei: '7200000000000000000', listed: 4 }, { address: '0xaa', name: 'Plain', floorWei: '700000000000000000', listed: 1 }] },
    [
      { collection: BOX.toLowerCase(), tokenId: '1', price: 7.2 },
      { collection: BOX.toLowerCase(), tokenId: '2', price: 9 },
      { collection: BOX.toLowerCase(), tokenId: '3', price: 30 },
      { collection: BOX.toLowerCase(), tokenId: '4', price: 25 },
      { collection: '0xaa', tokenId: '9', price: 0.7 },
    ],
    (_c, id) => (id === '3' || id === '4' ? { trait: 'Level', value: 'Rare' } : id === '9' ? null : { trait: 'Level', value: 'Common' }),
    1,
  );
  const box = d.collections[BOX.toLowerCase()]!;
  assert.equal(box.floor, 7.2);
  assert.equal(box.trait, 'Level');
  assert.deepEqual(box.tiers, { Common: { floor: 7.2, listed: 2 }, Rare: { floor: 25, listed: 2 } });
  assert.deepEqual(d.collections['0xaa']!.tiers, {});
  assert.equal(d.collections['0xaa']!.trait, null);
});

test('the route answers the document, or 503 without one', async () => {
  const doc = buildFloors({ collections: [] }, [], () => null, 5);
  const app = Fastify();
  await app.register(nftFloorsRoutes({ read: async () => doc }));
  const r = await app.inject({ method: 'GET', url: '/api/vs/nft/floors' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().source, 'valuemint.store');
  assert.match(String(r.headers['cache-control']), /max-age=300/);
  const none = Fastify();
  await none.register(nftFloorsRoutes({ read: async () => null }));
  assert.equal((await none.inject({ method: 'GET', url: '/api/vs/nft/floors' })).statusCode, 503);
});

test('offers: wrapped SOSO for any NFT of a collection or for one; per NFT its ask and its own best offer', () => {
  const now = 1_764_300_000;
  const off = (kind: 2 | 4, id: string, amount: string) => ({ params: { offer: [{ token: '0x5050505050505050505050505050505050505050', itemType: 1, startAmount: amount }], consideration: [{ token: BOX, itemType: kind, identifierOrCriteria: id, startAmount: '1' }], startTime: '0', endTime: '1803637294' } });
  assert.deepEqual(offerOf(off(4, '0', '6000000000000000000'), now), { collection: BOX.toLowerCase(), tokenId: null, price: 6 });
  assert.deepEqual(offerOf(off(2, '42', '9500000000000000000'), now), { collection: BOX.toLowerCase(), tokenId: '42', price: 9.5 });
  assert.equal(offerOf(off(4, '0xabc', '1'), now), null, 'a criteria list is not read');
  const five = off(4, '0', '225000000000000000000');
  five.params.consideration[0]!.startAmount = '5';
  assert.equal(offerOf(five, now)?.price, 45, 'an offer for five NFTs is priced per NFT');
  const doc = buildFloors({ collections: [{ address: BOX, name: 'Box', floorWei: '7200000000000000000' }] }, [], () => null, 1);
  const t = priceTokens(doc, [{ collection: BOX.toLowerCase(), tokenId: '42', price: 12 }, { collection: BOX.toLowerCase(), tokenId: '42', price: 11 }], [
    { collection: BOX.toLowerCase(), tokenId: null, price: 6 }, { collection: BOX.toLowerCase(), tokenId: null, price: 6.5 }, { collection: BOX.toLowerCase(), tokenId: '42', price: 9.5 },
  ]);
  assert.deepEqual(t[BOX.toLowerCase()]!['42'], [11, 9.5]);
  assert.equal(doc.collections[BOX.toLowerCase()]!.bestOffer, 6.5);
  assert.equal(doc.collections[BOX.toLowerCase()]!.offers, 3);
});
