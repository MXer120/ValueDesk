/**
 * The palette's type-ahead: keys typed after the open shortcut and before the
 * search box has the focus all arrive, in order (performance agent's finding:
 * on a busy main thread the second key of "btc" was lost).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TypeAhead, applyTyped, type KeyLike } from './typeAhead';

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, ...mods });

/** Type `word` into the type-ahead; returns which keys were taken. */
function type(ta: TypeAhead, keys: KeyLike[]): boolean[] {
  return keys.map((e) => ta.key(e));
}

test('idle: no key is taken before an open is asked for', () => {
  const ta = new TypeAhead();
  assert.equal(ta.active, false);
  assert.deepEqual(type(ta, [k('b'), k('1'), k('Backspace')]), [false, false, false]);
});

test('Cmd/Ctrl+K, then "btc" before the box has the focus: the whole word arrives', () => {
  const ta = new TypeAhead();
  ta.begin(); // the open shortcut
  assert.deepEqual(type(ta, [k('b'), k('t'), k('c')]), [true, true, true]);
  const t = ta.take(); // the box got the focus
  assert.equal(applyTyped('', t), 'btc');
  assert.equal(ta.active, false);
  assert.equal(ta.key(k('x')), false, 'once the box has the focus, keys go to it natively');
});

test('a key that opened the palette with a seed, then the rest of the word', () => {
  // App opens the palette with the first printable key as its seed ("e");
  // "th" arrive before the focus.
  const ta = new TypeAhead();
  ta.begin();
  type(ta, [k('t'), k('h')]);
  assert.equal(applyTyped('e', ta.take()), 'eth');
});

test('page shortcuts typed into the search are taken: digits, c, /, ?, space', () => {
  const ta = new TypeAhead();
  ta.begin();
  assert.deepEqual(type(ta, [k('1'), k('c'), k('/'), k('?'), k(' ')]), [true, true, true, true, true]);
  assert.equal(applyTyped('', ta.take()), '1c/? ');
});

test('Backspace edits what was typed ahead, then the seed', () => {
  const ta = new TypeAhead();
  ta.begin();
  type(ta, [k('s'), k('o'), k('l'), k('Backspace'), k('Backspace')]);
  assert.equal(applyTyped('', ta.take()), 's');

  ta.begin();
  type(ta, [k('Backspace'), k('x')]);
  assert.equal(applyTyped('ab', ta.take()), 'ax', 'a Backspace before any typed key removes from the seed');

  ta.begin();
  type(ta, [k('Backspace'), k('Backspace'), k('Backspace')]);
  assert.equal(applyTyped('ab', ta.take()), '', 'never below empty');
});

test('not taken: modified keys, Escape, arrows, Tab, IME composition; Enter is taken and dropped', () => {
  const ta = new TypeAhead();
  ta.begin();
  assert.equal(ta.key(k('k', { ctrlKey: true })), false, 'Ctrl+K closes the palette');
  assert.equal(ta.key(k('k', { metaKey: true })), false);
  assert.equal(ta.key(k('2', { altKey: true })), false, 'Alt+2 switches the palette section');
  assert.equal(ta.key(k('Escape')), false);
  assert.equal(ta.key(k('ArrowDown')), false);
  assert.equal(ta.key(k('Tab')), false);
  assert.equal(ta.key(k('a', { isComposing: true })), false);
  assert.equal(ta.key(k('Enter')), true, 'kept from the page behind');
  assert.equal(applyTyped('', ta.take()), '');
});

test('characters outside the BMP count as one', () => {
  const ta = new TypeAhead();
  ta.begin();
  type(ta, [k('🚀'), k('a'), k('Backspace')]);
  assert.equal(applyTyped('', ta.take()), '🚀');
  assert.equal(applyTyped('x🚀', { back: 1, text: '' }), 'x');
});

test('a second open request keeps what was typed; close forgets it', () => {
  const ta = new TypeAhead();
  ta.begin();
  type(ta, [k('a')]);
  ta.begin();
  type(ta, [k('b')]);
  assert.equal(applyTyped('', ta.take()), 'ab');

  ta.begin();
  type(ta, [k('z')]);
  ta.cancel();
  assert.equal(ta.active, false);
  assert.deepEqual(ta.take(), { back: 0, text: '' });
});
