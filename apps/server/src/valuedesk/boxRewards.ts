/**
 * What SoDEX Blind Boxes actually paid, per tier, from the chain (owner 2026-11-28: "a switch from our research that
 * shows the actual rewards avg median high and low historically and to where a user should merge excluding nft
 * rewards").
 *
 * SOURCE, all public on ValueChain (checked 2026-11-28):
 * - the box contract's `OpenRequested(uint256 indexed requestId, address indexed owner, address indexed by,
 *   uint256[] tokenIds)` names the boxes of each open;
 * - the distribute contract's `Distributed(uint256 indexed requestId, address indexed owner, address[] tokens,
 *   uint256[] rewards, uint256[] tokenAmounts)` pays them: `rewards[i]` is the i-th box's reward in USD with 6 decimals
 *   (a 3-box open paid [1, 1.65, 1]); an open paid in one token only emits the contract's other event, topics
 *   (requestId, owner, token) and data (uint256[] rewards, uint256 tokenAmount), the rewards the same way;
 * - the box contract's `boxLevels(uint256[])` gives each box's tier, kept after opening (it matched SoDEX's own feed
 *   on 100 of 100 boxes, 2026-11-28).
 * A PFP NFT a box also drops is not in `rewards`: these figures leave NFT rewards out, as asked.
 *
 * COST. The first read walks from the programme's start (block 14.57M) in 19k-block steps (the RPC's cap is
 * 20k); after that each refresh reads only the new blocks. The state is kept in one file, so a restart does not read
 * the history again. Answered as one small document; nothing per visitor reaches the chain.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const RPC = 'https://rpc.valuechain.xyz';
const BOX = '0x371c4f7f68be3e558b89cc1f0fb113851c76e750';
const DIST = '0x8517c546d124f57c6e9bbc714979149cd0b54167';
const T_OPEN = '0xaca65089642eb3213ea21bd970b49c78f1000a823c5a5a65ae5c6433b76e4d8a';
const T_DIST = '0xab283dcfb79e5b773038ab108c0caa5afaaaa0a882ae47598fc62176df443dc6';
/** The one-token payout: topics (requestId, owner, token), data (uint256[] rewards, uint256 tokenAmount). */
const T_DIST_ONE = '0xf52bf02fadcc9fd50899c4b99bc93c3ba801e2c4db2c25814efcfbc088493685';
const SEL_BOX_LEVELS = '0x0d3be4e8';
export const LEVELS = ['Common', 'Uncommon', 'Rare', 'SuperRare'] as const;
export type Level = (typeof LEVELS)[number];
/** Just before the first open (request 0, block 14,571,264). */
const START_BLOCK = 14_571_000;
const STEP = 19_000;
const REFRESH_MS = 10 * 60_000;
/** Blocks behind the head left for the next read, so a reorg cannot leave a half-read block behind. */
const LAG = 5;
const SEC_PER_BLOCK_FALLBACK = 2.04;

export interface Tally { n: number; avg: number; median: number; p25: number; p75: number; low: number; high: number; total: number }
export interface LevelStats extends Tally {
  /** The most frequent rewards: value (USD) and share of boxes, the largest shares first. */
  common: Array<{ usd: number; share: number }>;
  /** The same tally over the last 30 days only (bands change). */
  recent: Tally | null;
}
export interface RewardsDoc {
  source: 'valuechain';
  at: number;
  block: number;
  boxes: number;
  opens: number;
  since: number | null;
  levels: Partial<Record<Level, LevelStats>>;
}

/** A box paid: its tier index, the block it was paid in, the reward in micro-USD. */
type Paid = [level: number, block: number, usdMicro: number];
interface State { v: 1; cursor: number; pending: Record<string, string[]>; paid: Paid[]; opens: number; firstBlock: number | null }

const words = (hex: string): bigint[] => (hex.replace(/^0x/, '').match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`));
const arrayAt = (w: bigint[], offset: bigint): bigint[] => {
  const i = Number(offset / 32n);
  const n = Number(w[i] ?? 0n);
  return w.slice(i + 1, i + 1 + n);
};
const word = (n: bigint): string => n.toString(16).padStart(64, '0');

/** An OpenRequested log: its request and its boxes. */
export function openOf(l: { topics?: string[]; data?: string }): { requestId: string; ids: string[] } | null {
  if (l.topics?.[0] !== T_OPEN || !l.topics[1] || !l.data) return null;
  const w = words(l.data);
  return { requestId: BigInt(l.topics[1]).toString(), ids: arrayAt(w, w[0] ?? 0n).map(String) };
}

/** A payout log (either event): its request and each box's reward in micro-USD. */
export function paidOf(l: { topics?: string[]; data?: string }): { requestId: string; rewards: number[] } | null {
  const t = l.topics?.[0];
  if ((t !== T_DIST && t !== T_DIST_ONE) || !l.topics?.[1] || !l.data) return null;
  const w = words(l.data);
  return { requestId: BigInt(l.topics[1]).toString(), rewards: arrayAt(w, (t === T_DIST ? w[1] : w[0]) ?? 0n).map(Number) };
}

const quantile = (s: readonly number[], q: number): number => {
  if (!s.length) return 0;
  const p = (s.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return s[lo]! + (s[hi]! - s[lo]!) * (p - lo);
};
const round2 = (x: number): number => Math.round(x * 100) / 100;

export function tally(usd: readonly number[]): Tally | null {
  if (!usd.length) return null;
  const s = [...usd].sort((a, b) => a - b);
  const total = s.reduce((a, b) => a + b, 0);
  return { n: s.length, avg: round2(total / s.length), median: round2(quantile(s, 0.5)), p25: round2(quantile(s, 0.25)), p75: round2(quantile(s, 0.75)), low: round2(s[0]!), high: round2(s[s.length - 1]!), total: round2(total) };
}

/** The document from the paid boxes; `recentFrom` is the first block of the last 30 days. */
export function buildRewards(st: Pick<State, 'paid' | 'opens' | 'firstBlock'>, block: number, recentFrom: number, at: number): RewardsDoc {
  const levels: RewardsDoc['levels'] = {};
  LEVELS.forEach((name, li) => {
    const rows = st.paid.filter((p) => p[0] === li);
    const all = tally(rows.map((p) => p[2] / 1e6));
    if (!all) return;
    const freq = new Map<number, number>();
    for (const p of rows) freq.set(p[2], (freq.get(p[2]) ?? 0) + 1);
    const common = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u, c]) => ({ usd: round2(u / 1e6), share: Math.round((c / rows.length) * 10_000) / 10_000 }));
    levels[name] = { ...all, common, recent: tally(rows.filter((p) => p[1] >= recentFrom).map((p) => p[2] / 1e6)) };
  });
  return { source: 'valuechain', at, block, boxes: st.paid.length, opens: st.opens, since: st.firstBlock, levels };
}

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

const httpRpc: Rpc = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`ValueChain answered ${r.status}`);
  const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message || 'ValueChain refused the read');
  return j.result;
};

async function levelsOf(rpc: Rpc, ids: readonly string[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const data = SEL_BOX_LEVELS + word(32n) + word(BigInt(chunk.length)) + chunk.map((id) => word(BigInt(id))).join('');
    const w = words(String(await rpc('eth_call', [{ to: BOX, data }, 'latest'])));
    if (w.length !== chunk.length + 2) throw new Error('boxLevels answered the wrong length');
    for (const x of w.slice(2)) { const n = Number(x); if (n > 3) throw new Error('boxLevels answered an unknown tier'); out.push(n); }
  }
  return out;
}

/** Reads the blocks after the cursor into the state; returns the head read to. */
export async function advance(st: State, rpc: Rpc, maxSteps = Infinity): Promise<number> {
  const head = Number(BigInt(String(await rpc('eth_blockNumber', [])))) - LAG;
  let steps = 0;
  while (st.cursor < head && steps++ < maxSteps) {
    const from = st.cursor + 1;
    const to = Math.min(head, from + STEP - 1);
    const range = { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
    const [opens, paid] = await Promise.all([
      rpc('eth_getLogs', [{ ...range, address: BOX, topics: [T_OPEN] }]) as Promise<Array<{ topics?: string[]; data?: string; blockNumber?: string }>>,
      rpc('eth_getLogs', [{ ...range, address: DIST, topics: [[T_DIST, T_DIST_ONE]] }]) as Promise<Array<{ topics?: string[]; data?: string; blockNumber?: string }>>,
    ]);
    for (const l of opens) { const o = openOf(l); if (o) { st.pending[o.requestId] = o.ids; st.opens += 1; } }
    const matched: Array<{ id: string; block: number; usd: number }> = [];
    for (const l of paid) {
      const p = paidOf(l);
      const ids = p && st.pending[p.requestId];
      if (!p || !ids || ids.length !== p.rewards.length) continue;
      const block = Number(BigInt(l.blockNumber ?? '0x0'));
      ids.forEach((id, i) => matched.push({ id, block, usd: p.rewards[i]! }));
      delete st.pending[p.requestId];
    }
    if (matched.length) {
      const lv = await levelsOf(rpc, matched.map((m) => m.id));
      matched.forEach((m, i) => st.paid.push([lv[i]!, m.block, m.usd]));
      st.firstBlock ??= matched[0]!.block;
    }
    st.cursor = to;
  }
  return st.cursor;
}

const fresh = (): State => ({ v: 1, cursor: START_BLOCK, pending: {}, paid: [], opens: 0, firstBlock: null });

function load(file: string | null): State {
  if (!file || !existsSync(file)) return fresh();
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as State;
    return s?.v === 1 && Array.isArray(s.paid) ? s : fresh();
  } catch {
    return fresh();
  }
}

function save(file: string | null, st: State): void {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(st));
  renameSync(`${file}.tmp`, file);
}

let state: State | null = null;
let doc: RewardsDoc | null = null;
let running: Promise<RewardsDoc> | null = null;

async function refresh(file: string | null, rpc: Rpc): Promise<RewardsDoc> {
  state ??= load(file);
  const block = await advance(state, rpc);
  save(file, state);
  let spb = SEC_PER_BLOCK_FALLBACK;
  try {
    const ts = async (n: number) => Number(BigInt(String(((await rpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, false])) as { timestamp?: string })?.timestamp ?? '0x0')));
    const [a, b] = await Promise.all([ts(block), ts(block - 100_000)]);
    if (a > b) spb = (a - b) / 100_000;
  } catch { /* the fallback block time */ }
  doc = buildRewards(state, block, block - Math.round((30 * 86_400) / spb), Date.now());
  return doc;
}

/** The rewards document, at most ten minutes old; the last good one while a refresh runs or fails. */
export async function boxRewards(file: string | null, rpc: Rpc = httpRpc): Promise<RewardsDoc | null> {
  if (doc && Date.now() - doc.at < REFRESH_MS) return doc;
  running ??= refresh(file, rpc).finally(() => { running = null; });
  if (doc) { running.catch(() => undefined); return doc; }
  return running.catch(() => null);
}
