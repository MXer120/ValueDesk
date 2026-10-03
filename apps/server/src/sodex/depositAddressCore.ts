/**
 * Which deposit address to show for one coin on one chain - and when to show
 * none - plus SoDEX's issuer reads, with the transport injected. Pure: the
 * server binds it in depositAddress.ts, the browser reads the same sources
 * directly (sodex.com's API answers any origin; the registries are public
 * ValueChain views).
 *
 * sodex.com's rules, with every place it is laxer made strict:
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

/** One POST to sodex.com's API: the HTTP status and the parsed body (null when unreadable). */
export type BizPost = (path: string, body: unknown, timeoutMs: number) => Promise<{ ok: boolean; status: number; body: any }>;

export interface IssuerReads {
  /** The chain's current deposit address for `account` (custody `getDepositWallet`). */
  currentDepositWallet(account: string, chain: string): Promise<string | null>;
  /**
   * sodex.com's per-chain status read: POST `deposit_address {account, chain}`.
   * null when SoDEX did not answer (the on-chain checks still stand).
   */
  issuerDepositStatus(account: string, chain: string): Promise<{ status: IssuerStatus; address: string | null } | null>;
  /**
   * Ask SoDEX for a new deposit address on `chain` (sodex.com's "Confirm &
   * Update Address"): POST `replace_deposit_address {account, chain}`. Only ever
   * called when the user asks for it. Clears this account's cached reads.
   */
  replaceDepositAddress(account: string, chain: string): Promise<void>;
  /**
   * Ask SoDEX to ISSUE a deposit address on `chain` where it has none yet - what sodex.com's Deposit sheet does
   * when a chain's status is empty: POST `create_deposit_address {account, chain}`. Without it a wallet never
   * gets an address on Bitcoin, XRP, Stellar ... (the bulk `create_deposit_addresses` issues the EVM chains
   * only - seen 2026-10-03). At most once per wallet and chain every 10 minutes (a minute after a refused
   * request); never throws.
   */
  requestDepositAddress(account: string, chain: string): Promise<void>;
  forgetDepositReads(account: string): void;
}

const TTL = 60_000;
const MAX_CACHED = 1_000;
/** How often the same wallet and chain may ask SoDEX to issue an address - and again after a refused request. */
const REQUEST_EVERY_MS = 10 * 60_000;
const RETRY_REFUSED_MS = 60_000;

function bounded<V>(m: Map<string, V>): void {
  while (m.size > MAX_CACHED) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

export function issuerReads(getDepositWallet: (account: string, chain: string) => Promise<string | null>, post: BizPost): IssuerReads {
  const currentCache = new Map<string, { at: number; value: Promise<string | null> }>();
  const statusCache = new Map<string, { at: number; value: Promise<{ status: IssuerStatus; address: string | null } | null> }>();
  /** When each wallet and chain last asked SoDEX to issue an address. */
  const requested = new Map<string, number>();

  const reads: IssuerReads = {
    currentDepositWallet(account, chain) {
      const key = `${account.toLowerCase()}:${chain.toUpperCase()}`;
      const hit = currentCache.get(key);
      if (hit && Date.now() - hit.at < TTL) return hit.value;
      const value = getDepositWallet(account, chain);
      currentCache.delete(key);
      currentCache.set(key, { at: Date.now(), value });
      bounded(currentCache);
      return value;
    },

    issuerDepositStatus(account, chain) {
      const key = `${account.toLowerCase()}:${chain.toUpperCase()}`;
      const hit = statusCache.get(key);
      if (hit && Date.now() - hit.at < TTL) return hit.value;
      const value = (async () => {
        try {
          const r = await post('/biz/mirror/deposit_address', { account, chain }, 15_000);
          const body = r.body as { code?: unknown; data?: { status?: unknown; address?: unknown } } | null;
          if (!r.ok || !body?.data) return null;
          return { status: issuerStatus(body.data.status), address: typeof body.data.address === 'string' && body.data.address ? body.data.address : null };
        } catch {
          return null;
        }
      })();
      statusCache.delete(key);
      statusCache.set(key, { at: Date.now(), value });
      bounded(statusCache);
      value.then((v) => v === null && statusCache.delete(key)).catch(() => statusCache.delete(key));
      return value;
    },

    async replaceDepositAddress(account, chain) {
      const r = await post('/biz/mirror/replace_deposit_address', { account, chain }, 20_000);
      const body = r.body as { code?: unknown; msg?: string; message?: string } | null;
      const code = body?.code;
      if (!r.ok || (code !== undefined && code !== 0 && code !== '0' && code !== 200)) {
        throw new Error(body?.msg || body?.message || `SoDEX refused (HTTP ${r.status})`);
      }
      reads.forgetDepositReads(account);
    },

    async requestDepositAddress(account, chain) {
      const key = `${account.toLowerCase()}:${chain.toUpperCase()}`;
      const at = requested.get(key);
      if (at !== undefined && Date.now() - at < REQUEST_EVERY_MS) return;
      requested.delete(key);
      requested.set(key, Date.now());
      bounded(requested);
      let taken = false;
      try {
        const r = await post('/biz/mirror/create_deposit_address', { account, chain }, 15_000);
        const code = (r.body as { code?: unknown } | null)?.code;
        taken = r.ok && (code === undefined || String(code) === '0');
      } catch {
        /* no answer: below */
      }
      // Refused or unanswered: the next read may ask again a minute from now (the deposit sheet keeps polling).
      if (!taken) requested.set(key, Date.now() - REQUEST_EVERY_MS + RETRY_REFUSED_MS);
      reads.forgetDepositReads(account);
    },

    forgetDepositReads(account) {
      const prefix = `${account.toLowerCase()}:`;
      for (const m of [currentCache, statusCache] as Array<Map<string, unknown>>) {
        for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
      }
    },
  };
  return reads;
}
