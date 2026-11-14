#!/usr/bin/env node
/**
 * Tell Bing (and the other IndexNow engines - Bing's index is also what ChatGPT search reads) that the site's pages
 * changed, after a web release (2026-11-14). Reads the LIVE sitemap, so run it once the release is live:
 *
 *   node apps/web/tools/indexnow.mjs            (--dry: list what would be sent)
 *
 * The key is public by design: IndexNow checks that https://www.valuedesk.so/<key>.txt holds it.
 */
const KEY = '4de1d59e6f6f8ae80d5ab93f6b94ff48';
const HOST = 'www.valuedesk.so';
const dry = process.argv.includes('--dry');
const xml = await (await fetch(`https://${HOST}/sitemap.xml`)).text();
const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (!urls.length) throw new Error('the live sitemap lists no page - is the release with tools/seo.mjs live?');
const keyOk = (await (await fetch(`https://${HOST}/${KEY}.txt`)).text()).trim() === KEY;
if (!keyOk) throw new Error(`https://${HOST}/${KEY}.txt does not hold the key - is public/${KEY}.txt deployed?`);
if (dry) { console.log(`${urls.length} urls, key file ok`); process.exit(0); }
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls }),
});
console.log(`IndexNow: ${urls.length} urls -> ${res.status}`);
if (res.status >= 400) process.exit(1);
