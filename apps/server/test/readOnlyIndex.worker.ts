/**
 * The writer side of test/readOnlyIndex.test.ts: the index opened read-write
 * on a worker thread - as the indexer is in dev (indexer/host.ts) - writing a
 * board whenever the main thread asks for one.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { IndexStore } from '../src/indexer/store.js';

const port = parentPort!;
const store = new IndexStore((workerData as { path: string }).path);

port.on('message', (m: { type: string; n?: number }) => {
  if (m.type === 'write') {
    const n = m.n ?? 0;
    store.writeBoard(
      { venue: 'hyperliquid', window: '30d', side: 'top', filter: 'any', updatedAt: 1_000 + n, sourceAt: 1_000 + n, complete: true, pending: 0, scanned: n, note: null },
      Array.from({ length: n }, (_, i) => ({
        rank: i + 1, venue: 'hyperliquid' as const, address: `0x${String(i).padStart(40, '0')}`, label: null, accountId: null,
        pnl: 1_000 - i, volume: 10, trades: 3, tradesCapped: false, winRate: 0.5, accountValue: 100, assets: ['BTC'],
      })),
    );
    store.setMeta('indexer_status', JSON.stringify({ n }));
    port.postMessage({ type: 'wrote', n });
  } else if (m.type === 'stop') {
    store.close();
    port.postMessage({ type: 'stopped' });
  }
});
port.postMessage({ type: 'ready' });
