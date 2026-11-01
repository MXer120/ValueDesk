/**
 * What beta.valuedesk.so asks a tester's wallet to sign (beta/gate.ts checks it): free EIP-712
 * typed data with fixed wording - never a transaction - under a domain of its own, so a signature
 * for the admin suite, the feedback chat or the knowledge folders is never one for this.
 *
 *   BetaSignIn  proves the wallet is the tester's; the beta API then hands out a 7-day token, but
 *               only to a wallet on the beta list (the admin suite's Beta page, admin/store.ts).
 *
 * Pure and shared through the web's @sign alias (apps/web/src/beta/).
 */

export const BETA_DOMAIN = { name: 'ValueDesk Beta', version: '1' } as const;
export const BETA_SIGN_IN_STATEMENT = 'Sign in to the ValueDesk beta (beta.valuedesk.so) for 7 days. Free: a signature, never a transaction.';
export const BETA_SIGN_IN_TYPE = 'BetaSignIn(address owner,string statement,string nonce,uint64 issuedAt,uint64 expiresAt)';
/** How long a signed sign-in may be used after it was made. */
export const BETA_SIGN_IN_TTL_MS = 10 * 60_000;
export const BETA_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** The cookie the beta site keeps its token in; the Vercel function hands it to the API as BETA_TOKEN_HEADER. */
export const BETA_COOKIE = 'vs_beta';
export const BETA_TOKEN_HEADER = 'x-vs-beta';

export interface BetaSignIn {
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
export function betaSignInTypedData(s: Omit<BetaSignIn, 'signature'>) {
  return {
    domain: { name: BETA_DOMAIN.name, version: BETA_DOMAIN.version, chainId: s.chainId, verifyingContract: BETA_ZERO_ADDRESS },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      BetaSignIn: [
        { name: 'owner', type: 'address' },
        { name: 'statement', type: 'string' },
        { name: 'nonce', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'BetaSignIn' as const,
    message: { owner: s.owner.toLowerCase(), statement: s.statement, nonce: s.nonce, issuedAt: s.issuedAt, expiresAt: s.expiresAt },
  };
}
