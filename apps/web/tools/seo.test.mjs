import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './seo.mjs';
import { PAGES, marketPath } from '../seo/site.mjs';

const SHELL = `<!doctype html>
<html lang="en" translate="no">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <meta name="description" content="old" />
    <title>ValueDesk</title>
    <script type="module" src="/assets/index-abc.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

function fakeDist() {
  const dist = mkdtempSync(join(tmpdir(), 'seo-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), SHELL);
  writeFileSync(join(dist, 'assets', 'ibm-plex-sans-latin-400-normal-AbC123.woff2'), '');
  return dist;
}
const markets = JSON.parse(readFileSync(new URL('../seo/markets.json', import.meta.url), 'utf8')).markets;
const ldOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

test('every app page gets its own head, link card, JSON-LD and readable text; / has no canonical (it is every route\'s fallback)', () => {
  const dist = fakeDist();
  try {
    const r = run(dist, { beta: false, day: '2026-11-14' });
    assert.equal(r.pages, PAGES.length);
    for (const p of PAGES) {
      const file = p.path === '/' ? join(dist, 'index.html') : join(dist, p.path.slice(1), 'index.html');
      const html = readFileSync(file, 'utf8');
      assert.equal((html.match(/<title>/g) ?? []).length, 1, p.path);
      assert.match(html, new RegExp(`<title>${p.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</title>`));
      assert.equal((html.match(/name="description"/g) ?? []).length, 1, `${p.path}: one description`);
      assert.match(html, /<meta property="og:image" content="https:\/\/www\.valuedesk\.so\/og\/[a-z]+\.png" \/>/);
      assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
      assert.ok(existsSync(new URL(`../public/og/${p.og}.png`, import.meta.url)), `${p.path}: og/${p.og}.png exists`);
      assert.equal(html.includes('rel="canonical"'), p.path !== '/', p.path);
      assert.match(html, /<div id="root"><main class="seo-pre"><h1>/);
      assert.match(html, /<script type="module" src="\/assets\/index-abc\.js"><\/script>/, 'the app still starts');
      const [graph] = ldOf(html);
      assert.ok(graph['@graph'].some((n) => n['@type'] === 'WebApplication'));
      if (p.faq) assert.ok(graph['@graph'].some((n) => n['@type'] === 'FAQPage' && n.mainEntity.length >= 5));
      assert.ok(!/<\/script>[^<]*<\/script>/.test(html));
    }
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('a static page per SoDEX market, the markets index, sitemap and llms.txt', () => {
  const dist = fakeDist();
  try {
    const r = run(dist, { beta: false, day: '2026-11-14' });
    assert.equal(r.markets, markets.length + 1);
    const btc = readFileSync(join(dist, 'markets', 'btc', 'index.html'), 'utf8');
    assert.match(btc, /<h1>BTC-USD perpetual on SoDEX<\/h1>/);
    assert.match(btc, /href="\/trade\?symbol=BTC-USD"/);
    assert.match(btc, /href="\/bots\/new\?market=BTC-USD"/);
    assert.ok(!/<script(?![^>]*application\/ld\+json)/.test(btc), 'no app script on a market page');
    assert.ok(ldOf(btc)[0]['@graph'].some((n) => n['@type'] === 'BreadcrumbList'));
    const css = readFileSync(join(dist, 'markets', 'markets.css'), 'utf8');
    assert.match(css, /url\(\/assets\/ibm-plex-sans-latin-400-normal-AbC123\.woff2\)/, 'self-hosted font from the build, never a CDN');
    assert.ok(!/googleapis|gstatic/.test(css));
    const sm = readFileSync(join(dist, 'sitemap.xml'), 'utf8');
    for (const p of PAGES) assert.ok(sm.includes(`<loc>https://www.valuedesk.so${p.path}</loc>`), p.path);
    assert.ok(sm.includes(`<loc>https://www.valuedesk.so${marketPath('ETH')}</loc>`));
    assert.equal((sm.match(/<url>/g) ?? []).length, PAGES.length + markets.length + 1);
    const llms = readFileSync(join(dist, 'llms.txt'), 'utf8');
    assert.match(llms, /^# ValueDesk\n\n> /);
    assert.match(readFileSync(join(dist, 'llms-full.txt'), 'utf8'), /## Questions/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('the beta site is kept out of search: noindex everywhere, robots disallows all, no sitemap', () => {
  const dist = fakeDist();
  try {
    run(dist, { beta: true, day: '2026-11-14' });
    assert.match(readFileSync(join(dist, 'bots', 'index.html'), 'utf8'), /<meta name="robots" content="noindex, nofollow" \/>/);
    assert.match(readFileSync(join(dist, 'markets', 'btc', 'index.html'), 'utf8'), /noindex/);
    assert.equal(readFileSync(join(dist, 'robots.txt'), 'utf8'), 'User-agent: *\nDisallow: /\n');
    assert.ok(!existsSync(join(dist, 'sitemap.xml')));
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('the page texts state the fees the code charges (packages/copy-engine policy.ts, production.settings)', () => {
  const policy = readFileSync(new URL('../../../packages/copy-engine/src/policy.ts', import.meta.url), 'utf8');
  const ladder = (name) => {
    const body = new RegExp(`export const ${name}[^=]*= \\[([\\s\\S]*?)\\];`).exec(policy)[1];
    return [...body.matchAll(/\{ fromUsd: ([\d_]+), fee: (\d+) \}/g)].map((m) => ({ fromUsd: Number(m[1].replace(/_/g, '')), fee: Number(m[2]) }));
  };
  return import('../seo/site.mjs').then(({ FEES }) => {
    assert.deepEqual(FEES.copy, ladder('COPY_FEE_LADDER'));
    assert.deepEqual(FEES.bot, ladder('BOT_FEE_LADDER'));
    assert.match(policy, new RegExp(`COPY_FEE_WINDOW_DAYS = ${FEES.windowDays};`));
    const settings = readFileSync(new URL('../../../deploy/vercel/production.settings', import.meta.url), 'utf8');
    assert.match(settings, new RegExp(`^VITE_BUILDER_FEE_PERPS=${FEES.trade}$`, 'm'));
  });
});
