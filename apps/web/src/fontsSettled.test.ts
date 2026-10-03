import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onFontsSettled, type FontSetLike } from './fontsSettled';

function fakeFonts() {
  let resolve!: () => void;
  const listeners = new Set<() => void>();
  const fonts: FontSetLike = {
    ready: new Promise<void>((r) => { resolve = r; }),
    addEventListener: (_t, fn) => { listeners.add(fn); },
    removeEventListener: (_t, fn) => { listeners.delete(fn); },
  };
  return { fonts, ready: () => resolve(), loaded: () => listeners.forEach((fn) => fn()), listeners };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('onFontsSettled: once the fonts are ready, and again for a font that finishes later', async () => {
  const f = fakeFonts();
  let calls = 0;
  onFontsSettled(() => { calls++; }, f.fonts);
  await tick();
  assert.equal(calls, 0, 'nothing before the fonts are in');
  f.ready();
  await tick();
  assert.equal(calls, 1);
  f.loaded();
  assert.equal(calls, 2);
});

test('onFontsSettled: nothing after the unsubscribe, and the listener is removed', async () => {
  const f = fakeFonts();
  let calls = 0;
  const off = onFontsSettled(() => { calls++; }, f.fonts);
  off();
  f.ready();
  f.loaded();
  await tick();
  assert.equal(calls, 0);
  assert.equal(f.listeners.size, 0);
});

test('onFontsSettled: a browser without the font API is not an error', () => {
  assert.doesNotThrow(() => onFontsSettled(() => {}, undefined)());
  assert.doesNotThrow(() => onFontsSettled(() => {}, { ready: Promise.reject(new Error('x')) })());
});
