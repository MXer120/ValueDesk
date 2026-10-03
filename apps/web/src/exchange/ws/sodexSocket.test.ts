import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SodexSocket } from './sodexSocket';

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
