/**
 * One feedback message as the form sends it (POST /api/vs/feedback,
 * routes/reports.ts; the form is apps/web/src/feedback/): checked here, kept in
 * its thread (ops/feedbackThreads.ts), forwarded to the owner.
 *
 * What a message may carry: a category, the text, up to three screenshots
 * uploaded before (their ids), optionally the wallet address the visitor chose
 * to add, and - on by default in the form, "Recommended" - the page and browser
 * info. That info is PROJECTED, not passed through: every field is picked by
 * name, checked and cut to size, so whatever a newer or a hostile form adds is
 * dropped. Each one is what helps find a bug and nothing that identifies a
 * person: the page's path without its variable parts, the build, the browser and
 * OS families, the window size and pixel ratio, the language and time zone, the
 * app's connection state, whether a wallet is connected (not which), the copy
 * modes in use, the fingerprints of the last client errors (ops/clientErrors.ts),
 * and the element right-clicked to open the form, if any.
 *
 * A text that holds a private key or a seed phrase is refused (ops/secrets.ts).
 */
import { ADDRESS_RE } from '../builder/terms.js';
import { findSecret, SECRET_TEXT } from './secrets.js';
import { scrubRoute, scrubShort, scrubText } from './scrub.js';

export const CATEGORIES = ['bug', 'idea', 'other'] as const;
export type FeedbackCategory = (typeof CATEGORIES)[number];

export const MIN_MESSAGE = 1;
export const MAX_MESSAGE = 2000;
/** The body a message may have, in bytes (the route's bodyLimit): 2000 characters of any script, its page info, and room. */
export const FEEDBACK_BODY_LIMIT = 16 * 1024;

export interface FeedbackElement {
  path: string;
  role: string | null;
  label: string | null;
  panel: string | null;
}

export interface FeedbackContext {
  route: string;
  build: string;
  browser: string;
  os: string | null;
  viewport: string | null;
  dpr: number | null;
  lang: string | null;
  timeZone: string | null;
  sockets: string | null;
  walletConnected: boolean | null;
  modes: string[];
  errors: string[];
  element: FeedbackElement | null;
}

export interface Feedback {
  category: FeedbackCategory;
  message: string;
  context: FeedbackContext | null;
  wallet: string | null;
  images: string[];
}

const KEYS = new Set(['category', 'message', 'context', 'website', 'wallet', 'images']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Control characters other than tab and newline, and the bidi and zero-width ones. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const codePoints = (s: string): number => [...s].length;
const short = (v: unknown, max = 40): string | null => scrubShort(v, max) || null;

/** The page info, field by field (see the header). */
export function projectContext(c: Record<string, unknown>): FeedbackContext {
  const el = isRecord(c.element) ? c.element : null;
  const dpr = typeof c.dpr === 'number' && Number.isFinite(c.dpr) && c.dpr > 0 && c.dpr <= 8 ? Math.round(c.dpr * 100) / 100 : null;
  return {
    route: scrubRoute(c.route),
    build: short(c.build) ?? 'unknown',
    browser: short(c.browser) ?? 'other',
    os: short(c.os, 30),
    viewport: typeof c.viewport === 'string' && /^\d{2,5}x\d{2,5}$/.test(c.viewport) ? c.viewport : null,
    dpr,
    lang: typeof c.lang === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(c.lang) ? c.lang : null,
    timeZone: typeof c.timeZone === 'string' && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(c.timeZone) && c.timeZone.length <= 40 ? c.timeZone : null,
    sockets: short(c.sockets, 60),
    walletConnected: typeof c.walletConnected === 'boolean' ? c.walletConnected : null,
    modes: Array.isArray(c.modes) ? [...new Set(c.modes.filter((m): m is string => m === 'browser' || m === 'hosted' || m === 'self'))] : [],
    errors: Array.isArray(c.errors) ? c.errors.filter((e): e is string => typeof e === 'string' && /^[0-9a-f]{16}$/.test(e)).slice(0, 5) : [],
    element: el
      ? {
          path: scrubText(el.path, 200) || '?',
          role: short(el.role, 30),
          label: scrubText(el.label, 80) || null,
          panel: short(el.panel, 40),
        }
      : null,
  };
}

/**
 * A message as kept, or why it is refused. `spam`: the form's hidden field was
 * filled in - a bot. The route answers it like a success and keeps nothing.
 */
export function parseFeedback(body: unknown): { ok: true; feedback: Feedback } | { ok: false; error: string; code?: string } | { ok: 'spam' } {
  if (!isRecord(body)) return { ok: false, error: 'the body must be a JSON object' };
  for (const k of Object.keys(body)) if (!KEYS.has(k)) return { ok: false, error: `unknown field "${k}"` };
  if (typeof body.website === 'string' && body.website.trim() !== '') return { ok: 'spam' };
  const category = body.category === undefined ? 'other' : body.category;
  if (!CATEGORIES.includes(category as FeedbackCategory)) return { ok: false, error: 'category must be bug, idea or other' };
  if (typeof body.message !== 'string') return { ok: false, error: 'message is required' };
  const message = body.message.replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/\n{4,}/g, '\n\n\n').trim();
  if (codePoints(message) < MIN_MESSAGE) return { ok: false, error: 'the message is empty' };
  if (codePoints(message) > MAX_MESSAGE) return { ok: false, error: `the message can have at most ${MAX_MESSAGE} characters` };
  const secret = findSecret(message);
  if (secret) return { ok: false, error: SECRET_TEXT[secret], code: 'secret' };
  let wallet: string | null = null;
  if (body.wallet !== undefined && body.wallet !== null && body.wallet !== '') {
    if (typeof body.wallet !== 'string' || !ADDRESS_RE.test(body.wallet)) return { ok: false, error: 'wallet must be a 0x wallet address' };
    wallet = body.wallet.toLowerCase();
  }
  let images: string[] = [];
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || body.images.length > 3 || !body.images.every((i) => typeof i === 'string' && /^[0-9a-f]{24}$/.test(i))) {
      return { ok: false, error: 'images must be at most 3 screenshot ids' };
    }
    images = [...new Set(body.images as string[])];
  }
  let context: FeedbackContext | null = null;
  if (body.context !== undefined && body.context !== null) {
    if (!isRecord(body.context)) return { ok: false, error: 'context must be an object' };
    context = projectContext(body.context);
  }
  return { ok: true, feedback: { category: category as FeedbackCategory, message, context, wallet, images } };
}

/** The page info in lines, for the owner's Telegram message. */
export function contextLines(c: FeedbackContext | null, wallet: string | null): string[] {
  const out: string[] = [];
  if (c) {
    out.push(`Page ${c.route} · build ${c.build}`);
    out.push([c.browser, c.os, c.viewport && `${c.viewport}${c.dpr ? `@${c.dpr}x` : ''}`, c.lang, c.timeZone].filter(Boolean).join(' · '));
    const app = [c.sockets && `sockets ${c.sockets}`, c.walletConnected === null ? null : `wallet ${c.walletConnected ? 'connected' : 'not connected'}`, c.modes.length ? `copy ${c.modes.join('/')}` : null];
    if (app.some(Boolean)) out.push(app.filter(Boolean).join(' · '));
    if (c.errors.length) out.push(`Recent errors ${c.errors.join(', ')}`);
    if (c.element) out.push(`Element ${c.element.panel ? `[${c.element.panel}] ` : ''}${c.element.path}${c.element.label ? ` "${c.element.label}"` : ''}${c.element.role ? ` (${c.element.role})` : ''}`);
  }
  if (wallet) out.push(`Wallet ${wallet}`);
  return out;
}

/** The owner's message for one feedback: the first of a thread, or a follow-up in it. */
export function feedbackText(f: Feedback, thread: { id: number; isNew: boolean; images: number }): string {
  const head = thread.isNew ? `ValueDesk feedback (${f.category}) · thread #${thread.id}` : `Thread #${thread.id} · the visitor wrote`;
  return [
    head,
    '',
    f.message,
    ...(thread.images ? ['', `${thread.images} screenshot${thread.images === 1 ? '' : 's'} below`] : []),
    ...(thread.isNew ? ['', ...contextLines(f.context, f.wallet), '', 'Reply to this message to answer in the visitor\'s app.'] : []),
  ].join('\n');
}
