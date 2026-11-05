/**
 * The owner's own place for every film and picture: `desk/` at the top of this checkout, ignored by
 * git so nothing in it reaches GitHub. Writes desk/index.html from whatever the folder holds; open it
 * by double-click. What a file is comes from where it sits and how it is named:
 *
 *   desk/marketing/videos/    films for X
 *   desk/marketing/graphics/  cards for X
 *   desk/product/...          screenshots of the app; "-light-", "-dark-", "phone", "desktop" in the
 *                             path say the theme and the device
 *
 *   node marketing/video/capture/gallery.mjs [--dir <folder>]
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const DIR = resolve(arg('dir', join(HERE, '..', '..', '..', 'desk')));
mkdirSync(DIR, { recursive: true });

const IMAGE = /\.(png|jpe?g|webp)$/i;
const VIDEO = /\.(mp4|webm|mov)$/i;
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

const items = walk(DIR).filter((f) => IMAGE.test(f) || VIDEO.test(f)).map((f) => {
  const rel = relative(DIR, f).split(sep);
  const name = rel.at(-1);
  const path = rel.join('/').toLowerCase();
  const st = statSync(f);
  const bytes = st.size;
  return {
    href: rel.map(encodeURIComponent).join('/'),
    name: name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
    file: name,
    size: bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`,
    at: st.mtimeMs,
    kind: VIDEO.test(name) ? 'video' : rel[0] === 'marketing' ? 'graphic' : 'screenshot',
    area: rel[0] === 'marketing' ? 'marketing' : 'product',
    group: rel.slice(rel[0] === 'marketing' || rel[0] === 'product' ? 1 : 0, -1).filter((p) => !/^(desktop|phone)$/.test(p)).join(' / ') || 'other',
    theme: /(^|[-_/])light([-_/.]|$)/.test(path) ? 'light' : /(^|[-_/])dark([-_/.]|$)/.test(path) ? 'dark' : '',
    device: /(^|[-_/])phone([-_/.]|$)/.test(path) ? 'phone' : /(^|[-_/])desktop([-_/.]|$)/.test(path) ? 'desktop' : '',
  };
}).sort((a, b) => a.group.localeCompare(b.group) || a.file.localeCompare(b.file));

/* Everything goes into the page as data, so a double-clicked file works with no server. */
const DATA = JSON.stringify(items).replace(/</g, '\\u003c');

writeFileSync(join(DIR, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ValueDesk media</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0e0e0e; color: #f7f7f7; font: 14px/1.45 system-ui, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; padding: 18px 28px 14px; background: rgba(14, 14, 14, 0.92); backdrop-filter: blur(14px); border-bottom: 1px solid #272727; }
  h1 { margin: 0 0 12px; font-size: 20px; font-weight: 600; }
  h1 small { margin-left: 8px; color: #7b7b7b; font-size: 13px; font-weight: 400; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: #1a1a1b; }
  .seg button { height: 28px; padding: 0 12px; border: 0; border-radius: 7px; background: transparent; color: #a8a8a8; font: inherit; font-size: 13px; cursor: pointer; }
  .seg button:hover { color: #f7f7f7; }
  .seg button.on { background: #363636; color: #f7f7f7; }
  .seg button i { margin-left: 5px; color: #7b7b7b; font-style: normal; font-size: 11px; }
  input[type=search] { height: 34px; width: 200px; padding: 0 12px; border: 0; border-radius: 10px; background: #1a1a1b; color: #f7f7f7; font: inherit; font-size: 13px; }
  .size { margin-left: auto; }
  main { padding: 8px 28px 48px; }
  h2 { margin: 28px 0 12px; font-size: 15px; font-weight: 500; text-transform: capitalize; }
  h2 small { color: #7b7b7b; font-size: 12px; font-weight: 400; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--cell, 340px), 1fr)); gap: 12px; }
  figure { margin: 0; border-radius: 12px; background: #1a1a1b; overflow: hidden; }
  figure.video { grid-column: span 2; }
  img, video { display: block; width: 100%; background: #000; }
  img { cursor: zoom-in; }
  figcaption { display: flex; justify-content: space-between; gap: 8px; padding: 8px 12px; color: #bcbcbc; font-size: 12px; }
  figcaption span { color: #7b7b7b; flex: none; }
  figcaption a { color: inherit; }
  .none { padding: 60px 0; color: #7b7b7b; text-align: center; }
  #view { position: fixed; inset: 0; z-index: 5; display: none; overflow: auto; background: rgba(0, 0, 0, 0.94); cursor: zoom-out; }
  #view.on { display: block; }
  #view img { width: auto; max-width: none; margin: 0 auto; background: none; }
  #view.fit img { max-width: 100vw; max-height: 100vh; margin: auto; position: absolute; inset: 0; cursor: zoom-in; }
  #hint { position: fixed; right: 16px; bottom: 14px; padding: 4px 10px; border-radius: 8px; background: #1a1a1b; color: #bcbcbc; font-size: 12px; }
</style></head><body>
<header>
  <h1>ValueDesk media <small id="count"></small></h1>
  <div class="bar">
    <div class="seg" data-f="area"></div>
    <div class="seg" data-f="kind"></div>
    <div class="seg" data-f="theme"></div>
    <div class="seg" data-f="device"></div>
    <input type="search" id="q" placeholder="Search names…" aria-label="Search names">
    <div class="seg size" data-f="cell"></div>
  </div>
</header>
<main id="main"></main>
<div id="view" class="fit"><img alt=""><div id="hint"></div></div>
<script>
  const ITEMS = ${DATA};
  const FILTERS = {
    area: [['marketing', 'Marketing'], ['product', 'Product'], ['', 'All']],
    kind: [['', 'All kinds'], ['video', 'Videos'], ['graphic', 'Graphics'], ['screenshot', 'Screenshots']],
    theme: [['', 'Any theme'], ['dark', 'Dark'], ['light', 'Light']],
    device: [['', 'Any device'], ['desktop', 'Desktop'], ['phone', 'Phone']],
    cell: [['220', 'Small'], ['340', 'Medium'], ['560', 'Large']],
  };
  let state = { area: 'marketing', kind: '', theme: '', device: '', cell: '340', q: '' };
  try { state = { ...state, ...JSON.parse(localStorage.getItem('desk.view') || '{}'), q: '' }; } catch {}
  const main = document.getElementById('main');
  const matches = (it, skip) => Object.keys(FILTERS).every((f) => f === 'cell' || f === skip || !state[f] || it[f] === state[f])
    && (!state.q || (it.name + ' ' + it.group).toLowerCase().includes(state.q.toLowerCase()));
  function bars() {
    for (const el of document.querySelectorAll('.seg')) {
      const f = el.dataset.f;
      el.replaceChildren(...FILTERS[f].map(([v, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = state[f] === v ? 'on' : '';
        b.setAttribute('aria-pressed', String(state[f] === v));
        b.textContent = label;
        if (f !== 'cell') {
          const n = ITEMS.filter((it) => matches(it, f) && (!v || it[f] === v)).length;
          const i = document.createElement('i');
          i.textContent = n;
          b.append(i);
        }
        b.onclick = () => { state[f] = v; draw(); };
        return b;
      }));
    }
  }
  let links = [];
  function draw() {
    try { localStorage.setItem('desk.view', JSON.stringify({ ...state, q: '' })); } catch {}
    document.body.style.setProperty('--cell', state.cell + 'px');
    bars();
    const shown = ITEMS.filter((it) => matches(it));
    document.getElementById('count').textContent = shown.length + ' of ' + ITEMS.length + ' on this PC, not on GitHub';
    main.replaceChildren();
    links = shown.filter((it) => it.kind !== 'video');
    if (!shown.length) { main.innerHTML = '<p class="none">Nothing matches these filters.</p>'; return; }
    const groups = new Map();
    for (const it of shown) { if (!groups.has(it.group)) groups.set(it.group, []); groups.get(it.group).push(it); }
    for (const [group, list] of groups) {
      const h = document.createElement('h2');
      h.textContent = group + ' ';
      const small = document.createElement('small');
      small.textContent = list.length;
      h.append(small);
      const grid = document.createElement('div');
      grid.className = 'grid';
      for (const it of list) {
        const fig = document.createElement('figure');
        if (it.kind === 'video') {
          fig.className = 'video';
          const v = document.createElement('video');
          v.src = it.href + '#t=2.5'; v.controls = true; v.preload = 'metadata'; // a real frame, not the fade from black
          fig.append(v);
        } else {
          const img = document.createElement('img');
          img.src = it.href; img.loading = 'lazy'; img.alt = it.name;
          img.onclick = () => show(links.indexOf(it));
          fig.append(img);
        }
        const cap = document.createElement('figcaption');
        const a = document.createElement('a');
        a.href = it.href; a.textContent = it.name;
        const s = document.createElement('span');
        s.textContent = it.size;
        cap.append(a, s);
        fig.append(cap);
        grid.append(fig);
      }
      main.append(h, grid);
    }
  }
  const view = document.getElementById('view'), big = view.querySelector('img'), hint = document.getElementById('hint');
  let at = -1;
  function show(i) { at = (i + links.length) % links.length; big.src = links[at].href; view.classList.add('on', 'fit'); hint.textContent = (at + 1) + ' / ' + links.length + '  ' + links[at].name; }
  big.addEventListener('click', (e) => { e.stopPropagation(); view.classList.toggle('fit'); });
  view.addEventListener('click', () => view.classList.remove('on'));
  addEventListener('keydown', (e) => {
    if (!view.classList.contains('on')) return;
    if (e.key === 'Escape') view.classList.remove('on');
    if (e.key === 'ArrowRight') show(at + 1);
    if (e.key === 'ArrowLeft') show(at - 1);
  });
  document.getElementById('q').addEventListener('input', (e) => { state.q = e.target.value; draw(); });
  draw();
</script>
</body></html>
`);
console.log(`${items.length} files -> ${join(DIR, 'index.html')}`);
