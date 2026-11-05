// Before the first paint: a browser that chose the light theme (src/theme.ts) never flashes dark.
// A file of its own because the site's CSP allows no inline script.
try {
  if (localStorage.getItem('vs.theme') === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.style.colorScheme = 'light';
    var m = document.querySelector('meta[name="color-scheme"]');
    if (m) m.setAttribute('content', 'light');
  }
} catch (e) {
  /* no storage: the default theme */
}
