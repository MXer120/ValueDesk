/**
 * Which deposit address to show for one coin on one chain - and when to show
 * none. sodex.com's rules, with every place it is laxer made strict:
 *
 *   sodex.com shows the per-coin registry's FIRST entry
 *   (`getDepositWalletList(account, coin)[chain][0]`, SOSO/sSOSO: the custody
 *   contract's `getDepositWallet`). The custody contract APPENDS when SoDEX
 *   replaces an address, so after a replacement that first entry is the OLDEST
 *   address while `getDepositWallet` is the current one (verified contract
 *   source, SoDexTokenCustody._setDepositWallet; research 2026-09-26).
 *
 * Here the address shown is the CURRENT one (`getDepositWallet`), and only if
 *   - the per-coin registry lists it for this coin (so it is this coin's
 *     address, not only the chain's), when that registry could be read;
 *   - SoDEX's issuer agrees, where it answered for this chain (REST row or
 *     `deposit_address`), and
 *   - SoDEX has not flagged it: a "Suspicious" status withholds the address
 *     (sodex.com shows it under a warning with "Confirm & Update Address";
 *     here it is withheld until the user asks SoDEX for the new one).
 * A coin/chain the per-coin registry lists as empty is not offered (sodex.com
 * shows no address for it either). An XRP/Stellar entry carrying a ":memo"
 * is not offered: sodex.com drops the memo, and a memo nobody shows is a
 * deposit that may never be credited.
 */
import { getDepositWallet } from './mirrorRegistry.js';

export type IssuerStatus = 'Enabled' | 'Processing' | 'Suspicious' | 'Empty';

/** sodex.com's own mapping of the issuer's status (anything unknown is "Empty"). */
export const issuerStatus = (s: unknown): IssuerStatus =>
  s === 'Enabled' ? 'Enabled' : s === 'Processing' ? 'Processing' : s === 'Suspicious' ? 'Suspicious' : 'Empty';

export type Pick =
  | { ok: true; address: string }
  | { ok: false; flagged: boolean; reason: string };

const EVM_LIKE = /^0x[0-9a-fA-F]{40}$/;
/** EVM addresses compare case-insensitively (checksum casing); every other format byte for byte. */
export const sameDepositAddress = (a: string, b: string): boolean =>
  EVM_LIKE.test(a) && EVM_LIKE.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;

export function pickDepositAddress(i: {
  chain: string;
  /** `getDepositWallet(account, chain)` - the current address (null: none on-chain). */
  current: string | null;
  /** The per-coin registry's list for this chain; undefined when that read failed or the coin has none (SOSO). */
  list?: readonly string[];
  /** The issuer's word on this chain, when it gave one. */
  issuer?: { status: IssuerStatus; address?: string | null } | null;
}): Pick {
  if (i.issuer?.status === 'Suspicious') {
    return { ok: false, flagged: true, reason: 'SoDEX flagged this deposit address - request the new one before depositing' };
  }
  const current = i.current?.trim() || null;
  if (i.list && i.list.length === 0) return { ok: false, flagged: false, reason: 'no address issued for this coin on this chain yet' };
  if (!current) return { ok: false, flagged: false, reason: 'no current deposit address on-chain' };
  if (i.list && !i.list.some((a) => sameDepositAddress(a.trim(), current))) {
    return { ok: false, flagged: false, reason: 'the current address is not this coin\'s registered address' };
  }
  const issued = i.issuer?.address?.trim();
  if (issued && !sameDepositAddress(issued, current)) return { ok: false, flagged: false, reason: 'SoDEX\'s issuer and the chain disagree on the address' };
  if (!i.list && !issued) return { ok: false, flagged: false, reason: 'only one source confirms this address' };
  if (/^(XRP|XLM)$/i.test(i.chain) && current.includes(':')) return { ok: false, flagged: false, reason: 'the address carries a memo' };
  return { ok: true, address: current };
}

// --- reads (cached briefly; nothing here is trusted without the checks above) ----------------

const BIZ_API = process.env.SODEX_BIZ_API?.trim() || 'https://alpha-biz.sodex.dev';
const TTL = 60_000;
const currentCache = new Map<string, { at: number; value: Promise<string | null> }>();
const statusCache = new Map<string, { at: number; value: Promise<{ status: IssuerStatus; address: string | null } | null> }>();

/** The chain's current deposit address for `account` (custody `getDepositWallet`). */
export function currentDepositWallet(account: string, chain: string): Promise<string | null> {
  const key = `${account.toLowerCase()}:${chain.toUpperCase()}`;
  const hit = currentCache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = getDepositWallet(account, chain);
  currentCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * sodex.com's per-chain status read: POST `deposit_address {account, chain}`.
 * null when SoDEX did not answer (the on-chain checks still stand).
 */
export function issuerDepositStatus(account: string, chain: string): Promise<{ status: IssuerStatus; address: string | null } | null> {
  const key = `${account.toLowerCase()}:${chain.toUpperCase()}`;
  const hit = statusCache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = (async () => {
    try {
      const res = await fetch(`${BIZ_API}/biz/mirror/deposit_address`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, chain }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => null)) as { code?: unknown; data?: { status?: unknown; address?: unknown } } | null;
      if (!res.ok || !body?.data) return null;
      return { status: issuerStatus(body.data.status), address: typeof body.data.address === 'string' && body.data.address ? body.data.address : null };
    } catch {
      return null;
    }
  })();
  statusCache.set(key, { at: Date.now(), value });
  value.then((v) => v === null && statusCache.delete(key)).catch(() => statusCache.delete(key));
  return value;
}

/**
 * Ask SoDEX for a new deposit address on `chain` (sodex.com's "Confirm &
 * Update Address"): POST `replace_deposit_address {account, chain}`. Only ever
 * called when the user asks for it. Clears this account's cached reads.
 */
export async function replaceDepositAddress(account: string, chain: string): Promise<void> {
  const res = await fetch(`${BIZ_API}/biz/mirror/replace_deposit_address`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, chain }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as { code?: unknown; msg?: string; message?: string } | null;
  const code = body?.code;
  if (!res.ok || (code !== undefined && code !== 0 && code !== '0' && code !== 200)) {
    throw new Error(body?.msg || body?.message || `SoDEX refused (HTTP ${res.status})`);
  }
  forgetDepositReads(account);
}

export function forgetDepositReads(account: string): void {
  const prefix = `${account.toLowerCase()}:`;
  for (const m of [currentCache, statusCache] as Array<Map<string, unknown>>) {
    for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
  }
}
