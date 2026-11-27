/**
 * SoDEX's squads, as sodex.com's own points page reads and names them (its bundle, read 2026-11-27; notes in the
 * session folder sodex-squad-api-2026-11-27.md):
 *
 *   GET  biz/referral/team/name?walletAddress=   public: the name of the squad a wallet built and of the one it joined,
 *                                                whether it may still name its own (canSet) and whether it did (alreadySet)
 *   POST biz/referral/team/name {teamName}       the sign-in token: names the squad the wallet built, ONCE (SoDEX:
 *                                                "It can only be set once"); no signature, no transaction
 *   GET  biz/sopoints/v2/team/members?sort=cum   the sign-in token: both squads' members and each one's energy
 *
 * Joining a squad is binding an inviter's code (biz/referral/v3/join), once, with no way to leave or switch. That stays
 * on SoDEX's own join page (onboarding/referral.ts: its sign-in token for that call only comes from SoDEX's origins),
 * so here a code is only looked up: whose squad it is and its name, public reads.
 */
import { SODEX_POINTS_SIGNIN_LIVE } from '../../sodexProgrammes';
import { SodexError, authed, authedPost } from '../../points';

const BIZ = 'https://alpha-biz.sodex.dev';
const TIMEOUT_MS = 10_000;
/** SoDEX's own placeholder wallet for a code lookup (its invite dialog uses the same). */
const PROBE = '0x0000000000000000000000000000000000000001';

export interface SquadNames { built: string | null; joined: string | null; canSet: boolean; alreadySet: boolean }

export type SquadRole = 'inviter' | 'sibling' | 'self' | 'downline';
export interface SquadMember { address: string; role: SquadRole; energy: number }
export interface SquadList { total: number; truncated: boolean; members: SquadMember[] }
export interface SquadMembers { joined: SquadList; built: SquadList; asOf: number | null }

/** SoDEX's words for a member's place: the captain leads the squad, a teammate is in it with you. */
export const ROLE_WORD: Record<SquadRole, string> = { inviter: 'Captain', sibling: 'Teammate', self: 'You', downline: 'Member' };

async function publicGet<T>(path: string): Promise<T> {
  const r = await fetch(`${BIZ}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const j = (await r.json().catch(() => null)) as { code?: number; msg?: string; data?: T } | null;
  if (!r.ok || !j || j.code !== 0) throw new SodexError(j?.msg || `${r.status} from ${path.split('?')[0]}`, j?.code ?? null);
  return j.data as T;
}

const clean = (x: unknown): string | null => {
  const s = typeof x === 'string' ? x.trim() : '';
  return s ? s : null;
};

export async function fetchSquadNames(address: string): Promise<SquadNames> {
  const d = await publicGet<{ teamName?: string; uplineTeamName?: string; canSet?: boolean; alreadySet?: boolean }>(`/biz/referral/team/name?walletAddress=${encodeURIComponent(address)}`);
  return { built: clean(d?.teamName), joined: clean(d?.uplineTeamName), canSet: !!d?.canSet, alreadySet: !!d?.alreadySet };
}

const list = (x: unknown): SquadList => {
  const o = (x ?? {}) as { total?: unknown; truncated?: unknown; items?: unknown };
  const items = Array.isArray(o.items) ? o.items : [];
  return {
    total: Number(o.total) || 0,
    truncated: !!o.truncated,
    members: items.map((m) => m as { walletAddress?: unknown; role?: unknown; volume?: unknown }).map((m) => ({
      address: String(m.walletAddress ?? ''),
      role: (['inviter', 'sibling', 'self', 'downline'].includes(String(m.role)) ? String(m.role) : 'downline') as SquadRole,
      energy: Number(m.volume) || 0,
    })),
  };
};

export async function fetchSquadMembers(address: string): Promise<SquadMembers> {
  const d = await authed<{ uplineTeam?: unknown; invitees?: unknown; asOfTsMs?: unknown }>(`${BIZ}/biz/sopoints/v2/team/members?sort=cum`, address);
  return { joined: list(d?.uplineTeam), built: list(d?.invitees), asOf: Number(d?.asOfTsMs) || null };
}

/* -------------------------------------------------------------------------------------- the name ----- */

export const NAME_MIN = 4;
export const NAME_MAX = 40;
const ALLOWED = /^[A-Za-z0-9 ぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+$/u;
const RESERVED = /sodex|sosovalue|official/i;

/** SoDEX's own rules, as its page checks them before it asks: trimmed, single spaces, 4-40 characters, letters,
 * numbers and spaces (Japanese, Chinese and Korean letters too), none of its reserved words. */
export function checkSquadName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim().replace(/\s+/g, ' ');
  const n = Array.from(name).length;
  if (n < NAME_MIN) return { ok: false, error: `At least ${NAME_MIN} characters.` };
  if (n > NAME_MAX) return { ok: false, error: `At most ${NAME_MAX} characters.` };
  if (!ALLOWED.test(name)) return { ok: false, error: 'Only letters, numbers and spaces are allowed.' };
  if (RESERVED.test(name)) return { ok: false, error: 'This name is not available.' };
  return { ok: true, name };
}

/** SoDEX's answer to a naming, in words. */
export function nameError(e: unknown): string {
  const code = e instanceof SodexError ? e.code : null;
  if (code === -3001070) return 'This name is not available.';
  if (code === -3001050) return 'Naming unlocks with your invite code: reach SoDEX’s trading volume or vault deposit threshold first.';
  if (e instanceof Error && e.name === 'NeedsPointsToken') return 'Sign in to SoDEX again to name your squad.';
  return 'SoDEX did not take the name. Try again in a moment.';
}

/** Names the squad the wallet built, once (the wallet's SoDEX sign-in; no signature, no transaction). */
export async function nameSquad(address: string, raw: string): Promise<string> {
  if (!SODEX_POINTS_SIGNIN_LIVE) throw new Error('SoDEX sign-in is off here.');
  const c = checkSquadName(raw);
  if (!c.ok) throw new Error(c.error);
  await authedPost<unknown>(`${BIZ}/biz/referral/team/name`, address, { teamName: c.name });
  return c.name;
}

/* -------------------------------------------------------------------------------------- a code ----- */

/** A code as SoDEX takes it: capitals and digits, at most 18. */
export const codeOf = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 18);

/** Whose squad a code is and its name (two public reads); null when SoDEX knows no such code. */
export async function squadOfCode(code: string): Promise<{ captain: string; name: string | null } | null> {
  const c = codeOf(code);
  if (c.length < 4) return null;
  const e = await publicGet<{ inviterWalletAddress?: string }>(`/biz/referral/checkEligibility?walletAddress=${PROBE}&referralCode=${encodeURIComponent(c)}`).catch(() => null);
  const captain = e?.inviterWalletAddress && /^0x[0-9a-fA-F]{40}$/.test(e.inviterWalletAddress) ? e.inviterWalletAddress : null;
  if (!captain) return null;
  const n = await fetchSquadNames(captain).catch(() => null);
  return { captain, name: n?.built ?? null };
}
