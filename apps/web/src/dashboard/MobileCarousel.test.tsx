/**
 * The phone's trade page carousel (Chart / Order Book / Trade) as assistive tech reads it: the
 * WAI-ARIA tabs pattern, whole - each tab controls its page, each page a named tabpanel, the ticket's
 * page named "Order entry" as its desktop panel is. Before, the three pages were one unnamed stretch
 * inside the "Order book and trades" panel, and the ticket had no name at phone width (found by the
 * UI specs' phone run: e2e/ui/run.ts --viewport phone).
 *
 * Run (from apps/web): npx tsx --test src/dashboard/MobileCarousel.test.tsx
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { registerTestLoader, renderToMarkup } from '../testRender';

registerTestLoader();

test('the carousel is a tablist whose tabs control named tabpanels; the ticket\'s page is "Order entry"', async () => {
  const { MobileCarousel } = await import('./MobileCarousel');
  const html = renderToMarkup(
    createElement(MobileCarousel, {
      pages: [
        { key: 'chart', label: 'Chart', content: 'the chart' },
        { key: 'book', label: 'Order Book', content: 'the book' },
        { key: 'exec', label: 'Trade', name: 'Order entry', content: 'the ticket' },
      ],
    }),
  );
  const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].map((m) => ({ label: m[1], controls: /aria-controls="([^"]+)"/.exec(m[0])?.[1], id: /\bid="([^"]+)"/.exec(m[0])?.[1] }));
  const panels = [...html.matchAll(/<div[^>]*role="tabpanel"[^>]*>/g)].map((m) => ({ id: /\bid="([^"]+)"/.exec(m[0])?.[1], name: /aria-label="([^"]+)"/.exec(m[0])?.[1] }));
  assert.match(html, /role="tablist"/);
  assert.deepEqual(tabs.map((t) => t.label), ['Chart', 'Order Book', 'Trade']);
  assert.deepEqual(panels.map((p) => p.name), ['Chart', 'Order Book', 'Order entry'], 'each page is named; the ticket by the name it has on every screen');
  for (const [i, t] of tabs.entries()) {
    assert.ok(t.controls && t.controls === panels[i]!.id, `the ${t.label} tab controls its page (${t.controls} / ${panels[i]!.id})`);
    assert.ok(t.id && t.id !== panels[i]!.id, `the ${t.label} tab has an id of its own`);
  }
  assert.equal(new Set(panels.map((p) => p.id)).size, 3, 'every page has its own id');
});

test('the page last used in this browser is the one open from the first frame', async () => {
  const { MobileCarousel } = await import('./MobileCarousel');
  const { PAGE_KEY, carouselEnv } = await import('./carouselMemory');
  carouselEnv.storage = () => ({ getItem: (k: string) => (k === PAGE_KEY ? 'exec' : null), setItem: () => {} });
  const html = renderToMarkup(
    createElement(MobileCarousel, {
      pages: [
        { key: 'chart', label: 'Chart', content: 'the chart' },
        { key: 'book', label: 'Order Book', content: 'the book' },
        { key: 'exec', label: 'Trade', name: 'Order entry', content: 'the ticket' },
      ],
    }),
  );
  const selected = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].filter((m) => /is-active/.test(m[0])).map((m) => m[1]);
  assert.deepEqual(selected, ['Trade']);
});
