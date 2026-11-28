/**
 * Published ValueDesk indexes (indexes/, routes/vdIndexes.ts): only the owner's signature publishes, changes or takes
 * down an index; an old signature never brings back an old version; a nonce is used once; nothing is deleted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import Fastify from 'fastify';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';

import { checkIndexAction, indexActionDigest } from '../src/indexes/check.js';
import {
  INDEX_ID, INDEX_IMAGE_MAX_BYTES, INDEX_IMAGE_SIDE, INDEX_PER_WALLET_MAX, INDEX_PUBLISH_STATEMENT, INDEX_TYPE, INDEX_UNPUBLISH_STATEMENT,
  indexTypedData, type IndexAction,
} from '../src/indexes/claim.js';
import { IndexStore, indexesDbPath, randomIndexId } from '../src/indexes/store.js';
import { INDEX_LIMITS, INDEX_PUBLISH_BODY_LIMIT, vdIndexRoutes } from '../src/routes/vdIndexes.js';
import { bytesToHex, concat, hexToBytes, privateKeyToAddress, utf8, word } from '../src/signing/eip712.js';
import { KeyedLimiter } from '../src/rateLimit.js';
import { tempDir } from './builderFakes.js';

const NOW = 1_800_000_000_000;
const LEGS = 'vQQQ:4000,vSMH:3000,vVGT:3000';

function newWallet() {
  const key = randomBytes(32);
  return { key, address: privateKeyToAddress(key).toLowerCase() };
}
type W = ReturnType<typeof newWallet>;

/** r || s || v with v 27/28, as a browser wallet answers eth_signTypedData_v4. */
const rsv = (digest: Uint8Array, key: Uint8Array): string => {
  const sig = secp256k1.sign(digest, key, { lowS: true, prehash: false });
  const out = new Uint8Array(65);
  out.set(sig.toBytes('compact'), 0);
  out[64] = 27 + sig.recovery;
  return bytesToHex(out);
};

type Kind = 'publish' | 'unpublish';
function action(w: W, kind: Kind, o: Partial<IndexAction> = {}, signer: W = w): IndexAction {
  const base = {
    owner: w.address, id: '', name: 'Chips & AI', description: 'Semis and software, weighted by hand.', legs: LEGS, image: '',
    statement: kind === 'publish' ? INDEX_PUBLISH_STATEMENT : INDEX_UNPUBLISH_STATEMENT,
    nonce: randomBytes(16).toString('hex'), issuedAt: String(NOW), expiresAt: String(NOW + 5 * 60_000), chainId: 1, ...o,
  };
  return { ...base, signature: rsv(indexActionDigest(base), signer.key) };
}
/** Signed at NOW + ms (so later than an earlier action). */
const at = (ms: number): Partial<IndexAction> => ({ issuedAt: String(NOW + ms), expiresAt: String(NOW + ms + 5 * 60_000) });

function checked(a: IndexAction, now = NOW) {
  const c = checkIndexAction(a, now);
  if (!c.ok) throw new Error(c.error);
  return c;
}

// --- the signature -------------------------------------------------------------------------------------------------

/**
 * Made once with viem 2.56.0 (hashTypedData and privateKeyToAccount(KEY).signTypedData over indexTypedData(VECTOR),
 * uint64s as bigints), which encodes as eth_signTypedData_v4 does. KEY is the well-known first Hardhat/Anvil test key.
 */
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const VECTOR = {
  owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  id: '',
  name: 'Chips & AI (2026)',
  description: 'Halbleiter und Software – gleich gewichtet.\n\nNo leverage.',
  legs: LEGS,
  // SHA-256 of no bytes: any 64 lowercase hex characters sign the same way.
  image: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  statement: INDEX_PUBLISH_STATEMENT,
  nonce: '0123456789abcdef0123456789abcdef',
  issuedAt: '1800000000000',
  expiresAt: '1800000300000',
  chainId: 286623,
};
const VIEM_DIGEST = '0xcb7a12c89cfd9f77cc1d1b4c85744011ae3a476f2bcca3f2e3a0fc43fb4b0b95';
const VIEM_SIGNATURE = '0xed50e8eade2ef1ccbf603855a0fd6883ff14071936654ca227b901996ed84853492404dbb8e678ac9d8ff3509e178a6535d3d1a3e316914d08d6ecf37532a06a1c';
const VIEM_UNPUBLISH_DIGEST = '0xf9e79198358ac91cdcb61acbfd1ee372baf4278c64f8099e79199b2eabdb62c2';

/** EIP-712 straight from a typed-data object (flat structs of string, address and uint fields: all these use). */
function typedDataDigest(td: ReturnType<typeof indexTypedData>): Uint8Array {
  const types = td.types as unknown as Record<string, Array<{ name: string; type: string }>>;
  const hashStruct = (name: string, value: Record<string, unknown>): Uint8Array => {
    const fields = types[name]!;
    const typeHash = keccak_256(utf8(`${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`));
    const enc = fields.map((f) => {
      const v = value[f.name];
      if (f.type === 'string') return keccak_256(utf8(String(v)));
      if (f.type === 'address') { const out = new Uint8Array(32); out.set(hexToBytes(String(v)), 12); return out; }
      if (/^uint\d+$/.test(f.type)) return word(BigInt(v as string | number));
      throw new Error(`no encoder for ${f.type}`);
    });
    return keccak_256(concat(typeHash, ...enc));
  };
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), hashStruct('EIP712Domain', td.domain), hashStruct(td.primaryType, td.message)));
}

test('typed data: the digest is what eth_signTypedData_v4 signs (viem vector, a known key)', () => {
  const key = hexToBytes(KEY);
  assert.equal(privateKeyToAddress(key).toLowerCase(), VECTOR.owner.toLowerCase());
  const digest = indexActionDigest(VECTOR);
  assert.equal(bytesToHex(digest), VIEM_DIGEST);
  assert.equal(bytesToHex(typedDataDigest(indexTypedData(VECTOR))), VIEM_DIGEST, 'the encoder below agrees with viem');
  // RFC 6979: the same key and digest give the same signature in noble and viem.
  assert.equal(rsv(digest, key), VIEM_SIGNATURE);
  const c = checkIndexAction({ ...VECTOR, signature: VIEM_SIGNATURE }, NOW);
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(c.kind, 'publish');
  assert.equal(c.action.owner, VECTOR.owner.toLowerCase());
  assert.deepEqual(c.legs, [{ fundId: 'vQQQ', bp: 4000 }, { fundId: 'vSMH', bp: 3000 }, { fundId: 'vVGT', bp: 3000 }]);
  assert.equal(c.action.image, VECTOR.image);
  const down = { ...VECTOR, id: 'c012345678', statement: INDEX_UNPUBLISH_STATEMENT, name: '', description: '', legs: '', image: '' };
  assert.equal(bytesToHex(indexActionDigest(down)), VIEM_UNPUBLISH_DIGEST);
});

test('typed data: the page signs exactly the fields the server hashes, whatever the text', () => {
  const w = newWallet();
  const td = indexTypedData({ ...VECTOR, owner: w.address.toUpperCase().replace('0X', '0x') });
  assert.equal(td.primaryType, 'IndexAction');
  assert.equal(`IndexAction(${td.types.IndexAction.map((f) => `${f.type} ${f.name}`).join(',')})`, INDEX_TYPE);
  assert.equal(td.message.owner, w.address, 'the address signed lowercased, as the server hashes it');
  const samples = [
    { ...VECTOR, owner: w.address },
    { ...VECTOR, owner: w.address, id: 'czzzzzzzzz', name: 'Ünïcödé ’quotes’ +/:-', description: '', chainId: 1 },
    { ...VECTOR, owner: w.address, statement: INDEX_UNPUBLISH_STATEMENT, id: 'c000000000', name: '', legs: '', image: '', issuedAt: '9999999999999', expiresAt: '9999999999999' },
    { ...VECTOR, owner: w.address, image: 'f'.repeat(64) },
  ];
  for (const s of samples) assert.equal(bytesToHex(indexActionDigest(s)), bytesToHex(typedDataDigest(indexTypedData(s))), s.name);
});

// --- the check -----------------------------------------------------------------------------------------------------

test('action check: a publish and a take-down pass, and the owner is lowercased', () => {
  const w = newWallet();
  const p = checked(action(w, 'publish'));
  assert.equal(p.kind, 'publish');
  assert.equal(p.legs.length, 3);
  const mixed = action({ ...w, address: '0x' + w.address.slice(2).toUpperCase() }, 'publish');
  assert.equal(checked(mixed).action.owner, w.address);
  // A take-down's name, description and legs are signed but not read: whatever the page had.
  const d = checked(action(w, 'unpublish', { id: 'cabcdefghi', name: '', description: '  untidy  ', legs: 'not legs' }));
  assert.equal(d.kind, 'unpublish');
  assert.deepEqual(d.legs, []);
  assert.equal(d.action.id, 'cabcdefghi');
});

test('action check: every refusal', () => {
  const w = newWallet();
  const other = newWallet();
  const good = action(w, 'publish');
  const down = action(w, 'unpublish', { id: 'cabcdefghi' });
  const cases: Array<[string, unknown, RegExp]> = [
    ['nothing', null, /missing action/],
    ['not an object', 'action', /missing action/],
    ['owner', action(w, 'publish', { owner: 'nope' }), /owner must be a 0x address/],
    ['owner short', action(w, 'publish', { owner: '0x1234' }), /owner must be a 0x address/],
    ['statement', action(w, 'publish', { statement: 'Publish my index.' }), /not an index action/],
    ['id', action(w, 'publish', { id: 'C12345678Z' }), /id must be an index id/],
    ['id not text', { ...good, id: 7 }, /id must be an index id/],
    ['take-down without id', action(w, 'unpublish', { id: '' }), /needs its id/],
    ['name not text', { ...good, name: 42 }, /must be text/],
    ['legs not text', { ...down, legs: null }, /must be text/],
    ['name spaces inside', action(w, 'publish', { name: 'Chips  AI' }), /name has extra spaces/],
    ['name spaces at the end', action(w, 'publish', { name: 'Chips AI ' }), /name has extra spaces/],
    ['description blank lines', action(w, 'publish', { description: 'a\n\n\nb' }), /description has extra spaces or blank lines/],
    ['description spaces', action(w, 'publish', { description: 'a  b' }), /description has extra spaces/],
    ['legs not legs', action(w, 'publish', { legs: 'vQQQ 4000' }), /fundId:bp/],
    ['legs empty', action(w, 'publish', { legs: '' }), /fundId:bp/],
    ['legs other spelling', action(w, 'publish', { legs: 'vQQQ:04000,vSMH:3000,vVGT:3000' }), /fundId:bp/],
    ['image not a hash', action(w, 'publish', { image: 'https://example.com/a.png' }), /image must be the SHA-256/],
    ['image uppercase', action(w, 'publish', { image: 'A'.repeat(64) }), /image must be the SHA-256/],
    ['image short', action(w, 'publish', { image: 'a'.repeat(63) }), /image must be the SHA-256/],
    ['image missing', { ...good, image: undefined }, /image must be the SHA-256/],
    ['image on a take-down', action(w, 'unpublish', { id: 'cabcdefghi', image: 'nope' }), /image must be the SHA-256/],
    ['name short', action(w, 'publish', { name: 'ab' }), /at least 3 characters/],
    ['name long', action(w, 'publish', { name: 'a'.repeat(41) }), /at most 40 characters/],
    ['name characters', action(w, 'publish', { name: 'Chips <AI>' }), /letters, numbers, spaces/],
    ['name reserved', action(w, 'publish', { name: 'SoDEX Picks' }), /reads as ValueDesk/],
    ['description long', action(w, 'publish', { description: 'x'.repeat(281) }), /at most 280 characters/],
    ['description control', action(w, 'publish', { description: 'a‮b' }), /cannot be shown/],
    ['description link', action(w, 'publish', { description: 'see www.example.com' }), /Links are not allowed/],
    ['one leg', action(w, 'publish', { legs: 'vQQQ:10000' }), /at least 2 funds/],
    ['thirteen legs', action(w, 'publish', { legs: [...Array(13)].map((_, i) => `f${i}:${i === 0 ? 10000 - 12 * 700 : 700}`).join(',') }), /at most 12 funds/],
    ['fund twice', action(w, 'publish', { legs: 'vQQQ:5000,vqqq:5000' }), /twice/],
    ['leg small', action(w, 'publish', { legs: 'vQQQ:9995,vSMH:5' }), /at least 0\.1%/],
    ['sum', action(w, 'publish', { legs: 'vQQQ:4000,vSMH:3000' }), /add up to 100%/],
    ['nonce', action(w, 'publish', { nonce: 'xyz' }), /nonce must be 32 hex/],
    ['nonce uppercase', action(w, 'publish', { nonce: 'ABCDEF0123456789ABCDEF0123456789' }), /nonce must be 32 hex/],
    ['issuedAt', action(w, 'publish', { issuedAt: '180000' }), /issuedAt must be a time/],
    ['issuedAt a number', { ...good, issuedAt: NOW }, /issuedAt must be a time/],
    ['expiresAt', { ...good, expiresAt: 'soon' }, /expiresAt must be a time/],
    ['chainId zero', action(w, 'publish', { chainId: 0 }), /chainId must be a positive integer/],
    ['chainId fraction', { ...good, chainId: 1.5 }, /chainId must be a positive integer/],
    ['chainId text', { ...good, chainId: 'one' }, /chainId must be a positive integer/],
    ['signature short', { ...good, signature: '0x1234' }, /65 bytes of hex/],
    ['signature not hex', { ...good, signature: '0x' + 'z'.repeat(130) }, /65 bytes of hex/],
    ['signature unreadable', { ...good, signature: '0x' + '00'.repeat(65) }, /cannot be read/],
    ['expired', action(w, 'publish', { issuedAt: String(NOW - 60_000), expiresAt: String(NOW - 1) }), /expired/],
    ['too long', action(w, 'publish', { expiresAt: String(NOW + 10 * 60_000 + 1) }), /longer than allowed/],
    ['ends before it starts', action(w, 'publish', { issuedAt: String(NOW + 2000), expiresAt: String(NOW + 1000) }), /longer than allowed/],
    ['too far ahead', action(w, 'publish', { issuedAt: String(NOW + 3_600_000), expiresAt: String(NOW + 3_660_000) }), /too far ahead/],
    ['another signer', action(w, 'publish', {}, other), /not from this wallet/],
    ['name changed after signing', { ...good, name: 'Chips & ML' }, /not from this wallet/],
    ['legs changed after signing', { ...good, legs: 'vQQQ:5000,vSMH:2000,vVGT:3000' }, /not from this wallet/],
    ['image changed after signing', { ...good, image: 'a'.repeat(64) }, /not from this wallet/],
    ['chain changed after signing', { ...good, chainId: 2 }, /not from this wallet/],
    ['a take-down sent as a publish', { ...down, statement: INDEX_PUBLISH_STATEMENT }, /not from this wallet/],
  ];
  for (const [what, a, re] of cases) {
    const r = checkIndexAction(a, NOW);
    assert.equal(r.ok, false, what);
    assert.match((r as { error: string }).error, re, what);
  }
});

// --- the store -----------------------------------------------------------------------------------------------------

const DIR = tempDir('vs-indexes-');
let files = 0;
const dbFile = () => join(DIR, `indexes-${++files}.db`);

test('store: a new index, its repeat, an update, a stale one and a replay', () => {
  const s = new IndexStore(dbFile());
  const w = newWallet();
  const first = checked(action(w, 'publish'));
  const r = s.publish(first.action, first.legs, NOW);
  assert.ok(r.ok && r.fresh);
  const id = r.index.id;
  assert.match(id, INDEX_ID);
  assert.deepEqual(r.index, { id, owner: w.address, name: 'Chips & AI', description: 'Semis and software, weighted by hand.', legs: first.legs, image: null, createdAt: NOW, updatedAt: NOW });
  assert.deepEqual(s.get(id), r.index);
  assert.equal(s.countLive(w.address), 1);

  // The same signed action again (its answer lost): the same index, nothing new.
  const again = s.publish(first.action, first.legs, NOW + 5);
  assert.ok(again.ok && !again.fresh);
  assert.equal(again.index.id, id);
  assert.equal(s.countLive(w.address), 1);
  // Another action under a nonce this wallet used already.
  const reused = checked(action(w, 'publish', { nonce: first.action.nonce, name: 'Second one' }));
  assert.deepEqual(s.publish(reused.action, reused.legs, NOW + 6), { ok: false, code: 'replay' });

  const upd = checked(action(w, 'publish', { id, name: 'Chips & ML', legs: 'vSMH:5000,vQQQ:5000', ...at(1000) }));
  const u = s.publish(upd.action, upd.legs, NOW + 2000);
  assert.ok(u.ok && u.fresh);
  assert.deepEqual(s.get(id), { id, owner: w.address, name: 'Chips & ML', description: 'Semis and software, weighted by hand.', legs: [{ fundId: 'vSMH', bp: 5000 }, { fundId: 'vQQQ', bp: 5000 }], image: null, createdAt: NOW, updatedAt: NOW + 2000 });

  // Signed before (or at the same time as) the change that stands: refused, the index unchanged.
  for (const t of [500, 1000]) {
    const old = checked(action(w, 'publish', { id, name: 'Old name', ...at(t) }), NOW + 1000);
    assert.deepEqual(s.publish(old.action, old.legs, NOW + 3000), { ok: false, code: 'stale' });
  }
  assert.equal(s.get(id)?.name, 'Chips & ML');
  s.close();
});

test('store: only the owner changes or takes down an index, and only while it is up', () => {
  const s = new IndexStore(dbFile());
  const w = newWallet();
  const other = newWallet();
  const p = checked(action(w, 'publish'));
  const r = s.publish(p.action, p.legs, NOW);
  assert.ok(r.ok);
  const id = r.index.id;

  const theirs = checked(action(other, 'publish', { id, name: 'Taken over', ...at(10) }));
  assert.deepEqual(s.publish(theirs.action, theirs.legs, NOW + 20), { ok: false, code: 'not-owner' });
  assert.deepEqual(s.unpublish(checked(action(other, 'unpublish', { id, ...at(10) })).action, NOW + 20), { ok: false, code: 'not-owner' });
  const missing = checked(action(w, 'publish', { id: 'cnotthere0', ...at(10) }));
  assert.deepEqual(s.publish(missing.action, missing.legs, NOW + 20), { ok: false, code: 'not-found' });
  assert.deepEqual(s.unpublish(checked(action(w, 'unpublish', { id: 'cnotthere0', ...at(10) })).action, NOW + 20), { ok: false, code: 'not-found' });
  // A take-down signed before the publish that stands.
  const early = checked(action(w, 'unpublish', { id, issuedAt: String(NOW - 1000), expiresAt: String(NOW + 60_000) }));
  assert.deepEqual(s.unpublish(early.action, NOW + 20), { ok: false, code: 'stale' });

  const down = checked(action(w, 'unpublish', { id, ...at(100) }));
  assert.deepEqual(s.unpublish(down.action, NOW + 200), { ok: true, fresh: true });
  assert.equal(s.get(id), null);
  assert.deepEqual(s.list({ limit: 10 }), []);
  assert.equal(s.countLive(w.address), 0);
  assert.deepEqual(s.unpublish(down.action, NOW + 300), { ok: true, fresh: false }, 'a repeat after a lost answer');
  assert.deepEqual(s.unpublish(checked(action(w, 'unpublish', { id, ...at(400) })).action, NOW + 500), { ok: false, code: 'not-found' });
  const back = checked(action(w, 'publish', { id, ...at(400) }));
  assert.deepEqual(s.publish(back.action, back.legs, NOW + 500), { ok: false, code: 'not-found' }, 'a taken-down id does not come back');
  // An old publish signature replayed once the index is down: refused, nothing is brought back.
  assert.deepEqual(s.publish(p.action, p.legs, NOW + 600), { ok: false, code: 'replay' });
  s.close();
});

test('store: a wallet has at most INDEX_PER_WALLET_MAX up at once', () => {
  const s = new IndexStore(dbFile());
  const w = newWallet();
  const ids: string[] = [];
  for (let i = 0; i < INDEX_PER_WALLET_MAX; i++) {
    const p = checked(action(w, 'publish', { name: `Index ${i}` }));
    const r = s.publish(p.action, p.legs, NOW + i);
    assert.ok(r.ok);
    ids.push(r.index.id);
  }
  assert.equal(new Set(ids).size, INDEX_PER_WALLET_MAX);
  const over = checked(action(w, 'publish', { name: 'One too many' }));
  assert.deepEqual(s.publish(over.action, over.legs, NOW + 100), { ok: false, code: 'limit' });
  // An update is not a new one.
  const upd = checked(action(w, 'publish', { id: ids[0], name: 'Renamed', ...at(200) }));
  assert.ok(s.publish(upd.action, upd.legs, NOW + 300).ok);
  // Taking one down makes room; another wallet has its own count.
  assert.ok(s.unpublish(checked(action(w, 'unpublish', { id: ids[1]!, ...at(200) })).action, NOW + 300).ok);
  assert.ok(s.publish(over.action, over.legs, NOW + 400).ok);
  const other = checked(action(newWallet(), 'publish'));
  assert.ok(s.publish(other.action, other.legs, NOW + 400).ok);
  assert.equal(s.countLive(w.address), INDEX_PER_WALLET_MAX);
  s.close();
});

test('store: a new id that is taken is drawn again', () => {
  const s = new IndexStore(dbFile());
  const w = newWallet();
  const p = checked(action(w, 'publish'));
  assert.ok(s.publish(p.action, p.legs, NOW, () => 'caaaaaaaaa').ok);
  const draws = ['caaaaaaaaa', 'caaaaaaaaa', 'cbbbbbbbbb'];
  const q = checked(action(w, 'publish', { name: 'Second' }));
  const r = s.publish(q.action, q.legs, NOW + 1, () => draws.shift()!);
  assert.ok(r.ok);
  assert.equal(r.index.id, 'cbbbbbbbbb');
  const z = checked(action(w, 'publish', { name: 'Third' }));
  assert.throws(() => s.publish(z.action, z.legs, NOW + 2, () => 'caaaaaaaaa'), /no free id/);
  assert.equal(s.countLive(w.address), 2, 'a failed draw leaves nothing behind');
  for (let i = 0; i < 500; i++) assert.match(randomIndexId(), INDEX_ID);
  s.close();
});

test('store: the list is the last changed first, by owner, paged, live only', () => {
  const s = new IndexStore(dbFile());
  const a = newWallet();
  const b = newWallet();
  const made: string[] = [];
  for (const [i, w] of [a, b, a, b].entries()) {
    const p = checked(action(w, 'publish', { name: `Index ${i}` }));
    const r = s.publish(p.action, p.legs, NOW + i * 10);
    assert.ok(r.ok);
    made.push(r.index.id);
  }
  assert.deepEqual(s.list({ limit: 10 }).map((x) => x.name), ['Index 3', 'Index 2', 'Index 1', 'Index 0']);
  // A change moves an index to the front.
  const upd = checked(action(a, 'publish', { id: made[0], name: 'Index 0 again', ...at(100) }));
  assert.ok(s.publish(upd.action, upd.legs, NOW + 100).ok);
  assert.deepEqual(s.list({ limit: 10 }).map((x) => x.name), ['Index 0 again', 'Index 3', 'Index 2', 'Index 1']);
  assert.deepEqual(s.list({ owner: a.address.toUpperCase().replace('0X', '0x'), limit: 10 }).map((x) => x.name), ['Index 0 again', 'Index 2']);
  assert.deepEqual(s.list({ limit: 2 }).map((x) => x.name), ['Index 0 again', 'Index 3']);
  assert.deepEqual(s.list({ limit: 10, before: NOW + 30 }).map((x) => x.name), ['Index 2', 'Index 1']);
  assert.ok(s.unpublish(checked(action(b, 'unpublish', { id: made[3]!, ...at(100) })).action, NOW + 200).ok);
  assert.deepEqual(s.list({ limit: 10 }).map((x) => x.name), ['Index 0 again', 'Index 2', 'Index 1']);
  s.close();
});

test('store: every signed action is kept whole, a taken-down row stays, and the file survives a reopen', () => {
  const path = dbFile();
  const s = new IndexStore(path);
  const w = newWallet();
  const p = checked(action(w, 'publish'));
  const r = s.publish(p.action, p.legs, NOW);
  assert.ok(r.ok);
  const d = checked(action(w, 'unpublish', { id: r.index.id, name: '', description: '', legs: '', ...at(50) }));
  assert.ok(s.unpublish(d.action, NOW + 60).ok);
  s.close();

  const db = new DatabaseSync(path);
  const rows = db.prepare('SELECT * FROM index_actions ORDER BY id').all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { ...rows[0] },
    { id: 1, kind: 'publish', index_id: r.index.id, owner: w.address, signed_id: '', name: p.action.name, description: p.action.description, legs: LEGS, image: '', statement: INDEX_PUBLISH_STATEMENT, nonce: p.action.nonce, issued_at: NOW, expires_at: NOW + 5 * 60_000, chain_id: 1, signature: p.action.signature, at: NOW },
  );
  assert.equal(rows[1]!.kind, 'unpublish');
  assert.equal(rows[1]!.signed_id, r.index.id);
  assert.equal(rows[1]!.signature, d.action.signature);
  const kept = db.prepare('SELECT * FROM published_indexes').get() as Record<string, unknown>;
  assert.equal(kept.removed_at, NOW + 60);
  assert.equal(kept.name, 'Chips & AI', 'a take-down keeps what was published');
  db.close();

  const again = new IndexStore(path);
  assert.equal(again.get(r.index.id), null);
  assert.deepEqual(again.publish(p.action, p.legs, NOW + 70), { ok: false, code: 'replay' }, 'nonces are remembered across a restart');
  again.close();
});

test('store: the database path follows VALUESCAN_INDEXES_DB', () => {
  const before = process.env.VALUESCAN_INDEXES_DB;
  try {
    process.env.VALUESCAN_INDEXES_DB = ' /somewhere/else.db ';
    assert.equal(indexesDbPath(), '/somewhere/else.db');
    delete process.env.VALUESCAN_INDEXES_DB;
    assert.match(indexesDbPath(), /indexes\.db$/);
  } finally {
    if (before === undefined) delete process.env.VALUESCAN_INDEXES_DB;
    else process.env.VALUESCAN_INDEXES_DB = before;
  }
});

// --- the routes ----------------------------------------------------------------------------------------------------

/** `spread`: every request from a client of its own, so a test of many refusals stays under the per-client limits. */
async function api(nameOf?: (a: string) => string | null, spread = false) {
  const path = dbFile();
  const store = new IndexStore(path);
  const app = Fastify();
  let t = NOW;
  let clients = 0;
  await app.register(vdIndexRoutes, { store, now: () => t, limiter: new KeyedLimiter(1000), ...(nameOf ? { nameOf } : {}) });
  await app.ready();
  const from = () => (spread ? { remoteAddress: `10.0.${++clients >> 8}.${clients & 255}` } : {});
  const publish = (a: unknown, image?: unknown) => app.inject({ method: 'POST', url: '/api/vs/indexes/publish', payload: { action: a, ...(image !== undefined ? { image } : {}) }, ...from() });
  const unpublish = (a: unknown) => app.inject({ method: 'POST', url: '/api/vs/indexes/unpublish', payload: { action: a }, ...from() });
  const list = (q = '') => app.inject({ method: 'GET', url: `/api/vs/indexes${q}`, ...from() });
  const one = (id: string) => app.inject({ method: 'GET', url: `/api/vs/indexes/${id}`, ...from() });
  const picture = (hash: string) => app.inject({ method: 'GET', url: `/api/vs/indexes/image/${hash}`, ...from() });
  return { app, store, path, publish, unpublish, list, one, picture, tick: (ms: number) => { t += ms; } };
}

test('routes: publish, read, list, change and take down', async () => {
  const w = newWallet();
  const a = await api((x) => (x === w.address ? 'Luke_1' : null));
  assert.deepEqual((await a.list()).json(), { ok: true, indexes: [] });

  const r = await a.publish(action(w, 'publish'));
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.ok, true);
  const id = body.index.id as string;
  assert.match(id, INDEX_ID);
  assert.deepEqual(body.index, {
    id, owner: w.address, ownerName: 'Luke_1', name: 'Chips & AI', description: 'Semis and software, weighted by hand.',
    legs: [{ fundId: 'vQQQ', bp: 4000 }, { fundId: 'vSMH', bp: 3000 }, { fundId: 'vVGT', bp: 3000 }], image: null, createdAt: NOW, updatedAt: NOW,
  });
  assert.equal(r.headers['cache-control'], 'no-store');

  const got = await a.one(id);
  assert.equal(got.statusCode, 200);
  assert.deepEqual(got.json(), { ok: true, index: body.index });
  assert.equal(got.headers['cache-control'], 'no-store');
  const listed = await a.list();
  assert.deepEqual(listed.json(), { ok: true, indexes: [body.index] });
  assert.equal(listed.headers['cache-control'], 'no-store');

  // Someone else's index, and one with no name.
  const other = newWallet();
  a.tick(10);
  assert.equal((await a.publish(action(other, 'publish', { name: 'Other basket', ...at(10) }))).statusCode, 200);
  const all = (await a.list()).json().indexes as Array<{ name: string; ownerName: string | null }>;
  assert.deepEqual(all.map((x) => [x.name, x.ownerName]), [['Other basket', null], ['Chips & AI', 'Luke_1']]);
  assert.deepEqual((await a.list(`?owner=${w.address}`)).json().indexes.map((x: { id: string }) => x.id), [id]);
  assert.equal((await a.list('?limit=1')).json().indexes.length, 1);
  assert.equal((await a.list('?limit=1000')).json().indexes.length, 2, 'a limit above 200 is 200');
  assert.deepEqual((await a.list(`?before=${NOW + 10}`)).json().indexes.map((x: { id: string }) => x.id), [id]);

  a.tick(1000);
  const upd = await a.publish(action(w, 'publish', { id, name: 'Chips & ML', ...at(1000) }));
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.json().index.name, 'Chips & ML');
  assert.equal(upd.json().index.updatedAt, NOW + 1010);
  assert.equal(upd.json().index.createdAt, NOW);

  a.tick(1000);
  const down = await a.unpublish(action(w, 'unpublish', { id, ...at(2000) }));
  assert.equal(down.statusCode, 200);
  assert.deepEqual(down.json(), { ok: true });
  assert.equal((await a.one(id)).statusCode, 404);
  assert.deepEqual((await a.list(`?owner=${w.address}`)).json().indexes, []);
  await a.app.close();
});

test('routes: 400 for what the check refuses, 403 for another wallet, 404 for none, 409 for stale, replay and limit', async () => {
  const a = await api(undefined, true);
  const w = newWallet();
  const other = newWallet();
  const first = action(w, 'publish');
  const id = (await a.publish(first)).json().index.id as string;

  const bad = await a.publish(action(w, 'publish', { legs: 'vQQQ:4000,vSMH:3000' }));
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json(), { ok: false, error: 'The weights must add up to 100%.' });
  assert.equal((await a.publish(undefined)).statusCode, 400);
  assert.match((await a.publish(action(w, 'publish', {}, other))).json().error, /not from this wallet/);
  // Each signature on its own path: a take-down is never a publish, and the other way round.
  const swapped = await a.publish(action(w, 'unpublish', { id }));
  assert.equal(swapped.statusCode, 400);
  assert.match(swapped.json().error, /unpublish/);
  assert.equal((await a.unpublish(action(w, 'publish', { id, ...at(1) }))).statusCode, 400);

  const theirs = await a.publish(action(other, 'publish', { id, ...at(5) }));
  assert.equal(theirs.statusCode, 403);
  assert.equal(theirs.json().code, 'not-owner');
  assert.equal((await a.unpublish(action(other, 'unpublish', { id, ...at(5) }))).statusCode, 403);

  const none = await a.publish(action(w, 'publish', { id: 'cmissing00', ...at(5) }));
  assert.equal(none.statusCode, 404);
  assert.equal(none.json().code, 'not-found');
  assert.equal((await a.unpublish(action(w, 'unpublish', { id: 'cmissing00', ...at(5) }))).statusCode, 404);
  assert.equal((await a.one('cmissing00')).statusCode, 404);
  assert.equal((await a.one('not-an-id')).statusCode, 404);

  a.tick(100);
  assert.equal((await a.publish(action(w, 'publish', { id, name: 'Newer', ...at(100) }))).statusCode, 200);
  const stale = await a.publish(action(w, 'publish', { id, name: 'Older', ...at(50) }));
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'stale');
  const replay = await a.publish(action(w, 'publish', { nonce: first.nonce, name: 'Same nonce', ...at(100) }));
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().code, 'replay');
  // The very same signed publish again: the index it made, nothing new.
  const repeat = await a.publish(first);
  assert.equal(repeat.statusCode, 200);
  assert.equal(repeat.json().index.id, id);

  for (let i = 1; i < INDEX_PER_WALLET_MAX; i++) {
    const p = checked(action(w, 'publish', { name: `Index ${i}`, ...at(100) }));
    assert.ok(a.store.publish(p.action, p.legs, NOW + 100).ok);
  }
  const full = await a.publish(action(w, 'publish', { name: 'One too many', ...at(100) }));
  assert.equal(full.statusCode, 409);
  assert.equal(full.json().code, 'limit');

  assert.equal((await a.list('?owner=nope')).statusCode, 400);
  assert.equal((await a.list('?limit=0')).statusCode, 400);
  assert.equal((await a.list('?limit=ten')).statusCode, 400);
  assert.equal((await a.list('?before=yesterday')).statusCode, 400);
  const big = await a.app.inject({ method: 'POST', url: '/api/vs/indexes/publish', payload: { action: first, image: 'A'.repeat(INDEX_PUBLISH_BODY_LIMIT) } });
  assert.equal(big.statusCode, 413);
  const bigDown = await a.app.inject({ method: 'POST', url: '/api/vs/indexes/unpublish', payload: { action: { ...first, description: 'x'.repeat(9000) } } });
  assert.equal(bigDown.statusCode, 413, 'a take-down carries no picture: 8 KiB');
  await a.app.close();
});

test('routes: a failing username lookup never breaks the answer', async () => {
  const a = await api(() => { throw new Error('profiles.db is gone'); });
  const w = newWallet();
  const r = await a.publish(action(w, 'publish'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().index.ownerName, null);
  assert.equal((await a.list()).json().indexes[0].ownerName, null);
  await a.app.close();
});

test('routes: writes per client are limited, one budget for both, apart from reads', async () => {
  const a = await api();
  const w = newWallet();
  let last = 0;
  for (let i = 0; i < INDEX_LIMITS.write.max; i++) last = (await a.publish(action(w, 'publish', { nonce: 'f'.repeat(32) }))).statusCode;
  assert.notEqual(last, 429);
  const over = await a.unpublish(action(w, 'unpublish', { id: 'cabcdefghi' }));
  assert.equal(over.statusCode, 429);
  assert.ok(Number(over.headers['retry-after']) >= 1);
  assert.equal((await a.list()).statusCode, 200, 'reading is not a write');
  a.tick(INDEX_LIMITS.write.windowMs);
  assert.equal((await a.publish(action(w, 'publish', { ...at(INDEX_LIMITS.write.windowMs) }))).statusCode, 200);
  await a.app.close();
});

test('routes: reads per client are limited too', async () => {
  const a = await api();
  let last = 0;
  for (let i = 0; i <= INDEX_LIMITS.read.max; i++) last = (await (i % 2 ? a.list() : a.one('cabcdefghi'))).statusCode;
  assert.equal(last, 429);
  await a.app.close();
});

// --- the picture ---------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** A real PNG: RGB, 8 bits, one colour, `extra` chunks before IEND. */
function png(width = 1, height = 1, rgb: [number, number, number] = [200, 30, 90], extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), ...extra, chunk('IEND', new Uint8Array(0)),
  ]);
}
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function nonCanonical(s: string): string {
  const i = s.length - (s.endsWith('==') ? 3 : 2);
  const out = s.slice(0, i) + B64[B64.indexOf(s[i]!) + 1] + s.slice(i + 1);
  assert.deepEqual(Buffer.from(out, 'base64'), Buffer.from(s, 'base64'), 'Node decodes both spellings to the same bytes');
  return out;
}

test('picture: published with the index, served back by its hash with every header, kept once', async () => {
  const a = await api();
  const w = newWallet();
  const pic = png();
  const hash = sha(pic);
  const r = await a.publish(action(w, 'publish', { image: hash }), b64(pic));
  assert.equal(r.statusCode, 200, r.body);
  const ix = r.json().index;
  assert.equal(ix.image, hash);
  assert.equal((await a.one(ix.id)).json().index.image, hash);
  assert.equal((await a.list()).json().indexes[0].image, hash);

  const got = await a.picture(hash);
  assert.equal(got.statusCode, 200);
  assert.deepEqual(got.rawPayload, pic, 'the very bytes sent');
  assert.equal(got.headers['content-type'], 'image/png');
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
  assert.equal(got.headers['content-security-policy'], "default-src 'none'; sandbox");
  assert.equal(got.headers['content-disposition'], 'inline; filename="index.png"');
  assert.equal(got.headers['cache-control'], 'public, max-age=31536000, immutable');

  // Another index with the same picture: one row of bytes.
  a.tick(10);
  assert.equal((await a.publish(action(newWallet(), 'publish', { image: hash, ...at(10) }), b64(pic))).statusCode, 200);
  const db = new DatabaseSync(a.path);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM index_images').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT image FROM index_actions ORDER BY id LIMIT 1').get() as { image: string }).image, hash, 'the signed hash is kept with the action');
  db.close();
  await a.app.close();
});

test('picture: the image route never collides with an index id, and answers 404 for anything not a live picture', async () => {
  const a = await api();
  const w = newWallet();
  const pic = png();
  const hash = sha(pic);
  const id = (await a.publish(action(w, 'publish', { image: hash }), b64(pic))).json().index.id as string;
  // /image alone is the :id route with an id that is not one; /image/<hash> is never read as an index.
  assert.equal((await a.one('image')).statusCode, 404);
  assert.equal((await a.one(id)).statusCode, 200);
  for (const bad of [hash.toUpperCase(), hash.slice(1), `${hash}0`, 'f'.repeat(64), '..%2F..%2Fetc', 'x']) {
    const r = await a.picture(bad);
    assert.equal(r.statusCode, 404, bad);
    assert.equal(r.headers['cache-control'], 'no-store', 'a miss is never kept');
    assert.match(String(r.headers['content-type']), /json/);
  }
  assert.equal((await a.picture(hash)).statusCode, 200);
  // A taken-down index's picture is not served any more (its bytes stay in the file).
  a.tick(100);
  assert.equal((await a.unpublish(action(w, 'unpublish', { id, ...at(100) }))).statusCode, 200);
  assert.equal((await a.picture(hash)).statusCode, 404);
  await a.app.close();
});

test('picture: every refusal is a 400 with its reason, and nothing is kept', async () => {
  const a = await api(undefined, true);
  const w = newWallet();
  const pic = png();
  const hash = sha(pic);
  const big = png(1, 1, [1, 2, 3], [chunk('teSt', new Uint8Array(INDEX_IMAGE_MAX_BYTES))]);
  const wide = png(INDEX_IMAGE_SIDE + 1, 1);
  const tall = png(1, INDEX_IMAGE_SIDE + 1);
  const script = Buffer.concat([pic, Buffer.from('<script>alert(1)</script>')]);
  const inside = png(1, 1, [9, 9, 9], [chunk('tEXt', Buffer.from('c\0<svg onload=alert(1)>'))]);
  // A PNG whose base64 ends in padding, written with the unused low bits set: the same bytes in a second spelling.
  const padded = [1, 2, 3, 4, 5].map((n) => png(n, 1)).find((b) => b.length % 3 !== 0)!;
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');
  const cases: Array<[string, Partial<IndexAction>, unknown, RegExp]> = [
    ['hash mismatch', { image: sha(png(1, 1, [0, 0, 0])) }, b64(pic), /not the one that was signed/],
    ['too big', { image: sha(big) }, b64(big), /larger than 96 KB/],
    ['too wide', { image: sha(wide) }, b64(wide), new RegExp(`larger than ${INDEX_IMAGE_SIDE} x ${INDEX_IMAGE_SIDE}`)],
    ['too tall', { image: sha(tall) }, b64(tall), /larger than 512 x 512/],
    ['trailing script', { image: sha(script) }, b64(script), /data after the end of the PNG/],
    ['markup inside a chunk', { image: sha(inside) }, b64(inside), /something other than an image/],
    ['svg', { image: sha(svg) }, b64(svg), /only PNG, JPEG and WebP/],
    ['bytes missing for a new index', { image: hash }, undefined, /not sent/],
    ['not base64', { image: hash }, 'iVBOR*w0K', /as base64/],
    ['base64 with a data: prefix', { image: hash }, `data:image/png;base64,${b64(pic)}`, /as base64/],
    ['base64 with line breaks', { image: hash }, b64(pic).replace(/(.{20})/g, '$1\n'), /as base64/],
    ['base64 not canonical', { image: sha(padded) }, nonCanonical(b64(padded)), /as base64/],
    ['not text', { image: hash }, [1, 2, 3], /as base64/],
    ['a picture for an index signed without one', {}, b64(pic), /signed without one/],
  ];
  for (const [what, o, image, re] of cases) {
    const r = await a.publish(action(w, 'publish', o), image);
    assert.equal(r.statusCode, 400, `${what}: ${r.body}`);
    assert.match(r.json().error, re, what);
  }
  assert.equal(a.store.countLive(w.address), 0, 'no index was made');
  const db = new DatabaseSync(a.path);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM index_images').get() as { n: number }).n, 0, 'no bytes were kept');
  db.close();
  await a.app.close();
});

test('picture: an update may keep its picture without the bytes, a new one needs them, and \'\' takes it off', async () => {
  const a = await api();
  const w = newWallet();
  const pic = png();
  const hash = sha(pic);
  const id = (await a.publish(action(w, 'publish', { image: hash }), b64(pic))).json().index.id as string;

  a.tick(10);
  const kept = await a.publish(action(w, 'publish', { id, name: 'Renamed', image: hash, ...at(10) }));
  assert.equal(kept.statusCode, 200, kept.body);
  assert.equal(kept.json().index.image, hash);
  assert.equal(kept.json().index.name, 'Renamed');
  assert.equal((await a.picture(hash)).statusCode, 200);

  // Another picture's hash without its bytes: refused, whether or not those bytes are on the server already.
  const other = png(2, 2, [10, 200, 10]);
  const otherHash = sha(other);
  a.tick(10);
  const missing = await a.publish(action(w, 'publish', { id, image: otherHash, ...at(20) }));
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().code, 'image-missing');
  assert.equal((await a.one(id)).json().index.image, hash, 'unchanged');
  a.tick(10);
  assert.equal((await a.publish(action(newWallet(), 'publish', { image: otherHash, ...at(30) }), b64(other))).statusCode, 200);
  a.tick(10);
  assert.equal((await a.publish(action(w, 'publish', { id, image: otherHash, ...at(40) }))).statusCode, 400, 'someone else\'s bytes are not this one\'s to name');
  a.tick(10);
  const changed = await a.publish(action(w, 'publish', { id, image: otherHash, ...at(50) }), b64(other));
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().index.image, otherHash);
  assert.equal((await a.picture(hash)).statusCode, 404, 'the old picture is on no index that is up');

  a.tick(10);
  const none = await a.publish(action(w, 'publish', { id, image: '', ...at(60) }));
  assert.equal(none.statusCode, 200);
  assert.equal(none.json().index.image, null);
  assert.equal((await a.one(id)).json().index.image, null);
  a.tick(10);
  const fresh = await a.publish(action(w, 'publish', { name: 'No picture', ...at(70) }), '');
  assert.equal(fresh.statusCode, 200, 'an empty image field is no picture');
  assert.equal(fresh.json().index.image, null);
  await a.app.close();
});

test('picture: a JPEG is served as one, and the store refuses bytes that are not the signed hash', async () => {
  // Smallest JPEG the check reads: SOI, a baseline frame header (1x1, one component), EOI.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
  const a = await api();
  const w = newWallet();
  const hash = sha(jpeg);
  assert.equal((await a.publish(action(w, 'publish', { image: hash }), b64(jpeg))).statusCode, 200);
  const got = await a.picture(hash);
  assert.equal(got.headers['content-type'], 'image/jpeg');
  assert.equal(got.headers['content-disposition'], 'inline; filename="index.jpg"');
  const c = checked(action(w, 'publish', { image: 'a'.repeat(64), name: 'Another' }));
  assert.throws(() => a.store.publish(c.action, c.legs, NOW, undefined, { hash, kind: 'jpeg', bytes: jpeg }), /not the one the action names/);
  await a.app.close();
});

test('store: an older file without pictures gains the columns on open, its rows read as no picture', () => {
  const path = dbFile();
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE published_indexes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
    legs TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_issued_at INTEGER NOT NULL, removed_at INTEGER) WITHOUT ROWID;
    CREATE TABLE index_actions (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, index_id TEXT NOT NULL, owner TEXT NOT NULL, signed_id TEXT NOT NULL,
    name TEXT NOT NULL, description TEXT NOT NULL, legs TEXT NOT NULL, statement TEXT NOT NULL, nonce TEXT NOT NULL, issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, chain_id INTEGER NOT NULL, signature TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (owner, nonce));`);
  old.prepare('INSERT INTO published_indexes VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').run('cold000000', '0x' + '1'.repeat(40), 'Old one', '', LEGS, NOW, NOW, NOW);
  old.prepare(`INSERT INTO index_actions (kind, index_id, owner, signed_id, name, description, legs, statement, nonce, issued_at, expires_at, chain_id, signature, at)
    VALUES ('publish', 'cold000000', ?, '', 'Old one', '', ?, ?, ?, ?, ?, 1, '0x', ?)`).run('0x' + '1'.repeat(40), LEGS, INDEX_PUBLISH_STATEMENT, '0'.repeat(32), NOW, NOW, NOW);
  old.close();

  const s = new IndexStore(path);
  assert.equal(s.get('cold000000')?.image, null);
  const w = newWallet();
  const pic = png();
  const p = checked(action(w, 'publish', { image: sha(pic) }));
  const r = s.publish(p.action, p.legs, NOW, undefined, { hash: sha(pic), kind: 'png', bytes: pic });
  assert.ok(r.ok);
  assert.equal(s.image(sha(pic))?.kind, 'png');
  s.close();
  const again = new IndexStore(path);
  assert.equal(again.get(r.index.id)?.image, sha(pic), 'a second open finds the columns there');
  const db = new DatabaseSync(path);
  assert.equal((db.prepare("SELECT image FROM index_actions WHERE index_id = 'cold000000'").get() as { image: string }).image, '');
  db.close();
  again.close();
});
