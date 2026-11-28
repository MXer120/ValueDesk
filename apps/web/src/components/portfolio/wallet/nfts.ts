/**
 * NFTs as assets (owner 2026-11-28: "Nfts should be grouped like a normal asset, but can be expanded to view the image
 * and actual nft"): one row per collection, per chain, with how many the wallet holds; the NFTs themselves inside.
 *
 * Read only while a tab that shows them is open: ValueChain's explorer and the other EVM explorers that answer a
 * browser (chainHoldings NFT_CHAINS), each once per five minutes (readNfts' cache), in parallel.
 *
 * VALUE. A collection's value is its floor price times the count, and an NFT's rarity its rank in the collection - but
 * only from a source that publishes them for this collection. None is wired yet (OpenSea's API needs a key, Magic
 * Eden's EVM API is gone): until one is, `floorUsd` is null, the row says "No floor price" and the NFT counts nothing.
 */
import { useEffect, useMemo, useState } from 'react';
import { NFT_CHAINS, readNfts, type Nft } from '../../../trading/chainHoldings';

export interface NftCollection {
  key: string;
  chain: string;
  chainLabel: string;
  chainIcon: string;
  contract: string;
  name: string;
  count: number;
  items: Nft[];
  /** Floor price, USD, from a named source; null when none publishes it. */
  floorUsd: number | null;
  /** The source of the floor ("OpenSea"); null with no floor. */
  floorSource: string | null;
}

export interface NftState {
  collections: NftCollection[];
  loading: boolean;
  /** Chains whose explorer did not answer. */
  failed: string[];
}

export function useNftCollections(owner: string | null, enabled = true): NftState {
  const [by, setBy] = useState<Record<string, Nft[] | 'loading' | 'failed'>>({});
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
    return () => { off = true; };
  }, [owner, enabled]);
  return useMemo(() => {
    const groups = new Map<string, NftCollection>();
    for (const c of NFT_CHAINS) {
      const v = by[c.key];
      if (!Array.isArray(v)) continue;
      for (const n of v) {
        const key = `${n.chain}:${n.contract.toLowerCase()}`;
        const g = groups.get(key) ?? { key, chain: n.chain, chainLabel: n.chainLabel, chainIcon: n.chainIcon, contract: n.contract, name: n.collection, count: 0, items: [], floorUsd: null, floorSource: null };
        g.count += n.count;
        g.items.push(n);
        groups.set(key, g);
      }
    }
    return {
      collections: [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      loading: NFT_CHAINS.some((c) => by[c.key] === 'loading' || (owner && enabled && by[c.key] === undefined)),
      failed: NFT_CHAINS.filter((c) => by[c.key] === 'failed').map((c) => c.label),
    };
  }, [by, owner, enabled]);
}
