/**
 * Published ValueDesk indexes (owner 2026-11-28: "create your own ... ValueDesk indexes can also be published and users
 * can check out all, and their info"): the rules an index follows, and what a wallet signs to publish or take one down.
 * Pure, and shared with the web through its @sign alias (apps/web/src/trading/vdIndexApi.ts), so the page checks an
 * index by the same rules as the server and signs exactly what the server recomputes.
 *
 * An index is a name, a line about it and two to twelve SoDEX Wealth funds with whole basis-point weights adding up to
 * 10000. Publishing is free EIP-712 typed data with fixed wording, never a transaction, under a domain of its own so a
 * signature for the terms, a username or anything else is never one for this. Nothing about buying is published: what
 * a wallet bought stays in its own browser.
 */

export const INDEX_DOMAIN = { name: 'ValueDesk Index', version: '1' } as const;
export const INDEX_PUBLISH_STATEMENT = 'Publish my ValueDesk index for everyone to see. Free: a signature, never a transaction.';
export const INDEX_UNPUBLISH_STATEMENT = 'Take my published ValueDesk index down. Free: a signature, never a transaction.';
export const INDEX_TYPE = 'IndexAction(address owner,string id,string name,string description,string legs,string image,string statement,string nonce,uint64 issuedAt,uint64 expiresAt)';
/** How long a signed action may be used after it was made. */
export const INDEX_ACTION_TTL_MS = 10 * 60_000;
export const INDEX_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const INDEX_NAME_MIN = 3;
export const INDEX_NAME_MAX = 40;
export const INDEX_DESC_MAX = 280;
export const INDEX_LEGS_MIN = 2;
export const INDEX_LEGS_MAX = 12;
/** The whole: weights are basis points. */
export const INDEX_TOTAL_BP = 10_000;
/** The least a leg may weigh: 0.1% (owner 2026-11-28: small legs like 0.46% are fine). */
export const INDEX_LEG_MIN_BP = 10;
/** Published indexes one wallet may have up at once. */
export const INDEX_PER_WALLET_MAX = 20;

/** A published index's id: 'c' and nine base-36 characters, made by the server. '' in an action asks for a new one. */
export const INDEX_ID = /^c[0-9a-z]{9}$/;
/**
 * An index's picture: the SHA-256 of its bytes, lowercase hex, signed with the index; '' for none (the page draws a
 * default from the funds). The bytes go with the publish and are checked on the server (ops/imageCheck.ts: PNG, JPEG or
 * WebP judged by their bytes, nothing appended, no markup) and kept apart from the index; the browser re-encodes every
 * picture through a canvas to a small square first. Never a URL: nothing published can point a viewer anywhere.
 */
export const INDEX_IMAGE = /^[0-9a-f]{64}$/;
export const INDEX_IMAGE_SIDE = 512;
export const INDEX_IMAGE_MAX_BYTES = 96 * 1024;
/** A SoDEX Wealth fund id as SoDEX writes them (vQQQ, CXMT, Morpho-Earn, antb). */
export const FUND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export interface IndexLegBp {
  fundId: string;
  /** Basis points of the whole. */
  bp: number;
}

/** The one text the legs are signed and stored as: "vQQQ:4000,vSMH:3000,vVGT:3000", in the creator's order. */
export const legsText = (legs: readonly IndexLegBp[]): string => legs.map((l) => `${l.fundId}:${l.bp}`).join(',');

/** The legs a text names, or null when it is not in legsText's form. */
export function parseLegs(text: string): IndexLegBp[] | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 1000) return null;
  const out: IndexLegBp[] = [];
  for (const part of text.split(',')) {
    const m = /^([^:]+):(\d{1,5})$/.exec(part);
    if (!m || !FUND_ID.test(m[1]!)) return null;
    out.push({ fundId: m[1]!, bp: Number(m[2]) });
  }
  return out;
}

/**
 * Names that would read as ValueDesk's own indexes, SoDEX or their staff. Matched inside the name, case, spaces and
 * punctuation ignored: ValueDesk's indexes are the ones the page labels as ValueDesk's, never a name someone chose.
 */
const RESERVED_PARTS = ['valuedesk', 'valuescan', 'sodex', 'sosovalue', 'official', 'admin', 'support', 'verified'];
const NAME_CHARS = /^[\p{L}\p{N} &'’().,+/:-]+$/u;
// Written as escapes: a literal U+2028 is a line end inside a regex literal, so esbuild (tsx, Vite) refused this file.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/;
const LINK = /(https?:|www\.|\.(com|io|xyz|net|org|so|gg|app)\b)/i;

export type IndexProblem =
  | 'name-empty' | 'name-short' | 'name-long' | 'name-chars' | 'name-reserved'
  | 'desc-long' | 'desc-chars' | 'desc-link'
  | 'legs-few' | 'legs-many' | 'leg-fund' | 'leg-twice' | 'leg-small' | 'legs-sum';

/** A name with its spaces made single and its ends trimmed: what is stored and signed. */
export const tidyName = (s: string): string => s.replace(/\s+/g, ' ').trim();
export const tidyDescription = (s: string): string => s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** Why this index cannot be published, or null when the rules allow it. Expects tidied text. */
export function indexProblem(ix: { name: string; description: string; legs: readonly IndexLegBp[] }): IndexProblem | null {
  const name = ix.name;
  if (!name) return 'name-empty';
  if ([...name].length < INDEX_NAME_MIN) return 'name-short';
  if ([...name].length > INDEX_NAME_MAX) return 'name-long';
  if (!NAME_CHARS.test(name)) return 'name-chars';
  const bare = name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (RESERVED_PARTS.some((p) => bare.includes(p))) return 'name-reserved';
  if ([...ix.description].length > INDEX_DESC_MAX) return 'desc-long';
  if (CONTROL.test(ix.description.replace(/\n/g, ''))) return 'desc-chars';
  if (LINK.test(ix.description) || LINK.test(name)) return 'desc-link';
  const legs = ix.legs;
  if (legs.length < INDEX_LEGS_MIN) return 'legs-few';
  if (legs.length > INDEX_LEGS_MAX) return 'legs-many';
  const seen = new Set<string>();
  let sum = 0;
  for (const l of legs) {
    if (!FUND_ID.test(l.fundId)) return 'leg-fund';
    const k = l.fundId.toLowerCase();
    if (seen.has(k)) return 'leg-twice';
    seen.add(k);
    if (!Number.isInteger(l.bp) || l.bp < INDEX_LEG_MIN_BP) return 'leg-small';
    sum += l.bp;
  }
  if (sum !== INDEX_TOTAL_BP) return 'legs-sum';
  return null;
}

/** The problem in words, for the page and for an API error. */
export function indexProblemText(p: IndexProblem): string {
  switch (p) {
    case 'name-empty': return 'Give the index a name.';
    case 'name-short': return `A name needs at least ${INDEX_NAME_MIN} characters.`;
    case 'name-long': return `A name has at most ${INDEX_NAME_MAX} characters.`;
    case 'name-chars': return 'A name uses letters, numbers, spaces and & \' ( ) . , + / : - only.';
    case 'name-reserved': return 'This name reads as ValueDesk’s or SoDEX’s own. Choose another.';
    case 'desc-long': return `The description has at most ${INDEX_DESC_MAX} characters.`;
    case 'desc-chars': return 'The description has characters that cannot be shown.';
    case 'desc-link': return 'Links are not allowed in a published index.';
    case 'legs-few': return `Pick at least ${INDEX_LEGS_MIN} funds.`;
    case 'legs-many': return `An index holds at most ${INDEX_LEGS_MAX} funds.`;
    case 'leg-fund': return 'One of the funds is not a SoDEX Wealth fund id.';
    case 'leg-twice': return 'A fund is in the index twice.';
    case 'leg-small': return 'Every fund needs at least 0.1%.';
    case 'legs-sum': return 'The weights must add up to 100%.';
  }
}

export interface IndexAction {
  owner: string;
  /** The index's id; '' publishes a new one. */
  id: string;
  name: string;
  description: string;
  /** legsText of the legs. */
  legs: string;
  /** INDEX_IMAGE of the picture published with it, or ''. */
  image: string;
  /** INDEX_PUBLISH_STATEMENT or INDEX_UNPUBLISH_STATEMENT: which one says what is asked. */
  statement: string;
  /** 32 hex characters from the browser. */
  nonce: string;
  /** ms, decimal strings (uint64 in the typed data). */
  issuedAt: string;
  expiresAt: string;
  chainId: number;
  signature: string;
}

/** The typed data the wallet signs to publish or take down an index (eth_signTypedData_v4). */
export function indexTypedData(c: Omit<IndexAction, 'signature'>) {
  return {
    domain: { name: INDEX_DOMAIN.name, version: INDEX_DOMAIN.version, chainId: c.chainId, verifyingContract: INDEX_ZERO_ADDRESS },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      IndexAction: [
        { name: 'owner', type: 'address' },
        { name: 'id', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'description', type: 'string' },
        { name: 'legs', type: 'string' },
        { name: 'image', type: 'string' },
        { name: 'statement', type: 'string' },
        { name: 'nonce', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'IndexAction' as const,
    message: {
      owner: c.owner.toLowerCase(), id: c.id, name: c.name, description: c.description, legs: c.legs, image: c.image,
      statement: c.statement, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt,
    },
  };
}

/** One published index as the API answers it. */
export interface PublishedIndex {
  id: string;
  owner: string;
  /** The owner's ValueDesk username, when it has one. */
  ownerName: string | null;
  name: string;
  description: string;
  legs: IndexLegBp[];
  /** INDEX_IMAGE of its picture (GET /api/vs/indexes/image/<hash>), or null for the drawn default. */
  image: string | null;
  createdAt: number;
  updatedAt: number;
}
