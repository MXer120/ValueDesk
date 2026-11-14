/**
 * Whose a SoDEX referral code is, from SoDEX's public API (no login): `checkEligibility` with a code names the wallet
 * behind it ("" for no such code). The answers are kept: a code does not change hands.
 */
const BIZ = (process.env.VALUESCAN_SODEX_BIZ?.trim() || 'https://alpha-biz.sodex.dev').replace(/\/+$/, '');
const TIMEOUT_MS = 8_000;
/** Any wallet will do for asking whose a code is; this one asks nothing of anyone. */
const PROBE = '0x0000000000000000000000000000000000000001';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** The owner of a code: an address, null for no such code, undefined when SoDEX did not answer. */
export async function sodexOwnerOf(code: string, fetcher: FetchLike = fetch as unknown as FetchLike): Promise<string | null | undefined> {
  try {
    const r = await fetcher(`${BIZ}/biz/referral/checkEligibility?walletAddress=${PROBE}&referralCode=${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { code?: number; data?: { inviterWalletAddress?: unknown } };
    if (j.code !== 0 || !j.data) return undefined;
    const w = typeof j.data.inviterWalletAddress === 'string' ? j.data.inviterWalletAddress : '';
    return ADDRESS.test(w) ? w.toLowerCase() : null;
  } catch {
    return undefined;
  }
}
