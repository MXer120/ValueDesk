import test from 'node:test';
import assert from 'node:assert/strict';
import { createHoverMenu, type HoverMenuMode } from './useHoverMenu';

function rig(hold = () => false) {
  let mode: HoverMenuMode = 'closed';
  let due: (() => void) | null = null;
  const menu = createHoverMenu({
    mode: () => mode,
    setMode: (m) => { mode = m; },
    hold,
    timers: { set: (fn) => { due = fn; return 1; }, clear: () => { due = null; } },
  });
  return {
    menu,
    mode: () => mode,
    fire: () => { const f = due; due = null; f?.(); },
    waiting: () => due !== null,
  };
}

test('a mouse opens it after the wait, and passing by opens nothing', () => {
  const r = rig();
  r.menu.enter('mouse');
  assert.equal(r.mode(), 'closed');
  r.menu.leave('mouse');
  assert.ok(!r.waiting(), 'left before the wait ended');
  r.fire();
  assert.equal(r.mode(), 'closed');
  r.menu.enter('mouse');
  r.fire();
  assert.equal(r.mode(), 'hover');
});

test('leaving closes it after the wait; coming back in time keeps it', () => {
  const r = rig();
  r.menu.enter('mouse');
  r.fire();
  r.menu.leave('mouse');
  assert.equal(r.mode(), 'hover');
  r.menu.enter('mouse');
  assert.ok(!r.waiting());
  r.menu.leave('mouse');
  r.fire();
  assert.equal(r.mode(), 'closed');
});

test('a press on what hover opened pins it, leaving keeps it, a second press closes', () => {
  const r = rig();
  r.menu.enter('mouse');
  r.fire();
  r.menu.press();
  assert.equal(r.mode(), 'pinned');
  r.menu.leave('mouse');
  assert.ok(!r.waiting());
  assert.equal(r.mode(), 'pinned');
  r.menu.press();
  assert.equal(r.mode(), 'closed');
});

test('a press before the wait ends opens once, with nothing left to fire', () => {
  const r = rig();
  r.menu.enter('mouse');
  r.menu.press();
  assert.equal(r.mode(), 'pinned');
  assert.ok(!r.waiting());
});

test('a finger or pen never hovers; a tap opens and closes', () => {
  const r = rig();
  for (const t of ['touch', 'pen']) {
    r.menu.enter(t);
    assert.ok(!r.waiting(), t);
    r.menu.leave(t);
  }
  r.menu.press();
  assert.equal(r.mode(), 'pinned');
  r.menu.leave('touch');
  assert.equal(r.mode(), 'pinned');
  r.menu.press();
  assert.equal(r.mode(), 'closed');
});

test('hold keeps it open past the wait', () => {
  let held = true;
  const r = rig(() => held);
  r.menu.enter('mouse');
  r.fire();
  r.menu.leave('mouse');
  r.fire();
  assert.equal(r.mode(), 'hover', 'its own pop-over is in use');
  held = false;
  r.menu.leave('mouse');
  r.fire();
  assert.equal(r.mode(), 'closed');
});
