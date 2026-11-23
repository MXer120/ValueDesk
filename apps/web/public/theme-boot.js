// Before the first paint: a classic script in index.html's <head>, in a file of its own because the site's CSP allows
// no inline script. The build serves this same text from an immutable assets/theme-boot-<hash>.js
// (tools/boot-shell.mjs): a return visit then waits for no revalidation round trip before the page can paint.
// One function: its variables stay out of the page's globals.
(function () {
  try {
    // A browser that chose the light theme (src/theme.ts) never flashes dark - nor does Android Chrome's toolbar.
    if (localStorage.getItem('vs.theme') === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      document.documentElement.style.colorScheme = 'light';
      var m = document.querySelector('meta[name="color-scheme"]');
      if (m) m.setAttribute('content', 'light');
      var c = document.querySelector('meta[name="theme-color"]');
      if (c) c.setAttribute('content', '#efefed');
    }
  } catch (e) {
    /* no storage: the default theme */
  }
  try {
    // Which page index.html's static shell draws (src/bootShell.ts): its cards, its lit tab, the market type.
    var s = (location.pathname.split('/')[1] || '').toLowerCase();
    var p = s === '' || s === 'trade' ? 'trade' : s === 'home' ? 'home' : /^(bots|points|portfolio|explore)$/.test(s) ? s : 'page';
    document.documentElement.setAttribute('data-boot', p);
    document.documentElement.setAttribute('data-boot-tab', p === 'explore' || p === 'page' ? 'more' : p);
    var e = null;
    try { e = JSON.parse(localStorage.getItem('ot.engine') || 'null'); } catch (x) { /* the default */ }
    if (e === 'spot') document.documentElement.setAttribute('data-boot-spot', '');
    // /points reads SoDEX's points host first (points.ts, at the page's first render): connect while its code loads.
    if (s === 'points') {
      var l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = 'https://alpha-biz.sodex.dev';
      l.crossOrigin = '';
      document.head.appendChild(l);
    }
  } catch (e2) {
    /* the shell's default page */
  }
  // iPhone and iPad Safari zoom the page into any field under 16px when it is focused, and stay zoomed after: every
  // order size, price and search box here is 12-14px. maximum-scale=1 stops that zoom only - since iOS 10 Safari
  // ignores it for the visitor's own pinch, which keeps working. Not on Android, where it would block the pinch.
  // The two documented signals only: an iPhone/iPod/iPad user agent, or iPadOS's desktop one with a touch screen.
  try {
    var n = navigator;
    if (/iP(hone|od|ad)/.test(n.userAgent) || (n.platform === 'MacIntel' && n.maxTouchPoints > 1)) {
      var v = document.querySelector('meta[name="viewport"]');
      if (v) v.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover');
    }
  } catch (e) {
    /* the page keeps its viewport */
  }
})();
