/**
 * Invites and fee credits (owner 2026-11-14: "Introduce fee credits, and each invite that trades gets you builder fee
 * credits"): the rules the server and the page share (the web reads this file through its @sign alias), and what an
 * invited wallet signs to join under a code.
 *
 *   The link       valuedesk.so/?i=<code>. A wallet's code is random, made by the server the first time it is asked
 *                  for (it only ever pays that wallet: nothing to sign for it).
 *   Joining        the invited wallet signs once (free EIP-712 typed data, never a transaction) after it accepted the
 *                  site's terms. Never its own code; only a wallet the builder ledger has no volume for yet; the first
 *                  join stands.
 *   Credits        the inviter earns CREDIT_SHARE of the builder fees each invitee really pays (the builder ledger's
 *                  counted orders), for CREDIT_MONTHS from the join. Credits are dollars on the wallet that pay its own
 *                  builder fee: while it has them, its builder fee is CREDIT_FEE on every product (the least the
 *                  ledger can still count volume at), and the fee it would have paid above that comes off the balance.
 *                  Never paid out.
 *   Welcome        the invited wallet's own builder fee is CREDIT_FEE on its first WELCOME_USD of counted volume.
 */

/** Of what an invitee pays in builder fees, the inviter's credit. */
export const CREDIT_SHARE = 0.25;
/** For how long from the join an invitee's fees earn credit. */
export const CREDIT_MONTHS = 12;
export const CREDIT_WINDOW_MS = CREDIT_MONTHS * 30 * 86_400_000;
/**
 * The builder fee while credits (or the welcome) pay: 1 tenth of a bp. Not 0: the builder ledger counts a wallet's
 * volume only on orders that paid a builder fee (builder/counting.ts), so at 0 nothing would count - not the welcome's
 * $10k, not the credits it spent, not the volume toward the wallet's own tier.
 */
export const CREDIT_FEE = 1;
/** Credits start paying once the balance reaches this (USD), and stop at 0: no flicker at a few cents. */
export const CREDIT_MIN_USD = 0.05;
/** The invited wallet's builder fee is CREDIT_FEE on its first this much counted volume (USD). */
export const WELCOME_USD = 10_000;

/** A code: 8 of these, no look-alikes (0/O, 1/l/I). */
export const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const CODE_LENGTH = 8;
export const CODE_RE = /^[a-hj-km-np-z2-9]{8}$/;
/** The page's address parameter. */
export const INVITE_PARAM = 'i';

export const INVITE_DOMAIN = { name: 'ValueDesk Invite', version: '1' } as const;
export const INVITE_STATEMENT = 'Join ValueDesk with this invite. Free: a signature, never a transaction.';
export const INVITE_TYPE = 'InviteJoin(address wallet,string code,string statement,string nonce,uint64 issuedAt,uint64 expiresAt)';
export const INVITE_TTL_MS = 10 * 60_000;
export const INVITE_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface InviteJoin {
  wallet: string;
  code: string;
  statement: string;
  /** 32 hex characters from the browser. */
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  chainId: number;
  signature: string;
}

/** The typed data the invited wallet signs (eth_signTypedData_v4). */
export function inviteTypedData(c: Omit<InviteJoin, 'signature'>) {
  return {
    domain: { name: INVITE_DOMAIN.name, version: INVITE_DOMAIN.version, chainId: c.chainId, verifyingContract: INVITE_ZERO_ADDRESS },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      InviteJoin: [
        { name: 'wallet', type: 'address' },
        { name: 'code', type: 'string' },
        { name: 'statement', type: 'string' },
        { name: 'nonce', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'InviteJoin' as const,
    message: { wallet: c.wallet.toLowerCase(), code: c.code, statement: c.statement, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt },
  };
}

/** A wallet's invite status, as /api/vs/invites/me answers it. */
export interface InviteMe {
  ok: true;
  code: string | null;
  /** The code this wallet joined with (null: none). */
  joined: { code: string; at: number } | null;
  /** May this wallet still join with a code: never joined, and no ValueDesk volume yet. */
  canJoin: boolean;
  welcome: { active: boolean; leftUsd: number; limitUsd: number } | null;
  credits: { balanceUsd: number; earnedUsd: number; spentUsd: number; paying: boolean; share: number; months: number };
  invitees: Array<{ wallet: string; at: number; trading: boolean; earnedUsd: number; until: number }>;
}
