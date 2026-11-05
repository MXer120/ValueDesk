/**
 * What a wallet signs to take a username, and the rules a username follows. Pure, and shared
 * with the web through its @sign alias (apps/web/src/onboarding/), so the page checks a name by
 * the same rules as the server and asks the wallet to sign exactly what the server recomputes.
 *
 * Free EIP-712 typed data with fixed wording - never a transaction - under a domain of its own,
 * so a signature for the terms, the feedback chat or the folders is never one for this.
 */

export const USERNAME_DOMAIN = { name: 'ValueDesk Username', version: '1' } as const;
export const USERNAME_STATEMENT = 'Take this ValueDesk username for my wallet. It cannot be changed later. Free: a signature, never a transaction.';
export const USERNAME_TYPE = 'UsernameClaim(address owner,string username,string statement,string nonce,uint64 issuedAt,uint64 expiresAt)';
/** How long a signed claim may be used after it was made. */
export const USERNAME_CLAIM_TTL_MS = 10 * 60_000;
export const USERNAME_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

export interface UsernameClaim {
  owner: string;
  username: string;
  statement: string;
  /** 32 hex characters from the browser. */
  nonce: string;
  /** ms, decimal strings (uint64 in the typed data). */
  issuedAt: string;
  expiresAt: string;
  chainId: number;
  signature: string;
}

/**
 * Names that would read as ValueDesk itself, its venues or its staff. Matched inside the name
 * ("valuedesk_support" too), case and underscores ignored. Short on purpose: this stops
 * impersonation of the site, it is not a word filter.
 */
const RESERVED_PARTS = ['valuedesk', 'valuescan', 'sodex', 'sosovalue', 'hyperliquid', 'admin', 'official', 'support', 'moderator', 'helpdesk'];
/** Whole names that are ordinary words elsewhere but would mislead as an account. */
const RESERVED_WHOLE = new Set(['mod', 'mods', 'team', 'staff', 'owner', 'root', 'system', 'null', 'undefined', 'anonymous', 'wallet', 'me', 'you', 'everyone', 'all']);

export type UsernameProblem = 'empty' | 'short' | 'long' | 'chars' | 'address' | 'reserved';

/** The one spelling two names are the same under: `Luke_1` and `luke_1` cannot both exist. */
export const usernameKey = (name: string): string => name.toLowerCase();

/** Why this name cannot be taken, or null when the rules allow it. */
export function usernameProblem(name: string): UsernameProblem | null {
  if (!name) return 'empty';
  if (name.length < USERNAME_MIN) return 'short';
  if (name.length > USERNAME_MAX) return 'long';
  if (!/^[A-Za-z0-9_]+$/.test(name)) return 'chars';
  const key = usernameKey(name);
  // Would read as a wallet address on a screen full of wallet addresses.
  if (/^0x[0-9a-f]*$/.test(key)) return 'address';
  const bare = key.replace(/_/g, '');
  if (RESERVED_WHOLE.has(key) || RESERVED_WHOLE.has(bare)) return 'reserved';
  if (RESERVED_PARTS.some((p) => bare.includes(p))) return 'reserved';
  return null;
}

/** The problem in words, for the page and for an API error. */
export function usernameProblemText(p: UsernameProblem): string {
  switch (p) {
    case 'empty': return 'Choose a username.';
    case 'short': return `At least ${USERNAME_MIN} characters.`;
    case 'long': return `At most ${USERNAME_MAX} characters.`;
    case 'chars': return 'Only letters, numbers and _.';
    case 'address': return 'A username cannot look like a wallet address.';
    case 'reserved': return 'This name is reserved.';
  }
}

/** The typed data the wallet signs (eth_signTypedData_v4). */
export function usernameTypedData(c: Omit<UsernameClaim, 'signature'>) {
  return {
    domain: { name: USERNAME_DOMAIN.name, version: USERNAME_DOMAIN.version, chainId: c.chainId, verifyingContract: USERNAME_ZERO_ADDRESS },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      UsernameClaim: [
        { name: 'owner', type: 'address' },
        { name: 'username', type: 'string' },
        { name: 'statement', type: 'string' },
        { name: 'nonce', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'UsernameClaim' as const,
    message: { owner: c.owner.toLowerCase(), username: c.username, statement: c.statement, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt },
  };
}
