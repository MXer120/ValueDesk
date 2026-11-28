/**
 * LOCALHOST ONLY (import.meta.env.DEV): the Portfolio page with demo data (owner 2026-11-27: "give me on portfolio page
 * i want demo data rn"). In a build `useDevDemo()` is always false and nothing here is read.
 *
 * What the demo is made of:
 *   - a REAL, active SoDEX wallet, read-only as "View a wallet" reads one: #1 on SoDEX's 30-day PnL board on 2026-11-27
 *     (Perps, Spot, Wealth, its history and open positions, its EVM chains) - every figure there is SoDEX's or LI.FI's;
 *   - SAMPLE addresses on other chains (Bitcoin, Solana, TON, Sui, Cosmos Hub) with sample amounts, valued at the LIVE
 *     prices the page uses (SoDEX, then Hyperliquid);
 *   - the NFTs of a real ValueChain holder (their real pictures);
 *   - SAMPLE copies and bots (no copy or bot of anyone is read).
 * Everything sample is marked "Demo" where it shows.
 */
import { useSyncExternalStore } from 'react';
import type { Watched } from '../../trading/chainHoldings';

export const DEMO_WALLET = '0x19781a809211e55491767f027c4de4183d60fe04';
/** Holds 20 NFTs on ValueChain (Hypno Plush and others) and one on Optimism. */
export const DEMO_NFT_OWNER = '0xda70d3a52d30560fd344980638ae2bc856612602';

/** Sample addresses on other chains and what they hold (amounts are samples; prices are live). */
export const DEMO_ADDED: ReadonlyArray<Watched & { holdings: Array<{ symbol: string; name: string; amount: number; token?: string; verified?: boolean }> }> = [
  { family: 'btc', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', label: 'Demo cold wallet', holdings: [{ symbol: 'BTC', name: 'Bitcoin', amount: 0.8421 }] },
  {
    family: 'sol', address: '7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs', label: 'Demo Phantom',
    holdings: [
      { symbol: 'SOL', name: 'Solana', amount: 212.4 },
      { symbol: 'JUP', name: 'Jupiter', amount: 1840, token: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
      { symbol: 'USDC', name: 'USD Coin', amount: 2400, token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
      { symbol: 'BONK', name: 'Bonk', amount: 18_400_000, token: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
      { symbol: 'CLAIM', name: 'Unknown token', amount: 50_000, token: 'Fake1111111111111111111111111111111111111111', verified: false },
    ],
  },
  { family: 'ton', address: 'UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG', label: 'Demo Tonkeeper', holdings: [{ symbol: 'TON', name: 'TON', amount: 1250 }] },
  { family: 'sui', address: '0x02a212de6a9dfa3a69e22387acfbafbb1a9e591bd9d636e7895dcfc8de05f331', label: 'Demo Sui', holdings: [{ symbol: 'SUI', name: 'Sui', amount: 900 }] },
  { family: 'cosmos', address: 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu', label: 'Demo Keplr', holdings: [{ symbol: 'ATOM', name: 'Cosmos Hub', amount: 340 }] },
];

/** Sample copies (Copy trading tab, the All tab's set-aside): two live, one practice. */
export const DEMO_COPY_ROWS = [
  { id: 'dc1', leader: '0xca4903c207a0df58bf37d4bc8bbc5210726f53c8', venue: 'hyperliquid', direction: 'copy' as const, allocationUsd: 1500, pnl: 142.18, pnlPct: 0.0948, paper: false, mode: 'hosted', status: 'running' },
  { id: 'dc2', leader: '0xb98f118f2d3123226104b47f87c8d8b451de1647', venue: 'sodex', direction: 'counter' as const, allocationUsd: 1000, pnl: 42.09, pnlPct: 0.0421, paper: false, mode: 'hosted', status: 'running' },
  { id: 'dc3', leader: '0x6e44c0efeca886b546bc2aa85118094b83b87297', venue: 'sodex', direction: 'copy' as const, allocationUsd: 500, pnl: -8.4, pnlPct: -0.0168, paper: true, mode: 'browser', status: 'running' },
];
/** Sample copy trading figures (useCopies), from the rows above. */
export const DEMO_COPIES = { all: 3, live: 2, paper: 1, allocated: 2500, pnl: 184.27 };

/** Sample bots (BotsPanel). */
export const DEMO_BOTS: ReadonlyArray<{ id: string; symbol: string; strategy: 'maker' | 'grid' | 'hedge'; name: string; paper: boolean; state: 'running' | 'paused' | 'waiting'; volume: number; netPnl: number; allocUsd: number }> = [
  { id: 'd1', symbol: 'BTC-USD', strategy: 'maker', name: 'Maker BTC', paper: false, state: 'running', volume: 412_380, netPnl: 96.41, allocUsd: 4200 },
  { id: 'd2', symbol: 'ETH-USD', strategy: 'grid', name: 'Grid ETH', paper: false, state: 'running', volume: 88_120, netPnl: -12.07, allocUsd: 2600 },
  { id: 'd3', symbol: 'SOL-USD', strategy: 'grid', name: 'Grid SOL', paper: true, state: 'paused', volume: 14_960, netPnl: 3.18, allocUsd: 900 },
];

const KEY = 'vs.dev.pf.demo';
const listeners = new Set<() => void>();
let on = (() => {
  if (!import.meta.env.DEV) return false;
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
})();

export function setDevDemo(v: boolean): void {
  if (!import.meta.env.DEV) return;
  on = v;
  try { if (v) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* this tab only */ }
  for (const f of listeners) f();
}

const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const snapshot = () => on;

/** The page shows the demo (localhost only). */
export function useDevDemo(): boolean {
  const v = useSyncExternalStore(subscribe, snapshot, snapshot);
  return import.meta.env.DEV ? v : false;
}
