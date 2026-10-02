// Preload for the smoke test's hosted server:  node --import ./net-guard.mjs ...
//
// Every outbound TCP connection that is not to this machine is refused before it
// leaves the process - before any DNS lookup, even. The server can answer what it
// has on disk and nothing else: it cannot read an exchange, open a trade stream
// or spend a single request of this machine's per-address budgets.
//
// WHY. A hosted API process is not a pure reader of the index file: Explore, the
// whale tape, positioning, the screener and the podium curves read the venues
// from the API process itself (apps/server/src/valuescan/*). On a machine that
// already runs a Valuescan server, a second one would double that traffic from
// the same address - SoDEX's positioning crawl alone is about 1,000 of the
// address's 1,200 weight a minute.
//
// What it refuses is appended to the file named by SMOKE_NET_GUARD_LOG (one
// "host:port" per line), so the report can say what the server would have called.
//
// LIMITS. It guards TCP made by this process (every HTTP, TLS and WebSocket client
// of Node goes through it; deploy/smoke/smoke.test.mjs tries each). It does not
// see UDP (dgram, a direct dns.resolve) or what a child process does - the
// server uses neither to reach an exchange.
import net from 'node:net';
import { appendFileSync } from 'node:fs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', '0.0.0.0', '::']);
const logFile = process.env.SMOKE_NET_GUARD_LOG;
const seen = new Set();

function destination(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0]; // net.connect() hands over its normalised [options, callback]
  if (a !== null && typeof a === 'object') return a;
  if (typeof a === 'string' && !/^\d+$/.test(a)) return { path: a };
  return { port: Number(a), host: typeof args[1] === 'string' ? args[1] : 'localhost' };
}

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const d = destination(args);
  // A pipe or a unix socket never leaves the machine. Only a non-empty string is
  // one: http(s) agents pass `path: null` with every TCP connection, on purpose
  // ("don't confuse net"), and that must NOT be mistaken for a pipe - it is how
  // every agent-made connection, the `ws` package's included, arrives here.
  if (typeof d.path === 'string' && d.path !== '') return original.apply(this, args);
  const host = String(d.host ?? 'localhost').toLowerCase();
  if (LOOPBACK.has(host)) return original.apply(this, args);
  const where = `${host}:${d.port}`;
  if (!seen.has(where)) {
    seen.add(where);
    if (logFile) {
      try { appendFileSync(logFile, where + '\n'); } catch { /* the report just lists less */ }
    }
  }
  const err = Object.assign(new Error(`smoke net-guard: outbound connection to ${where} refused`), {
    code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: host, port: d.port,
  });
  process.nextTick(() => this.destroy(err));
  return this;
};

// TLSSocket and every agent (http, https, undici's fetch and WebSocket, the `ws`
// package) connect through net.Socket.prototype.connect, so this one patch covers them.
globalThis.__smokeNetGuard = { refused: seen };
