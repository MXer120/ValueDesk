'use strict';
/* ===================================================================
   window.MCShell — the app shell every page shares.

   Before this, each of the ten pages hand-rolled its own buildNav() with its
   own drifted copy of the hidden-bot list (scan.js hid `sodex`, index.html did
   not), and the context menus / dock / shortcuts existed only on the fleet page.
   This owns all of it in one place:

     MCShell.nav(active, opts)   one navbar, fleet-layout aware
     MCShell.hotkey({...})       register a shortcut (shows up in the ? overlay)
     MCShell.refresh(fn)         what `R` should re-run on this page
     MCShell.search(sel)         what `/` should focus on this page
     MCShell.dock([...])         extra dock buttons for this page
     MCShell.help()              the shortcut overlay

   Loaded on every page, before that page's own script.
   =================================================================== */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  const TQ = TOKEN ? '?token=' + encodeURIComponent(TOKEN) : '';
  const HDR = TOKEN ? { 'X-Dash-Token': TOKEN } : {};
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');

  /* Only app.js (the fleet page) defined toast(), so on the other nine pages a
     shortcut that could not do anything failed silently — which reads as "the
     hotkey is broken". Provide one for every page, and defer to the page's own
     if it has a nicer one. */
  function toast(msg, kind) {
    if (window.toast && window.toast !== toast) return window.toast(msg, kind);
    let host = $('#toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toasts'; host.id = 'toasts';
      document.body.appendChild(host);
    }
    const e = document.createElement('div');
    e.className = 'toast ' + (kind || 'info');
    e.textContent = msg;
    host.appendChild(e);
    setTimeout(() => { e.style.opacity = '0'; setTimeout(() => e.remove(), 250); }, 3000);
  }

  /* ── page identity ─────────────────────────────────────────────
   * The original PAGES list linked to the other nine tools in that
   * multi-page dashboard (Fleet, Aggregator, Forensics, Feed, ...) - none of
   * which exist standalone here, so those entries would be dead links, not a
   * navbar. This IS the standalone page; it links only to itself. */
  const PAGES = [
    { key: 'scan', label: 'Scan', href: '/scan', accent: '#ffb547', go: 's' },
  ];
  const withTok = (h) => (h.indexOf('#') >= 0
    ? h.split('#')[0] + TQ + '#' + h.split('#')[1]
    : h + TQ);

  function detectPage() {
    // Valuetrade links here as `/scan/index.html`, not the bare `/scan` the
    // original dashboard's router mapped to scan.html - strip it so the
    // PAGES lookup below still matches on href.
    const p = location.pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '') || '/';
    if (p === '/' || p === '/index.html') return (location.hash === '#vps') ? 'vps' : 'fleet';
    // trade.html is served at BOTH /trade and /forensics; the nav only has a
    // Forensics tab, so /trade must light that one up rather than nothing.
    if (p === '/trade') return 'forensics';
    const hit = PAGES.find((x) => x.href.split('#')[0] === p);
    return hit ? hit.key : p.replace(/^\//, '');
  }
  const PAGE = detectPage();

  /* ── cached fleet data (nav paints instantly on the next page) ── */
  const CK = 'mc-shell-nav';
  let BOTS = [], LAYOUT = null;
  try {
    const c = JSON.parse(sessionStorage.getItem(CK) || 'null');
    if (c && Array.isArray(c.bots)) { BOTS = c.bots; LAYOUT = c.layout; }
  } catch (e) { /* ignore */ }

  async function fetchFleet() {
    const j = (p) => fetch(p, { headers: HDR }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [b, l] = await Promise.all([j('/api/bots'), j('/api/fleet/layout')]);
    if (b && b.bots) BOTS = b.bots;
    if (l && l.active) LAYOUT = l;
    try { sessionStorage.setItem(CK, JSON.stringify({ bots: BOTS, layout: LAYOUT })); } catch (e) {}
    const dot = $('#connDot'); if (dot) dot.className = 'dot ' + (b ? 'on' : 'off');
    return { bots: BOTS, layout: LAYOUT };
  }

  // Only bots the user keeps in Fleet Control get a tab. Before the layout has
  // loaded, show everything rather than flashing an empty nav.
  const navBots = () => (LAYOUT && LAYOUT.active
    ? LAYOUT.active.map((id) => BOTS.find((b) => b.id === id)).filter(Boolean)
    : BOTS);

  /* ── navbar ───────────────────────────────────────────────────── */
  let navOpts = {};
  function renderNav(active) {
    const el = $('#topnav'); if (!el) return;
    const spa = !!navOpts.spa;
    const tab = (key, label, accent, href, isBot) => {
      const on = key === active ? ' active' : '';
      const dv = (spa && (key === 'fleet' || key === 'vps' || isBot)) ? ` data-view="${esc(key)}"` : '';
      const tag = dv ? 'button' : 'a';
      const hp = dv ? '' : ` href="${esc(withTok(href))}"`;
      return `<${tag} class="nav-tab${on}"${dv}${hp} data-nav="${esc(key)}"><span class="ndot" style="background:${esc(accent)}"></span>${esc(label)}</${tag}>`;
    };
    // The original always opened on the Fleet/VPS tabs with per-bot tabs
    // alongside them; neither concept exists standalone here, so the nav is
    // just PAGES (i.e. Scan) plus whatever bots fetchFleet() finds (none,
    // since /api/bots doesn't exist in this backend - see its own comment).
    const parts = [];
    navBots().forEach((b) => parts.push(tab(b.id, b.name, b.accent, '/#' + b.id, true)));
    PAGES.forEach((p) => parts.push(tab(p.key, p.label, p.accent, p.href, false)));
    el.innerHTML = parts.join('');

    if (spa && typeof navOpts.onSelect === 'function') {
      $$('#topnav [data-view]').forEach((b) => { b.onclick = () => navOpts.onSelect(b.dataset.view); });
    }
    const at = $('#topnav .nav-tab.active');
    if (at && at.scrollIntoView) { try { at.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) {} }
    navScrollAffordance();
  }

  /* The nav is a horizontal scroller on every width; show which side has more,
     and let a plain mouse wheel move it (a trackpad can already scroll sideways,
     a wheel cannot). */
  let navWrapped = false;
  function navScrollAffordance() {
    const nv = $('#topnav'); if (!nv) return;
    let wrap = nv.parentElement;
    if (!navWrapped) {
      navWrapped = true;
      wrap = document.createElement('div');
      wrap.className = 'navwrap';
      nv.parentElement.insertBefore(wrap, nv);
      wrap.appendChild(nv);
      nv.addEventListener('scroll', update, { passive: true });
      nv.addEventListener('wheel', (e) => {
        if (e.deltaX !== 0 || Math.abs(e.deltaY) < 1) return;   // let real sideways scroll through
        if (nv.scrollWidth <= nv.clientWidth) return;
        e.preventDefault();
        nv.scrollLeft += e.deltaY;
      }, { passive: false });
      window.addEventListener('resize', update);
    }
    function update() {
      const w = nv.parentElement;
      if (!w || !w.classList.contains('navwrap')) return;
      const max = nv.scrollWidth - nv.clientWidth;
      w.classList.toggle('more-l', nv.scrollLeft > 2);
      w.classList.toggle('more-r', nv.scrollLeft < max - 2);
    }
    setTimeout(update, 0);
  }

  async function nav(active, opts) {
    navOpts = opts || {};
    const a = active || PAGE;
    renderNav(a);            // paint from cache immediately
    await fetchFleet();
    renderNav(a);            // repaint with fresh data
    return { bots: BOTS, layout: LAYOUT };
  }

  /* ── hotkey registry ──────────────────────────────────────────── */
  // {keys:'r', desc:'Refresh', run(), section:'Page', when():bool}
  const KEYS = [];
  function hotkey(spec) {
    if (!spec || !spec.keys) return;
    KEYS.push(Object.assign({ section: 'Page' }, spec));
  }
  const typing = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    || t.tagName === 'SELECT');

  let refreshFn = null, searchSel = null;
  const refresh = (fn) => { refreshFn = fn; };
  const search = (sel) => { searchSel = sel; };

  const visible = (el) => !!el && el.offsetParent !== null && !el.disabled && !el.readOnly;
  function focusSearch() {
    let el = searchSel ? $(searchSel) : null;
    // A registered input can exist but be inside a collapsed panel (forensics'
    // #symFilter lives in a closed symbol popup). Focusing it silently does
    // nothing, which reads as a dead key — fall through to autodetect instead.
    if (el && !visible(el)) el = null;
    if (!el) {
      // fall back to the page's first obvious filter box
      el = $$('input').find((i) => {
        if (!visible(i)) return false;
        const t = (i.type || '').toLowerCase();
        if (t === 'search') return true;
        const h = ((i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || '')).toLowerCase();
        return /search|filter|address|symbol|wallet|0x/.test(h);
      });
    }
    if (el) { el.focus(); if (el.select) el.select(); return true; }
    return false;
  }

  /* "g then key" chord — the fastest way between pages without the palette. */
  let chord = null, chordTimer = null, chordEl = null;
  function showChord() {
    if (!chordEl) {
      chordEl = document.createElement('div');
      chordEl.className = 'chordhint';
      document.body.appendChild(chordEl);
    }
    chordEl.innerHTML = '<kbd>g</kbd> … <span>' +
      PAGES.map((p) => p.go + '=' + p.label.toLowerCase()).join(' · ') + '</span>';
  }
  function endChord() {
    chord = null; clearTimeout(chordTimer);
    if (chordEl) { chordEl.remove(); chordEl = null; }
  }

  function navSiblings(dir) {
    const tabs = $$('#topnav .nav-tab');
    if (!tabs.length) return;
    let i = tabs.findIndex((t) => t.classList.contains('active'));
    if (i < 0) i = 0;
    const t = tabs[(i + dir + tabs.length) % tabs.length];
    if (!t) return;
    if (t.dataset.view && navOpts.onSelect) navOpts.onSelect(t.dataset.view);
    else if (t.href) location.href = t.href;
  }

  document.addEventListener('keydown', (e) => {
    // never fight a menu, the palette, or a text field
    if (window.MCMenu && window.MCMenu.isOpen()) return;
    if (document.querySelector('.cmdk-ov')) return;

    if (e.key === 'Escape') {
      if (chord) { endChord(); return; }
      const ov = $('#kbdov'); if (ov) { ov.remove(); e.preventDefault(); return; }
    }
    if (typing(e.target)) return;

    // chord: g then a page letter
    if (chord === 'g') {
      const p = PAGES.find((x) => x.go === e.key.toLowerCase());
      endChord();
      if (p) { e.preventDefault(); location.href = withTok(p.href); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'g' || e.key === 'G') {
      e.preventDefault(); chord = 'g'; showChord();
      chordTimer = setTimeout(endChord, 2000);
      return;
    }
    if (e.key === '?') { e.preventDefault(); help(); return; }
    // Fees is a floating module, not a page — F opens it anywhere.
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (window.MCFees) window.MCFees.toggle();
      else if (window.MCOpenModule) window.MCOpenModule('fees');
      return;
    }
    if (e.key === '/') { e.preventDefault(); if (!focusSearch()) toast('No filter on this page', 'info'); return; }
    if (e.key === '[') { e.preventDefault(); navSiblings(-1); return; }
    if (e.key === ']') { e.preventDefault(); navSiblings(1); return; }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      if (refreshFn) { try { refreshFn(); toast('Refreshed', 'ok'); } catch (er) { toast('✗ ' + er.message, 'err'); } }
      else location.reload();
      return;
    }
    // page-registered keys
    for (const k of KEYS) {
      if (k.keys.length !== 1) continue;
      if (e.key.toLowerCase() !== k.keys.toLowerCase()) continue;
      if (k.when && !k.when()) continue;
      e.preventDefault(); try { k.run(); } catch (er) { toast('✗ ' + er.message, 'err'); }
      return;
    }
  });

  /* ── shortcut overlay ─────────────────────────────────────────── */
  function help() {
    const old = $('#kbdov'); if (old) { old.remove(); return; }
    const ov = document.createElement('div');
    ov.className = 'kbd-ov'; ov.id = 'kbdov';
    const row = (k, d) => `<div class="k">${String(k).split('+').map((x) => `<kbd>${esc(x)}</kbd>`).join('')}</div><div class="d">${esc(d)}</div>`;
    const sections = {};
    KEYS.forEach((k) => { (sections[k.section] = sections[k.section] || []).push(k); });
    let pageRows = '';
    Object.keys(sections).forEach((s) => {
      pageRows += `<div class="kbd-sec">${esc(s)}</div>` +
        sections[s].map((k) => row(k.keys, k.desc)).join('');
    });
    ov.innerHTML = `<div class="kbd-card" role="dialog" aria-label="Keyboard shortcuts">
      <div class="panel-h"><h3>Keyboard — ${esc(PAGE)}</h3><span class="grow"></span>
        <button class="mini-btn" id="kbdx">Close</button></div>
      <div class="kbd-grid">
        <div class="kbd-sec">Everywhere</div>
        ${row('⌘+K', 'Command palette (Ctrl+K on Windows)')}
        ${row('g', 'Go to… then ' + PAGES.map((p) => p.go).join(' / '))}
        ${row('[', 'Previous tab')}
        ${row(']', 'Next tab')}
        ${row('/', 'Focus this page’s filter')}
        ${row('R', 'Refresh this page’s data')}
        ${row('F', 'Fee ladder (floating)')}
        ${row('?', 'This panel')}
        ${row('Esc', 'Close menu / overlay')}
        ${row('Right-click', 'Context menu on almost anything')}
        ${pageRows}
      </div></div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.onclick = (e) => { if (e.target === ov) close(); };
    $('#kbdx', ov).onclick = close;
  }

  /* ── floating dock ────────────────────────────────────────────── */
  const dockExtra = [];
  function dock(items) { (items || []).forEach((i) => dockExtra.push(i)); renderDock(); }
  let dockEl = null;
  function renderDock() {
    if (!dockEl) {
      dockEl = document.createElement('div');
      dockEl.className = 'dock'; dockEl.id = 'mcdock';
      document.body.appendChild(dockEl);
      if (sessionStorage.getItem('mc-dock-folded') === '1') dockEl.classList.add('folded');
    }
    const base = [
      { icon: '⌘', label: 'Palette', run: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })) },
      { icon: '↻', label: 'Refresh', run: () => (refreshFn ? refreshFn() : location.reload()) },
    ];
    const tail = [{ icon: '?', label: 'Shortcuts', run: help }];
    const all = base.concat(dockExtra, tail);
    dockEl.innerHTML =
      `<button class="dock-btn dock-toggle" data-i="fold" title="Collapse"><span class="dk-lbl">Collapse</span>⋯</button>` +
      all.map((a, i) => `<button class="dock-btn${a.danger ? ' danger' : ''}" data-i="${i}" title="${esc(a.label)}"><span class="dk-lbl">${esc(a.label)}</span>${esc(a.icon)}</button>`).join('');
    $$('.dock-btn', dockEl).forEach((b) => {
      b.onclick = () => {
        if (b.dataset.i === 'fold') {
          dockEl.classList.toggle('folded');
          sessionStorage.setItem('mc-dock-folded', dockEl.classList.contains('folded') ? '1' : '0');
          return;
        }
        const a = all[+b.dataset.i]; if (a && a.run) a.run();
      };
    });
  }

  /* ── context menus that make sense on every page ──────────────── */
  function wireGlobalMenus() {
    const navEl = $('#topnav');
    if (navEl && window.MCMenu) {
      window.MCMenu.attach(navEl, '.nav-tab', (t) => {
        const href = t.href || (location.origin + withTok('/#' + t.dataset.nav));
        return [
          { header: t.textContent.trim() },
          { label: 'Open', icon: '↗', on: () => (t.dataset.view && navOpts.onSelect ? navOpts.onSelect(t.dataset.view) : (location.href = href)) },
          { label: 'Open in new tab', icon: '⧉', href, blank: true },
          { label: 'Copy link', icon: '⧉', copy: href },
          '-',
          { label: 'Command palette', icon: '⌘', hint: '⌘K', on: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })) },
          { label: 'Keyboard shortcuts', icon: '?', hint: '?', on: help },
        ];
      });
    }
    const hdr = document.querySelector('.app-header');
    if (hdr && window.MCMenu) {
      window.MCMenu.attach(hdr, '.logo', () => PAGES.map((p) => ({
        label: p.label, icon: '›', hint: 'g ' + p.go, href: withTok(p.href),
      })));
    }
  }

  function boot() {
    // No floating dock here - Valuetrade's own navbar (see index.html) already
    // gives every page a consistent, non-floating way to reach these actions,
    // and dockExtra/renderDock stay unused rather than deleted so a future
    // page can still opt back in via MCShell.dock([...]) if it ever needs to.
    wireGlobalMenus();
    // Pages that never called nav() still get a correct navbar.
    setTimeout(() => { if ($('#topnav') && !$('#topnav .nav-tab')) nav(PAGE); }, 400);
  }
  if (!window.toast) window.toast = toast;   // pages without app.js get one

  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);

  /* ── viewport class, one source of truth ───────────────────────────
     Every page needs the same answer to "is this a phone", and the charts need
     it in JS as well as CSS: they are hand-rolled SVG with a fixed viewBox, so
     they scale down proportionally and a 10-unit label lands at under 4px on a
     375px screen. Readable type on mobile means a NARROWER viewBox, not smaller
     text — which the renderers can only do if they know. */
  const BP = { phone: 620, tablet: 900 };
  function applyViewport() {
    const w = window.innerWidth || 1200;
    const b = document.body;
    if (!b) return;
    b.classList.toggle('mc-phone', w < BP.phone);
    b.classList.toggle('mc-tablet', w >= BP.phone && w < BP.tablet);
    b.classList.toggle('mc-narrow', w < BP.tablet);
  }
  const viewport = () => {
    const w = window.innerWidth || 1200;
    return { w: w, phone: w < BP.phone, tablet: w >= BP.phone && w < BP.tablet, narrow: w < BP.tablet };
  };
  /* Chart geometry for the current viewport. A phone gets a viewBox roughly the
     width of the screen so SVG units are close to CSS pixels, and more height
     to compensate for the lost width. */
  function chartBox(desktop) {
    const v = viewport();
    if (v.phone) return { W: 380, H: Math.round((desktop.H || 320) * 1.15), S: Math.round((desktop.S || 150) * 0.42), mobile: true };
    if (v.tablet) return { W: 640, H: desktop.H || 320, S: Math.round((desktop.S || 150) * 0.68), mobile: false };
    return Object.assign({ mobile: false }, desktop);
  }
  let vpTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(vpTimer);
    vpTimer = setTimeout(() => { applyViewport(); vpListeners.forEach((f) => { try { f(viewport()); } catch (e) {} }); }, 140);
  });
  const vpListeners = [];
  const onViewport = (f) => { vpListeners.push(f); };
  if (document.readyState !== 'loading') applyViewport();
  else document.addEventListener('DOMContentLoaded', applyViewport);

  window.MCShell = {
    page: PAGE, PAGES, nav, hotkey, help, dock, refresh, search, toast,
    bots: () => BOTS, layout: () => LAYOUT, fetchFleet, withTok, renderNav,
      // the viewport helpers every chart renderer needs — defined above but
      // never exported, which left chartBox undefined and threw in every
      // renderer that asked for its geometry
      viewport, chartBox, onViewport,
  };
})();
