/**
 * The signed-in Blind Box: a wallet's boxes opened, merged, claimed and gifted from this site (owner 2026-11-28: "so
 * users can see their boxes, open & merge them. Also if possible add a Bulk open & merge for big users ... only if
 * securely possible").
 *
 * HOW SODEX OPENS A BOX (read from its own page, 2026-11-28):
 *   GET  /box/sign-params?action=open|merge   -> {chainId, verifyingContract, domainName, domainVersion, primaryType, nonce, deadline}
 *   the wallet signs EIP-712 RequestOpen|RequestMerge(address owner, uint256[] tokenIds, uint256 nonce, uint256 deadline),
 *   the ids de-duplicated and sorted ascending, on SoDEXTreasureBox v1, chain 286623
 *   POST /box/open|merge {tokenIds, nonce, deadline, signature}  -> {jobId}
 *   GET  /job/<jobId> every 2 s until it is revealed (or fails), at most 180 s
 * SoDEX's relayer then sends the transaction; the user pays no gas. Every call passes our server (the box host sends no
 * CORS): routes/sodexLotteryUser.ts, the token from the SoPoints sign-in.
 *
 * SAFE BY CONSTRUCTION.
 * - Nothing is signed for the user: every request is one prompt in the user's wallet, and the request names the owner,
 *   so it can only open or merge that wallet's own boxes; the rewards go to that wallet's SoDEX account.
 * - Before a prompt the sign params are checked against what SoDEX's contract is (name, version, chain, contract, type):
 *   a changed answer is refused, never signed.
 * - Bulk is a queue of such requests, one after another (SoDEX runs one job per wallet at a time and each nonce once),
 *   each its own signature, stoppable between any two.
 * - A gift is the wallet's own ERC-721 transfer on ValueChain, sent by the wallet, to an address the user typed.
 */
import { NeedsPointsToken, clearPointsToken, getPointsToken } from './points';
import { SODEX_POINTS_SIGNIN_LIVE } from './sodexProgrammes';
import { addOrSwitchChain, getChainId, sendTransaction, signTypedData, type Eip1193Provider } from './wallet';
import type { Level, Reward } from './blindBox';
import { nftPicture } from './trading/chainHoldings';

const RELAY = '/api/vs/sodex/lottery/u';

/** What SoDEX's box contract is: the sign params must say exactly this before anything is signed. */
export const TREASURE_BOX = {
  name: 'SoDEXTreasureBox',
  version: '1',
  chainId: 286623,
  address: '0x371c4f7f68be3e558b89cc1f0fb113851c76e750',
} as const;
/** Cybereator, the PFP a box can drop. */
export const CYBEREATOR = '0xcd30d4bcaa99e556b70a2c4bdfc4050d26e48d30';
export const VALUEMINT = 'https://www.valuemint.store';
export const valuemintCollection = (address: string): string => `${VALUEMINT}/collection/${address.toLowerCase()}`;
export const CYBEREATOR_SITE = 'https://cybereator.com';

export const VALUECHAIN_PARAMS = {
  chainId: '0x45f9f',
  chainName: 'ValueChain',
  rpcUrls: ['https://rpc.valuechain.xyz'],
  blockExplorerUrls: ['https://main-scan.valuechain.xyz'],
  nativeCurrency: { name: 'SOSO', symbol: 'SOSO', decimals: 18 },
};

export class BoxApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'BoxApiError'; }
}

type Fetch = typeof fetch;

/** One relayed call with the wallet's SoDEX token; a dead token is dropped and asked for again. */
async function call<T>(address: string, path: string, body?: unknown, f: Fetch = fetch): Promise<T> {
  if (!SODEX_POINTS_SIGNIN_LIVE) throw new NeedsPointsToken();
  const token = getPointsToken(address);
  if (!token) throw new NeedsPointsToken();
  const r = await f(RELAY + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'omit',
  });
  const j = (await r.json().catch(() => null)) as { code?: number; msg?: string; data?: T } | null;
  if (r.status === 401 || j?.code === 401) { clearPointsToken(); throw new NeedsPointsToken(); }
  if (!r.ok || j?.code !== 0) throw new BoxApiError(j?.msg || `SoDEX answered ${r.status}`, r.status);
  return j.data as T;
}

const nOf = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export interface SignParams { chainId: number; verifyingContract: string; domainName: string; domainVersion: string; primaryType: string; nonce: string; deadline: string }

/** The sign params, refused unless they are SoDEX's box contract and the type the action needs. */
export function checkParams(raw: unknown, action: 'open' | 'merge', box: string = TREASURE_BOX.address): SignParams {
  const d = obj(raw);
  const p: SignParams = {
    chainId: Number(d.chainId), verifyingContract: String(d.verifyingContract ?? ''), domainName: String(d.domainName ?? ''),
    domainVersion: String(d.domainVersion ?? ''), primaryType: String(d.primaryType ?? ''), nonce: String(d.nonce ?? ''), deadline: String(d.deadline ?? ''),
  };
  const want = action === 'open' ? 'RequestOpen' : 'RequestMerge';
  const ok = p.chainId === TREASURE_BOX.chainId && p.verifyingContract.toLowerCase() === box.toLowerCase() && p.domainName === TREASURE_BOX.name
    && p.domainVersion === TREASURE_BOX.version && p.primaryType === want && /^[0-9]{1,78}$/.test(p.nonce) && /^[0-9]{1,20}$/.test(p.deadline);
  if (!ok) throw new BoxApiError('SoDEX sent sign details that are not its box contract\'s, so nothing was signed.', 0);
  return p;
}

/** De-duplicated and ascending, as SoDEX's contract checks them. */
export const sortIds = (ids: readonly string[]): string[] =>
  [...new Set(ids.map((x) => BigInt(x)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String);

export function typedRequest(p: SignParams, owner: string, ids: readonly string[]) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ],
      [p.primaryType]: [
        { name: 'owner', type: 'address' }, { name: 'tokenIds', type: 'uint256[]' },
        { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: p.primaryType,
    domain: { name: p.domainName, version: p.domainVersion, chainId: p.chainId, verifyingContract: p.verifyingContract },
    message: { owner, tokenIds: sortIds(ids), nonce: p.nonce, deadline: p.deadline },
  };
}

export interface OpenedBox { tokenId: string; level: string | null; rewardUsd: number | null; reward: Reward | null; pfpTokenId: string | null }
export interface MergedBox { tokenId: string; level: string | null; consumed: string[] }
export interface JobResult { jobId: string; status: string; opened: OpenedBox[]; merged: MergedBox[] }

const DONE = /^(revealed|done|completed|success|settled|merged)$/i;
const FAILED = /^(failed|error|rejected|expired|cancel+ed)$/i;

export function readJob(jobId: string, raw: unknown): JobResult {
  const d = obj(raw);
  const boxes = Array.isArray(d.boxes) ? d.boxes : Array.isArray(d.results) ? d.results : [];
  const opened: OpenedBox[] = [];
  const merged: MergedBox[] = [];
  for (const b of boxes.map(obj)) {
    const consumed = Array.isArray(b.consumedTokenIds) ? b.consumedTokenIds.map(String) : null;
    if (consumed) merged.push({ tokenId: String(b.tokenId ?? ''), level: typeof b.level === 'string' ? b.level : null, consumed });
    else opened.push({
      tokenId: String(b.tokenId ?? ''), level: typeof b.level === 'string' ? b.level : null, rewardUsd: nOf(b.rewardUsd),
      reward: b.reward && typeof b.reward === 'object' ? (b.reward as Reward) : null,
      pfpTokenId: b.pfpTokenId === undefined || b.pfpTokenId === null || b.pfpTokenId === '' || String(b.pfpTokenId) === '0' ? null : String(b.pfpTokenId),
    });
  }
  return { jobId, status: String(d.status ?? ''), opened, merged };
}

export interface BoxDeps { fetchImpl?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number }

/** Waits for SoDEX to finish one job: every 2 s, at most 180 s. */
export async function waitJob(address: string, jobId: string, deps: BoxDeps = {}): Promise<JobResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const until = now() + 180_000;
  for (;;) {
    const j = readJob(jobId, await call(address, `/job/${encodeURIComponent(jobId)}`, undefined, deps.fetchImpl));
    if (DONE.test(j.status)) return j;
    if (FAILED.test(j.status)) throw new BoxApiError(`SoDEX could not finish it (${j.status}). Your boxes are unchanged unless they show as opened.`, 0);
    if (now() > until) throw new BoxApiError('SoDEX is still working on it. Check your boxes again in a minute.', 0);
    await sleep(2_000);
  }
}

/** One open or merge: the sign params checked, the wallet's one prompt, SoDEX's job waited for. */
export async function runRequest(o: { action: 'open' | 'merge'; address: string; provider: Eip1193Provider; ids: readonly string[]; box?: string; onSigned?: () => void }, deps: BoxDeps = {}): Promise<JobResult> {
  const p = checkParams(await call(o.address, `/box/sign-params?action=${o.action}`, undefined, deps.fetchImpl), o.action, o.box);
  /* MetaMask and others refuse typed data for another chain than the one they are on. */
  if ((await getChainId(o.provider)) !== p.chainId) await addOrSwitchChain(o.provider, VALUECHAIN_PARAMS);
  const typed = typedRequest(p, o.address, o.ids);
  const signature = await signTypedData(o.provider, o.address, typed);
  o.onSigned?.();
  const sent = obj(await call(o.address, `/box/${o.action}`, { tokenIds: typed.message.tokenIds, nonce: p.nonce, deadline: p.deadline, signature }, deps.fetchImpl));
  const jobId = String(sent.jobId ?? '');
  if (!jobId) throw new BoxApiError('SoDEX took the request but sent no job to follow. Check your boxes again in a minute.', 0);
  return waitJob(o.address, jobId, deps);
}

/** Open: up to `per` ids a request (SoDEX's maxBoxOpen). Merge: exactly the tier's merge size a request. */
export function batches(action: 'open' | 'merge', ids: readonly string[], size: number): string[][] {
  const s = sortIds(ids);
  const out: string[][] = [];
  if (size < 1) return out;
  for (let i = 0; i + (action === 'merge' ? size : 1) <= s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** The claim of earned boxes into the wallet (SoDEX's "Open treasure"); one job like an open. */
export async function claimTreasure(address: string, count: number, deps: BoxDeps = {}): Promise<JobResult | null> {
  const sent = obj(await call(address, '/treasure/open', { count }, deps.fetchImpl));
  return sent.jobId ? waitJob(address, String(sent.jobId), deps) : null;
}

export interface Treasures { total: number | null; maxPerOpen: number | null }
export const readTreasures = async (address: string): Promise<Treasures> => {
  const d = obj(await call(address, '/treasures'));
  return { total: nOf(d.total), maxPerOpen: nOf(d.maxPerOpen) };
};

export interface Progress { effectiveU: number | null; boxesEarned: number | null; toNextBoxU: number | null }
export const readProgress = async (address: string): Promise<Progress> => {
  const d = obj(await call(address, '/progress'));
  return { effectiveU: nOf(d.effectiveU), boxesEarned: nOf(d.boxesEarned), toNextBoxU: nOf(d.toNextBoxU) };
};

export interface HistoryItem { tokenId: string; level: string | null; rewardUsd: number | null; reward: Reward | null; pfpTokenId: string | null; at: number | null }
export const readHistory = async (address: string, limit = 50): Promise<HistoryItem[]> => {
  const d = obj(await call(address, `/history?limit=${limit}&offset=0`));
  const items = Array.isArray(d.items) ? d.items.map(obj) : [];
  return items.map((h) => ({
    tokenId: String(h.tokenId ?? ''), level: typeof h.level === 'string' ? h.level : null, rewardUsd: nOf(h.rewardUsd),
    reward: h.reward && typeof h.reward === 'object' ? (h.reward as Reward) : null,
    pfpTokenId: h.pfpTokenId === undefined || h.pfpTokenId === null || String(h.pfpTokenId) === '0' ? null : String(h.pfpTokenId),
    at: typeof h.settledAt === 'string' ? Date.parse(h.settledAt) : nOf(h.tsMs),
  }));
};

/* --- gifts: the wallet's own ERC-721 transfer on ValueChain ------------------------------------------------------ */

const word = (hex: string): string => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
/** safeTransferFrom(address,address,uint256) */
export const giftData = (from: string, to: string, tokenId: string): string =>
  `0x42842e0e${word(from)}${word(to)}${BigInt(tokenId).toString(16).padStart(64, '0')}`;

export const isAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

/** Sends one NFT (a box or a Cybereator) from the wallet to `to`; the wallet shows the transaction and pays its gas. */
export async function gift(o: { provider: Eip1193Provider; from: string; to: string; contract: string; tokenId: string }): Promise<string> {
  const to = o.to.trim();
  if (!isAddress(to)) throw new BoxApiError('That is not a wallet address.', 0);
  if (to.toLowerCase() === o.from.toLowerCase()) throw new BoxApiError('That is this wallet.', 0);
  if ((await getChainId(o.provider)) !== TREASURE_BOX.chainId) await addOrSwitchChain(o.provider, VALUECHAIN_PARAMS);
  return sendTransaction(o.provider, { from: o.from, to: o.contract, data: giftData(o.from, to, o.tokenId), value: '0x0', chainId: TREASURE_BOX.chainId });
}

/* --- what boxes paid: GET /api/vs/sodex/lottery/rewards (server valuedesk/boxRewards.ts) -------------------------- */

export interface Tally { n: number; avg: number; median: number; p25: number; p75: number; low: number; high: number; total: number }
export interface LevelRewards extends Tally { common: Array<{ usd: number; share: number }>; recent: Tally | null }
export interface RewardsDoc { at: number; block: number; boxes: number; opens: number; levels: Partial<Record<Level, LevelRewards>> }

export async function fetchRewards(signal?: AbortSignal): Promise<RewardsDoc> {
  const r = await fetch('/api/vs/sodex/lottery/rewards', { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) });
  if (!r.ok) throw new Error(r.status === 503 ? 'The history is still being read.' : `The server answered ${r.status}`);
  return (await r.json()) as RewardsDoc;
}

/**
 * Merge or open, by what boxes paid (NFT drops left out): a merge of `size` boxes of a tier is worth the next tier's
 * average, opening them `size` times this tier's. Medians too, since a few large wins lift an average.
 */
export function mergeAdvice(doc: RewardsDoc | null, from: Level, to: Level, size: number): { openAvg: number; mergeAvg: number; openMedian: number; mergeMedian: number; gain: number; n: [number, number] } | null {
  const a = doc?.levels[from];
  const b = doc?.levels[to];
  if (!a || !b || size < 1) return null;
  return { openAvg: a.avg * size, mergeAvg: b.avg, openMedian: a.median * size, mergeMedian: b.median, gain: b.avg - a.avg * size, n: [a.n, b.n] };
}

/* --- the wallet's Cybereators, from ValueChain's explorer -------------------------------------------------------- */

export interface Cybereator { id: string; name: string; image: string | null; traits: Array<{ type: string; value: string }>; link: string }
const EXPLORER = 'https://main-scan.valuechain.xyz';

/** Every Cybereator the wallet holds (the explorer's instances by holder, 50 a page, at most 20 pages). */
export async function readCybereators(owner: string, f: Fetch = fetch): Promise<Cybereator[]> {
  const out: Cybereator[] = [];
  let next: Record<string, unknown> | null = {};
  for (let page = 0; next && page < 20; page += 1) {
    const q = new URLSearchParams({ holder_address_hash: owner, ...Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])) });
    const r = await f(`${EXPLORER}/api/v2/tokens/${CYBEREATOR}/instances?${q}`, { credentials: 'omit' });
    if (!r.ok) throw new Error(`ValueChain's explorer answered ${r.status}`);
    const j = (await r.json()) as { items?: Array<Record<string, unknown>>; next_page_params?: Record<string, unknown> | null };
    for (const n of j.items ?? []) {
      const md = obj(n.metadata);
      const id = String(n.id ?? '');
      out.push({
        id, name: typeof md.name === 'string' && md.name ? `${md.name} #${id}` : `Cybereator #${id}`,
        image: nftPicture(n as never),
        traits: (Array.isArray(md.attributes) ? md.attributes : []).map(obj).filter((a) => a.trait_type != null && a.value != null).map((a) => ({ type: String(a.trait_type), value: String(a.value) })),
        link: `${EXPLORER}/token/${CYBEREATOR}/instance/${id}`,
      });
    }
    next = j.next_page_params ?? null;
  }
  return out;
}

/* --- prices on valuemint.store: GET /api/vs/nft/floors ------------------------------------------------------------ */

export interface MarketDoc {
  collections: Record<string, { name: string; floor: number | null; listed: number; tiers: Record<string, { floor: number; listed: number }>; bestOffer: number | null; offers: number }>;
  tokens?: Record<string, Record<string, [number | null, number | null]>>;
}
export async function fetchMarket(signal?: AbortSignal): Promise<MarketDoc> {
  const r = await fetch('/api/vs/nft/floors', { credentials: 'omit', ...(signal ? { signal } : {}) });
  if (!r.ok) throw new Error(`The server answered ${r.status}`);
  return (await r.json()) as MarketDoc;
}
