/**
 * The liquidation heatmap's "View" (the portfolio pages' View panel: ViewPop + FilterBar
 * `Section` / `Seg`, opened by the same button as everywhere else): in the live and chart views
 * the bars' size (fine, medium, coarse: a fixed share of the price) and their unit (the coin or
 * USD); in every view which wallets the map shows - every one, or up to MAX_WALLETS picked by
 * search, from the address book, the connected wallet or a pasted address - which side, and
 * the picked wallets' positions on every coin with their liquidation prices. Kept per panel.
 *
 * And (owner 2026-10-31) the colours - by side or by leverage - with a filter of the leverage
 * bands shown (chart/liqLev.ts), every view and the wallet lists alike; in the historical view
 * whether the levels now are laid over its right edge.
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
import { LEV_BANDS, LEV_COLOR, LEV_LABEL, isAllLev, type ColorBy, type LevBand } from '../../chart/liqLev';

export const MAX_WALLETS = 10;
export type Side = 'both' | 'long' | 'short';
export type Res = 'fine' | 'medium' | 'coarse';
export type Unit = 'usd' | 'coin';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** What the View changes (one write, so a reset is never half a reset). */
export interface ViewChange { wallets?: string[]; side?: Side; res?: Res; unit?: Unit; colorBy?: ColorBy; lev?: LevBand[]; strip?: boolean }

const SlidersGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 4.5h12M2 11.5h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.55" /><circle cx="10.5" cy="4.5" r="1.8" fill="var(--bg-panel)" stroke="currentColor" strokeWidth="1.3" /><circle cx="5.5" cy="11.5" r="1.8" fill="var(--bg-panel)" stroke="currentColor" strokeWidth="1.3" /></svg>
);

export function WalletView({ wallets, side, venues, self, bars, colors, onChange, onReset }: {
  wallets: string[];
  side: Side;
  venues: Venue[];
  /** The connected wallet, offered first. */
  self: string | null;
  /** The live and chart views' bars: their size and unit, and how wide a bar is now (price); null in the historical view. */
  bars: { res: Res; unit: Unit; coin: string; width: string | null } | null;
  /** Colour by side or leverage, the bands shown, and the historical view's strip of the levels now (null elsewhere). */
  colors: { colorBy: ColorBy; lev: LevBand[]; strip: boolean | null };
  onChange: (c: ViewChange) => void;
  onReset: () => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const count = wallets.length + (side === 'both' ? 0 : 1) + (bars && bars.res !== 'fine' ? 1 : 0) + (bars && bars.unit !== 'usd' ? 1 : 0)
    + (colors.colorBy !== 'side' ? 1 : 0) + (isAllLev(colors.lev) ? 0 : 1) + (colors.strip ? 1 : 0);
  // A band on or off; the last one on stays (none at all would be an empty map).
  const toggleLev = (b: LevBand) => {
    const on = colors.lev.includes(b);
    if (on && colors.lev.length === 1) return;
    onChange({ lev: LEV_BANDS.filter((x) => (x === b ? !on : colors.lev.includes(x))) });
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`acctf-view${open ? ' is-open' : ''}${count > 0 ? ' is-active' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={wallets.length ? `Showing ${wallets.length === 1 ? shortAddr(wallets[0]!) : `${wallets.length} wallets`}` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersGlyph />
        <span>View</span>
        {count > 0 && <span className="acctf-count">{count}</span>}
      </button>
      <ViewPop
        open={open}
        anchor={btn}
        onClose={() => setOpen(false)}
        onReset={onReset}
        resetDisabled={count === 0}
      >
        {bars && (
          <>
            <Section label="Bars" aside={bars.width ? <span className="lqm-view-n">{bars.width} each</span> : undefined}>
              <Seg<Res> value={bars.res} onChange={(res) => onChange({ res })} options={[['fine', 'Fine'], ['medium', 'Medium'], ['coarse', 'Coarse']]} />
            </Section>
            <Section label="Unit">
              <Seg<Unit> value={bars.unit} onChange={(unit) => onChange({ unit })} options={[['coin', bars.coin], ['usd', 'USD']]} />
            </Section>
          </>
        )}
        <Section label="Side">
          <Seg<Side> value={side} onChange={(s) => onChange({ side: s })} options={[['both', 'Both'], ['long', 'Longs'], ['short', 'Shorts']]} tones={{ long: 'neg', short: 'pos' }} />
        </Section>
        <Section label="Color by">
          <Seg<ColorBy> value={colors.colorBy} onChange={(colorBy) => onChange({ colorBy })} options={[['side', 'Side'], ['lev', 'Leverage']]} />
        </Section>
        <Section label="Leverage" aside={<span className="lqm-view-n">{isAllLev(colors.lev) ? 'All' : `${colors.lev.length} of 3`}</span>}>
          <div className="acctf-seg lqm-view-lev" role="group" aria-label="Leverage bands shown" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            {LEV_BANDS.map((b) => (
              <button key={b} type="button" aria-pressed={colors.lev.includes(b)} className={colors.lev.includes(b) ? 'is-on' : ''} onClick={() => toggleLev(b)} title={colors.lev.includes(b) && colors.lev.length === 1 ? 'At least one band stays on' : undefined}>
                <i className="lqm-sw" style={{ background: LEV_COLOR[b] }} aria-hidden="true" />{LEV_LABEL[b]}
              </button>
            ))}
          </div>
          {!isAllLev(colors.lev) && <p className="lqm-view-empty">Positions of unknown leverage show only with every band on.</p>}
        </Section>
        {colors.strip !== null && (
          <Section label="Levels now">
            <Seg<'off' | 'on'> value={colors.strip ? 'on' : 'off'} onChange={(v) => onChange({ strip: v === 'on' })} options={[['off', 'Hidden'], ['on', 'On the right']]} />
          </Section>
        )}
        <WalletPicker wallets={wallets} onWallets={(w) => onChange({ wallets: w })} self={self} />
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
