/**
 * Test support (not a test): lets `tsx --test` import the widgets the way Vite
 * builds them, with no DOM and no new dependency.
 *
 *   - `.css` imports become empty modules;
 *   - `import.meta.env` (Vite's) becomes a production build's;
 *   - a module whose path ends in a key of `stubs` is replaced by that source
 *     (a plain ES module; it can import nothing but node builtins);
 *   - `localStorage` is an in-memory store, seeded from `stored`.
 *
 * Call it BEFORE the first import of a widget: static imports are all loaded
 * before any code runs, so widgets are brought in with `await import(...)`.
 */
import { createRequire, registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import type { ReactElement } from 'react';

const EMPTY = 'data:text/javascript,export default {}';
const toData = (src: string) => `data:text/javascript,${encodeURIComponent(src)}`;

export function installViteStubs({ stubs = {}, stored = {} }: { stubs?: Record<string, string>; stored?: Record<string, unknown> } = {}): Map<string, string> {
  registerHooks({
    resolve(spec, ctx, next) {
      if (/\.css(\?.*)?$/.test(spec)) return { url: EMPTY, shortCircuit: true };
      const r = next(spec, ctx);
      for (const [suffix, src] of Object.entries(stubs)) if (r.url.endsWith(suffix)) return { url: toData(src), shortCircuit: true };
      return r;
    },
    load(url, ctx, next) {
      const r = next(url, ctx);
      if (url.startsWith('file:') && /\.tsx?$/.test(url) && r.source) {
        const s = String(r.source);
        if (s.includes('import.meta.env')) return { ...r, source: s.replaceAll('import.meta.env', '({ DEV: false, PROD: true, MODE: "test" })') };
      }
      return r;
    },
  });
  const store = new Map<string, string>(Object.entries(stored).map(([k, v]) => [k, JSON.stringify(v)]));
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
  return store;
}

/**
 * react-dom/server's renderToStaticMarkup. Its legacy browser build is the
 * fallback: a cloud-only (OneDrive) copy of node_modules may hold some of the
 * package's files as placeholders that cannot be read offline.
 */
export async function staticMarkup(): Promise<(el: ReactElement) => string> {
  let render: (el: ReactElement) => string;
  try {
    render = (await import('react-dom/server')).renderToStaticMarkup;
  } catch {
    const require = createRequire(import.meta.url);
    const dir = dirname(require.resolve('react-dom/package.json'));
    render = (require(join(dir, 'cjs', 'react-dom-server-legacy.browser.development.js')) as { renderToStaticMarkup: (el: ReactElement) => string }).renderToStaticMarkup;
  }
  // The server renderer's note that layout effects do not run there is expected here.
  return (el) => {
    const error = console.error;
    console.error = (...a: unknown[]) => { if (!/useLayoutEffect does nothing on the server/.test(String(a[0]))) error(...a); };
    try { return render(el); } finally { console.error = error; }
  };
}

/** A Modal that renders its body in place (react-dom/server has no portals). */
export const INLINE_MODAL = 'export function Modal(p) { return p.open ? p.children : null; }';
