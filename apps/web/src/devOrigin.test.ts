import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromAppOrigin } from './devOrigin';

const PORTS = new Set([5180]);

test('the app origin gets the token, on either loopback spelling', () => {
  assert.equal(fromAppOrigin({ origin: 'http://127.0.0.1:5180' }, PORTS), true);
  assert.equal(fromAppOrigin({ origin: 'http://localhost:5180' }, PORTS), true);
  assert.equal(fromAppOrigin({ origin: 'http://[::1]:5180' }, PORTS), true);
});

test('another loopback port, scheme or host does not', () => {
  assert.equal(fromAppOrigin({ origin: 'http://127.0.0.1:3000' }, PORTS), false);
  assert.equal(fromAppOrigin({ origin: 'http://localhost:5173' }, PORTS), false);
  assert.equal(fromAppOrigin({ origin: 'https://127.0.0.1:5180' }, PORTS), false);
  assert.equal(fromAppOrigin({ origin: 'ws://127.0.0.1:5180' }, PORTS), false);
  assert.equal(fromAppOrigin({ origin: 'http://localhost.evil.example:5180' }, PORTS), false);
  assert.equal(fromAppOrigin({ origin: 'http://192.168.1.10:5180' }, PORTS), false);
  assert.equal(fromAppOrigin({ origin: 'http://127.0.0.1' }, PORTS), false);
});

test('opaque, malformed and repeated Origin headers do not', () => {
  assert.equal(fromAppOrigin({ origin: 'null' }, PORTS), false);
  assert.equal(fromAppOrigin({ origin: '' }, PORTS), false);
  assert.equal(fromAppOrigin({ origin: 'not a url' }, PORTS), false);
  assert.equal(fromAppOrigin({ origin: ['http://127.0.0.1:5180', 'http://127.0.0.1:5180'] }, PORTS), false);
});

test('no Origin: same-origin GETs and native clients do, cross-site no-cors requests do not', () => {
  assert.equal(fromAppOrigin({}, PORTS), true); // curl, the e2e tools
  assert.equal(fromAppOrigin({ 'sec-fetch-site': 'same-origin' }, PORTS), true); // the app's own GET
  assert.equal(fromAppOrigin({ 'sec-fetch-site': 'none' }, PORTS), true); // typed into the address bar
  assert.equal(fromAppOrigin({ 'sec-fetch-site': 'same-site' }, PORTS), false); // another localhost port's <img>
  assert.equal(fromAppOrigin({ 'sec-fetch-site': 'cross-site' }, PORTS), false);
});

test('the port set is the one the server actually listens on', () => {
  assert.equal(fromAppOrigin({ origin: 'http://127.0.0.1:5181' }, PORTS), false);
  assert.equal(fromAppOrigin({ origin: 'http://127.0.0.1:5181' }, new Set([5180, 5181])), true);
});
