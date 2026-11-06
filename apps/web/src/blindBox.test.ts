/**
 * Blind Boxes, view only: the chain reads against a scripted RPC, and the signed-in GETs against mocks.
 * Nothing here reaches SoDEX or ValueChain, and nothing posts or signs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlindBoxApiError, LOTTERY_API, createBlindBoxReads, mergeLadder, readWalletBoxes, replayTransfers, type Rpc } from './blindBox';
import { SodexSigninOff } from './sodexProgrammes';

const SRC = dirname(fileURLToPath(import.meta.url));
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const BOX = '0x371c4F7F68bE3e558b89cC1f0fB113851C76E750';
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const C = '0xdeaa91b6123d068f5821d0fb0678463d1a8a6079fe8af5de3ce5e896dcf9133d';
const pad = (h: string) => `0x${h.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
const id = (n: number) => pad(n.toString(16));
const ZERO = pad('0');

let idx = 0;
const transfer = (from: string, to: string, tokenId: number, block: number) => ({
  topics: [T, from === 'mint' ? ZERO : pad(from), pad(to), id(tokenId)],
  data: '0x',
  blockNumber: `0x${block.toString(16)}`,
  logIndex: `0x${(idx++).toString(16)}`,
});

interface Script { balance: number; logs?: () => unknown[]; levels?: (ids: bigint[]) => number[]; failLogs?: boolean; failLevels?: boolean }

function rpcOf(s: Script): { rpc: Rpc; calls: string[]; blocks: unknown[] } {
  const calls: string[] = [];
  const blocks: unknown[] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push(method);
    assert.ok(['eth_blockNumber', 'eth_call', 'eth_getLogs'].includes(method), `read-only: ${method}`);
    if (method === 'eth_blockNumber') return '0x10';
    if (method === 'eth_getLogs') {
      if (s.failLogs) throw new Error('range too large');
      const p = params[0] as { topics: Array<string | null>; toBlock: string };
      blocks.push(p.toBlock);
      const want = (l: { topics: string[] }) => p.topics.every((t, i) => t === null || l.topics[i] === t);
      return (s.logs?.() ?? []).filter((l) => want(l as { topics: string[] }));
    }
    const { data } = params[0] as { data: string };
    blocks.push(params[1]);
    if (data.startsWith('0x70a08231')) return `0x${s.balance.toString(16).padStart(64, '0')}`;
    if (data.startsWith('0x0d3be4e8')) {
      if (s.failLevels) throw new Error('reverted');
      const words = data.slice(10).match(/.{64}/g)!;
      const ids = words.slice(2).map((w) => BigInt(`0x${w}`));
      const levels = s.levels ? s.levels(ids) : ids.map(() => 0);
      return `0x${(32).toString(16).padStart(64, '0')}${levels.length.toString(16).padStart(64, '0')}${levels.map((l) => l.toString(16).padStart(64, '0')).join('')}`;
    }
    throw new Error(`unexpected call ${data.slice(0, 10)}`);
  };
  return { rpc, calls, blocks };
}

test('replayTransfers: in chain order, bought back, sold on, duplicates ignored', () => {
  const a = transfer('mint', WALLET, 7, 1);
  const logs = [
    transfer(WALLET, OTHER, 7, 3),
    a,
    a, // a self-transfer shows up in both the "to" and "from" queries
    transfer('mint', WALLET, 8, 2),
    transfer(OTHER, WALLET, 7, 5),
    transfer('mint', WALLET, 9, 4),
    transfer(WALLET, ZERO, 9, 6), // burned by opening
  ];
  assert.deepEqual(replayTransfers(logs, WALLET), ['7', '8']);
});

test('replayTransfers: a consecutive mint counts each id in its range', () => {
  const log = { topics: [C, id(10), ZERO, pad(WALLET)], data: id(12), blockNumber: '0x1', logIndex: '0x0' };
  assert.deepEqual(replayTransfers([log], WALLET), ['10', '11', '12']);
});

test('readWalletBoxes: ids that add up get their tier from the contract, at one block', async () => {
  const logs = [transfer('mint', WALLET, 7, 1), transfer('mint', WALLET, 8, 2), transfer('mint', WALLET, 20, 3)];
  const m = rpcOf({ balance: 3, logs: () => logs, levels: (ids) => ids.map((i) => (i === 20n ? 3 : 0)) });
  const r = await readWalletBoxes(WALLET, BOX, m.rpc);
  assert.equal(r.count, 3);
  assert.equal(r.exact, true);
  assert.deepEqual(r.byLevel, { Common: ['7', '8'], Uncommon: [], Rare: [], SuperRare: ['20'] });
  assert.ok(m.blocks.every((b) => b === '0x10'), 'every read at the same block');
});

test('logs that disagree with balanceOf: the count alone, no ids, no tiers', async () => {
  const m = rpcOf({ balance: 5, logs: () => [transfer('mint', WALLET, 7, 1)] });
  const r = await readWalletBoxes(WALLET, BOX, m.rpc);
  assert.equal(r.count, 5);
  assert.equal(r.exact, false);
  assert.deepEqual(r.byLevel, { Common: [], Uncommon: [], Rare: [], SuperRare: [] });
});

test('logs limited or refused: the count alone', async () => {
  const r = await readWalletBoxes(WALLET, BOX, rpcOf({ balance: 2, failLogs: true }).rpc);
  assert.deepEqual([r.count, r.exact], [2, false]);
});

test('a tier that cannot be read or named: the count alone, never a guess', async () => {
  const logs = () => [transfer('mint', WALLET, 7, 1)];
  const failed = await readWalletBoxes(WALLET, BOX, rpcOf({ balance: 1, logs, failLevels: true }).rpc);
  assert.deepEqual([failed.count, failed.exact], [1, false]);
  const odd = await readWalletBoxes(WALLET, BOX, rpcOf({ balance: 1, logs, levels: () => [9] }).rpc);
  assert.deepEqual([odd.count, odd.exact], [1, false]);
  assert.deepEqual(odd.byLevel.Common, []);
});

test('an empty wallet needs no logs', async () => {
  const m = rpcOf({ balance: 0 });
  const r = await readWalletBoxes(WALLET, BOX, m.rpc);
  assert.deepEqual([r.count, r.exact], [0, true]);
  assert.ok(!m.calls.includes('eth_getLogs'));
});

test('large wallets read their tiers in batches', async () => {
  const logs = Array.from({ length: 450 }, (_, i) => transfer('mint', WALLET, i + 1, i + 1));
  const m = rpcOf({ balance: 450, logs: () => logs });
  const r = await readWalletBoxes(WALLET, BOX, m.rpc);
  assert.equal(r.byLevel.Common.length, 450);
  assert.equal(m.calls.filter((c) => c === 'eth_call').length, 1 + 3);
});

test('signed-in reads: GETs only, straight to SoDEX, with the bearer and no Origin', async () => {
  const calls: Array<{ url: string; method: string; auth: string | null; origin: string | null }> = [];
  const answers: Record<string, unknown> = {
    '/treasures': { total: 3, maxPerOpen: 100 },
    '/progress': { effectiveU: '4411.5' },
    '/history': { items: [{ tokenId: 1 }] },
    '/ledger': {},
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const h = new Headers(init?.headers);
    calls.push({ url: u, method: init?.method ?? 'GET', auth: h.get('authorization'), origin: h.get('origin') });
    const path = u.slice(LOTTERY_API.length);
    if (path === '/draw/entries') return new Response(JSON.stringify({ code: -1, msg: 'no draw yet' }));
    return new Response(JSON.stringify({ code: 0, data: answers[path] }));
  }) as typeof fetch;
  const c = createBlindBoxReads({ fetchImpl, token: () => 'jwt', live: true });
  assert.equal((await c.treasures()).total, 3);
  const p = await c.progress();
  assert.equal(p.effectiveU, 4411.5);
  assert.equal(p.toNextBoxU, null, 'a missing field stays null');
  assert.equal((await c.history()).totalRewardUsd, null);
  assert.deepEqual((await c.ledger()).items, []);
  assert.equal(await c.drawEntries(), null, '"no draw yet" is not a fault');
  assert.ok(calls.every((x) => x.method === 'GET' && x.auth === 'Bearer jwt' && x.origin === null));
});

test('signed-in reads: no token is an answer, not a call', async () => {
  let n = 0;
  const c = createBlindBoxReads({ fetchImpl: (async () => { n += 1; return new Response('{}'); }) as typeof fetch, token: () => null, live: true });
  await assert.rejects(c.progress(), BlindBoxApiError);
  assert.equal(n, 0);
});

test('switch off: every signed-in read refuses before anything leaves, and that is the default', async () => {
  let n = 0;
  const fetchImpl = (async () => { n += 1; return new Response('{}'); }) as typeof fetch;
  for (const c of [createBlindBoxReads({ fetchImpl, token: () => 'jwt', live: false }), createBlindBoxReads({ fetchImpl, token: () => 'jwt' })]) {
    for (const go of [() => c.treasures(), () => c.progress(), () => c.history(), () => c.ledger(), () => c.drawEntries()]) {
      await assert.rejects(go(), SodexSigninOff);
    }
  }
  assert.equal(n, 0);
});

test('view only: no write, no signature, no open or merge in the module', () => {
  const src = readFileSync(join(SRC, 'blindBox.ts'), 'utf8');
  for (const word of ['RequestOpen', 'RequestMerge', 'signTypedData', '/box/open', '/box/merge', '/treasure/open', 'sign-params']) {
    assert.ok(!src.includes(word), word);
  }
  const vault = readFileSync(join(SRC, 'components', 'sodex', 'BoxVault.tsx'), 'utf8');
  assert.ok(!/signTypedData|method: 'POST'/.test(vault));
});

test('mergeLadder: from the rules, SuperRare (0) does not merge', () => {
  assert.deepEqual(mergeLadder({ mergeSize: { Common: 10, Uncommon: 10, Rare: 4, SuperRare: 0 } }), [
    { from: 'Common', to: 'Uncommon', consume: 10 },
    { from: 'Uncommon', to: 'Rare', consume: 10 },
    { from: 'Rare', to: 'SuperRare', consume: 4 },
  ]);
});
