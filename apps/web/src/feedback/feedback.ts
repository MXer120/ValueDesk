/**
 * "Send feedback" (docs/GO-LIVE.md: the site does not go live without it).
 *
 * A chat with the ValueDesk team: the form (FeedbackDialog.tsx) sends a message
 * to /api/vs/feedback (apps/server routes/reports.ts), which keeps it in this
 * browser's thread (threads.ts) and forwards it to the owner by Telegram; the
 * owner's answer comes back into the same thread and shows in the bell
 * (FeedbackHost.tsx). Screenshots go along (images.ts), and - recommended, on
 * by default - the page and browser info (context.ts).
 *
 * VITE_FEEDBACK_URL (the owner's Discord invite, https) adds a "Discord" button
 * to the form; without it that button says "coming soon".
 */
import { findSecret, SECRET_TEXT, type SecretKind } from '@sign/ops/secrets.js';
import type { FeedbackContext } from './context';

export type FeedbackCategory = 'bug' | 'idea' | 'other';

/** The longest message the server takes (apps/server ops/feedback.ts MAX_MESSAGE). */
export const FEEDBACK_MAX = 2000;

/** A usable Discord (or other community) page: https, nothing else. Anything else counts as unset. */
export function feedbackUrlFrom(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/** The build's Discord invite, or null. */
export const FEEDBACK_URL: string | null = feedbackUrlFrom(import.meta.env?.VITE_FEEDBACK_URL);

/** The message's length as the server counts it (code points). */
export const messageLength = (s: string): number => [...s.trim()].length;

/** A private key or a seed phrase in the text: the form will not send it (@sign/ops/secrets). */
export const secretIn = (text: string): { kind: SecretKind; text: string } | null => {
  const kind = findSecret(text);
  return kind ? { kind, text: SECRET_TEXT[kind] } : null;
};

export interface OutgoingMessage {
  category: FeedbackCategory;
  message: string;
  images: string[];
  context: FeedbackContext | null;
  wallet: string | null;
  /** The form's hidden field: only a bot fills it in. */
  website: string;
}

export type SendResult = { ok: true; thread: number | null } | { ok: false; error: string; secret?: boolean };

/** Send one message into the thread `token`. Never throws: a failure is a sentence for the form. */
export async function sendMessage(token: string, m: OutgoingMessage, f: typeof fetch = fetch): Promise<SendResult> {
  const secret = secretIn(m.message);
  if (secret) return { ok: false, error: secret.text, secret: true };
  const body = {
    category: m.category,
    message: m.message.trim(),
    ...(m.images.length ? { images: m.images } : {}),
    ...(m.context ? { context: m.context } : {}),
    ...(m.wallet ? { wallet: m.wallet } : {}),
    ...(m.website ? { website: m.website } : {}),
  };
  let res: Response;
  try {
    res = await f('/api/vs/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      credentials: 'omit',
    });
  } catch {
    return { ok: false, error: 'Your message could not be sent - check your connection and try again.' };
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; thread?: number; error?: string; code?: string } | null;
  if (res.ok && json?.ok) return { ok: true, thread: typeof json.thread === 'number' ? json.thread : null };
  if (res.status === 429) return { ok: false, error: 'You sent several messages just now - please wait a few minutes and try again.' };
  if (res.status === 400 && json?.code === 'secret' && json.error) return { ok: false, error: json.error, secret: true };
  if (res.status === 400 && json?.error) return { ok: false, error: `${json.error.charAt(0).toUpperCase()}${json.error.slice(1)}.` };
  return { ok: false, error: 'Your message could not be sent right now - please try again later.' };
}
