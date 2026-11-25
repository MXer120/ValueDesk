/**
 * Referrals and fee credits (owner 2026-11-14): the rules the server and the page share (the web reads this file
 * through its @sign alias), and what an invited wallet signs to join.
 *
 *   The code       a wallet's own SoDEX referral code (every SoDEX account has one; SoDEX's public API says whose a code
 *                  is). One link does both: valuedesk.so/?ref=<CODE> joins the inviter on ValueDesk, and the same code
 *                  is the one the invited wallet is offered on SoDEX (owner: "they get their valuedesk code applied +
 *                  the underlying sodex code").
 *   Joining        the invited wallet signs once (free EIP-712 typed data, never a transaction) after it accepted the
 *                  site's terms. Refused: its own code, ValueDesk's own code, a wallet that traded on ValueDesk already
 *                  (not when SoDEX has it under this very inviter: every link lost its code until 2026-11-25),
 *                  a wallet that has referrals of its own (no loops), a second join (the first stands).
 *   Credits        of the ValueDesk builder fees a wallet really pays (the builder ledger's counted orders), its inviter
 *                  gets TIER_SHARES[0], the inviter's inviter TIER_SHARES[1], the next TIER_SHARES[2] (each at
 *                  VIP_TIER_SHARES while it is VIP itself) - for as long as
 *                  it trades. Credits pay only the wallet's own ValueDesk builder fee: while they last its fee is
 *                  CREDIT_FEE and the rest is taken from them. Never paid out, never moved.
 *   Welcome        a wallet that joined pays no ValueDesk builder fee on its first WELCOME_USD of volume (all of its
 *                  SoDEX volume since the join counts, wherever it traded). Every join has it:
 *                  invites have no limit (owner 2026-11-25; was 50 welcomes per inviter in 30 days).
 */

/** Of the ValueDesk fees a wallet pays: its inviter's credit, the inviter's inviter's, the next one's. */
export const TIER_SHARES = [0.15, 0.05, 0.01] as const; // owner 2026-11-25: 15 / 5 / 1% (was 20 / 7.5 / 2% for everyone)
/** The same for an earner that is VIP when the credit is given (owner 2026-11-25: "for vip its the current tiers"). */
export const VIP_TIER_SHARES = [0.2, 0.075, 0.02] as const;
export const sharesFor = (vip: boolean): readonly [number, number, number] => (vip ? VIP_TIER_SHARES : TIER_SHARES);
export const TIERS = TIER_SHARES.length;
/**
 * The builder fee while credits pay: 1 tenth of a bp. Not 0: the builder ledger sees an order only when it paid a
 * builder fee (builder/counting.ts), and what credits paid is counted on exactly those orders.
 */
export const CREDIT_FEE = 1;
/** Credits start paying from this balance (USD) - or more, see creditsOnAt - and stop at 0. */
export const CREDIT_MIN_USD = 0.05;
/**
 * Credits switch on only when they cover this many minutes of the wallet's own recent trading: what an order can still
 * run at the credit fee before the switch reaches it (the signed fee's life, the executor's re-read, the ledger's sweep).
 */
export const CREDIT_COVER_MIN = 15;
/** The welcome: no ValueDesk builder fee on the first this much volume after the join (USD). */
export const WELCOME_USD = 100_000;
export const WELCOME_FEE = 0;
/**
 * A lowered fee from credits or the welcome is handed out for this long at a time: the signed terms and the executor
 * ask again within it, so neither runs on after the credits or the welcome ran out.
 */
export const PERK_HORIZON_MS = 3 * 60_000;

/**
 * A VIP code (owner 2026-11-25): a wallet that joins with the code of a VIP wallet, or with one upgraded on the dev page,
 * pays the VIP fee (the lowest tier of each product) for this many days from its join. Not VIP itself: its own code is
 * no VIP code for it. (The one-time VIP credit ended the same day, store.ts totals.)
 */
export const VIP_CODE_DAYS = 7;
export const VIP_CODE_LABEL = 'VIP invite';

/**
 * A wallet that joined through a referral starts at the fee tier of this much volume (owner 2026-11-15: "referred
 * traders start at tier 1, so >100k"): its site tier and its copy and bot ladder steps read at least this volume.
 * Its own volume counts once it is higher.
 */
export const REFERRED_START_USD = 100_000;

/* ------------------------------------------------------------------- the weekly claim ----- */

/**
 * Credits are claimed by the week (owner 2026-11-25: "only be claimabile every tuesday from 12utc, then the whole 7days,
 * but only for that week"). A week runs from a Tuesday 12:00 UTC to the next, as SoDEX's own. What a wallet earned in one
 * week it can claim from that week's end, for the 7 days until the next week ends; then the next week's claim takes its
 * place. A claimed credit pays fees until it is used up, however long that takes. Credits from before the claims began
 * (the store's 'claims-from') needed none and keep paying.
 */
export const WEEK_MS = 7 * 86_400_000;
/** A Tuesday, 12:00 UTC (SoDEX's Layer 1 Season began on it). */
export const WEEK_ANCHOR = Date.UTC(2026, 8, 1, 12);
export const weekOf = (t: number): number => Math.floor((t - WEEK_ANCHOR) / WEEK_MS);
export const weekStart = (week: number): number => WEEK_ANCHOR + week * WEEK_MS;
/** The week whose claim is open at `t`: the one that ended last. Open until `closesAt`. */
export const claimWindow = (t: number): { week: number; opensAt: number; closesAt: number } => {
  const now = weekOf(t);
  return { week: now - 1, opensAt: weekStart(now), closesAt: weekStart(now + 1) };
};

export const CLAIM_DOMAIN = { name: 'ValueDesk Credits', version: '1' } as const;
export const CLAIM_STATEMENT = 'Claim my ValueDesk fee credits of this week. Free: a signature, never a transaction.';
export const CLAIM_TYPE = 'CreditClaim(address wallet,uint64 week,string statement,string nonce,uint64 issuedAt,uint64 expiresAt)';

export interface CreditClaim {
  wallet: string;
  week: number;
  statement: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  chainId: number;
  signature: string;
}

/** The typed data the wallet signs to claim (eth_signTypedData_v4). */
export function claimTypedData(c: Omit<CreditClaim, 'signature'>) {
  return {
    domain: { name: CLAIM_DOMAIN.name, version: CLAIM_DOMAIN.version, chainId: c.chainId, verifyingContract: INVITE_ZERO_ADDRESS },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      CreditClaim: [
        { name: 'wallet', type: 'address' },
        { name: 'week', type: 'uint64' },
        { name: 'statement', type: 'string' },
        { name: 'nonce', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'CreditClaim' as const,
    message: { wallet: c.wallet.toLowerCase(), week: String(c.week), statement: c.statement, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt },
  };
}

/** Why a claim is refused. */
export type ClaimRefusal = 'closed' | 'nothing' | 'claimed';

/** A wallet's claim as /api/vs/invites/me answers it. */
export interface InviteClaims {
  /** The week whose claim is open now, what it holds, and whether it was claimed. */
  week: number;
  opensAt: number;
  closesAt: number;
  usd: number;
  claimed: boolean;
  /** Earned in the week that runs now: claimable from `closesAt` on. */
  pendingUsd: number;
  /** Claimed so far, and what lapsed unclaimed. */
  claimedUsd: number;
  lapsedUsd: number;
}

/** One UTC day of a wallet's credit ledger: every day there is, summed (the history lists only the newest entries). */
export interface CreditDay { day: number; kind: 'earn' | 'spend' | 'claim'; tier: number | null; usd: number }

/** ValueDesk's own SoDEX code: it refers nobody on ValueDesk (its fees are ValueDesk's). */
export const OURS_CODE = 'VALUEDESK';
/** A SoDEX referral code, upper case. */
export const CODE_RE = /^[A-Z0-9]{4,20}$/;
export const normCode = (s: string): string => s.trim().toUpperCase();
/** The page's address parameter: valuedesk.so/?ref=<CODE>. */
export const INVITE_PARAM = 'ref';

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

/** Why a join is refused. */
export type JoinRefusal = 'unknown-code' | 'ours' | 'self' | 'joined' | 'has-volume' | 'has-referrals' | 'sodex-silent';

/** A code as /api/vs/invites/check answers it. */
export interface InviteCheck {
  ok: true;
  valid: boolean;
  /** Whether a wallet joining now gets the welcome (the inviter's cap). */
  welcome: boolean;
  /** Days of the VIP fee a wallet joining now gets (0: not a VIP code). */
  vipDays?: number;
}

export interface InviteReferral {
  /** Shortened: the page never names a referral whole. */
  wallet: string;
  tier: 1 | 2 | 3;
  rate: number;
  at: number;
  perpsUsd: number;
  spotUsd: number;
  earnedUsd: number;
  welcome: boolean;
}

export interface InviteEntry {
  at: number;
  /** earn: a share of a referral's fee; spend: a fee credits paid; grant: credit given (the VIP credit); claim: a week's credits claimed. */
  kind: 'earn' | 'spend' | 'grant' | 'claim';
  usd: number;
  tier: number | null;
  /** The referral it came from, shortened (earn only). */
  from: string | null;
}

/** A wallet's referrals and credits, as /api/vs/invites/me answers it. */
export interface InviteMe {
  ok: true;
  /** Whom this wallet joined (null: nobody). */
  joined: { inviter: string; code: string; at: number } | null;
  /** May this wallet still join: never joined, no ValueDesk volume, no referrals of its own. */
  canJoin: boolean;
  /** Why not, when it may not ('has-volume' is lifted by SoDEX naming the same inviter, routes/invites.ts). */
  blocked?: 'joined' | 'has-volume' | 'has-referrals' | null;
  welcome: { active: boolean; usedUsd: number; leftUsd: number; limitUsd: number } | null;
  /** The VIP fee from a VIP code: until when (null: none, or over). */
  vipUntil?: number | null;
  /** This wallet is VIP now: it earns VIP_TIER_SHARES (absent: a server from before 2026-11-25). */
  vip?: boolean;
  /** This wallet's own code gives the VIP days now. */
  vipCode?: boolean;
  credits: { balanceUsd: number; earnedUsd: number; grantedUsd: number; spentUsd: number; paying: boolean; rates: readonly number[] };
  stats: { referred: [number, number, number]; perpsUsd: number; spotUsd: number; earnedUsd: number };
  referrals: InviteReferral[];
  history: InviteEntry[];
  /** The weekly claim (absent: a server from before it - credits apply by themselves there). */
  claims?: InviteClaims;
  /** The whole ledger by UTC day (absent: as above). */
  days?: CreditDay[];
}
