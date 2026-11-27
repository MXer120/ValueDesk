/**
 * The On-chain account of the Portfolio: the connected wallet on every EVM chain, plus the addresses on other chains
 * its owner adds (Bitcoin, Solana, Tron, TON, Sui, Cosmos chains, ...), read by trading/chainHoldings.ts.
 *
 * The added addresses are the owner's own list, kept in this browser only (`vs.pf.chains.<wallet>`), never sent to a
 * ValueDesk server. A read-only view (a watched wallet) reads that wallet's EVM chains and nothing else.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useStored } from '../../../hooks';
import { chainOf, chainReads, chainsVersion, hyperliquidMids, priceBase, refreshChains, subscribeChains, type ChainHolding, type SourceRead, type Watched } from '../../../trading/chainHoldings';
import { coinPrices } from '../../../trading/prices';
import { DEMO_ADDED, DEMO_NFT_OWNER, useDevDemo } from '../devDemo';
import type { PortfolioContext } from '../../Portfolio';

export interface ChainTotal { key: string; label: string; icon: string; usd: number }

export interface OnchainState {
  /** The wallet first, then the added addresses. Empty without a wallet. */
  watched: Watched[];
  added: Watched[];
  canAdd: boolean;
  add: (w: Watched) => void;
  remove: (address: string) => void;
  reads: SourceRead[];
  /** Verified and priced: what the total counts, largest first. */
  counted: ChainHolding[];
  /** Verified, no source prices it: listed, not counted. */
  unpriced: ChainHolding[];
  /** Not verified by its source (spam airdrops, unknown tokens): hidden, never counted. */
  hidden: ChainHolding[];
  /** null until a source has answered. */
  total: number | null;
  byChain: ChainTotal[];
  /** Some source is still out. */
  loading: boolean;
  failed: SourceRead[];
  /** Whose NFTs the tab shows: the wallet (localhost demo: a ValueChain holder's). */
  nftOwner: string | null;
}

/** Localhost demo (devDemo.ts): the sample addresses' holdings, valued at the live prices. */
function useDemoReads(demo: boolean): SourceRead[] {
  const [reads, setReads] = useState<SourceRead[]>([]);
  useEffect(() => {
    if (!demo) { setReads([]); return; }
    let off = false;
    void Promise.all([coinPrices().catch(() => null), hyperliquidMids().catch(() => null)]).then(([s, h]) => {
      if (off) return;
      setReads(DEMO_ADDED.map((w) => {
        const ch = chainOf(w);
        const rows = w.holdings.map((x) => ({ chain: ch.key, chainLabel: ch.label, chainIcon: ch.icon, owner: w.address, symbol: x.symbol, name: x.name, token: x.token ?? '', amount: x.amount, verified: x.verified ?? true }));
        return { id: `demo:${w.address}`, label: ch.label, owner: w.address, status: 'ok' as const, rows: priceBase(rows, s, h) };
      }));
    });
    return () => { off = true; };
  }, [demo]);
  return reads;
}

const REFRESH_MS = 60_000;
/** Below a cent a row is dust: not listed, not counted. */
const DUST = 0.01;

export function useOnchain(c: PortfolioContext): OnchainState {
  const owner = c.address ? c.address.toLowerCase() : null;
  const canAdd = !!owner && !c.readOnly;
  const [stored, setStored] = useStored<Watched[]>(`vs.pf.chains.${owner ?? 'none'}`, []);
  const added = useMemo(() => (canAdd && Array.isArray(stored) ? stored.filter((w) => w && typeof w.address === 'string' && w.family !== 'evm') : []), [canAdd, stored]);
  const live = useMemo((): Watched[] => (owner ? [{ family: 'evm', address: owner }, ...added] : []), [owner, added]);
  const demo = useDevDemo();
  const demoReads = useDemoReads(demo && !!owner);
  // The demo's sample addresses are shown as chips but never read from a chain.
  const watched = useMemo((): Watched[] => (demo && owner ? [...live, ...DEMO_ADDED.map(({ holdings: _h, ...w }) => w)] : live), [demo, owner, live]);
  const key = live.map((w) => `${w.family}:${w.address}`).join('|');

  useEffect(() => {
    if (!live.length) return;
    refreshChains(live);
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') refreshChains(live); }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const version = useSyncExternalStore(subscribeChains, chainsVersion, chainsVersion);
  const liveReads = useMemo(() => chainReads(live), [version, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const reads = useMemo(() => (demoReads.length ? [...liveReads, ...demoReads] : liveReads), [liveReads, demoReads]);

  const add = useCallback((w: Watched) => {
    const a = w.address.trim();
    if (!canAdd || !a || added.some((x) => x.address.toLowerCase() === a.toLowerCase() && x.family === w.family)) return;
    setStored([...added, { family: w.family, address: a, ...(w.label?.trim() ? { label: w.label.trim().slice(0, 32) } : {}) }]);
  }, [added, canAdd, setStored]);
  const remove = useCallback((address: string) => setStored(added.filter((x) => x.address !== address)), [added, setStored]);

  return useMemo(() => {
    const all = reads.flatMap((r) => r.rows);
    const byUsd = (a: ChainHolding, b: ChainHolding) => (b.usd ?? 0) - (a.usd ?? 0) || b.amount - a.amount;
    const counted = all.filter((h) => h.verified && h.usd !== null && h.usd >= DUST).sort(byUsd);
    const unpriced = all.filter((h) => h.verified && h.usd === null).sort(byUsd);
    const hidden = all.filter((h) => !h.verified).sort(byUsd);
    const answered = reads.some((r) => r.status === 'ok');
    const totals = new Map<string, ChainTotal>();
    for (const h of counted) {
      const t = totals.get(h.chain) ?? { key: h.chain, label: h.chainLabel, icon: h.chainIcon, usd: 0 };
      t.usd += h.usd!;
      totals.set(h.chain, t);
    }
    return {
      watched, added, canAdd, add, remove, reads, counted, unpriced, hidden,
      total: answered ? counted.reduce((s, h) => s + h.usd!, 0) : null,
      byChain: [...totals.values()].sort((a, b) => b.usd - a.usd),
      loading: reads.some((r) => r.status === 'loading'),
      failed: reads.filter((r) => r.status === 'failed'),
      nftOwner: demo ? DEMO_NFT_OWNER : owner,
    };
  }, [reads, watched, added, canAdd, add, remove, demo, owner]);
}
