'use strict';
/* ===================================================================
   Cross-device prefs sync (wallet aliases + feed watched-wallet groups).

   localStorage stays the synchronous working store — existing code reads
   `scan-aliases` / `feed-assoc` from it directly and is untouched. This layer:
     • on boot, GETs the shared server copy (/api/prefs);
     • the FIRST time on each device, UNION-merges this device's local data INTO
       the server (so nothing is ever deleted on migration) and marks the device
       migrated;
     • thereafter the server is the source of truth — local is refreshed from it
       (so edits/deletes propagate across devices, no resurrection);
     • after any local edit, pushes the current local store up (debounced).
   Fires a `prefs-synced` event once local has been refreshed so pages can redraw.
   =================================================================== */
(function () {
  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  const GHDR = TOKEN ? { 'X-Dash-Token': TOKEN } : {};
  const PHDR = Object.assign({ 'Content-Type': 'application/json' }, GHDR);
  const AK = 'scan-aliases', FK = 'feed-assoc', MIGK = 'prefs-migrated';

  function lsGet(k, dflt) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? dflt : v; } catch (e) { return dflt; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota */ } }
  function localAliases() { const v = lsGet(AK, {}); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
  function localAssoc() { const v = lsGet(FK, []); return Array.isArray(v) ? v : []; }
  function isEmpty(sa, fa) { return (!sa || !Object.keys(sa).length) && (!fa || !fa.length); }

  // ── union merges (used only at first-time migration — never lose anything) ──
  function mergeAliases(server, local) { return Object.assign({}, server || {}, local || {}); }  // local wins
  function mergeAssoc(server, local) {
    const out = [], byName = {};
    const add = (g) => { const c = { name: g.name, color: g.color, own: !!g.own, addrs: (g.addrs || []).slice() }; out.push(c); byName[String(g.name).toLowerCase()] = c; };
    (server || []).forEach((g) => { if (g && g.name) add(g); });
    (local || []).forEach((g) => {
      if (!g || !g.name) return;
      const ex = byName[String(g.name).toLowerCase()];
      if (!ex) { add(g); return; }
      (g.addrs || []).forEach((a) => { if (!ex.addrs.some((x) => String(x).toLowerCase() === String(a).toLowerCase())) ex.addrs.push(a); });
    });
    return out;
  }

  let pushTimer = null, lastPushed = '';
  function pushNow() {
    const body = JSON.stringify({ scan_aliases: localAliases(), feed_assoc: localAssoc() });
    if (body === lastPushed) return;
    lastPushed = body;
    fetch('/api/prefs', { method: 'POST', headers: PHDR, body }).catch(() => {});
  }
  function push() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 700); }

  let ready = fetch('/api/prefs', { headers: GHDR })
    .then((r) => (r.ok ? r.json() : null))
    .then((srv) => {
      if (!srv) return false;                                  // offline → keep working off localStorage
      const sa = (srv.scan_aliases && typeof srv.scan_aliases === 'object' && !Array.isArray(srv.scan_aliases)) ? srv.scan_aliases : {};
      const fa = Array.isArray(srv.feed_assoc) ? srv.feed_assoc : [];
      if (!localStorage.getItem(MIGK)) {
        // first time on THIS device: fold this device's data into the server (no loss)
        const mA = mergeAliases(sa, localAliases()), mF = mergeAssoc(fa, localAssoc());
        lsSet(AK, mA); lsSet(FK, mF);
        try { localStorage.setItem(MIGK, '1'); } catch (e) { /* ignore */ }
        lastPushed = ''; pushNow();                            // seed/converge the server with the union
      } else {
        // already migrated → server is the truth; refresh the local cache from it
        lsSet(AK, sa); lsSet(FK, fa);
        lastPushed = JSON.stringify({ scan_aliases: sa, feed_assoc: fa });
      }
      document.dispatchEvent(new CustomEvent('prefs-synced'));
      return true;
    })
    .catch(() => false);

  window.Prefs = { push: push, ready: function () { return ready; } };
})();
