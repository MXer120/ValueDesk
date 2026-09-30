'use strict';
/* ===================================================================
   window.MCMenu — right-click / long-press context menus.

   Desktop apps let you right-click the thing you mean instead of hunting
   for the button that acts on it. This is that, for every page here:

     MCMenu.open({x, y, items})                  // open at a point
     MCMenu.attach(root, selector, itemsFn)      // delegated contextmenu
     MCMenu.close()

   `items` is an array of:
     {label, on, icon, hint, danger, disabled, checked, sub:[…], href, copy}
     '-'  → separator
     {header:'Text'} → section label

   `sub` opens a nested menu; `href` navigates (new tab if `blank`); `copy`
   writes the string to the clipboard and toasts. An item may set `keep:true`
   to leave the menu open (used by the toggles).

   Behaviour that makes it feel native rather than like a styled <div>:
     • flips against the viewport edges instead of overflowing;
     • full keyboard model (↑ ↓ Home End Enter Esc, ← → for submenus);
     • long-press opens it on touch, with the browser's own callout suppressed;
     • closes on outside-click, scroll, resize, blur and Escape;
     • focus returns to whatever opened it.
   Self-contained: no deps, styles live in fleet.css.
   =================================================================== */
(function () {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');

  let stack = [];          // open menu elements, outermost first
  let opener = null;       // element focus returns to
  let subTimer = null;

  const toast = (m, k) => (window.toast ? window.toast(m, k) : void 0);

  function close() {
    stack.forEach((el) => el.remove());
    stack = [];
    clearTimeout(subTimer);
    document.removeEventListener('keydown', onKey, true);
    if (opener && opener.focus) { try { opener.focus({ preventScroll: true }); } catch (e) {} }
    opener = null;
  }

  function closeFrom(depth) {
    while (stack.length > depth) stack.pop().remove();
  }

  async function runCopy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'ok');
    } catch (e) {
      // clipboard API needs a secure context; the dashboard is often plain-HTTP
      // over Tailscale, so fall back rather than silently doing nothing.
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      toast(ok ? 'Copied' : 'Copy failed — select manually', ok ? 'ok' : 'err');
    }
  }

  function itemHTML(it, i) {
    if (it === '-' || it === null) return '<div class="mcm-sep" role="separator"></div>';
    if (it.header) return `<div class="mcm-header">${esc(it.header)}</div>`;
    const cls = ['mcm-item'];
    if (it.danger) cls.push('danger');
    if (it.disabled) cls.push('disabled');
    if (it.checked) cls.push('checked');
    const hint = it.sub ? '<span class="mcm-caret">›</span>'
      : (it.hint ? `<span class="mcm-hint">${esc(it.hint)}</span>` : '');
    return `<div class="${cls.join(' ')}" role="menuitem" tabindex="-1" data-i="${i}"
      ${it.disabled ? 'aria-disabled="true"' : ''} ${it.sub ? 'aria-haspopup="true"' : ''}>
      <span class="mcm-ic">${it.checked ? '✓' : esc(it.icon || '')}</span>
      <span class="mcm-lbl">${esc(it.label || '')}</span>${hint}</div>`;
  }

  /* Place at (x,y), flipping instead of overflowing. `anchorRect` (a submenu's
     parent item) makes the child open beside its row, not under the cursor. */
  function place(el, x, y, anchorRect) {
    const m = 6;
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = x, top = y;
    if (anchorRect) {
      left = anchorRect.right - 2;
      top = anchorRect.top - 5;
      if (left + w > vw - m) left = anchorRect.left - w + 2;   // flip to the left side
    } else if (left + w > vw - m) {
      left = x - w;
    }
    if (top + h > vh - m) top = Math.max(m, (anchorRect ? vh - h - m : y - h));
    el.style.left = Math.max(m, Math.min(left, vw - w - m)) + 'px';
    el.style.top = Math.max(m, Math.min(top, vh - h - m)) + 'px';
  }

  function render(items, x, y, depth, anchorRect) {
    closeFrom(depth);
    const el = document.createElement('div');
    el.className = 'mcm' + (depth ? ' mcm-sub' : '');
    el.setAttribute('role', 'menu');
    el.innerHTML = items.map(itemHTML).join('');
    document.body.appendChild(el);
    place(el, x, y, anchorRect);
    stack.push(el);

    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.querySelectorAll('.mcm-item').forEach((row) => {
      const it = items[+row.dataset.i];
      row.addEventListener('mouseenter', () => {
        clearTimeout(subTimer);
        el.querySelectorAll('.mcm-item.hot').forEach((r) => r.classList.remove('hot'));
        row.classList.add('hot');
        if (it.disabled) return;
        // a hover onto a non-sub row must retract an open submenu, else two
        // branches look active at once
        subTimer = setTimeout(() => {
          if (it.sub && it.sub.length) render(it.sub, 0, 0, depth + 1, row.getBoundingClientRect());
          else closeFrom(depth + 1);
        }, it.sub ? 90 : 140);
      });
      row.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (it.disabled) return;
        if (it.sub) { clearTimeout(subTimer); render(it.sub, 0, 0, depth + 1, row.getBoundingClientRect()); return; }
        activate(it);
      });
    });
    return el;
  }

  function activate(it) {
    const keep = !!it.keep;
    if (!keep) close();
    try {
      if (it.copy != null) runCopy(String(it.copy));
      else if (it.href) { if (it.blank) window.open(it.href, '_blank', 'noopener'); else location.href = it.href; }
      else if (typeof it.on === 'function') it.on();
    } catch (e) { toast('✗ ' + (e && e.message ? e.message : e), 'err'); }
  }

  function rows(el) { return Array.from(el.querySelectorAll('.mcm-item:not(.disabled)')); }

  function onKey(e) {
    if (!stack.length) return;
    const el = stack[stack.length - 1];
    const rs = rows(el);
    const cur = rs.findIndex((r) => r.classList.contains('hot'));
    const focus = (i) => {
      rs.forEach((r) => r.classList.remove('hot'));
      const r = rs[(i + rs.length) % rs.length];
      if (r) { r.classList.add('hot'); r.scrollIntoView({ block: 'nearest' }); }
    };
    const K = e.key;
    if (K === 'Escape') { e.preventDefault(); e.stopPropagation(); stack.length > 1 ? closeFrom(stack.length - 1) : close(); return; }
    if (K === 'ArrowDown') { e.preventDefault(); focus(cur + 1); return; }
    if (K === 'ArrowUp') { e.preventDefault(); focus(cur - 1); return; }
    if (K === 'Home') { e.preventDefault(); focus(0); return; }
    if (K === 'End') { e.preventDefault(); focus(rs.length - 1); return; }
    if (K === 'ArrowLeft' && stack.length > 1) { e.preventDefault(); closeFrom(stack.length - 1); return; }
    if (K === 'ArrowRight' || K === 'Enter' || K === ' ') {
      const r = rs[cur]; if (!r) return;
      e.preventDefault(); r.click();
    }
  }

  function open(opt) {
    const items = (opt.items || []).filter(Boolean);
    if (!items.length) return;
    close();
    opener = opt.opener || document.activeElement;
    render(items, opt.x || 0, opt.y || 0, 0, null);
    document.addEventListener('keydown', onKey, true);
  }

  document.addEventListener('mousedown', () => { if (stack.length) close(); });
  window.addEventListener('resize', () => { if (stack.length) close(); });
  window.addEventListener('blur', () => { if (stack.length) close(); });
  document.addEventListener('scroll', () => { if (stack.length) close(); }, true);

  /* Delegated attach. `itemsFn(targetEl, event)` returns the item list, so the
     menu is always built from the row you actually clicked. */
  function attach(root, selector, itemsFn) {
    root.addEventListener('contextmenu', (e) => {
      const t = e.target.closest(selector);
      if (!t || !root.contains(t)) return;
      const items = itemsFn(t, e);
      if (!items || !items.length) return;
      e.preventDefault();
      open({ x: e.clientX, y: e.clientY, items, opener: t });
    });

    // Touch: long-press. Cancel on move so it never fights a scroll or a drag.
    let lp = null, sx = 0, sy = 0;
    root.addEventListener('touchstart', (e) => {
      const t = e.target.closest(selector);
      if (!t) return;
      const to = e.touches[0]; sx = to.clientX; sy = to.clientY;
      lp = setTimeout(() => {
        lp = null;
        const items = itemsFn(t, e);
        if (!items || !items.length) return;
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (er) {} }
        open({ x: sx, y: sy, items, opener: t });
      }, 480);
    }, { passive: true });
    const cancel = (e) => {
      if (lp && e.touches && e.touches[0]) {
        const to = e.touches[0];
        if (Math.abs(to.clientX - sx) < 10 && Math.abs(to.clientY - sy) < 10) return;
      }
      clearTimeout(lp); lp = null;
    };
    root.addEventListener('touchmove', cancel, { passive: true });
    root.addEventListener('touchend', cancel, { passive: true });
    root.addEventListener('touchcancel', cancel, { passive: true });
  }

  window.MCMenu = { open, close, attach, copy: runCopy, isOpen: () => stack.length > 0 };
})();
