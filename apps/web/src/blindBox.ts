/**
 * SoDEX's Blind Boxes, view only (owner 2026-11-05: no opening for now). Nothing here signs or posts;
 * opening and merging happen on SoDEX's own page.
 *
 * THREE SOURCES:
 *  - the public rules and feed, through our server (the host sends no CORS): routes/sodexLottery.ts;
 *  - a wallet's boxes, read from the browser off the chain: `readWalletBoxes` below;
 *  - the signed-in reads (progress, history, draw), behind SODEX_SIGNIN_LIVE, off today. They would call
 *    `mainnet-lottery.sodex.dev` directly, no proxy of ours. They 401 without a token, so their fields are
 *    from the mock SoDEX ships in its own public bundle, not from a real answer: every one is read
 *    defensively and a missing one prints as a dash. Check them on a real wallet before the switch goes on.
 */
import { assertSigninLive, SODEX_SIGNIN_LIVE } from './sodexProgrammes';
import { serverGetJson } from './serverFetch';
import { vsPaths } from './vsPaths';

export const LEVELS = ['Common', 'Uncommon', 'Rare', 'SuperRare'] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_LABEL: Record<Level, string> = { Common: 'Common', Uncommon: 'Uncommon', Rare: 'Rare', SuperRare: 'SuperRare' };

export const isLevel = (v: unknown): v is Level => (LEVELS as readonly unknown[]).includes(v);
export const nextLevel = (l: Level): Level | null => LEVELS[LEVELS.indexOf(l) + 1] ?? null;

/* --- the public half: GET /api/vs/sodex/lottery/* ---------------------------------------------- */

export interface RewardAsset { address?: string; symbol: string; decimals?: number }
export interface Reward { asset?: RewardAsset; amount?: string; amountRaw?: string; destination?: string }

export interface LotteryRules {
  volumePerBoxU: number;
  takerWeightBps: number;
  makerWeightBps: number;
  newcomerMaxUAtBound?: number;
  maxTradeBoxesPerWallet?: number | null;
  milestones: Array<{ thresholdU: number; beneficiary: string; level: string }>;
  rewardBands: Array<{ level: string; minUsd: string; maxUsd: string }>;
  mergeSize: Record<string, number>;
  tradeBoxLevels: string[];
  limits: { maxTreasureOpen?: number; maxBoxOpen?: number };
}

export interface LotteryMeta {
  contracts?: { treasureBox?: string; distribute?: string; pfp?: string };
  rewardTokens?: Array<{ asset?: RewardAsset; priceUsd?: string; destination?: string }>;
  rules: LotteryRules;
}

export interface FeedItem {
  kind: string;
  tsMs: number;
  /** Masked by SoDEX ("0x06bd....22d6"). */
  wallet: string;
  level: string;
  tokenId: number;
  rewardUsd?: string;
  reward?: Reward;
  pfp?: boolean;
}

export interface LotteryFeed { minLevel: string | null; items: FeedItem[]; stale?: boolean }

const readPublic = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
  const r = await serverGetJson<T & { error?: string }>(path, signal);
  if (!r.ok || !r.body) throw new Error(r.body?.error || `The server answered ${r.status}`);
  return r.body;
};

export const fetchLotteryMeta = (signal?: AbortSignal): Promise<LotteryMeta> => readPublic(vsPaths.lotteryMeta, signal);

/** How many recent openings the Blind Box page's feed shows. */
export const LOTTERY_FEED_SIZE = 24;
export const fetchLotteryFeed = (limit: number, signal?: AbortSignal): Promise<LotteryFeed> => readPublic(vsPaths.lotteryFeed(limit), signal);

/** The steps of the merge ladder that exist: `mergeSize` 0 means that level cannot be merged. */
export function mergeLadder(rules: Pick<LotteryRules, 'mergeSize'>): Array<{ from: Level; to: Level; consume: number }> {
  const out: Array<{ from: Level; to: Level; consume: number }> = [];
  for (const from of LEVELS) {
    const consume = rules.mergeSize?.[from] ?? 0;
    const to = nextLevel(from);
    if (consume > 0 && to) out.push({ from, to, consume });
  }
  return out;
}

export const bpsToPct = (bps: number): number => bps / 100;

/* --- a wallet's boxes, off the chain ----------------------------------------------------------- */

/**
 * WHAT THE CONTRACT GIVES, checked live 2026-11-05 (verified source, implementation of the treasureBox
 * proxy): `balanceOf`, standard ERC-721 Transfer logs (the ERC-2309 ConsecutiveTransfer exists in its ABI,
 * so it is read too; none seen so far), and `boxLevels(uint256[])`, an enum 0..3 in the order of LEVELS.
 * That matched SoDEX's own feed on 100 of 100 boxes. The netted logs matched `balanceOf` on the 12 largest
 * holders, up to 3,939 logs, in about 2 s.
 *
 * NEVER A GUESS. The ids are the logs replayed, and they are only shown when they add up to `balanceOf` at
 * the same block; the tiers come from the contract for exactly those ids. If the logs fail, are limited or
 * disagree, the count stands alone (`exact: false`).
 */
export const VALUECHAIN_RPC = 'https://rpc.valuechain.xyz';

const SEL_BALANCE_OF = '0x70a08231';
const SEL_BOX_LEVELS = '0x0d3be4e8';
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TOPIC_CONSECUTIVE = '0xdeaa91b6123d068f5821d0fb0678463d1a8a6079fe8af5de3ce5e896dcf9133d';
const LEVEL_BATCH = 200;

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export const valuechainRpc = (signal?: AbortSignal): Rpc => async (method, params) => {
  const r = await fetch(VALUECHAIN_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    credentials: 'omit',
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) throw new Error(`ValueChain answered ${r.status}`);
  const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message || 'ValueChain refused the read');
  return j.result;
};

const word = (hex: string): string => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uintWord = (n: bigint): string => n.toString(16).padStart(64, '0');

export interface WalletBoxes {
  /** `balanceOf`: always exact. */
  count: number;
  /** True only when the ids below add up to `count`. */
  exact: boolean;
  byLevel: Record<Level, string[]>;
}

interface RawLog { topics?: string[]; data?: string; blockNumber?: string; logIndex?: string }

const emptyByLevel = (): Record<Level, string[]> => ({ Common: [], Uncommon: [], Rare: [], SuperRare: [] });

/** The token ids a wallet holds, by replaying its transfers in chain order. Exported for the tests. */
export function replayTransfers(logs: readonly RawLog[], wallet: string): string[] {
  const me = word(wallet);
  const key = (l: RawLog): [bigint, bigint] => [BigInt(l.blockNumber ?? 0), BigInt(l.logIndex ?? 0)];
  const seen = new Set<string>();
  const ordered = logs
    .filter((l) => {
      const k = `${l.blockNumber}:${l.logIndex}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => {
      const [ab, ai] = key(a);
      const [bb, bi] = key(b);
      return ab < bb ? -1 : ab > bb ? 1 : ai < bi ? -1 : ai > bi ? 1 : 0;
    });
  const held = new Set<bigint>();
  const apply = (from: string, to: string, id: bigint) => {
    if (word(from) === me) held.delete(id);
    if (word(to) === me) held.add(id);
  };
  for (const l of ordered) {
    const t = l.topics ?? [];
    if (t[0] === TOPIC_TRANSFER && t.length === 4) apply(t[1]!, t[2]!, BigInt(t[3]!));
    else if (t[0] === TOPIC_CONSECUTIVE && t.length === 4 && l.data) {
      const last = BigInt(l.data.slice(0, 66));
      for (let id = BigInt(t[1]!); id <= last; id += 1n) apply(t[2]!, t[3]!, id);
    }
  }
  return [...held].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String);
}

/** Each id's tier from the contract, in order. Throws rather than return one it cannot name. */
async function readLevels(rpc: Rpc, box: string, ids: readonly string[], block: string): Promise<Level[]> {
  const out: Level[] = [];
  for (let i = 0; i < ids.length; i += LEVEL_BATCH) {
    const chunk = ids.slice(i, i + LEVEL_BATCH);
    const data = SEL_BOX_LEVELS + uintWord(32n) + uintWord(BigInt(chunk.length)) + chunk.map((id) => uintWord(BigInt(id))).join('');
    const res = String(await rpc('eth_call', [{ to: box, data }, block]));
    const words = res.replace(/^0x/, '').match(/.{64}/g) ?? [];
    if (words.length !== chunk.length + 2) throw new Error('boxLevels answered the wrong length');
    for (const w of words.slice(2)) {
      const level = LEVELS[Number(BigInt(`0x${w}`))];
      if (!level) throw new Error('boxLevels answered an unknown tier');
      out.push(level);
    }
  }
  return out;
}

export async function readWalletBoxes(address: string, box: string, rpc: Rpc): Promise<WalletBoxes> {
  /* One block for every read, so a box moving between two calls cannot look like a mismatch. */
  const block = String(await rpc('eth_blockNumber', []));
  const count = Number(BigInt(String(await rpc('eth_call', [{ to: box, data: SEL_BALANCE_OF + word(address) }, block]))));
  const countOnly: WalletBoxes = { count, exact: false, byLevel: emptyByLevel() };
  if (count === 0) return { count, exact: true, byLevel: emptyByLevel() };
  try {
    const me = `0x${word(address)}`;
    const q = (topics: Array<string | null>) => rpc('eth_getLogs', [{ address: box, fromBlock: 'earliest', toBlock: block, topics }]) as Promise<RawLog[]>;
    const sets = await Promise.all([
      q([TOPIC_TRANSFER, null, me]),
      q([TOPIC_TRANSFER, me]),
      q([TOPIC_CONSECUTIVE, null, null, me]),
      q([TOPIC_CONSECUTIVE, null, me]),
    ]);
    const ids = replayTransfers(sets.flat(), address);
    if (ids.length !== count) return countOnly;
    const levels = await readLevels(rpc, box, ids, block);
    const byLevel = emptyByLevel();
    ids.forEach((id, i) => byLevel[levels[i]!].push(id));
    return { count, exact: true, byLevel };
  } catch {
    return countOnly;
  }
}

/* --- the signed-in reads, behind the switch ---------------------------------------------------- */

export interface ProgressAnswer {
  effectiveU: number | null;
  boxesEarned: number | null;
  toNextBoxU: number | null;
}
export interface HistoryRow { requestId?: number | string; tokenId?: number | string; level?: string; rewardUsd?: string; reward?: Reward; pfpTokenId?: number | string; settledAt?: string }
export interface HistoryAnswer { total: number | null; totalRewardUsd: string | null; items: HistoryRow[] }
export interface DrawAnswer {
  round: number | string | null;
  status: string | null;
  deadlineMs: number | null;
  tickets: number | null;
  wins: number | null;
  entries: Array<{ tokenId?: number | string; level?: string; won?: boolean; prizeLevel?: string }>;
}
export interface TreasuresAnswer {
  total: number | null;
  maxPerOpen: number | null;
}

export interface BlindBoxDeps {
  fetchImpl: typeof fetch;
  /** The SoDEX bearer for the connected wallet. */
  token: () => string | null;
  base?: string;
  /** Test seam only. */
  live?: boolean;
}

export const LOTTERY_API = 'https://mainnet-lottery.sodex.dev/api/v1/lottery';

export class BlindBoxApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'BlindBoxApiError'; }
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const nOf = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export interface BlindBoxReads {
  treasures(): Promise<TreasuresAnswer>;
  progress(): Promise<ProgressAnswer>;
  history(): Promise<HistoryAnswer>;
  ledger(): Promise<{ total: number | null; items: Array<Record<string, unknown>> }>;
  drawEntries(): Promise<DrawAnswer | null>;
}

/** GETs only. There is no write in this client on purpose. */
export function createBlindBoxReads(deps: BlindBoxDeps): BlindBoxReads {
  const live = deps.live ?? SODEX_SIGNIN_LIVE;
  const base = deps.base ?? LOTTERY_API;

  const get = async <T>(path: string): Promise<T> => {
    assertSigninLive(live);
    const token = deps.token();
    if (!token) throw new BlindBoxApiError('Sign in to SoDEX first.', 401);
    const r = await deps.fetchImpl(base + path, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      credentials: 'omit',
    });
    const j = (await r.json().catch(() => null)) as { code?: number; msg?: string; data?: T } | null;
    if (!r.ok || j?.code !== 0) throw new BlindBoxApiError(j?.msg || `SoDEX ${r.status}`, r.status);
    return j.data as T;
  };

  return {
    treasures: async () => {
      const d = obj(await get('/treasures'));
      return { total: nOf(d.total), maxPerOpen: nOf(d.maxPerOpen) };
    },
    progress: async () => {
      const d = obj(await get('/progress'));
      return { effectiveU: nOf(d.effectiveU), boxesEarned: nOf(d.boxesEarned), toNextBoxU: nOf(d.toNextBoxU) };
    },
    history: async () => {
      const d = obj(await get('/history'));
      return { total: nOf(d.total), totalRewardUsd: typeof d.totalRewardUsd === 'string' ? d.totalRewardUsd : null, items: arr(d.items) };
    },
    ledger: async () => {
      const d = obj(await get('/ledger'));
      return { total: nOf(d.total), items: arr(d.items) };
    },
    drawEntries: async () => {
      /* SoDEX answers "no draw yet" with a non-zero code, which is not a fault. */
      const raw = await get<unknown>('/draw/entries').catch((e: unknown) => {
        if (e instanceof Error && /no draw yet/i.test(e.message)) return null;
        throw e;
      });
      if (!raw) return null;
      const d = obj(raw);
      return {
        round: (d.round as number | string | undefined) ?? null,
        status: typeof d.status === 'string' ? d.status : null,
        deadlineMs: nOf(d.deadlineMs),
        tickets: nOf(d.tickets),
        wins: nOf(d.wins),
        entries: arr(d.entries),
      };
    },
  };
}
