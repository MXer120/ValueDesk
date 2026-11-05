/**
 * What the admin suite (dev.valuedesk.so) asks the builder wallet to sign
 * (admin/auth.ts checks it). Free EIP-712 typed data with fixed wording - never
 * a transaction - under a domain of its own, so a signature for the feedback
 * chat is never one for this, and the other way round.
 *
 *   AdminSignIn  opens a 24-hour session, together with the password.
 *   AdminAction  one write (a reply, a status change, signing out everywhere):
 *                it names the action, its target, a line the wallet shows, and
 *                the keccak-256 of the exact payload the server then receives.
 *                A session alone writes nothing.
 *
 * Pure and shared through the web's @sign alias (apps/web/src/admin/).
 */
import { keccak_256 } from '@noble/hashes/sha3';

export const ADMIN_DOMAIN = { name: 'ValueDesk Admin', version: '1' } as const;
export const ADMIN_SIGN_IN_STATEMENT = 'Sign in to the ValueDesk admin suite (dev.valuedesk.so) for 24 hours. Free: a signature, never a transaction.';
export const ADMIN_SIGN_IN_TYPE = 'AdminSignIn(address owner,string statement,string nonce,uint64 issuedAt,uint64 expiresAt)';
export const ADMIN_ACTION_TYPE = 'AdminAction(address owner,string action,string target,string summary,bytes32 payload,string nonce,uint64 issuedAt,uint64 expiresAt)';
/** How long a signed sign-in or action may be used after it was made. */
export const ADMIN_SIGNATURE_TTL_MS = 5 * 60_000;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The writes there are, each checked against the route it is sent to. */
export const ADMIN_ACTIONS = ['ticket.reply', 'ticket.status', 'sessions.revoke', 'beta.add', 'beta.remove', 'board.add', 'board.move'] as const;
export type AdminActionName = (typeof ADMIN_ACTIONS)[number];

export interface AdminSignIn {
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

export interface AdminAction {
  owner: string;
  action: AdminActionName;
  /** What it acts on, e.g. "ticket 12" or "all sessions". */
  target: string;
  /** The line the wallet shows, e.g. the reply's first words. */
  summary: string;
  /** 0x + 64 hex: adminPayloadHash of the payload sent with it. */
  payload: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  chainId: number;
  signature: string;
}

/** JSON with its object keys sorted, so the browser and the server hash the same text. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** The `payload` an action signs: keccak-256 of the payload's canonical JSON, 0x-hex. */
export function adminPayloadHash(payload: unknown): string {
  const bytes = keccak_256(new TextEncoder().encode(canonicalJson(payload)));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** At most this many characters of a summary; the wallet shows it, the payload hash binds the rest. */
export const SUMMARY_MAX = 200;
export const summaryOf = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > SUMMARY_MAX ? `${one.slice(0, SUMMARY_MAX - 1)}…` : one;
};

const domainOf = (chainId: number) => ({ name: ADMIN_DOMAIN.name, version: ADMIN_DOMAIN.version, chainId, verifyingContract: ZERO_ADDRESS });
const DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

/** The typed data the wallet signs to sign in (eth_signTypedData_v4). */
export function adminSignInTypedData(s: Omit<AdminSignIn, 'signature'>) {
  return {
    domain: domainOf(s.chainId),
    types: {
      EIP712Domain: DOMAIN_FIELDS,
      AdminSignIn: [
        { name: 'owner', type: 'address' },
        { name: 'statement', type: 'string' },
        { name: 'nonce', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'AdminSignIn' as const,
    message: { owner: s.owner.toLowerCase(), statement: s.statement, nonce: s.nonce, issuedAt: s.issuedAt, expiresAt: s.expiresAt },
  };
}

/** The typed data the wallet signs for one write. */
export function adminActionTypedData(a: Omit<AdminAction, 'signature'>) {
  return {
    domain: domainOf(a.chainId),
    types: {
      EIP712Domain: DOMAIN_FIELDS,
      AdminAction: [
        { name: 'owner', type: 'address' },
        { name: 'action', type: 'string' },
        { name: 'target', type: 'string' },
        { name: 'summary', type: 'string' },
        { name: 'payload', type: 'bytes32' },
        { name: 'nonce', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'AdminAction' as const,
    message: {
      owner: a.owner.toLowerCase(), action: a.action, target: a.target, summary: a.summary, payload: a.payload,
      nonce: a.nonce, issuedAt: a.issuedAt, expiresAt: a.expiresAt,
    },
  };
}
