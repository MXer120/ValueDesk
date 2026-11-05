/**
 * The owner's own place for every picture and film: a folder on this PC, never in the repo and never
 * on GitHub. Writes index.html there from whatever the folder holds, with each group from its
 * subfolders; open it by double-click. Everything shows at full size in a click.
 *
 *   node marketing/video/capture/gallery.mjs [--dir <folder>]        default ~/ValueDesk-media
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg('dir', join(homedir(), 'ValueDesk-media'));
mkdirSync(DIR, { recursive: true });

const IMAGE = /\.(png|jpe?g|webp)$/i;
const VIDEO = /\.(mp4|webm|mov)$/i;
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const files = walk(DIR).filter((f) => IMAGE.test(f) || VIDEO.test(f));

const groups = new Map();
for (const f of files) {
  const rel = relative(DIR, f).split(sep);
  const group = rel.slice(0, -1).join(' / ') || 'Other';
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(rel.join('/'));
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const size = (rel) => { const n = statSync(join(DIR, ...rel.split('/'))).size; return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`; };
const nice = (s) => s.replace(/[-_]/g, ' ');

const sections = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, list]) => `
<section>
  <h2>${esc(nice(group))} <small>${list.length}</small></h2>
  <div class="grid">${list.sort().map((rel) => {
    const name = rel.split('/').pop();
    const href = rel.split('/').map(encodeURIComponent).join('/');
    return VIDEO.test(name)
      ? `<figure class="wide"><video src="${href}" controls preload="metadata"></video><figcaption><a href="${href}">${esc(name)}</a> ${size(rel)}</figcaption></figure>`
      : `<figure><a href="${href}" data-full><img src="${href}" loading="lazy" alt="${esc(nice(name))}"></a><figcaption>${esc(nice(name.replace(IMAGE, '')))} <span>${size(rel)}</span></figcaption></figure>`;
  }).join('')}</div>
</section>`).join('');

writeFileSync(join(DIR, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ValueDesk media</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #0e0e0e; color: #f7f7f7; font: 14px/1.45 system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 28px; font-weight: 600; }
  p { margin: 0 0 28px; color: #9a9a9a; }
  h2 { margin: 36px 0 14px; font-size: 18px; font-weight: 500; text-transform: capitalize; }
  h2 small { color: #7b7b7b; font-size: 13px; font-weight: 400; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
  figure { margin: 0; border-radius: 12px; background: #1a1a1b; overflow: hidden; }
  figure.wide { grid-column: span 2; }
  img, video { display: block; width: 100%; background: #000; }
  figcaption { display: flex; justify-content: space-between; gap: 8px; padding: 8px 12px; color: #bcbcbc; font-size: 12px; }
  figcaption span { color: #7b7b7b; flex: none; }
  a { color: inherit; }
  #view { position: fixed; inset: 0; display: none; overflow: auto; background: rgba(0, 0, 0, 0.94); cursor: zoom-out; }
  #view.on { display: block; }
  #view img { width: auto; max-width: none; margin: 0 auto; background: none; }
  #view.fit img { max-width: 100vw; max-height: 100vh; margin: auto; position: absolute; inset: 0; cursor: zoom-in; }
  #hint { position: fixed; right: 16px; bottom: 14px; padding: 4px 10px; border-radius: 8px; background: #1a1a1b; color: #bcbcbc; font-size: 12px; }
</style></head><body>
<h1>ValueDesk media</h1>
<p>${files.length} files on this PC, not on GitHub. Click a picture: fits the screen; click it again: full size. Arrows move, Esc closes.</p>
${sections}
<div id="view" class="fit"><img alt=""><div id="hint"></div></div>
<script>
  const links = [...document.querySelectorAll('a[data-full]')];
  const view = document.getElementById('view'), img = view.querySelector('img'), hint = document.getElementById('hint');
  let at = -1;
  const show = (i) => { at = (i + links.length) % links.length; img.src = links[at].href; view.classList.add('on', 'fit'); hint.textContent = (at + 1) + ' / ' + links.length + '  ' + decodeURIComponent(links[at].href.split('/').pop()); };
  links.forEach((a, i) => a.addEventListener('click', (e) => { e.preventDefault(); show(i); }));
  img.addEventListener('click', (e) => { e.stopPropagation(); view.classList.toggle('fit'); });
  view.addEventListener('click', () => view.classList.remove('on'));
  addEventListener('keydown', (e) => {
    if (!view.classList.contains('on')) return;
    if (e.key === 'Escape') view.classList.remove('on');
    if (e.key === 'ArrowRight') show(at + 1);
    if (e.key === 'ArrowLeft') show(at - 1);
  });
</script>
</body></html>
`);
console.log(`${files.length} files, ${groups.size} groups -> ${join(DIR, 'index.html')}`);
