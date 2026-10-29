/**
 * The algo ticket from a close-only place (the US and its territories, the UK,
 * Canada - or a country the edge could not tell): it runs in this browser
 * whatever is stored, the stored choice untouched; the ValueDesk executor and
 * the self-hosted copier show as unavailable, said in one line (owner,
 * 2026-10-29: they need the copy terms, which a close-only place cannot sign).
 * An opening algo there stays refused by the order button's legal gate.
 * Run (from apps/web): npx tsx --test src/components/algo/AlgoTicket.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { registerTestLoader, renderToMarkup } from '../../testRender';

// Stylesheets and Vite's import.meta.env, for Node (testRender.ts).
registerTestLoader();

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
const g = globalThis as unknown as { window?: unknown; localStorage?: Storage };
g.localStorage = memoryStorage();

const WALLET = '0x1111111111111111111111111111111111111111';
const LINE = 'From your region, algos run in this browser and can only close or reduce positions.';

/** The ticket's first render, a closing TWAP (reduce-only), from `country` with `stored` as the kept choice. */
async function ticket(country: string | null, stored: 'hosted' | 'browser' | 'self'): Promise<string> {
  const { _resetGeoForTests } = await import('../../legal/geo');
  const { EXECUTOR_KEY } = await import('./executor');
  const { default: AlgoTicket } = await import('./AlgoTicket');
  _resetGeoForTests({ country, region: null, known: true });
  g.localStorage!.setItem(EXECUTOR_KEY, JSON.stringify(stored));
  return renderToMarkup(
    createElement(AlgoTicket, {
      kind: 'twap', symbol: 'BTC-USD', side: 'sell', quantity: '0.5', reduceOnly: true, leverage: 5, marginMode: 'cross',
      bid: 99_990, ask: 100_000, last: 100_000, address: WALLET, builderFee: 0, onState: () => {},
    }),
  );
}
const runsOf = (html: string): string | null => /title="Runs ([^.]*)\./.exec(html)?.[1] ?? null;

test('from the US, its territories, the UK and Canada the ticket runs in this browser; the stored choice stays', async () => {
  const { EXECUTOR_KEY } = await import('./executor');
  for (const country of ['US', 'PR', 'GB', 'CA']) {
    for (const stored of ['hosted', 'self'] as const) {
      assert.equal(runsOf(await ticket(country, stored)), 'in this browser', `${country}, ${stored} stored`);
      assert.equal(g.localStorage!.getItem(EXECUTOR_KEY), JSON.stringify(stored), `${country}: the stored choice is not changed`);
    }
  }
});

test('elsewhere the stored choice runs', async () => {
  assert.equal(runsOf(await ticket('DE', 'hosted')), 'on ValueDesk');
  assert.equal(runsOf(await ticket('DE', 'self')), 'on your copier');
  assert.equal(runsOf(await ticket('DE', 'browser')), 'in this browser');
});

test('a wallet that declared a close-only residence in its terms runs in this browser, wherever it connects from', async () => {
  const { _resetAcceptanceForTests, _signedTermsForTests } = await import('../../legal/acceptance');
  _resetAcceptanceForTests();
  _signedTermsForTests(WALLET, 'US');
  try {
    assert.equal(runsOf(await ticket('DE', 'hosted')), 'in this browser');
  } finally {
    // The signature is kept in this browser's storage too.
    _resetAcceptanceForTests();
    g.localStorage!.clear();
  }
  assert.equal(runsOf(await ticket('DE', 'hosted')), 'on ValueDesk');
});

test('a country the edge could not tell, treated as close-only like the order button does, runs in this browser', async () => {
  // In a browser only: outside one (no window) there is no edge to ask, and the place counts as known.
  g.window = Object.assign(new EventTarget(), { localStorage: g.localStorage, location: { search: '' } });
  try {
    assert.equal(runsOf(await ticket(null, 'hosted')), 'in this browser');
    assert.equal(runsOf(await ticket('DE', 'hosted')), 'on ValueDesk');
  } finally {
    delete g.window;
  }
});

test('there, an opening algo stays refused by the order button; one that only closes may start', async () => {
  const { _resetGeoForTests } = await import('../../legal/geo');
  const { useLegalTradeGate } = await import('../account/useTradeGate');
  const { algoClosesOnly, checkAlgoSpec } = await import('@copy-engine');
  const { DEFAULT, draftToSpec } = await import('./draft');
  _resetGeoForTests({ country: 'US', region: null, known: true });
  const shared = { symbol: 'BTC-USD', side: 'sell' as const, quantity: '0.5', leverage: 5, marginMode: 'cross' as const, bid: 99_990, ask: 100_000 };
  const closesOnly = (reduceOnly: boolean): boolean => {
    const c = checkAlgoSpec(draftToSpec('twap', DEFAULT, { ...shared, reduceOnly }, 1_800_000_000_000));
    assert.ok(c.spec, JSON.stringify(c.errors));
    return algoClosesOnly(c.spec);
  };
  assert.equal(closesOnly(true), true);
  assert.equal(closesOnly(false), false);
  // As OrderEntry asks it: opening = !algoState.closesOnly.
  const Gate = ({ opening }: { opening: boolean }) => useLegalTradeGate(WALLET, opening)?.label ?? 'may start';
  assert.equal(renderToMarkup(createElement(Gate, { opening: !closesOnly(false) })), 'Close-only here');
  assert.equal(renderToMarkup(createElement(Gate, { opening: !closesOnly(true) })), 'may start');
});

test('where only the browser may run it, ValueDesk and Self-hosted show as unavailable, said in one line', async () => {
  const { RunsOn } = await import('./AlgoTicket');
  const props = { place: 'browser' as const, onChange: () => {}, paper: false, setPaper: () => {} };
  const only = renderToMarkup(createElement(RunsOn, { ...props, onlyBrowser: true }));
  const card = (html: string, name: string) => new RegExp(`<button[^>]*>(?=<b>${name}</b>)`).exec(html)?.[0] ?? '';
  assert.match(card(only, 'ValueDesk'), / disabled/);
  assert.match(card(only, 'Self-hosted'), / disabled/);
  assert.doesNotMatch(card(only, 'This browser'), / disabled/);
  assert.match(card(only, 'This browser'), /aria-checked/);
  assert.equal(only.split(LINE).length - 1, 1, 'the line, once');

  const open = renderToMarkup(createElement(RunsOn, { ...props, place: 'hosted' }));
  assert.doesNotMatch(open, / disabled/);
  assert.equal(open.includes(LINE), false);
  assert.match(card(open, 'ValueDesk'), /aria-checked/);
});
