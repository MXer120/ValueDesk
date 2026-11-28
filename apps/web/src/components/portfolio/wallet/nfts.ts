/**
 * NFTs as assets (owner 2026-11-28: "Nfts should be grouped like a normal asset, but can be expanded to view the image
 * and actual nft"): one row per collection, per chain, with how many the wallet holds; the NFTs themselves inside.
 *
 * Read only while a tab that shows them is open: ValueChain's explorer and the other EVM explorers that answer a
 * browser (chainHoldings NFT_CHAINS), each once per five minutes (readNfts' cache), in parallel.
 *
 * VALUE (owner 2026-11-28: "unvalued, use valuemint.store for valuechain nfts floor prices and floor price of rarity").
 * A ValueChain NFT is worth the floor of its rarity tier on valuemint.store, else its collection's floor, in SOSO at
 * SoDEX's price (GET /api/vs/nft/floors, the server's ten-minute read; trading/prices.ts). Its tier is its own: a
 * SoDEX box's from its token URI (read from ValueChain's node, the level numbers from the same answer), anything else's
 * from a Tier, Rarity, Level or Grade trait. NFTs on other chains stay unvalued: no source publishes their floors here.
 * A floor is a listing, not a sale: NFTs are shown with their value but are not in Total value.
 */
import { useEffect, useMemo, useState } from 'react';
import { NFT_CHAINS, readNfts, type Nft } from '../../../trading/chainHoldings';
import { coinPrices, priceOf } from '../../../trading/prices';
import { VALUECHAIN_RPC } from '../../../trading/rpc';

const SOBOX = '0x371c4f7f68be3e558b89cc1f0fb113851c76e750';

export interface HeldNft extends Nft {
  /** The floor it is valued at, SOSO (its tier's, else its collection's); null when none is published. */
  floorSoso: number | null;
  /** Whether that floor is its tier's ("Rare") or the collection's. */
  floorOf: 'tier' | 'collection' | null;
  valueUsd: number | null;
}

export interface NftCollection {
  key: string;
  chain: string;
  chainLabel: string;
  chainIcon: string;
  contract: string;
  name: string;
  count: number;
  items: HeldNft[];
  /** The collection's floor, SOSO and USD; null when no source publishes one (every chain but ValueChain). */
  floorSoso: number | null;
  floorUsd: number | null;
  /** What its NFTs are worth together at their floors, USD; null when none is valued. */
  valueUsd: number | null;
  floorSource: string | null;
}

export interface NftState {
  collections: NftCollection[];
  loading: boolean;
  /** Chains whose explorer did not answer. */
  failed: string[];
}

interface FloorsDoc { collections: Record<string, { floor: number | null; tiers: Record<string, { floor: number }> }>; soboxLevels?: Record<string, string> }

let floorsRead: { at: number; p: Promise<FloorsDoc | null> } | null = null;
function readFloors(): Promise<FloorsDoc | null> {
  if (floorsRead && Date.now() - floorsRead.at < 300_000) return floorsRead.p;
  const p = fetch('/api/vs/nft/floors', { credentials: 'omit' }).then((r) => (r.ok ? (r.json() as Promise<FloorsDoc>) : null)).catch(() => null);
  floorsRead = { at: Date.now(), p };
  return p;
}

const boxLevel = new Map<string, string | null>();
/** Held SoDEX boxes: their token URIs, one batched request to ValueChain's node, kept (a box's level never changes). */
async function readBoxLevels(ids: string[], levels: Record<string, string>): Promise<void> {
  const todo = ids.filter((id) => !boxLevel.has(id) && /^\d+$/.test(id)).slice(0, 200);
  if (!todo.length) return;
  const calls = todo.map((id, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: SOBOX, data: `0xc87b56dd${BigInt(id).toString(16).padStart(64, '0')}` }, 'latest'] }));
  const res = await fetch(VALUECHAIN_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(calls) })
    .then((r) => r.json() as Promise<Array<{ id: number; result?: string }>>).catch(() => []);
  for (const r of Array.isArray(res) ? res : []) {
    const id = todo[r.id];
    if (!id || !r.result || r.result.length < 130) continue;
    const hex = r.result.slice(2);
    const len = parseInt(hex.slice(64, 128), 16);
    let uri = '';
    for (let i = 128; i < 128 + len * 2; i += 2) uri += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    const n = /\/sobox\/(\d+)\b/.exec(uri)?.[1];
    boxLevel.set(id, n !== undefined ? levels[n] ?? null : null);
  }
}

export function useNftCollections(owner: string | null, enabled = true): NftState {
  const [by, setBy] = useState<Record<string, Nft[] | 'loading' | 'failed'>>({});
  const [floors, setFloors] = useState<FloorsDoc | null>(null);
  const [soso, setSoso] = useState<number | null>(null);
  const [boxes, setBoxes] = useState(0);
  useEffect(() => {
    setBy({});
    if (!owner || !enabled) return;
    let off = false;
    for (const c of NFT_CHAINS) {
      setBy((p) => ({ ...p, [c.key]: 'loading' }));
      readNfts(c.key, owner)
        .then((list) => { if (!off) setBy((p) => ({ ...p, [c.key]: list })); })
        .catch(() => { if (!off) setBy((p) => ({ ...p, [c.key]: 'failed' })); });
    }
    void readFloors().then((d) => { if (!off) setFloors(d); });
    void coinPrices().then((m) => { if (!off) setSoso(priceOf(m, 'SOSO') ?? null); }).catch(() => undefined);
    return () => { off = true; };
  }, [owner, enabled]);
  // Held SoDEX boxes carry no traits on the explorer: their level comes from their token URI.
  const vc = by.VALUECHAIN;
  useEffect(() => {
    if (!Array.isArray(vc) || !floors?.soboxLevels) return;
    const ids = vc.filter((n) => n.contract.toLowerCase() === SOBOX && !n.tier).map((n) => n.id);
    if (ids.length) void readBoxLevels(ids, floors.soboxLevels).then(() => setBoxes((x) => x + 1));
  }, [vc, floors]);
  return useMemo(() => {
    const groups = new Map<string, NftCollection>();
    for (const c of NFT_CHAINS) {
      const v = by[c.key];
      if (!Array.isArray(v)) continue;
      for (const n of v) {
        const key = `${n.chain}:${n.contract.toLowerCase()}`;
        const f = n.chain === 'VALUECHAIN' ? floors?.collections[n.contract.toLowerCase()] ?? null : null;
        const g = groups.get(key) ?? {
          key, chain: n.chain, chainLabel: n.chainLabel, chainIcon: n.chainIcon, contract: n.contract, name: n.collection, count: 0, items: [],
          floorSoso: f?.floor ?? null, floorUsd: f?.floor != null && soso !== null ? f.floor * soso : null, valueUsd: null, floorSource: f?.floor != null ? 'valuemint.store' : null,
        };
        const tier = n.tier ?? (n.contract.toLowerCase() === SOBOX ? boxLevel.get(n.id) ?? null : null);
        const tf = tier && f ? f.tiers[tier]?.floor ?? null : null;
        const floorSoso = tf ?? f?.floor ?? null;
        const valueUsd = floorSoso !== null && soso !== null ? floorSoso * soso * n.count : null;
        g.items.push({ ...n, tier, floorSoso, floorOf: tf !== null ? 'tier' : floorSoso !== null ? 'collection' : null, valueUsd });
        g.count += n.count;
        if (valueUsd !== null) g.valueUsd = (g.valueUsd ?? 0) + valueUsd;
        groups.set(key, g);
      }
    }
    return {
      collections: [...groups.values()].sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1) || b.count - a.count || a.name.localeCompare(b.name)),
      loading: NFT_CHAINS.some((c) => by[c.key] === 'loading' || (owner && enabled && by[c.key] === undefined)),
      failed: NFT_CHAINS.filter((c) => by[c.key] === 'failed').map((c) => c.label),
    };
  }, [by, owner, enabled, floors, soso, boxes]); // eslint-disable-line react-hooks/exhaustive-deps
}
