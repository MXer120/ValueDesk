/**
 * The liquidation heatmap's "View" (the portfolio pages' View panel: ViewPop + FilterBar
 * `Section` / `Seg`): which wallets the map shows - every one, or up to MAX_WALLETS picked by
 * search, from the address book, the connected wallet or a pasted address - which side, and
 * the picked wallets' positions on every coin with their liquidation prices. The pick holds
 * for every view (live, chart, historical) and is kept per panel.
 */
import { useMemo, useRef, useState } from 'react';
import type { WalletLiq } from '@sign/indexer/liqRead.js';
import { ViewPop } from '../ViewPop';
import { Section, Seg } from '../accountTables/FilterBar';
import { useContacts } from '../funds/contacts';
import { VENUE_LABEL, vsApi, type Venue } from '../../vsApi';
import { VenueLogo } from '../VenueLogo';
import { usePolled } from '../explore/cohorts/parts';
import { shortAddr } from '../../format';
import { fmtPx, fmtUsdShort } from '../explore/model';
import { fmtFixed } from '../../numStyle';

export const MAX_WALLETS = 10;
export type Side = 'both' | 'long' | 'short';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function WalletView({ wallets, onWallets, side, onSide, venues, self }: {
  wallets: string[];
  onWallets: (w: string[]) => void;
  side: Side;
  onSide: (s: Side) => void;
  venues: Venue[];
  /** The connected wallet, offered first. */
  self: string | null;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const count = wallets.length + (side === 'both' ? 0 : 1);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`lqm-view${count ? ' is-on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Wallets and side: show only some wallets' liquidations"
        onClick={() => setOpen((o) => !o)}
      >
        View{wallets.length ? ` · ${wallets.length === 1 ? shortAddr(wallets[0]!) : `${wallets.length} wallets`}` : ''}
      </button>
      <ViewPop
        open={open}
        anchor={btn}
        onClose={() => setOpen(false)}
        onReset={() => { onWallets([]); onSide('both'); }}
        resetDisabled={count === 0}
      >
        <Section label="Side">
          <Seg<Side> value={side} onChange={onSide} options={[['both', 'Both'], ['long', 'Longs'], ['short', 'Shorts']]} tones={{ long: 'neg', short: 'pos' }} />
        </Section>
        <WalletPicker wallets={wallets} onWallets={onWallets} self={self} />
        {wallets.length > 0 && <Positions wallets={wallets} venues={venues} />}
      </ViewPop>
    </>
  );
}

function WalletPicker({ wallets, onWallets, self }: { wallets: string[]; onWallets: (w: string[]) => void; self: string | null }) {
  const contacts = useContacts();
  const [q, setQ] = useState('');
  const lower = wallets.map((w) => w.toLowerCase());
  const has = (a: string) => lower.includes(a.toLowerCase());
  const toggle = (a: string) => {
    const x = a.toLowerCase();
    if (has(x)) onWallets(wallets.filter((w) => w.toLowerCase() !== x));
    else if (wallets.length < MAX_WALLETS) onWallets([...wallets, x]);
  };
  const query = q.trim().toLowerCase();
  // The connected wallet, the address book's EVM wallets, and the picked ones not in it.
  const rows = useMemo(() => {
    const out: Array<{ address: string; name: string; you?: boolean }> = [];
    const seen = new Set<string>();
    const add = (address: string, name: string, you?: boolean) => {
      const a = address.toLowerCase();
      if (seen.has(a)) return;
      seen.add(a);
      out.push({ address: a, name, ...(you ? { you } : {}) });
    };
    if (self) add(self, 'Your wallet', true);
    for (const c of contacts) if (c.kind === 'evm') add(c.address, c.name);
    for (const w of wallets) add(w, shortAddr(w));
    return out;
  }, [contacts, self, wallets]);
  const shown = rows.filter((r) => !query || r.name.toLowerCase().includes(query) || r.address.includes(query));
  const pasted = ADDRESS.test(q.trim()) && !has(q.trim()) ? q.trim().toLowerCase() : null;
  return (
    <Section label="Wallets" aside={<span className="lqm-view-n">{wallets.length ? `${wallets.length} of ${MAX_WALLETS}` : 'All wallets'}</span>}>
      <input
        className="lqm-view-search"
        type="search"
        placeholder="Search saved wallets or paste an address"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && pasted) { toggle(pasted); setQ(''); } }}
        aria-label="Search wallets"
      />
      {pasted && (
        <button type="button" className="lqm-view-row is-add" disabled={wallets.length >= MAX_WALLETS} onClick={() => { toggle(pasted); setQ(''); }}>
          <span className="lqm-view-check" aria-hidden="true">+</span>
          <span className="lqm-view-name">Add {shortAddr(pasted)}</span>
        </button>
      )}
      <div className="lqm-view-list" role="listbox" aria-multiselectable="true" aria-label="Wallets to show">
        {shown.map((r) => {
          const on = has(r.address);
          return (
            <button
              key={r.address}
              type="button"
              role="option"
              aria-selected={on}
              className={`lqm-view-row${on ? ' is-on' : ''}`}
              disabled={!on && wallets.length >= MAX_WALLETS}
              onClick={() => toggle(r.address)}
              title={r.address}
            >
              <span className="lqm-view-check" aria-hidden="true">{on ? '✓' : ''}</span>
              <span className="lqm-view-name">{r.name}{r.you ? '' : ''}</span>
              <span className="lqm-view-addr">{shortAddr(r.address)}</span>
            </button>
          );
        })}
        {!shown.length && !pasted && <p className="lqm-view-empty">{rows.length ? 'No saved wallet matches.' : 'No saved wallets yet: paste an address above, or save one in the address book.'}</p>}
      </div>
    </Section>
  );
}

/** The picked wallets' positions, every coin: where each liquidates, and how far that is. */
function Positions({ wallets, venues }: { wallets: string[]; venues: Venue[] }) {
  const r = usePolled<{ wallets: string[]; positions: WalletLiq[] }>(
    `${wallets.join(',')}|${venues.join(',')}`,
    (s) => vsApi.liquidationPositions(wallets, venues, s),
    30_000,
  );
  const rows = r.data?.positions ?? [];
  return (
    <Section label="Their positions" aside={<span className="lqm-view-n">{r.data ? `${rows.length}` : '…'}</span>}>
      {r.error && !r.data && <p className="lqm-view-empty">Positions couldn't load.</p>}
      {r.data && !rows.length && <p className="lqm-view-empty">No open positions on {venues.length > 2 ? 'these platforms' : venues.map((v) => VENUE_LABEL[v]).join(', ')}.</p>}
      <ol className="lqm-view-pos">
        {rows.slice(0, 40).map((p) => (
          <li key={`${p.venue}|${p.address}|${p.symbol}`} className={p.szi > 0 ? 'is-long' : 'is-short'} title={`${VENUE_LABEL[p.venue]} · ${p.address}`}>
            <span className="lqm-view-who"><VenueLogo venue={p.venue} size={12} />{p.coin}</span>
            <span>{p.szi > 0 ? 'Long' : 'Short'} {p.usd !== null ? fmtUsdShort(p.usd) : ''}</span>
            <span>{p.liq !== null ? `@ ${fmtPx(p.liq)}` : 'no liq. price'}</span>
            <span className="lqm-view-dist">{p.dist !== null ? `${fmtFixed(Math.abs(p.dist) * 100, 1)}%` : ''}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
