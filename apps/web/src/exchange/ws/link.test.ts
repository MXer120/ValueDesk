/**
 * Cross-tab sharing without a SharedWorker (link.ts LeaderLink): two tabs,
 * a BroadcastChannel between them (Node's own) and a Web Lock (faked). One tab
 * leads and holds the only socket host; the other talks to it; when the leader
 * tab goes, the other takes over and its subscriptions come back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeaderLink, type LeaderDeps } from './link';
import { SocketHub } from './socketHub';
import type { SocketLike } from './sodexSocket';
import type { ToTab } from './messages';

const BASE = 'wss://mainnet-gw.sodex.dev';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: any[] = [];
  closed = false;
  constructor(readonly url: string, readonly hub: string) {}
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

/** Web Locks, in one process: the first requester holds the lock until its promise settles. */
function fakeLocks() {
  let held = false;
  const queue: Array<() => Promise<void>> = [];
  const run = (cb: () => Promise<void>) => {
    held = true;
    void cb().then(() => {
      held = false;
      const next = queue.shift();
      if (next) run(next);
    });
  };
  return (_name: string, cb: () => Promise<void>) => (held ? void queue.push(cb) : run(cb));
}

const settle = () => new Promise((r) => setTimeout(r, 30));
/** Wait until `cond` holds (BroadcastChannel delivery is slower on a busy machine than 30 ms). */
async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
}

test('leader election: one tab holds the sockets, the other is served over the channel, and takes over when the leader goes', async () => {
  const channelName = `vs-test-${Math.random().toString(36).slice(2)}`;
  const requestLock = fakeLocks();
  const sockets: FakeSocket[] = [];
  let hubs = 0;
  const deps = (): LeaderDeps => ({
    channel: () => new BroadcastChannel(channelName) as unknown as ReturnType<LeaderDeps['channel']>,
    requestLock,
    onPageHide: () => {},
    makeHub: () => {
      const id = `hub${++hubs}`;
      return new SocketHub({ host: 'leader', factory: (url) => {
        const s = new FakeSocket(url, id);
        sockets.push(s);
        return s;
      } });
    },
  });

  const tab1 = new LeaderLink(deps());
  const tab2 = new LeaderLink(deps());
  const got2: ToTab[] = [];
  tab2.onMessage((m) => void got2.push(m));
  try {
    await waitFor(() => tab1.state() === 'open' && tab2.state() === 'open');
    assert.equal(tab1.mode(), 'leader');
    assert.equal(tab2.mode(), 'follower');
    assert.equal(tab1.state(), 'open');
    assert.equal(tab2.state(), 'open', 'the follower was answered by the leader');

    // Both tabs want the same book: ONE socket, ONE upstream subscription.
    tab2.post({ op: 'subscribe', engine: 'perps', params: { channel: 'l2Book', symbol: 'BTC-USD' }, wsBase: BASE });
    tab1.post({ op: 'subscribe', engine: 'perps', params: { channel: 'l2Book', symbol: 'BTC-USD' }, wsBase: BASE });
    await settle();
    assert.equal(sockets.length, 1, 'one connection for both tabs');
    sockets[0]!.open();
    assert.equal(sockets[0]!.sent.filter((m) => m.op === 'subscribe').length, 1);
    sockets[0]!.push({ channel: 'l2Book', type: 'snapshot', data: { s: 'BTC-USD', b: [['1', '1']], a: [] } });
    await settle();
    assert.equal(got2.filter((m) => m.type === 'push').length, 1, 'the follower got the push');

    // The leader tab closes: the lock passes to tab 2, which becomes the host.
    tab1.close();
    assert.equal(sockets[0]!.closed, true, "the old leader's sockets go with it");
    await waitFor(() => tab2.mode() === 'leader' && tab2.state() === 'open');
    assert.equal(tab2.mode(), 'leader');
    assert.equal(tab2.state(), 'open');
    // ws.ts re-sends its subscriptions whenever the link opens again.
    tab2.post({ op: 'subscribe', engine: 'perps', params: { channel: 'l2Book', symbol: 'BTC-USD' }, wsBase: BASE });
    await settle();
    assert.equal(sockets.length, 2);
    assert.equal(sockets[1]!.hub, 'hub2', 'the new leader holds the connection now');
    sockets[1]!.open();
    sockets[1]!.push({ channel: 'l2Book', type: 'update', data: { s: 'BTC-USD', b: [['2', '1']], a: [] } });
    await settle();
    assert.equal(got2.filter((m) => m.type === 'push').length, 2, 'and the stream continues');
  } finally {
    tab1.close();
    tab2.close();
  }
});

test('leader election: a follower only hears messages addressed to it', async () => {
  const channelName = `vs-test-${Math.random().toString(36).slice(2)}`;
  const requestLock = fakeLocks();
  const sockets: FakeSocket[] = [];
  const deps = (): LeaderDeps => ({
    channel: () => new BroadcastChannel(channelName) as unknown as ReturnType<LeaderDeps['channel']>,
    requestLock,
    onPageHide: () => {},
    makeHub: () => new SocketHub({ host: 'leader', factory: (url) => {
      const s = new FakeSocket(url, 'h');
      sockets.push(s);
      return s;
    } }),
  });
  const leader = new LeaderLink(deps());
  const a = new LeaderLink(deps());
  const b = new LeaderLink(deps());
  const gotA: ToTab[] = [];
  const gotB: ToTab[] = [];
  a.onMessage((m) => void gotA.push(m));
  b.onMessage((m) => void gotB.push(m));
  try {
    await waitFor(() => a.state() === 'open' && b.state() === 'open');
    a.post({ op: 'subscribe', engine: 'perps', params: { channel: 'trade', symbols: ['BTC-USD'] }, wsBase: BASE });
    b.post({ op: 'subscribe', engine: 'perps', params: { channel: 'trade', symbols: ['ETH-USD'] }, wsBase: BASE });
    await settle();
    sockets[0]!.open();
    sockets[0]!.push({ channel: 'trade', type: 'update', data: { s: 'BTC-USD', p: '1' } });
    await settle();
    assert.equal(gotA.filter((m) => m.type === 'push').length, 1);
    assert.equal(gotB.filter((m) => m.type === 'push').length, 0, 'b asked for ETH only');
  } finally {
    leader.close();
    a.close();
    b.close();
  }
});
