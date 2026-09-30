/**
 * A saved address's picture: the platform's logo (or the coin's) with the CHAIN
 * as the small badge - always the chain. A contact that names neither gets a
 * plain wallet mark (a bare initial read as a riddle); a named platform or coin
 * whose logo cannot load falls back to its initial. An EVM address nobody said
 * the chain of gets a plain "EVM" badge rather than a guessed network.
 */
import { useMemo, useState } from 'react';
import { chainLogo, coinColor, coinLogo } from '../../../logos';
import { COIN_LOGOS } from '../../../logoManifest';
import type { Contact } from '../contacts';
import { CATALOG, CHAIN_LOGOS, PLATFORM_LOGOS } from './catalogData';
import { detectFromName, resolveLook, type CatalogChain, type Look } from './detect';

const BASE = (() => {
  const b = import.meta.env?.BASE_URL;
  return typeof b === 'string' && b ? (b.endsWith('/') ? b : `${b}/`) : '/';
})();
const own = (rel: string | undefined) => (rel ? `${BASE}addrbook/${rel}` : null);

/** Every coin the app has a logo for - the coins a name can mention. */
export const KNOWN_COINS: ReadonlySet<string> = new Set(Object.keys(COIN_LOGOS).filter((k) => /^[A-Z0-9]{2,10}$/.test(k)));

export const platformById = (id: string | null | undefined) => (id ? CATALOG.platforms.find((p) => p.id === id) ?? null : null);
export const chainById = (id: string | null | undefined) => (id ? CATALOG.chains.find((c) => c.id === id) ?? null : null);
export const platformLogo = (id: string | null | undefined): string | null => (id ? own(PLATFORM_LOGOS[id]) : null);

/** The address book's logo for a connected wallet, matched on its name ("Rabby Wallet", "MetaMask"). */
export function walletLogoForName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const hit = platformById(detectFromName(trimmed, CATALOG, new Set()).platform);
  return hit?.kind === 'wallet' ? platformLogo(hit.id) : null;
}
/** SoDEX's own chain icon where SoDEX routes there (the rest of the app uses it too), else ours. */
export const catalogChainLogo = (c: CatalogChain | null): string | null => (c ? (c.sodexKey && chainLogo(c.sodexKey)) || own(CHAIN_LOGOS[c.id]) : null);

export function useContactLook(c: Pick<Contact, 'name' | 'kind' | 'look'>) {
  return useMemo(() => resolveLook(c, CATALOG, KNOWN_COINS), [c.name, c.kind, c.look]); // eslint-disable-line react-hooks/exhaustive-deps
}

function Img({ src, alt, className, fallback }: { src: string | null; alt: string; className: string; fallback: JSX.Element }) {
  const [bad, setBad] = useState<string | null>(null);
  return src && bad !== src ? <img className={className} src={src} alt={alt} onError={() => setBad(src)} /> : fallback;
}

export function ContactAvatar({ name, kind, look, size = 30 }: { name: string; kind: Contact['kind']; look: Look; size?: number }) {
  const platform = platformById(look.platform);
  const chain = chainById(look.chain);
  const main = platform ? platformLogo(platform.id) : look.coin ? coinLogo(look.coin) : null;
  const named = platform?.name ?? look.coin ?? null;
  const badge = chain ? catalogChainLogo(chain) : null;
  const badgeSize = Math.round(size * 0.46);
  return (
    <span className="ab-av" style={{ width: size, height: size }} aria-hidden="true">
      <Img
        src={main}
        alt=""
        className="ab-av__main"
        fallback={
          named ? (
            <span className="ab-av__main ab-av__letter" style={{ background: coinColor(named) }}>{named.charAt(0).toUpperCase()}</span>
          ) : (
            <span className="ab-av__main ab-av__plain" title={name}><PlainWallet /></span>
          )
        }
      />
      {(chain || kind === 'evm') && (
        <span className="ab-av__badge" style={{ width: badgeSize, height: badgeSize }} title={chain?.name ?? 'Any EVM chain'}>
          {chain ? (
            <Img src={badge} alt="" className="ab-av__badgeimg" fallback={<span className="ab-av__badgetxt">{chain.name.charAt(0)}</span>} />
          ) : (
            <span className="ab-av__badgetxt">EVM</span>
          )}
        </span>
      )}
    </span>
  );
}

/** A contact that is just an address: a wallet mark, not a letter. */
const PlainWallet = () => (
  <svg viewBox="0 0 24 24" width="56%" height="56%" aria-hidden="true">
    <rect x="3" y="6" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M3 9.5h18" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="16.5" cy="14" r="1.3" fill="currentColor" />
  </svg>
);
