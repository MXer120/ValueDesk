/**
 * Something in a feedback message that must never be sent: a private key or a
 * seed phrase (owner, 2026-10-27). The form refuses to send it, with a red line
 * that says why (apps/web/src/feedback), and the server refuses it again
 * (ops/feedback.ts) - a message that holds one is never stored or forwarded.
 *
 * Pure and shared through the web's @sign alias.
 *
 *   private key   64 hex digits on their own (with or without 0x), an extended
 *                 key (xprv / tprv ...), or a base58 run of 80+ characters (a
 *                 Solana-style secret key). A 64-hex value inside a web link is a
 *                 transaction hash on an explorer and passes: that is the way to
 *                 point at one.
 *   seed phrase   12 or more words in a row that are all BIP39 words, numbering
 *                 and punctuation between them ignored ("1. abandon 2. ability").
 */
import { BIP39_WORDS } from './bip39Words.js';

export type SecretKind = 'private-key' | 'seed-phrase';

export const SEED_MIN_WORDS = 12;

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

export function findSecret(text: unknown): SecretKind | null {
  if (typeof text !== 'string' || !text) return null;
  const noLinks = text.replace(URL_RE, ' ');
  if (/(?:^|[^0-9a-f])(?:0x)?[0-9a-f]{64}(?![0-9a-f])/i.test(noLinks)) return 'private-key';
  if (/\b[xyzt]prv[1-9A-HJ-NP-Za-km-z]{100,}/.test(noLinks)) return 'private-key';
  if (/(?:^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{80,}(?![1-9A-HJ-NP-Za-km-z])/.test(noLinks)) return 'private-key';
  let run = 0;
  for (const tok of noLinks.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!tok || /^\d+$/.test(tok)) continue; // "1." "2)" between the words of a written-down phrase
    run = BIP39_WORDS.has(tok) ? run + 1 : 0;
    if (run >= SEED_MIN_WORDS) return 'seed-phrase';
  }
  return null;
}

/** The sentence the form and the server show. */
export const SECRET_TEXT: Record<SecretKind, string> = {
  'private-key':
    'This message seems to contain a private key. Never send a private key to anyone - ValueDesk will never ask for one. Remove it to send the message (a transaction is best shown as its explorer link).',
  'seed-phrase':
    'This message seems to contain a seed phrase. Never send a seed phrase to anyone - ValueDesk will never ask for one. Remove it to send the message.',
};
