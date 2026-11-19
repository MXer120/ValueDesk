/**
 * The address book's logo for a connected wallet, matched on its name ("Rabby Wallet", "MetaMask"): the fallback
 * for a wallet that announced no icon of its own, or whose icon failed to load. Its own module because the match
 * needs the whole address-book catalogue (catalogData.ts, ~22 KB): ConnectedWalletLogo (funds/ui.tsx), which every
 * page's navbar draws, loads it only when the fallback is wanted. ContactAvatar.tsx re-exports it.
 */
import { CATALOG, PLATFORM_LOGOS } from './catalogData';
import { detectFromName } from './detect';

const BASE = (() => {
  const b = import.meta.env?.BASE_URL;
  return typeof b === 'string' && b ? (b.endsWith('/') ? b : `${b}/`) : '/';
})();

/** The address book's logo for a connected wallet, matched on its name, or null. */
export function walletLogoForName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const id = detectFromName(trimmed, CATALOG, new Set()).platform;
  const hit = id ? CATALOG.platforms.find((p) => p.id === id) ?? null : null;
  const rel = hit?.kind === 'wallet' ? PLATFORM_LOGOS[hit.id] : undefined;
  return rel ? `${BASE}addrbook/${rel}` : null;
}
