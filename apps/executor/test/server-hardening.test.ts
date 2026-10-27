/**
 * The executor's HTTP layer under hostile input (server.ts): the rate-limit key of
 * an IPv6 client is its /64, the limiter's memory and work stay bounded under a
 * flood of new addresses, a flood of refused requests leaves one audit row per
 * client and window, and a request target new URL cannot read is a 400 - never an
 * unhandled rejection, which would stop the executor (main.ts).
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { ExecutorConfig } from '../src/config.ts';
import { createExecutorServer, Limiter, rateKey } from '../src/server.ts';
import type { ExecutorService } from '../src/service.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

test('rateKey: IPv4 as is, IPv4-mapped as its IPv4, IPv6 by /64', () => {
  assert.equal(rateKey('203.0.113.7'), '203.0.113.7');
  assert.equal(rateKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(rateKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(rateKey('2001:DB8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(rateKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(rateKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.notEqual(rateKey('2001:db8:1:2::1'), rateKey('2001:db8:1:3::1'));
  assert.equal(rateKey(''), 'unknown');
});

test('Limiter: the first refusal of a window is told apart; memory is capped under a flood of keys', () => {
  const l = new Limiter(2, 100);
  const t = 1_000_000;
  assert.equal(l.check('a', t), 'ok');
  assert.equal(l.check('a', t), 'ok');
  assert.equal(l.check('a', t), 'first-refusal');
  assert.equal(l.check('a', t), 'refused');
  assert.equal(l.check('a', t + 60_000), 'ok', 'a new window');
  for (let i = 0; i < 10_000; i++) l.check(`k${i}`, t + 60_000);
  assert.ok(l.size <= 100, `size ${l.size}`);
});

function fakeService() {
  const audits: Array<{ path: string; status: number }> = [];
  const svc = {
    info: () => ({ ok: true }),
    health: () => ({ ok: true }),
    audit: (r: { path: string; status: number }) => audits.push({ path: r.path, status: r.status }),
  } as unknown as ExecutorService;
  return { svc, audits };
}

const cfg = { trustEdge: true, allowedOrigins: [], originSecrets: [] } as unknown as ExecutorConfig;

/** A raw request (fetch would normalise the target). */
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on('error', reject);
    r.end();
  });
}

test('HTTP: an unreadable request target is a 400 and the executor keeps answering', async () => {
  const { svc } = fakeService();
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  let unhandled: unknown = null;
  const onUnhandled = (e: unknown) => {
    unhandled = e;
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.equal(await raw(port, '//[x]/../api/copy/v1/info'), 400);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unhandled, null, 'no unhandled rejection');
    assert.equal(await raw(port, '/api/copy/v1/info'), 200);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    server.close();
  }
});

test('HTTP: one IPv6 /64 shares one budget, and a flood of refusals is audited once per window', async () => {
  const { svc, audits } = fakeService();
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const codes: number[] = [];
    // 240 reads a minute per client: 260 requests from 260 addresses of one /64.
    for (let i = 1; i <= 260; i++) codes.push(await raw(port, '/api/copy/v1/info', { 'x-forwarded-for': `2001:db8:5:6::${i.toString(16)}` }));
    assert.equal(codes.filter((c) => c === 200).length, 240);
    assert.equal(codes.filter((c) => c === 429).length, 20);
    assert.equal(audits.filter((a) => a.status === 429).length, 1, 'one audit row for the whole flood');
    assert.equal(await raw(port, '/api/copy/v1/info', { 'x-forwarded-for': '2001:db8:5:7::1' }), 200, 'another /64 has its own budget');
  } finally {
    server.close();
  }
});
