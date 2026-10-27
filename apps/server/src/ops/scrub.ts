/**
 * What may leave a browser in a client error report, and how one is recognised
 * again (docs/GO-LIVE.md, the privacy policy's "Error reports").
 *
 * SHARED, NOT COPIED. The web reporter (apps/web/src/errorReport.ts) scrubs with
 * these functions before anything is sent, and the server (ops/clientErrors.ts)
 * runs every field through them again on arrival - so a reporter that is old,
 * broken or not ours still cannot store more than this allows. Pure: no Node and
 * no DOM API, so the web imports it through its @sign alias.
 *
 * What is kept: the error's type, its message with every identifying run taken
 * out, up to ten stack frames as function name + script path + line, the page's
 * path with its variable parts replaced, the build, and the browser's family and
 * major version. What never is: a wallet address, a key, a signature or any other
 * long hex or base64 run, an e-mail address, a query string or fragment, an origin,
 * a long number, a long quoted string (where typed text ends up in a message), and
 * anything past the length caps.
 */

export const MAX_MESSAGE = 300;
export const MAX_NAME = 60;
export const MAX_FRAMES = 10;
export const MAX_FRAME = 200;
export const MAX_ROUTE = 120;
export const MAX_SHORT = 40;

/** URL -> its path: no scheme, host, query or fragment. A line:col suffix stays. */
const URL_RE = /\b(?:https?|wss?|blob|chrome-extension|moz-extension|safari-web-extension|webpack|file):\/\/?[^\s()'"<>]*/gi;

function urlToPath(raw: string): string {
  const m = /^[a-z-]+:\/\/?(?:[^/\s]*)(\/[^?#\s]*)?(?:[?#][^\s]*)?$/i.exec(raw);
  let path = m?.[1] ?? '/';
  // A line:col that the query cut off ("app.js?v=2:10:5") is put back.
  const pos = /(:\d+:\d+)$/.exec(raw);
  if (pos && !path.endsWith(pos[1]!)) path += pos[1];
  return path;
}

/**
 * One line of text, scrubbed and capped. Order matters: URLs first (they hold
 * hex and digits of their own), then the identifying runs, then the length.
 */
export function scrubText(raw: unknown, max = MAX_MESSAGE): string {
  if (typeof raw !== 'string') return '';
  let s = raw.slice(0, max * 4);
  s = s.replace(URL_RE, (u) => urlToPath(u));
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>');
  s = s.replace(/0x[0-9a-f]{6,}/gi, '0x…');
  // Long hex, base58 or base64 runs: keys, signatures, tokens, hashes.
  s = s.replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) => (/[0-9]/.test(run) || /[A-Z]/.test(run) ? '…' : run));
  // Quoted strings long enough to be something a person typed.
  s = s.replace(/(["'`])([^"'`]{24,})\1/g, '$1…$1');
  // Numbers of five digits or more: amounts, ids, timestamps.
  s = s.replace(/\d[\d,._]{3,}\d/g, '#');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** An error type: an identifier, or "Error". */
export function scrubName(raw: unknown): string {
  return typeof raw === 'string' && /^[A-Za-z_$][\w$]{0,59}$/.test(raw) ? raw : 'Error';
}

/**
 * Stack frames from an Error's `stack` (V8's "at fn (url:1:2)", Firefox's and
 * Safari's "fn@url:1:2"): "fn path:1:2" or "path:1:2", at most MAX_FRAMES.
 */
export function framesFromStack(stack: unknown): string[] {
  if (typeof stack !== 'string') return [];
  const out: string[] = [];
  for (const line of stack.split('\n')) {
    if (out.length >= MAX_FRAMES) break;
    const t = line.trim();
    const v8 = /^at (?:(.+?) \()?(.+?)(?::(\d+))?(?::(\d+))?\)?$/.exec(t);
    const ff = /^(.*?)@(.+?)(?::(\d+))?(?::(\d+))?$/.exec(t);
    const m = t.startsWith('at ') ? v8 : ff;
    if (!m) continue;
    const fn = (m[1] ?? '').replace(/^async\s+/, '');
    const where = m[2] ?? '';
    if (!where || where === '<anonymous>' || where === 'native') continue;
    out.push(scrubFrame(`${fn && /^[\w$.<>[\] ]{1,80}$/.test(fn) ? `${fn} ` : ''}${where}${m[3] ? `:${m[3]}` : ''}${m[4] ? `:${m[4]}` : ''}`));
  }
  return out.filter(Boolean);
}

/** One frame as the server stores it: the same scrub, its own length cap. */
export function scrubFrame(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw.slice(0, MAX_FRAME * 4).replace(URL_RE, (u) => urlToPath(u));
  s = s.replace(/0x[0-9a-f]{6,}/gi, '0x…').replace(/[?#][^\s:]*/g, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length > MAX_FRAME ? s.slice(0, MAX_FRAME) : s;
}

/**
 * A page's path with its variable parts replaced: an address becomes ":address",
 * any other segment that is not a short plain word ":id". Four segments at most;
 * never a query or a fragment.
 */
export function scrubRoute(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  const path = raw.split(/[?#]/)[0] ?? '';
  const segs = path.split('/').filter(Boolean).slice(0, 4).map((seg) => {
    if (/^0x[0-9a-f]{6,}$/i.test(seg)) return ':address';
    return /^[a-z][a-z0-9-]{0,31}$/i.test(seg) ? seg.toLowerCase() : ':id';
  });
  const out = `/${segs.join('/')}`;
  return out.length > MAX_ROUTE ? out.slice(0, MAX_ROUTE) : out;
}

/** A build id or a browser label: short, plain characters only. */
export function scrubShort(raw: unknown, max = MAX_SHORT): string {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(/[^\w .+/-]/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** "chrome 130", "firefox 131 mobile", "safari 18", "edge 130", or "other". Never the user agent itself. */
export function browserFamily(ua: unknown): string {
  if (typeof ua !== 'string') return 'other';
  const mobile = /Mobi|Android|iPhone|iPad/i.test(ua) ? ' mobile' : '';
  const pick = (re: RegExp, name: string): string | null => {
    const m = re.exec(ua);
    return m ? `${name} ${m[1]}${mobile}` : null;
  };
  return (
    pick(/Edg(?:e|A|iOS)?\/(\d+)/, 'edge') ??
    pick(/OPR\/(\d+)/, 'opera') ??
    pick(/Firefox\/(\d+)/, 'firefox') ??
    pick(/FxiOS\/(\d+)/, 'firefox') ??
    pick(/CriOS\/(\d+)/, 'chrome') ??
    pick(/Chrome\/(\d+)/, 'chrome') ??
    pick(/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//, 'safari') ??
    'other'
  );
}

/** 64-bit FNV-1a as 16 hex digits: stable across browsers and Node, no crypto API needed. */
export function hash64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * The same error again, whichever build and page it came from: its kind and type,
 * its message with the numbers taken out, and its top three frames without line
 * numbers or the build's file hashes ("/assets/Trade-a1B2c3.js" -> "/assets/Trade.js").
 */
export function errorFingerprint(r: { kind: string; name: string; message: string; frames: readonly string[] }): string {
  const msg = r.message.replace(/\d+/g, '0');
  const frames = r.frames.slice(0, 3).map((f) => f.replace(/:\d+(?::\d+)?$/, '').replace(/-[A-Za-z0-9_]{6,12}(\.m?js)$/, '$1'));
  return hash64([r.kind, r.name, msg, ...frames].join('\n'));
}
