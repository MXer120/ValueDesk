import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECT_TIMEOUT_MS, SILENT_MS, SodexSocket } from './sodexSocket';

/** A socket that records what is sent and lets the test play the gateway. */
function fakeSocket() {
  const sent: any[] = [];
  const sock: any = {
    readyState: 1,
    send: (t: string) => sent.push(JSON.parse(t)),
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return { sock, sent, reply: (msg: unknown) => sock.onmessage?.({ data: JSON.stringify(msg) }) };
}

test('a wallet with no SoDEX account yet: its account subscriptions are sent again later, until one is accepted', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const f = fakeSocket();
    const errors: string[] = [];
    const s = new SodexSocket('wss://mainnet-gw.sodex.dev', 'perps', { onPush: () => {}, onAckError: (_s, m) => errors.push(m) }, () => f.sock, '0xabc');
    s.subscribe({ channel: 'accountOrderUpdate', user: '0xabc' });
    f.sock.onopen?.();
    const subscribes = () => f.sent.filter((m) => m.op === 'subscribe').length;
    const first = subscribes();
    f.reply({ op: 'subscribe', success: false, error: 'user not found' });
    assert.deepEqual(errors, ['user not found']);
    mock.timers.tick(19_000);
    assert.equal(subscribes(), first, 'not before 20 s');
    mock.timers.tick(1_000);
    assert.equal(subscribes(), first + 1, 'sent again after 20 s');
    // Still no account: the next try waits longer (40 s).
    f.reply({ op: 'subscribe', success: false, error: 'user not found' });
    mock.timers.tick(39_000);
    assert.equal(subscribes(), first + 1);
    mock.timers.tick(1_000);
    assert.equal(subscribes(), first + 2);
    // The account exists now: accepted, nothing more is scheduled.
    f.reply({ op: 'subscribe', success: true });
    mock.timers.tick(600_000);
    assert.equal(subscribes(), first + 2);
    s.close();
  } finally {
    mock.timers.reset();
  }
});

test('other refusals, and market-data connections, are not retried', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const f = fakeSocket();
    const s = new SodexSocket('wss://mainnet-gw.sodex.dev', 'perps', { onPush: () => {} }, () => f.sock);
    s.subscribe({ channel: 'trade', symbol: 'BTC-USD' } as never);
    f.sock.onopen?.();
    const n = f.sent.filter((m) => m.op === 'subscribe').length;
    f.reply({ op: 'subscribe', success: false, error: 'user not found' });
    f.reply({ op: 'subscribe', success: false, error: 'invalid symbol' });
    mock.timers.tick(600_000);
    assert.equal(f.sent.filter((m) => m.op === 'subscribe').length, n);
    s.close();
  } finally {
    mock.timers.reset();
  }
});

/** Time passing in small steps, so a timer set by another timer runs too (mock.timers runs only those due at the start of a tick). */
const step = (ms: number) => {
  for (let t = 0; t < ms; t += 250) mock.timers.tick(Math.min(250, ms - t));
};

/** A factory that hands out a new fake socket per connection and keeps them all. */
function fakeFactory(openAtOnce = true) {
  const made: ReturnType<typeof fakeSocket>[] = [];
  const factory = () => {
    const f = fakeSocket();
    f.sock.readyState = openAtOnce ? 1 : 0;
    made.push(f);
    return f.sock;
  };
  return { made, factory };
}

test('a connection that goes silent (no pong) is closed and made again, and its subscriptions sent again', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { made, factory } = fakeFactory();
    const s = new SodexSocket('wss://mainnet-gw.sodex.dev', 'perps', { onPush: () => {} }, factory);
    s.subscribe({ channel: 'l2Book', symbol: 'BTC-USD' });
    made[0]!.sock.onopen?.();
    // It pings on time, as the docs ask; the gateway answers.
    mock.timers.tick(30_000);
    assert.equal(made[0]!.sent.filter((m) => m.op === 'ping').length, 1);
    made[0]!.reply({ op: 'pong' });
    mock.timers.tick(40_000);
    assert.equal(made.length, 1, 'alive while it answers');
    // Then nothing at all comes back.
    step(SILENT_MS + 10_000); // the silence, then the reconnect's backoff
    assert.equal(made.length, 2, 'a new connection');
    made[1]!.sock.onopen?.();
    assert.deepEqual(made[1]!.sent.filter((m) => m.op === 'subscribe').map((m) => m.params), [{ channel: 'l2Book', symbol: 'BTC-USD' }]);
    s.close();
  } finally {
    mock.timers.reset();
  }
});

test('a connection that never opens is given up and tried again', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { made, factory } = fakeFactory(false);
    const s = new SodexSocket('wss://mainnet-gw.sodex.dev', 'perps', { onPush: () => {} }, factory);
    s.subscribe({ channel: 'l2Book', symbol: 'BTC-USD' });
    step(CONNECT_TIMEOUT_MS - 250);
    assert.equal(made.length, 1);
    step(1_000);
    assert.equal(made.length, 2);
    s.close();
  } finally {
    mock.timers.reset();
  }
});

test('wake(): a connection that is down tries again at once, not at the end of its backoff', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { made, factory } = fakeFactory();
    const s = new SodexSocket('wss://mainnet-gw.sodex.dev', 'perps', { onPush: () => {} }, factory);
    s.subscribe({ channel: 'l2Book', symbol: 'BTC-USD' });
    // Dropped several times: the backoff has grown to seconds.
    for (let i = 0; i < 5; i++) {
      made.at(-1)!.sock.onclose?.();
      step(10_000);
    }
    const n = made.length;
    made.at(-1)!.sock.onclose?.();
    s.wake();
    assert.equal(made.length, n + 1, 'reconnected now');
    s.close();
  } finally {
    mock.timers.reset();
  }
});
