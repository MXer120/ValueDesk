#!/usr/bin/env node
/**
 * SEO AFTER THE BUILD (2026-11-14, owner: "full seo optimization for search engines, llms ... the preview images").
 * Static files only - nothing here runs on a request, so it costs no Vercel function time.
 *
 *   node tools/seo.mjs [dist]          (apps/web's build runs it after vite build)
 *
 * Writes into dist:
 *   - every app page of seo/site.mjs as <path>/index.html: the shell with that page's title, description, canonical,
 *     link card (og/twitter), JSON-LD, and the page's text inside #root - what a crawler or a chat's fetcher reads
 *     without running JavaScript; React replaces it on mount. Vercel serves dist/x/index.html for /x before the SPA
 *     fallback (deploy/vercel/package.mjs, `handle: filesystem`).
 *   - index.html (/ and the fallback of every other route): the home page's head, no canonical (it also answers
 *     /bots/<id>, the legal pages ...).
 *   - /markets and /markets/<coin>: plain pages, no app script - one per SoDEX perps market in seo/markets.json.
 *   - sitemap.xml, llms.txt (the short map for language models, llmstxt.org) and llms-full.txt.
 * The beta channel (VITE_CHANNEL=beta) gets noindex on every page and a robots.txt that disallows everything.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAQ, FEES, GUIDES, NAME, ORIGIN, PAGES, SUMMARY, guidePath, marketPath } from '../seo/site.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** JSON inside <script type="application/ld+json">: no "</" can close the element early. */
const ld = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

const OG = { width: 1200, height: 630 };

export function headTags(p, { beta = false, canonical = true } = {}) {
  const url = `${ORIGIN}${p.path}`;
  const image = `${ORIGIN}/og/${p.og}.png`;
  const tags = [
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.description)}" />`,
    beta ? '<meta name="robots" content="noindex, nofollow" />' : '<meta name="robots" content="index, follow, max-image-preview:large" />',
    canonical ? `<link rel="canonical" href="${esc(url)}" />` : '',
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${NAME}" />`,
    `<meta property="og:title" content="${esc(p.title)}" />`,
    `<meta property="og:description" content="${esc(p.description)}" />`,
    canonical ? `<meta property="og:url" content="${esc(url)}" />` : '',
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:image:width" content="${OG.width}" />`,
    `<meta property="og:image:height" content="${OG.height}" />`,
    `<meta property="og:image:alt" content="${esc(p.h1)} - ${NAME}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(p.title)}" />`,
    `<meta name="twitter:description" content="${esc(p.description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
    '<link rel="manifest" href="/manifest.webmanifest" />',
  ];
  return tags.filter(Boolean).join('\n    ');
}

export function jsonLd(p) {
  const graph = [
    { '@type': 'WebSite', '@id': `${ORIGIN}/#site`, url: `${ORIGIN}/`, name: NAME, description: SUMMARY },
    { '@type': 'Organization', '@id': `${ORIGIN}/#org`, name: NAME, url: `${ORIGIN}/`, logo: `${ORIGIN}/apple-touch-icon.png` },
    {
      '@type': 'WebApplication', '@id': `${ORIGIN}/#app`, name: NAME, url: `${ORIGIN}/trade`, applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web browser', description: SUMMARY, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
    { '@type': 'WebPage', '@id': `${ORIGIN}${p.path}#page`, url: `${ORIGIN}${p.path}`, name: p.title, description: p.description, isPartOf: { '@id': `${ORIGIN}/#site` } },
  ];
  if (p.faq) {
    graph.push({
      '@type': 'FAQPage', '@id': `${ORIGIN}${p.path}#faq`,
      mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    });
  }
  return `<script type="application/ld+json">${ld({ '@context': 'https://schema.org', '@graph': graph })}</script>`;
}

/** What #root holds until React mounts: the page's words and links to the rest, in the app's own type. */
export function bodyText(p) {
  const links = PAGES.filter((q) => q.path !== p.path && q.path !== '/').map((q) => `<a href="${q.path}">${esc(q.h1)}</a>`).concat('<a href="/markets">Markets</a>', '<a href="/learn">Guides</a>');
  const faq = p.faq ? `<h2>Questions</h2>${FAQ.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('')}` : '';
  return `<main class="seo-pre"><h1>${esc(p.h1)}</h1>${p.text.map((t) => `<p>${esc(t)}</p>`).join('')}${faq}<nav>${links.join(' · ')}</nav></main>`;
}

export function pageHtml(shell, p, o = {}) {
  let html = shell
    .replace(/<meta name="description"[^>]*\/>\s*/, '')
    .replace(/<title>[^<]*<\/title>/, `${headTags(p, o)}\n    ${jsonLd(p)}`);
  if (!html.includes('<div id="root"></div>')) throw new Error('seo: the shell has no empty #root');
  html = html.replace('<div id="root"></div>', `<div id="root">${bodyText(p)}</div>`);
  return html;
}

// --- the market pages: plain HTML, no app script ------------------------------------------------------------------

const pct = (x) => `${(x * 100).toLocaleString('en-US', { maximumFractionDigits: 3 })}%`;

function findFont(dist, re) {
  const dir = join(dist, 'assets');
  const f = existsSync(dir) ? readdirSync(dir).find((n) => re.test(n)) : null;
  return f ? `/assets/${f}` : null;
}

export function marketCss(dist) {
  const faces = [
    ['IBM Plex Sans', 400, /^ibm-plex-sans-latin-400-normal.*\.woff2$/],
    ['IBM Plex Sans', 500, /^ibm-plex-sans-latin-500-normal.*\.woff2$/],
    ['Space Grotesk', 600, /^space-grotesk-latin-600-normal.*\.woff2$/],
    ['Asap', 400, /^asap-latin-400-normal.*\.woff2$/],
  ].map(([family, weight, re]) => {
    const src = findFont(dist, re);
    return src ? `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:swap;src:url(${src}) format('woff2')}` : '';
  });
  return `${faces.join('')}
:root{color-scheme:dark;--bg:#0e0e0e;--panel:#161616;--line:rgba(255,255,255,.09);--text:#f2f2f0;--dim:#a3a3a0;--pos:#00b481}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:400 16px/1.6 'IBM Plex Sans',system-ui,sans-serif}
a{color:inherit}.wrap{max-width:960px;margin:0 auto;padding:28px 16px 64px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px}.top a{text-decoration:none}
.brand{display:flex;align-items:center;gap:10px;font:600 20px 'Space Grotesk',sans-serif;letter-spacing:-.02em}
h1{font:600 clamp(30px,6vw,46px)/1.08 'Space Grotesk',sans-serif;letter-spacing:-.03em;margin:48px 0 14px}
h2{font:600 22px 'Space Grotesk',sans-serif;letter-spacing:-.02em;margin:40px 0 12px}
p{color:var(--dim);max-width:680px}.num{font-family:'Asap',sans-serif;color:var(--text)}
.ctas{display:flex;flex-wrap:wrap;gap:10px;margin:26px 0}
.btn{display:inline-flex;align-items:center;height:42px;padding:0 18px;border-radius:999px;font-weight:500;text-decoration:none;border:1px solid var(--line)}
.btn.main{background:var(--text);color:#0b0b0b;border-color:transparent}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}
.fact{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.fact span{display:block;font-size:13px;color:var(--dim)}.fact b{font:400 20px 'Asap',sans-serif}
.list{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;padding:0;list-style:none}
.list a{display:block;padding:10px 12px;border-radius:10px;background:var(--panel);border:1px solid var(--line);text-decoration:none;font-family:'Asap',sans-serif}
.list a:hover,.btn:hover{border-color:rgba(255,255,255,.28)}
ol,ul:not(.list){color:var(--dim);padding-left:22px;max-width:680px}li{margin:6px 0}
footer{margin-top:56px;font-size:13px;color:var(--dim)}footer a{color:var(--dim)}
`;
}

const MARK = '<svg width="26" height="20" viewBox="0 0 26 20" aria-hidden="true"><rect x="0" y="0" width="5" height="5" rx="1.35" fill="#f2f2f0"/><rect x="21" y="0" width="5" height="5" rx="1.35" fill="#f2f2f0"/><rect x="5.5" y="7.5" width="5" height="5" rx="1.35" fill="#f2f2f0"/><rect x="15.5" y="7.5" width="5" height="5" rx="1.35" fill="#f2f2f0"/><rect x="10.5" y="15" width="5" height="5" rx="1.35" fill="#00b481"/></svg>';

function staticPage({ path, title, description, h1, body, beta, ldExtra = [], og = 'markets' }) {
  const p = { path, title, description, og, h1 };
  const graph = { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', url: `${ORIGIN}${path}`, name: title, description, isPartOf: { '@id': `${ORIGIN}/#site` } }, ...ldExtra] };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/markets/markets.css" />
    ${headTags(p, { beta })}
    <script type="application/ld+json">${ld(graph)}</script>
  </head>
  <body>
    <div class="wrap">
      <header class="top"><a class="brand" href="/">${MARK}<span>${NAME}</span></a><a class="btn" href="/trade">Open the desk</a></header>
      ${body}
      <footer>${NAME} is non-custodial: you trade from your own SoDEX account. Trading perpetual futures carries a high risk of loss. <a href="/risk">Risk</a> · <a href="/terms">Terms</a> · <a href="/impressum">Impressum</a></footer>
    </div>
  </body>
</html>
`;
}

export function marketPages(data, { beta = false } = {}) {
  const asOf = data.asOf;
  const out = new Map();
  for (const m of data.markets) {
    const coin = m.base;
    const path = marketPath(coin);
    const facts = [
      m.maxLeverage ? ['Max leverage on SoDEX', `${m.maxLeverage}x`] : null,
      m.minNotional ? ['Smallest order', `$${m.minNotional}`] : null,
      ['Price step', m.tickSize],
      m.fundingHours ? ['Funding', `every ${m.fundingHours === 1 ? 'hour' : `${m.fundingHours} hours`}`] : null,
      ['SoDEX maker / taker fee', `${pct(m.makerFee)} / ${pct(m.takerFee)}`],
    ].filter(Boolean);
    const body = `
      <h1>${esc(m.name)} perpetual on SoDEX</h1>
      <p>Trade ${esc(coin)} perpetual futures on SoDEX from ${NAME}: a chart with the liquidation heatmap, the live order book, the trade flow of every candle, and take-profit and stop-loss on every order - from your own account.</p>
      <div class="ctas"><a class="btn main" href="/trade?symbol=${encodeURIComponent(m.name)}">Trade ${esc(m.name)}</a><a class="btn" href="/bots/new?market=${encodeURIComponent(m.name)}">Run a bot on ${esc(coin)}</a></div>
      <div class="facts">${facts.map(([k, v]) => `<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
      <p>Market details as SoDEX listed them on <span class="num">${esc(asOf)}</span>. ${NAME} adds a builder fee of ${FEES.trade / 10} bp to orders placed through it.</p>
      <h2>Work ${esc(coin)} orders your way</h2>
      <p>Split a large ${esc(coin)} order with TWAP, VWAP, Iceberg or Scale, set a trailing stop or a bracket, or run a market-making or grid bot that rests on the book around the clock.</p>
      <h2>How to trade ${esc(coin)} on SoDEX with ${NAME}</h2>
      <ol>${HOW_TO(m.name).map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
      <p><a href="/markets">All SoDEX markets</a> · <a href="/learn/liquidation-heatmap">How to read a liquidation heatmap</a> · <a href="/learn/sodex-builder-fee">Fees explained</a></p>`;
    out.set(path, staticPage({
      path, beta, h1: `${m.name} perpetual on SoDEX`,
      title: `${m.name} perp on SoDEX: liquidation heatmap, chart and bots - ${NAME}`,
      description: `Trade ${coin} perpetual futures on SoDEX with a liquidation heatmap, order book, TP/SL, algo orders and bots.${m.maxLeverage ? ` Up to ${m.maxLeverage}x leverage.` : ''}`,
      body,
      ldExtra: [{ '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Markets', item: `${ORIGIN}/markets` },
        { '@type': 'ListItem', position: 2, name: m.name, item: `${ORIGIN}${path}` },
      ] }, howTo(`How to trade ${m.name} on SoDEX`, HOW_TO(m.name))],
    }));
  }
  const list = data.markets.map((m) => `<li><a href="${marketPath(m.base)}">${esc(m.name)}</a></li>`).join('');
  out.set('/markets', staticPage({
    path: '/markets', beta, h1: 'SoDEX perpetual markets',
    title: `All SoDEX perpetual markets - ${NAME}`,
    description: `The ${data.markets.length} perpetual futures markets SoDEX lists - crypto, stocks, indices and commodities - each with its liquidation heatmap, order book and bots on ${NAME}.`,
    body: `<h1>SoDEX perpetual markets</h1><p>The ${data.markets.length} perpetual futures markets SoDEX listed on <span class="num">${esc(asOf)}</span>. Open one to trade it with the liquidation heatmap, order book and algo orders, or run a bot on it.</p><ul class="list">${list}</ul>`,
  }));
  return out;
}

const HOW_TO = (sym) => [
  'Connect your wallet on ValueDesk and accept the terms.',
  'Deposit USDC into your SoDEX account.',
  'Enable trading: approve a trading key for your SoDEX account in your wallet.',
  `Open ${sym} on the Trade page, set size, leverage and take-profit / stop-loss, and place the order.`,
];
const howTo = (name, steps) => ({ '@type': 'HowTo', name, step: steps.map((t, i) => ({ '@type': 'HowToStep', position: i + 1, text: t })) });

export function guidePages({ beta = false, day } = {}) {
  const out = new Map();
  for (const g of GUIDES) {
    const path = guidePath(g.slug);
    const others = GUIDES.filter((x) => x !== g).map((x) => `<li><a href="${guidePath(x.slug)}">${esc(x.h1)}</a></li>`).join('');
    const body = `
      <h1>${esc(g.h1)}</h1>
      ${g.text.map((t) => `<p>${esc(t)}</p>`).join('')}
      ${g.steps ? `<h2>Step by step</h2><ol>${g.steps.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>` : ''}
      <div class="ctas"><a class="btn main" href="${g.cta[0]}">${esc(g.cta[1])}</a></div>
      <h2>More guides</h2><ul>${others}</ul>`;
    const ldExtra = [{ '@type': 'Article', headline: g.h1, description: g.description, ...(day ? { dateModified: day } : {}), author: { '@type': 'Organization', name: NAME }, publisher: { '@id': `${ORIGIN}/#org` }, mainEntityOfPage: `${ORIGIN}${path}` }];
    if (g.steps) ldExtra.push(howTo(g.h1, g.steps));
    out.set(path, staticPage({ path, beta, title: g.title, description: g.description, h1: g.h1, body, ldExtra, og: 'home' }));
  }
  out.set('/learn', staticPage({
    path: '/learn', beta, og: 'home', h1: 'Guides',
    title: `Guides: liquidation heatmaps, copy trading, builder fees, algo orders, bots - ${NAME}`,
    description: 'Short guides to reading a liquidation heatmap, copy trading on SoDEX, builder fees, algo orders and market-making bots.',
    body: `<h1>Guides</h1><p>Short answers to what traders ask about ${NAME} and SoDEX.</p><ul>${GUIDES.map((g) => `<li><a href="${guidePath(g.slug)}">${esc(g.h1)}</a> - ${esc(g.description)}</li>`).join('')}</ul>`,
  }));
  return out;
}

// --- sitemap and the files for language models ---------------------------------------------------------------------

export function sitemap(paths, day) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${ORIGIN}${p === '/' ? '/' : p}</loc><lastmod>${day}</lastmod></url>`).join('\n')}
</urlset>
`;
}

export function llmsTxt(markets) {
  const pages = PAGES.map((p) => `- [${p.h1}](${ORIGIN}${p.path === '/' ? '/' : p.path}): ${p.description}`).join('\n');
  return `# ${NAME}

> ${SUMMARY}

${NAME} is non-custodial: orders are placed in the user's own SoDEX account. It has no subscription; a builder fee is added to orders placed through it (see Fees in ${ORIGIN}/llms-full.txt).

## Pages

${pages}
- [SoDEX markets](${ORIGIN}/markets): the ${markets.length} SoDEX perpetual markets, one page each.

## Guides

${GUIDES.map((g) => `- [${g.h1}](${ORIGIN}${guidePath(g.slug)}): ${g.description}`).join('\n')}

## Optional

- [Full text for language models](${ORIGIN}/llms-full.txt)
- [Terms](${ORIGIN}/terms), [Risk](${ORIGIN}/risk), [Status](${ORIGIN}/status)
`;
}

export function llmsFull(markets) {
  const sections = PAGES.map((p) => `## ${p.h1}\n\nURL: ${ORIGIN}${p.path === '/' ? '/' : p.path}\n\n${p.text.join('\n\n')}`).join('\n\n');
  const faq = FAQ.map(([q, a]) => `### ${q}\n\n${a}`).join('\n\n');
  const guides = GUIDES.map((g) => {
    const steps = g.steps ? `\n\n${g.steps.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : '';
    return `## ${g.h1}\n\nURL: ${ORIGIN}${guidePath(g.slug)}\n\n${g.text.join('\n\n')}${steps}`;
  }).join('\n\n');
  return `# ${NAME} - full text

> ${SUMMARY}

${sections}

## Questions

${faq}

${guides}

## Markets

SoDEX perpetual markets, each with a page at ${ORIGIN}/markets/<coin>: ${markets.map((m) => m.name).join(', ')}.
`;
}

// --- the build step -----------------------------------------------------------------------------------------------

export function run(dist, { beta = process.env.VITE_CHANNEL === 'beta', day = new Date().toISOString().slice(0, 10) } = {}) {
  const shellPath = join(dist, 'index.html');
  const shell = readFileSync(shellPath, 'utf8');
  const markets = JSON.parse(readFileSync(join(web, 'seo', 'markets.json'), 'utf8'));
  const write = (rel, text) => {
    const file = join(dist, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  for (const p of PAGES) {
    if (p.path === '/') write('index.html', pageHtml(shell, p, { beta, canonical: false }));
    else write(join(p.path.slice(1), 'index.html'), pageHtml(shell, p, { beta }));
  }
  write(join('markets', 'markets.css'), marketCss(dist));
  const mp = marketPages(markets, { beta });
  for (const [path, html] of mp) write(join(path.slice(1), 'index.html'), html);
  const gp = guidePages({ beta, day });
  for (const [path, html] of gp) write(join(path.slice(1), 'index.html'), html);
  if (beta) {
    write('robots.txt', 'User-agent: *\nDisallow: /\n');
  } else {
    write('sitemap.xml', sitemap([...PAGES.map((p) => p.path), ...mp.keys(), ...gp.keys()], day));
    write('llms.txt', llmsTxt(markets.markets));
    write('llms-full.txt', llmsFull(markets.markets));
  }
  return { pages: PAGES.length, markets: mp.size, guides: gp.size, beta };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? join(web, 'dist'));
  const r = run(dist);
  console.log(`seo: ${r.pages} app pages, ${r.markets} market pages${r.beta ? ' (beta: noindex)' : ', sitemap.xml, llms.txt'}`);
}
