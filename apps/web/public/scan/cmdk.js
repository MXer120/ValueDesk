'use strict';
/* ===================================================================
   Global ⌘K / Ctrl+K command palette — shared across every page.
   Navigate (Fleet, bots, Aggregator, Scan, Feed, API) + scan a wallet
   by 0x address or by saved alias. Injects a small centered header
   trigger too. Self-contained (no deps).

   It also carries two things that must exist on EVERY page, because this
   is the only script every page already loads:
     • the /static/ui.css stylesheet (floating-module + share primitives);
     • window.MCFloat — the draggable floating-module factory.
   A module (fees today) is then a single lazy-loaded JS file that can be
   opened from any route, instead of a page you have to navigate to.
   =================================================================== */
(function () {
  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  const TQ = TOKEN ? '?token=' + encodeURIComponent(TOKEN) : '';
  const HDR = TOKEN ? { 'X-Dash-Token': TOKEN } : {};
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
  const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : (a || ''));
  const scanHref = (addr) => '/scan' + (TOKEN ? TQ + '&' : '?') + 'address=' + encodeURIComponent(addr);
  let bots = [];

  /* ═══════════════════════════════════════════════════════════════════
     SHARED CHROME — ui.css + window.MCFloat
     ═══════════════════════════════════════════════════════════════════ */

  /* ui.css is injected, not <link>ed, because ten HTML files are owned by
     different people and a floating module can be opened on any of them.
     A page that links it itself is fine — we only add it if it is absent. */
  function ensureUiCss() {
    if (document.querySelector('link[rel="stylesheet"][href*="ui.css"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/static/ui.css'; l.dataset.mcui = '1';
    document.head.appendChild(l);
  }

  /* Below 640px there is no room to float anything — ui.css docks the panel
     to the bottom as a sheet, so dragging is switched off in lockstep. */
  const smallScreen = () => window.matchMedia('(max-width:640px)').matches;

  let floatZ = 500;            // cmd+k overlay is 400; modules stack above it
  const floats = [];           // open handles, for Escape + resize re-clamping

  /* window.MCFloat.create({id,title,sub,width,onClose}) → a draggable panel.
     `id` is also the localStorage key for its position, so each module
     reopens where it was last put. Returns {root, body, bar, foot, …}; the
     caller owns everything inside .mcf-body. Other surfaces (share picker,
     later modules) are expected to reuse this rather than hand-rolling one. */
  function createFloat(opt) {
    const o = opt || {};
    const id = String(o.id || 'mod');
    const PK = 'mc-float:' + id;

    const root = document.createElement('div');
    root.className = 'mcf'; root.setAttribute('data-mcf', id);
    root.style.width = (typeof o.width === 'number' ? o.width + 'px' : (o.width || '560px'));
    root.innerHTML =
      '<div class="mcf-bar"><span class="mcf-grip"></span>'
      + '<span class="mcf-title"></span><span class="mcf-sub"></span>'
      + '<span class="mcf-spacer"></span><span class="mcf-bartools"></span>'
      + '<button class="mcf-x" type="button" title="Close (esc)">✕</button></div>'
      + '<div class="mcf-body"></div>'
      + '<div class="mcf-foot" hidden></div>';
    const bar = root.querySelector('.mcf-bar');
    const body = root.querySelector('.mcf-body');
    const foot = root.querySelector('.mcf-foot');
    root.querySelector('.mcf-title').textContent = String(o.title || '');
    root.querySelector('.mcf-sub').textContent = String(o.sub || '');
    document.body.appendChild(root);

    /* ── position: restore, else centre. Always clamped to the viewport, so a
       panel dragged to the edge of a big monitor cannot come back off-screen
       and unreachable on a small one. ── */
    function place(x, y) {
      const w = root.offsetWidth, h = root.offsetHeight;
      const maxX = Math.max(0, window.innerWidth - w);
      const maxY = Math.max(0, window.innerHeight - h);
      root.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
      root.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
    }
    function pos() { return { x: parseFloat(root.style.left) || 0, y: parseFloat(root.style.top) || 0 }; }
    function savePos() { try { localStorage.setItem(PK, JSON.stringify(pos())); } catch (e) { /* quota / private mode */ } }
    function restore() {
      let p = null;
      try { p = JSON.parse(localStorage.getItem(PK) || 'null'); } catch (e) { p = null; }
      if (p && isFinite(p.x) && isFinite(p.y)) place(p.x, p.y);
      else place((window.innerWidth - root.offsetWidth) / 2, Math.max(48, window.innerHeight * 0.10));
    }
    restore();

    /* ── drag: pointer events, so mouse / trackpad / touch are one code path.
       Controls that live in the bar keep working — we ignore drags that start
       on them, otherwise the close button would only ever start a drag. ── */
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || smallScreen()) return;
      if (e.target.closest('button,a,input,select,textarea,.mcshare')) return;
      const r = root.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, pid: e.pointerId };
      root.classList.add('dragging'); front();
      try { bar.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      place(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    function endDrag(e) {
      if (!drag || (e && e.pointerId !== drag.pid)) return;
      try { bar.releasePointerCapture(drag.pid); } catch (err) {}
      drag = null; root.classList.remove('dragging'); savePos();
    }
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
    root.addEventListener('mousedown', front);

    function front() { floatZ += 1; root.style.zIndex = String(floatZ); }
    front();

    const h = {
      id, root, bar, body, foot, front,
      setTitle(t) { root.querySelector('.mcf-title').textContent = String(t == null ? '' : t); },
      setSub(s) { root.querySelector('.mcf-sub').textContent = String(s == null ? '' : s); },
      barTools() { return root.querySelector('.mcf-bartools'); },
      showFoot(on) { foot.hidden = !on; },
      isOpen() { return !!root.parentNode; },
      reclamp() { const p = pos(); place(p.x, p.y); },
      close() {
        const i = floats.indexOf(h); if (i >= 0) floats.splice(i, 1);
        if (root.parentNode) root.parentNode.removeChild(root);
        if (typeof o.onClose === 'function') { try { o.onClose(); } catch (e) {} }
      },
    };
    root.querySelector('.mcf-x').onclick = h.close;
    floats.push(h);
    return h;
  }

  // a panel dragged to the bottom-right of a wide window must not vanish when
  // the window shrinks — re-clamp everything that is open.
  window.addEventListener('resize', () => { floats.forEach((f) => { try { f.reclamp(); } catch (e) {} }); });

  // Escape closes the top-most module — but only when the palette is not the
  // thing on screen, since the palette owns Escape while it is open.
  // defaultPrevented is the real guard: the palette's own handler is on the
  // CAPTURE phase, so by the time this one runs it has already closed itself
  // and cleared `ov` — one Escape would otherwise dismiss both.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || ov || !floats.length) return;
    const top = floats.slice().sort((a, b) => (+a.root.style.zIndex || 0) - (+b.root.style.zIndex || 0)).pop();
    if (top) { e.preventDefault(); top.close(); }
  });

  window.MCFloat = { create: createFloat, list: () => floats.slice() };

  /* ── lazy modules: one JS file each, fetched the first time it is asked for.
     Keeping them off the initial page load is the whole point of a module —
     the fees registry is not worth a request on a page nobody opened it on. ── */
  const MODULES = { fees: { src: '/static/fees.js', global: 'MCFees' } };
  function loadScript(src) {
    return new Promise((res, rej) => {
      const prev = document.querySelector('script[data-mcmod="' + src + '"]');
      if (prev) {
        if (prev.dataset.loaded === '1') return res();
        prev.addEventListener('load', () => res()); prev.addEventListener('error', rej);
        return;
      }
      const s = document.createElement('script');
      s.src = src; s.setAttribute('data-mcmod', src);
      s.onload = () => { s.dataset.loaded = '1'; res(); };
      s.onerror = () => rej(new Error('failed to load ' + src));
      document.body.appendChild(s);
    });
  }
  function openModule(name, arg) {
    const m = MODULES[name]; if (!m) return;
    const get = () => window[m.global];
    if (get()) { get().open(arg); return; }
    loadScript(m.src).then(() => {
      const M = get();
      if (M) M.open(arg);
      else console.warn('[cmdk] ' + m.src + ' loaded but window.' + m.global + ' is missing');
    }).catch((e) => console.warn('[cmdk] ' + (e && e.message)));
  }
  window.MCOpenModule = openModule;

  // The original mounted a bottom-left status bar for the OTHER bots this
  // dashboard's fleet ran (sodex/apex/katana) - there is no fleet here, so
  // there is nothing for that bar to report. Removed rather than left to
  // show three permanently-grey dots for processes that do not exist.

  function aliases() { try { return JSON.parse(localStorage.getItem('scan-aliases') || '{}') || {}; } catch (e) { return {}; } }
  function feedAssoc() { try { const x = JSON.parse(localStorage.getItem('feed-assoc') || '[]'); return Array.isArray(x) ? x : []; } catch (e) { return []; } }

  function commands(q) {
    const out = [];
    const raw = q.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(raw)) out.push({ ic: '✦', label: 'Scan ' + short(raw), sub: 'address', href: scanHref(raw), find: raw.toLowerCase() });
    else if (/^[0-9]{1,15}$/.test(raw)) out.push({ ic: '#', label: 'Account #' + raw, sub: 'resolve wallet & scan', acct: raw, find: 'account #' + raw + ' ' + raw });
    // The original palette here also listed every other page in that
    // multi-page dashboard (Fleet, Aggregator, Trade, Feed, API) and a
    // floating "Fees" module - none of which exist standalone, so those
    // entries would open dead links or silently fail to load a script this
    // port never copied. This palette now does only what THIS page can
    // actually do: jump to an address or a saved alias.
    const al = aliases();
    Object.keys(al).forEach((a) => out.push({ ic: '✦', label: al[a], sub: 'wallet · ' + short(a), href: scanHref(a), find: (al[a] + ' ' + a).toLowerCase() }));
    feedAssoc().forEach((g) => (g.addrs || []).forEach((a) => { if (!al[String(a).toLowerCase()]) out.push({ ic: '✦', label: g.name + ' · ' + short(a), sub: 'watched wallet', href: scanHref(a), find: (g.name + ' ' + a).toLowerCase() }); }));
    return out;
  }
  function filtered(q) {
    const t = q.trim().toLowerCase();
    const cmds = commands(q);
    if (!t) return cmds;
    return cmds.filter((c) => (c.find || (c.label + ' ' + c.sub).toLowerCase()).includes(t));
  }

  let ov = null, sel = 0, list = [];
  function close() { if (ov) { ov.remove(); ov = null; document.removeEventListener('keydown', navKeys, true); } }
  function paint() {
    const L = ov.querySelector('.cmdk-list');
    L.innerHTML = list.length ? list.map((c, i) =>
      `<div class="cmdk-item ${i === sel ? 'on' : ''}" data-i="${i}"><span class="cmdk-ic">${esc(c.ic || '›')}</span><span class="cmdk-lb">${esc(c.label)}</span><span class="cmdk-sub">${esc(c.sub || '')}</span></div>`).join('')
      : '<div class="cmdk-empty">No matches</div>';
    L.querySelectorAll('.cmdk-item').forEach((el) => { el.onclick = () => go(+el.dataset.i); el.onmousemove = () => { if (sel !== +el.dataset.i) { sel = +el.dataset.i; markSel(); } }; });
    markSel();
  }
  function markSel() { if (!ov) return; ov.querySelectorAll('.cmdk-item').forEach((el, i) => el.classList.toggle('on', i === sel)); const on = ov.querySelector('.cmdk-item.on'); if (on) on.scrollIntoView({ block: 'nearest' }); }
  function refresh(q) { list = filtered(q); sel = Math.min(sel, Math.max(0, list.length - 1)); paint(); }
  function go(i) {
    const c = list[i]; if (!c) return;
    if (c.acct) return resolveAndScan(c.acct);
    close();
    if (c.mod) return openModule(c.mod);      // stays on this page — opens over it
    location.href = c.href;
  }
  function resolveAndScan(id) {   // numeric account id → look up its wallet → scan
    const L = ov && ov.querySelector('.cmdk-list'); if (L) L.innerHTML = `<div class="cmdk-empty">Resolving account #${esc(id)}…</div>`;
    fetch('/api/feed/account?id=' + encodeURIComponent(id), { headers: HDR })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const addr = d && d.address;
        if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) { close(); location.href = scanHref(addr); return; }
        if (L) L.innerHTML = `<div class="cmdk-empty">Account #${esc(id)} isn’t on the public leaderboard — paste its 0x address.</div>`;
      })
      .catch(() => { if (L) L.innerHTML = `<div class="cmdk-empty">Couldn’t resolve account #${esc(id)}.</div>`; });
  }
  function navKeys(e) {
    if (!ov) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, list.length - 1); markSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); markSel(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }
  function open() {
    if (ov) return;
    ov = document.createElement('div'); ov.className = 'cmdk-ov';
    ov.innerHTML = `<div class="cmdk-box"><div class="cmdk-top"><span class="cmdk-mag">⌕</span><input class="cmdk-inp" placeholder="Search pages, bots, wallets…  (paste a 0x address)" autocomplete="off" spellcheck="false"></div><div class="cmdk-list"></div><div class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div></div>`;
    document.body.appendChild(ov);
    const inp = ov.querySelector('.cmdk-inp');
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    inp.addEventListener('input', () => { sel = 0; refresh(inp.value); });
    document.addEventListener('keydown', navKeys, true);
    sel = 0; refresh(''); setTimeout(() => inp.focus(), 20);
  }

  function injectTrigger() {
    const h = document.querySelector('.app-header');
    if (!h || h.querySelector('.cmdk-trigger')) return;
    const b = document.createElement('button');
    b.className = 'cmdk-trigger'; b.type = 'button';
    b.innerHTML = '<span class="cmdk-mag">⌕</span><span class="cmdk-lbl">Search</span><kbd>⌘K</kbd>';
    b.onclick = open;
    h.appendChild(b);   // completely to the right — always the last header item
  }

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); ov ? close() : open(); }
  });
  function boot() { ensureUiCss(); injectTrigger(); }
  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
