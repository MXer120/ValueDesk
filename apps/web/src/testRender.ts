/**
 * A first render to markup for unit tests, without react-dom/server or a DOM:
 * function components are called with a stand-in hooks dispatcher (state is the
 * initial state, effects never run, context is the provider's value or the
 * default), class components rendered once, and host elements printed as tags.
 *
 * Enough to ask "does this component put X on the screen" (feedback.test.tsx -
 * the go-live guard for the feedback entry); not a renderer for behaviour. Never
 * imported by the app.
 */
import * as React from 'react';
import { register } from 'node:module';
import type { ReactNode } from 'react';

/**
 * Lets a test import components as the app has them: a stylesheet import is an
 * empty module, and `import.meta.env` (Vite's, which Node does not have) reads as
 * a development-less, production-less build. Call before the dynamic imports.
 */
export function registerTestLoader(): void {
  register('data:text/javascript,' + encodeURIComponent(`
    const ENV = '({"DEV":false,"PROD":false,"MODE":"test"})';
    export async function load(url, ctx, next) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      const r = await next(url, ctx);
      if (!url.includes('/apps/web/src/') || r.source == null) return r;
      const src = typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source);
      return src.includes('import.meta.env') ? { ...r, source: src.replaceAll('import.meta.env', ENV) } : r;
    }`));
}

type Dispatcher = Record<string, unknown>;
const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: Dispatcher | null } } })
  .__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;

const noop = () => {};
const DISPATCHER: Dispatcher = {
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, noop],
  useReducer: (_r: unknown, init: unknown, fn?: (i: unknown) => unknown) => [fn ? fn(init) : init, noop],
  useRef: (current: unknown) => ({ current }),
  useEffect: noop,
  useLayoutEffect: noop,
  useInsertionEffect: noop,
  useImperativeHandle: noop,
  useDebugValue: noop,
  useCallback: (f: unknown) => f,
  useMemo: (f: () => unknown) => f(),
  useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
  useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
  useId: () => ':test:',
  useTransition: () => [false, (f: () => void) => f()],
  useDeferredValue: (v: unknown) => v,
};

const sym = (name: string): symbol => Symbol.for(name);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attrName = (k: string): string => (k === 'className' ? 'class' : k === 'htmlFor' ? 'for' : k);

/** The markup of a first render. */
export function renderToMarkup(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(String(node));
  if (Array.isArray(node)) return node.map(renderToMarkup).join('');
  const el = node as unknown as { $$typeof?: symbol; type: unknown; props: Record<string, unknown> & { children?: ReactNode } };
  if (el.$$typeof === sym('react.portal')) return renderToMarkup((el as unknown as { children: ReactNode }).children);
  if (!React.isValidElement(node)) return '';
  const { type, props } = el;
  if (typeof type === 'string') {
    const attrs = Object.entries(props)
      .filter(([k, v]) => k !== 'children' && k !== 'key' && (typeof v === 'string' || typeof v === 'number' || v === true))
      .map(([k, v]) => (v === true ? ` ${attrName(k)}` : ` ${attrName(k)}="${esc(String(v))}"`))
      .join('');
    return `<${type}${attrs}>${renderToMarkup(props.children)}</${type}>`;
  }
  if (typeof type === 'symbol') return renderToMarkup(props.children); // Fragment, StrictMode, Suspense
  const t = type as { $$typeof?: symbol; type?: unknown; render?: (p: unknown, r: unknown) => ReactNode; _context?: { _currentValue: unknown }; prototype?: { isReactComponent?: unknown } };
  if (t.$$typeof === sym('react.provider')) {
    const ctx = t._context!;
    const prev = ctx._currentValue;
    ctx._currentValue = props.value;
    try {
      return renderToMarkup(props.children);
    } finally {
      ctx._currentValue = prev;
    }
  }
  if (t.$$typeof === sym('react.context')) return renderToMarkup((props.children as unknown as (v: unknown) => ReactNode)((t as unknown as { _currentValue: unknown })._currentValue));
  if (t.$$typeof === sym('react.memo')) return renderToMarkup(React.createElement(t.type as React.ComponentType<Record<string, unknown>>, props as Record<string, unknown>));
  if (t.$$typeof === sym('react.forward_ref')) return withHooks(() => t.render!(props, null));
  if (typeof type === 'function') {
    if (t.prototype?.isReactComponent) {
      const C = type as new (p: unknown) => { props: unknown; state?: unknown; render: () => ReactNode };
      const inst = new C(props);
      inst.props = props;
      return renderToMarkup(inst.render());
    }
    return withHooks(() => (type as (p: unknown) => ReactNode)(props));
  }
  return '';
}

function withHooks(fn: () => ReactNode): string {
  const prev = internals.current;
  internals.current = DISPATCHER;
  let out: ReactNode;
  try {
    out = fn();
  } finally {
    internals.current = prev;
  }
  return renderToMarkup(out);
}
