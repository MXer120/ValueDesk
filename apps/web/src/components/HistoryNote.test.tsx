import test from 'node:test';
import assert from 'node:assert/strict';
import type { WalkScope, WalkState } from '../exchange/allTime';

const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
g.window ??= Object.assign(new EventTarget(), { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });

const NOW = Date.UTC(2026, 10, 7);
const DAY = 86_400_000;
const part = (kind: WalkScope['kind'], o: Partial<WalkScope> = {}): WalkScope => ({ kind, running: false, rows: 10, oldest: NOW - 10 * DAY, complete: false, limited: false, error: null, ...o });
const state = (scopes: WalkScope[], o: Partial<WalkState> = {}): WalkState => ({ scopes, held: false, speed: 'normal', firstTradeAt: NOW - 40 * DAY, ...o });

test('every part complete: the card goes, though a read of the newest rows runs (it sat at 99% for good)', async () => {
  const { noteView } = await import('./historyNoteView');
  const all = state([part('trades-spot', { complete: true }), part('trades-perps', { complete: true, limited: true, running: true }), part('funding', { complete: true })]);
  const v = noteView(all, NOW);
  assert.equal(v.visible, false);
  assert.equal(v.pct, 100);
  assert.doesNotMatch(v.detail, /starting/, 'not "starting" once all of it is read');
});

test('a part still walking back: shown, below 100, saying how far back it is', async () => {
  const { noteView } = await import('./historyNoteView');
  const v = noteView(state([part('trades-spot', { complete: true }), part('trades-perps', { running: true, oldest: NOW - 20 * DAY }), part('funding', { complete: true })]), NOW);
  assert.equal(v.visible, true);
  assert.ok(v.pct !== null && v.pct > 0 && v.pct < 100, String(v.pct));
  assert.match(v.detail, /back to /);
});

test('paused: shown whatever is read, and it says so', async () => {
  const { noteView } = await import('./historyNoteView');
  const v = noteView(state([part('trades-spot', { complete: true }), part('trades-perps', { complete: true }), part('funding', { complete: true })], { held: true }), NOW);
  assert.equal(v.visible, true);
  assert.match(v.detail, /Resume/);
});

test('the history card is pinned at the lane end, notifications come in on its left', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./shell.css', import.meta.url), 'utf8');
  assert.match(css, /\.toasts\.is-docked \.toasts__live \{ order: 1; \}/);
  assert.match(css, /\.toasts\.is-docked > #vs-toast-pin > \* \{ order: 2; \}/);
  const card = readFileSync(new URL('./HistoryNote.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(card, /two pages of trades a minute/, 'the note under the controls is gone (owner 2026-11-07)');
});
