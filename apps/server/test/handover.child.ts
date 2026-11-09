/**
 * A real indexer process (main.ts) whose trade sockets are a fake venue's (handover.test.ts): every print the test's
 * venue broadcasts over TCP, one JSON line each, a snapshot of the last ones first - what a real venue's socket does on
 * subscribe. The test drives it with IPC: 'stop' is SIGTERM (main.ts; Windows delivers no SIGTERM to a Node handler).
 */
import net from 'node:net';
import { setSourceFactory, type Sources } from '../src/indexer/printSources.js';
import { Dedup, type Print } from '../src/indexer/streams.js';
import type { Venue } from '../src/valuedesk/types.js';

class FakeSocket {
  since: number | null = null;
  readonly dedup = new Dedup();
  private sock: net.Socket | null = null;
  constructor(private readonly venue: Venue, private readonly port: number, private readonly emit: (p: Print) => void) {}
  start(): void {
    const sock = net.connect(this.port, '127.0.0.1');
    this.sock = sock;
    let rest = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ venue: this.venue })}\n`));
    sock.on('data', (chunk: string) => {
      rest += chunk;
      let i: number;
      while ((i = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, i);
        rest = rest.slice(i + 1);
        if (!line) continue;
        const p = JSON.parse(line) as Print;
        this.since ??= Date.now();
        if (this.dedup.add(p.id, p.t)) this.emit(p);
      }
    });
    sock.on('error', () => {});
  }
  stop(): void {
    this.sock?.destroy();
    this.sock = null;
    this.since = null;
  }
}

const port = Number(process.env.VALUESCAN_FAKE_VENUE);
setSourceFactory((emit) => {
  const s = {
    hyperliquid: new FakeSocket('hyperliquid', port, emit),
    sodex: new FakeSocket('sodex', port, emit),
    lighter: null,
    arcus: null,
  };
  s.hyperliquid.start();
  s.sodex.start();
  return s as unknown as Sources;
});
process.on('message', (m) => {
  // 'stop': main.ts takes it as SIGTERM.
  if (m === 'rss') process.send?.({ rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed });
});
await import('../src/indexer/main.js');
