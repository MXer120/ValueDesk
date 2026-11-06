import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerTestLoader, renderToMarkup } from '../testRender';
import { _forgetConfirmPrefs, setConfirmOn } from '../trading/confirmPrefs';

registerTestLoader();
const { createElement } = await import('react');
const { askTrade, TradeSummary } = await import('./TradeConfirm');

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  _forgetConfirmPrefs();
});

const ask = { title: 'Close', confirmLabel: 'Close at market' };

test('a kind turned off answers yes at once, without a window', async () => {
  setConfirmOn('close', false);
  // No document here: anything that tried to open a window would throw.
  assert.equal(await askTrade({ kind: 'close', ...ask }), true);
});

test('a forced question and a kind still on both try to open the window', () => {
  setConfirmOn('order', false);
  assert.throws(() => void askTrade({ kind: 'order', force: true, ...ask }), /document/);
});

test('the summary says the market, the side and each figure', () => {
  const html = renderToMarkup(
    createElement(TradeSummary, { ask: { market: 'BTC-USD', coin: 'BTC', side: { word: 'Long 10x', tone: 'pos' }, facts: [{ label: 'Size', value: '0.01 BTC' }, { label: 'PnL', value: '+$2', tone: 'pos' }], note: 'Reduce-only.' } }),
  );
  for (const want of ['BTC-USD', 'Long 10x', 'is-pos', '0.01 BTC', 'Reduce-only.']) assert.ok(html.includes(want), want);
});

test('every trade path goes through the window, and no gate reads its setting', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const account = read('./Account.tsx');
  for (const kind of ['close', 'tpsl', 'cancel', 'cancelAll', 'move']) assert.match(account, new RegExp(`kind: '${kind}'`), kind);
  assert.match(read('./OrderEntry.tsx'), /kind: 'order'/);
  const chart = read('./Chart.tsx');
  assert.match(chart, /kind: 'cancel'/);
  assert.match(chart, /kind: 'move'/);
  assert.doesNotMatch(read('../App.tsx'), /confirm\('Cancel every open order/);
});
