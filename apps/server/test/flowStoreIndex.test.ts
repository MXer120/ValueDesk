// flow/store.ts reads that run on the API thread under /api/vs/bots/markets: same answers as the plain SQL, through
// the indexes (stall profiles 2026-11-19: the plain forms scanned the whole chunk index / party table, 9-33 s cold).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FlowStore } from '../src/flow/store.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-flowidx-'));
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the file */ } });

test('marketsWithChunks and partiesOf answer as the scans did and use the indexes', () => {
  const path = join(dir, 'flow.db');
  const s = new FlowStore(path);
  const btc = s.marketId('sodex', 'BTC-USD', 'BTC', 0);
  const eth = s.marketId('hyperliquid', 'ETH', 'ETH', 0);
  const sol = s.marketId('lighter', 'SOL', 'SOL', 0);
  for (const [mid, t] of [[btc, 1000], [btc, 5000], [eth, 3000], [sol, 9000]] as const) s.putChunk(mid, t, 1, new Uint8Array([1]));
  const addr = '0x' + 'ab'.repeat(20);
  const p1 = s.partyId('sodex', '1002', addr);
  const p2 = s.partyId('hyperliquid', addr, addr);
  const p3 = s.partyId('lighter', 'AbC', null);
  s.partyId('sodex', '23342', null);

  assert.deepEqual(s.marketsWithChunks(0, 10_000), [btc, eth, sol]);
  assert.deepEqual(s.marketsWithChunks(2000, 6000), [btc, eth]);
  assert.deepEqual(s.marketsWithChunks(9001, 20_000), []);

  assert.deepEqual(s.partiesOf('1002').map((p) => p.id), [p1]);
  assert.deepEqual(s.partiesOf(addr.toUpperCase().replace('0X', '0x')).map((p) => p.id), [p1, p2], 'by address, any venue');
  assert.deepEqual(s.partiesOf('AbC').map((p) => p.id), [p3], 'a venue key keeps its case');
  assert.deepEqual(s.partiesOf('nobody'), []);
  s.close();

  const db = new DatabaseSync(path, { readOnly: true });
  const plan = (sql: string) => (db.prepare('EXPLAIN QUERY PLAN ' + sql).all() as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
  assert.doesNotMatch(plan('SELECT m.id AS mid FROM flow_market m WHERE EXISTS (SELECT 1 FROM flow_chunk c WHERE c.mid = m.id AND c.t >= 1 AND c.t < 2)'), /SCAN c\b|SCAN flow_chunk/);
  assert.match(plan("SELECT id FROM flow_party WHERE venue = 'sodex' AND key IN ('a', 'A')"), /SEARCH flow_party USING (COVERING )?INDEX/);
  assert.match(plan("SELECT id FROM flow_party WHERE address = 'a'"), /SEARCH flow_party USING (COVERING )?INDEX/);
  db.close();
});
