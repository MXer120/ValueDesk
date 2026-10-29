/**
 * The wallet sign-in of the feedback chat (ops/feedbackAuth.ts checks it): what
 * the browser asks the wallet to sign. Free EIP-712 typed data with a fixed
 * statement - never a transaction - the same shape as the knowledge folders'
 * sign-in (folders/types.ts) under its own domain and type, so a signature for
 * one is never accepted by the other.
 *
 * Pure and shared through the web's @sign alias (apps/web/src/feedback/session.ts).
 */

export const FEEDBACK_SIGN_IN_DOMAIN = { name: 'ValueDesk Feedback', version: '1' } as const;
/** What the wallet signs to open its feedback chat and its inbox (ops/inbox.ts: its algos' and copies' notices). */
export const FEEDBACK_SIGN_IN_STATEMENT = 'Open my ValueDesk feedback chat and notifications in this browser. Free: a signature, never a transaction.';
/** The statement before 2026-10-29 (the chat alone): still taken, so a page loaded before the change can sign in. */
export const FEEDBACK_SIGN_IN_STATEMENTS: readonly string[] = [FEEDBACK_SIGN_IN_STATEMENT, 'Open my ValueDesk feedback chat in this browser. Free: a signature, never a transaction.'];
export const FEEDBACK_SIGN_IN_TYPE = 'FeedbackSignIn(address owner,string statement,string nonce,uint64 issuedAt,uint64 expiresAt)';
/** How long a signed sign-in may be used after it was made. */
export const FEEDBACK_SIGN_IN_TTL_MS = 10 * 60_000;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface FeedbackSignIn {
  owner: string;
  statement: string;
  /** 32 hex characters from the browser. */
  nonce: string;
  /** ms, decimal strings (uint64 in the typed data). */
  issuedAt: string;
  expiresAt: string;
  chainId: number;
  signature: string;
}

/** The typed data the wallet signs (eth_signTypedData_v4). */
export function feedbackSignInTypedData(s: Omit<FeedbackSignIn, 'signature'>) {
  return {
    domain: { name: FEEDBACK_SIGN_IN_DOMAIN.name, version: FEEDBACK_SIGN_IN_DOMAIN.version, chainId: s.chainId, verifyingContract: ZERO_ADDRESS },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      FeedbackSignIn: [
        { name: 'owner', type: 'address' },
        { name: 'statement', type: 'string' },
        { name: 'nonce', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'FeedbackSignIn' as const,
    message: { owner: s.owner.toLowerCase(), statement: s.statement, nonce: s.nonce, issuedAt: s.issuedAt, expiresAt: s.expiresAt },
  };
}
