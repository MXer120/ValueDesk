/**
 * Read-only JSON-RPC to public chain endpoints: balances, straight from the
 * chain, in one batched request per chain. Nothing here signs or sends; every
 * host used must be in index.html's connect-src.
 */

/** ValueChain's public RPC (the same entry walletconnect.ts hands the wallet). */
export const VALUECHAIN_RPC = 'https://rpc.valuechain.xyz';

const READ_TIMEOUT_MS = 6000;

export interface RpcCall {
  method: string;
  params: unknown[];
}

/**
 * Other public nodes of the same chain, asked when its usual node does not answer (no reply in time, an error
 * status, or not a batch answer) - READS only, like everything in this file. Polygon's node answered 529 to the
 * site's smoke test and gave no answer for 15 minutes in a live run (2026-10-03). Each host is in connect-src.
 */
export const RPC_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  'https://polygon-bor-rpc.publicnode.com': ['https://polygon.drpc.org', 'https://1rpc.io/matic'],
};

/** Answers by position in `calls`; a call the node refused reads undefined. Another node of the chain if one does not answer. */
export async function rpcBatch(url: string, calls: RpcCall[]): Promise<Map<number, string | undefined>> {
  let last: unknown;
  for (const u of [url, ...(RPC_FALLBACKS[url] ?? [])]) {
    try {
      return await rpcBatchFrom(u, calls);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function rpcBatchFrom(url: string, calls: RpcCall[]): Promise<Map<number, string | undefined>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), READ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: '2.0', id, ...c }))),
      signal: ctl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const answers = (await res.json()) as Array<{ id: number; result?: string }>;
    if (!Array.isArray(answers)) throw new Error(`${url}: not a batch answer`);
    return new Map(answers.map((a) => [a.id, a.result]));
  } finally {
    clearTimeout(timer);
  }
}

const pad32 = (addr: string) => addr.replace(/^0x/, '').toLowerCase().padStart(64, '0');
/** ERC-20 balanceOf(owner). */
export const balanceOfCall = (token: string, owner: string): RpcCall => ({
  method: 'eth_call',
  params: [{ to: token, data: `0x70a08231${pad32(owner)}` }, 'latest'],
});
/** The chain's gas-coin balance. */
export const nativeBalanceCall = (owner: string): RpcCall => ({ method: 'eth_getBalance', params: [owner, 'latest'] });

/** A hex quantity as base units, or null when the answer is not one. */
export const hexUnits = (hex: string | undefined): bigint | null => {
  if (hex === '0x') return 0n;
  return hex && /^0x[0-9a-f]+$/i.test(hex) ? BigInt(hex) : null;
};

/** One JSON-RPC call; the node's error (with any revert data) is returned, not thrown. */
export async function rpcCall<T = string>(
  url: string,
  method: string,
  params: unknown[],
): Promise<{ result?: T; error?: { code?: number; message?: string; data?: string } }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), READ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const j = (await res.json()) as { result?: T; error?: { code?: number; message?: string; data?: unknown } };
    const data = j.error?.data;
    return j.error ? { error: { code: j.error.code, message: j.error.message, data: typeof data === 'string' ? data : undefined } } : { result: j.result };
  } finally {
    clearTimeout(timer);
  }
}
