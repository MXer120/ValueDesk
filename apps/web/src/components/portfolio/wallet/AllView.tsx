/**
 * The Portfolio's All tab (owner 2026-11-27: "Add an all tab too ... include allocations through a bar"; 2026-11-28:
 * "Total value & share ... change share to free margin tho, and anything used up by bots or copy or algo orders needs
 * to be dashed, e.g. dashed what we limit. Full sodex actual free margin. The where looks wrong ... Show nfts";
 * "allocation bar on hover info on what each is").
 *
 * - The total, and its share button (holdingsCard: the total and its parts).
 * - One bar, each dollar once. Perps is split as SoDEX reports it: margin in use (solid), what copies may use and bots
 *   set aside (dashed: limits ValueDesk keeps, not money moved), and free margin (light). Hovering a part says what it
 *   is. Under it the four accounts; Perps shows SoDEX's free margin.
 * - Every asset as one row; a row held in more than one place opens to each place (USDC in Spot and on Solana are two
 *   lines in it, never one place). NFT collections are rows too, valued only where a floor price is published.
 */
import { useMemo, useState } from 'react';
import { Button, Icon } from '../../bots/kit/kit';
import { CoinIcon } from '../../CoinIcon';
import { coinLogo } from '../../../logos';
import { DASH, fmt, fmtUsd } from '../../../format';
import { Private } from '../../../privacy';
import { requestConnect } from '../../account/actions';
import { ShareButton } from '../../share/host';
import { claimedCoins, shareKey } from '../summary';
import { BucketIcon, ViewAll, share, useMasks, type Section } from './blocks';
import { ChainIcon, Chevron } from './Onchain';
import type { Bucket, PfData } from './data';
import type { Reserve } from './reserve';
import type { NftState } from './nfts';
import type { ShareAs } from '../PortfolioPage';

const ROWS = 10;
const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

interface Piece { bucket: Bucket; where: string; usd: number; amount: number | null; chainIcon?: string }
interface AssetRow { key: string; symbol: string; icon: { coin?: string; bucket?: Bucket; chain?: string }; name: string; usd: number; pieces: Piece[]; nft?: { count: number; floor: boolean } }

/** Every asset across the four accounts, by coin, each dollar once (the same rules as summary.ts); each place inside. */
export function assetRows(d: PfData): AssetRow[] {
  const by = new Map<string, AssetRow>();
  const put = (symbol: string, piece: Piece) => {
    if (!(piece.usd > 0.005)) return;
    const key = shareKey(symbol);
    const row = by.get(key) ?? { key, symbol: symbol.replace(/^v(?=[A-Z])/, ''), icon: { coin: symbol }, name: '', usd: 0, pieces: [] };
    if (piece.chainIcon && !row.icon.chain) row.icon.chain = piece.chainIcon;
    row.usd += piece.usd;
    const same = row.pieces.find((p) => p.bucket === piece.bucket && p.where === piece.where);
    if (same) { same.usd += piece.usd; same.amount = same.amount !== null && piece.amount !== null ? same.amount + piece.amount : null; } else row.pieces.push({ ...piece });
    by.set(key, row);
  };
  if (d.s.perps !== null && d.s.perps > 0.005) by.set('#PERPS', { key: '#PERPS', symbol: 'Perps account', icon: { bucket: 'perps' }, name: 'Margin and open positions', usd: d.s.perps, pieces: [{ bucket: 'perps', where: 'Perps', usd: d.s.perps, amount: null }] });
  const claimed = claimedCoins(d.w.rows);
  for (const c of d.spotCoins ?? []) if (c.usd !== null && !claimed.has(shareKey(c.coin))) put(c.coin, { bucket: 'spot', where: 'Spot', usd: c.usd, amount: c.amount });
  for (const r of d.w.rows ?? []) {
    if (r.marketValue === null) continue;
    const pledged = r.shares > 0 && r.perpShares > 0 ? r.marketValue * Math.min(1, r.perpShares / r.shares) : 0;
    put(r.coin, { bucket: 'wealth', where: 'Wealth', usd: Math.max(0, r.marketValue - pledged) + (r.inFlight || 0), amount: null });
  }
  if (d.s.slp) by.set('#SLP', { key: '#SLP', symbol: 'SLP', icon: { bucket: 'wealth' }, name: 'Liquidity vault', usd: d.s.slp, pieces: [{ bucket: 'wealth', where: 'Vault', usd: d.s.slp, amount: null }] });
  for (const h of d.evmRows) put(h.symbol, { bucket: 'evm', where: h.chainLabel, usd: h.usd, amount: null, chainIcon: h.chainIcon ?? h.chain });
  for (const r of by.values()) r.pieces.sort((a, b) => b.usd - a.usd);
  return [...by.values()].sort((a, b) => b.usd - a.usd);
}

/* ------------------------------------------------------------------ the bar ----- */

export interface Seg { id: string; usd: number; label: string; line: string; tone: Bucket; kind: 'solid' | 'dashed' | 'light' }

export function allocationSegments(d: PfData, r: Reserve): Seg[] {
  const out: Seg[] = [];
  const perps = d.s.perps;
  if (perps !== null && perps > 0) {
    const inUse = Math.max(0, Math.min(perps, r.inUse ?? 0));
    const free = Math.max(0, Math.min(perps - inUse, r.free ?? perps - inUse));
    // What copies may use and bots set aside comes out of the free margin, as far as it goes.
    let room = free;
    const take = (v: number) => { const t = Math.max(0, Math.min(room, v)); room -= t; return t; };
    const copies = take(r.copyUsd);
    const bots = take(r.botUsd);
    const algoLine = r.algos ? ` ${r.algos} algo order${r.algos === 1 ? '' : 's'} running: the orders they have placed are part of this; they set nothing aside before.` : '';
    out.push({ id: 'perps-used', usd: inUse, label: 'Perps · margin in use', line: `SoDEX's margin for your open positions and resting orders.${algoLine}`, tone: 'perps', kind: 'solid' });
    if (copies > 0) out.push({ id: 'perps-copy', usd: copies, label: 'Perps · copy trading may use', line: `The allocations of your ${r.copies.filter((c) => !c.paper && c.status !== 'stopped').length} live copies: a limit ValueDesk keeps, not money moved. Still in SoDEX's free margin.`, tone: 'perps', kind: 'dashed' });
    if (bots > 0) out.push({ id: 'perps-bots', usd: bots, label: 'Perps · bots set aside', line: `What your ${r.bots.filter((b) => !b.paper && b.usd > 0).length} running bots may hold and quote: a limit ValueDesk keeps. Still in SoDEX's free margin.`, tone: 'perps', kind: 'dashed' });
    if (room > 0) out.push({ id: 'perps-free', usd: room, label: 'Perps · free margin', line: 'Free for new orders, copies and bots.', tone: 'perps', kind: 'light' });
  }
  const p = (k: Bucket) => d.parts.find((x) => x.key === k)?.usd ?? null;
  const spot = p('spot');
  if (spot) out.push({ id: 'spot', usd: spot, label: 'Spot', line: 'Coins in your SoDEX Spot account.', tone: 'spot', kind: 'solid' });
  const wealth = p('wealth');
  if (wealth) out.push({ id: 'wealth', usd: wealth, label: 'Wealth', line: 'Funds and vaults, at SoDEX’s market value.', tone: 'wealth', kind: 'solid' });
  const evm = p('evm');
  if (evm) out.push({ id: 'evm', usd: evm, label: 'On-chain', line: 'Your wallets on every chain read: what a source prices.', tone: 'evm', kind: 'solid' });
  return out.filter((s) => s.usd > 0.005);
}

export function AllocationBar({ segs }: { segs: Seg[] }) {
  const m = useMasks();
  const [hover, setHover] = useState<string | null>(null);
  const total = segs.reduce((t, s) => t + s.usd, 0);
  if (!(total > 0)) return <span className="pfa-bar is-empty" aria-hidden="true" />;
  const h = segs.find((s) => s.id === hover) ?? null;
  let mid = 0;
  if (h) { let x = 0; for (const s of segs) { if (s.id === h.id) { mid = (x + s.usd / 2) / total; break; } x += s.usd; } }
  return (
    <Private k="charts">
      <div className="pfa-barbox" onPointerLeave={() => setHover(null)}>
        <div className="pfa-bar" role="list" aria-label="Where your money is">
          {segs.map((s) => (
            <button
              key={s.id} type="button" role="listitem" className={cx('pfa-bar__seg', `is-${s.tone}`, `is-${s.kind}`, hover === s.id && 'is-on')}
              style={{ width: `${(s.usd / total) * 100}%` }} aria-label={`${s.label}: ${fmtUsd(s.usd)}, ${share(s.usd / total)}. ${s.line}`}
              onPointerEnter={() => setHover(s.id)} onFocus={() => setHover(s.id)} onBlur={() => setHover(null)}
            />
          ))}
        </div>
        {h && (
          <div className="pfa-tip" role="tooltip" style={{ left: `clamp(130px, ${mid * 100}%, calc(100% - 130px))` }}>
            <span className="pfa-tip__h"><i className={cx('pfa-key', `is-${h.tone}`, `is-${h.kind}`)} aria-hidden="true" /><b>{h.label}</b></span>
            <span className="pfa-tip__v">{m.funds(fmtUsd(h.usd))} <small>{share(h.usd / total)}</small></span>
            <small className="pfa-tip__l">{h.line}</small>
          </div>
        )}
      </div>
    </Private>
  );
}

/* ----------------------------------------------------------- automation row ----- */

function Automation({ r, onSection }: { r: Reserve; onSection: (s: Section) => void }) {
  const m = useMasks();
  const live = r.copies.filter((c) => !c.paper && c.status !== 'stopped');
  const paper = r.copies.filter((c) => c.paper && c.status !== 'stopped');
  const realBots = r.bots.filter((b) => !b.paper);
  return (
    <div className="pfa-auto">
      <span className="pfa-auto__k">Set aside of Perps</span>
      <button type="button" className="pfa-auto__item" onClick={() => onSection('copy')}>
        <i className="pfa-key is-perps is-dashed" aria-hidden="true" />
        <span className="pfa-auto__t"><b>Copy trading</b><small>{live.length ? `${live.length} live${paper.length ? `, ${paper.length} practice` : ''}` : paper.length ? `${paper.length} practice` : 'None running'}</small></span>
        <span className="pfa-auto__v"><b>{r.copyUsd > 0 ? m.funds(fmtUsd(r.copyUsd)) : DASH}</b><small>may use</small></span>
        <Icon name="arrowRight" size={14} />
      </button>
      <button type="button" className="pfa-auto__item" onClick={() => onSection('bots')}>
        <i className="pfa-key is-perps is-dashed" aria-hidden="true" />
        <span className="pfa-auto__t"><b>Bots</b><small>{realBots.length ? `${realBots.length} running${r.bots.length > realBots.length ? `, ${r.bots.length - realBots.length} practice` : ''}` : r.signedIn || r.demo ? 'None running' : 'Sign in on the Bots page to see them'}</small></span>
        <span className="pfa-auto__v"><b>{r.botUsd > 0 ? m.funds(fmtUsd(r.botUsd)) : DASH}</b><small>set aside</small></span>
        <Icon name="arrowRight" size={14} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------- the tab ----- */

export function AllView({ d, onSection, automation = true, reserve, nfts, shareAs }: {
  d: PfData; onSection: (s: Section) => void; automation?: boolean; reserve: Reserve; nfts: NftState; shareAs?: ShareAs;
}) {
  const m = useMasks();
  const assets = useMemo(() => assetRows(d), [d]);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const total = d.s.total;
  const segs = useMemo(() => allocationSegments(d, reserve), [d, reserve]);
  // NFT collections as rows after the coins (no published floor yet: they count nothing).
  // NFT collections after the coins, at their floors (valuemint.store, ValueChain only); not in Total value.
  const nftRows: AssetRow[] = nfts.collections.map((c) => ({
    key: `#NFT:${c.key}`, symbol: c.name, icon: { chain: c.chainIcon }, name: `${c.count} NFT${c.count === 1 ? '' : 's'} · ${c.chainLabel}`, usd: c.valueUsd ?? 0,
    pieces: [{ bucket: 'evm', where: c.chainLabel, usd: c.valueUsd ?? 0, amount: c.count, chainIcon: c.chainIcon }], nft: { count: c.count, floor: c.valueUsd !== null },
  }));
  const rows = [...assets, ...nftRows];
  const shown = all ? rows : rows.slice(0, ROWS);
  const top = assets[0]?.usd ?? 0;
  const tab: Record<Bucket, Section> = { perps: 'perps', spot: 'spot', wealth: 'wealth', evm: 'onchain' };
  const where = (r: AssetRow) => (r.pieces.length > 1 ? `${r.pieces.length} places` : r.pieces[0]?.where ?? '');
  return (
    <div className="pfa">
      <div className="pfa-top">
        <div className="pfa-head">
          <span className="pfa-total"><small>Total value</small><b>{total === null ? DASH : m.equity(fmtUsd(total))}</b></span>
          {total !== null && total > 0 && (
            <ShareButton label="Share where the money is" make={(b) => b.holdingsCard({ title: shareAs?.title ?? 'My accounts', total, parts: d.parts.map((p) => ({ label: p.label, usd: p.usd ?? 0 })), wallet: d.c.address, link: shareAs?.link, label: shareAs?.label })} />
          )}
        </div>
        <AllocationBar segs={segs} />
        <ul className="pfa-parts">
          {d.parts.map((p) => (
            <li key={p.key}>
              <button type="button" onClick={() => onSection(tab[p.key])}>
                <i className={`pfv-dot is-${p.key}`} aria-hidden="true" />
                <span className="pfa-parts__t">
                  <b>{p.label}</b>
                  {p.key === 'perps'
                    ? <small title="SoDEX's own free margin: what new orders can use now.">Free {reserve.free === null ? DASH : m.funds(fmtUsd(reserve.free))}</small>
                    : <small>{p.share === null ? DASH : share(p.share)}</small>}
                </span>
                <span className="pfa-parts__v">{p.usd === null ? (p.key === 'evm' && d.evmLoading ? '…' : DASH) : m.funds(fmtUsd(p.usd))}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {automation && <Automation r={reserve} onSection={onSection} />}
      {rows.length > 0 && (
        <div className="pfa-assets">
          <div className="pfv-scroll">
            <table className="pfo-tbl pfa-tbl">
              <thead><tr><th>Asset</th><th>Where</th><th className="pfo-tbl__num">Value</th><th className="pfa-tbl__share">Share</th></tr></thead>
              <tbody>
                {shown.map((r) => {
                  const many = r.pieces.length > 1 || !!r.nft;
                  const isOpen = open.has(r.key);
                  const sh = total && total > 0 && r.usd > 0 ? r.usd / total : null;
                  return [
                    <tr key={r.key} className={cx(many && 'is-group', isOpen && 'is-open')} onClick={many ? () => toggle(r.key) : undefined}>
                      <td><div className="pfo-tbl__asset">
                        <span className="pfv-coins__ic">{r.icon.bucket ? <BucketIcon k={r.icon.bucket} size={26} />
                          : r.nft ? <NftThumb nfts={nfts} k={r.key.slice(5)} icon={r.icon.chain!} />
                          : coinLogo(r.icon.coin) || !r.icon.chain ? <CoinIcon coin={r.icon.coin} size={26} /> : <ChainIcon icon={r.icon.chain} size={26} />}</span>
                        <span className="pfo-tbl__t"><b>{r.symbol}</b>{r.name && <small>{r.name}</small>}</span>
                      </div></td>
                      <td className="pfa-where">
                        {many ? <button type="button" className="pfa-where__more" aria-expanded={isOpen} onClick={(e) => { e.stopPropagation(); toggle(r.key); }}>{r.nft ? `${r.nft.count} to see` : where(r)}<Chevron /></button>
                          : <span className="pfa-where__p"><i className={`pfv-dot is-${r.pieces[0]!.bucket}`} aria-hidden="true" />{where(r)}</span>}
                      </td>
                      <td className="pfo-tbl__num"><b>{r.nft && !r.nft.floor ? <span className="pfa-nofloor" title="No source publishes a floor for this collection: shown unvalued.">Unvalued</span> : r.nft ? <span title="At the floor of each NFT's rarity tier on valuemint.store (else the collection's), SOSO at SoDEX's price. A floor is a listing, not a sale: not in Total value.">{m.funds(fmtUsd(r.usd))}</span> : m.funds(fmtUsd(r.usd))}</b></td>
                      <td className="pfa-tbl__share">
                        <Private k="charts">
                          <span className="pfa-share" aria-hidden="true">
                            {r.pieces.map((p) => <i key={`${p.bucket}:${p.where}`} className={`is-${p.bucket}`} style={{ width: `${top > 0 ? (p.usd / top) * 100 : 0}%` }} />)}
                          </span>
                        </Private>
                        <small>{share(sh)}</small>
                      </td>
                    </tr>,
                    isOpen && !r.nft && r.pieces.map((p) => (
                      <tr key={`${r.key}|${p.bucket}|${p.where}`} className="is-child">
                        <td><div className="pfo-tbl__asset pfa-child">
                          <span className="pfv-coins__ic">{p.chainIcon ? <ChainIcon icon={p.chainIcon} size={18} /> : <BucketIcon k={p.bucket} size={18} />}</span>
                          <span className="pfo-tbl__t"><b>{p.bucket === 'evm' ? `On ${p.where}` : `In ${p.where}`}</b>{p.amount !== null && <small>{m.funds(fmt(p.amount, p.amount >= 1000 ? 2 : 4))} {r.symbol}</small>}</span>
                        </div></td>
                        <td className="pfa-where"><span className="pfa-where__p"><i className={`pfv-dot is-${p.bucket}`} aria-hidden="true" />{p.bucket === 'evm' ? 'On-chain' : p.where}</span></td>
                        <td className="pfo-tbl__num">{m.funds(fmtUsd(p.usd))}</td>
                        <td className="pfa-tbl__share"><small>{share(total ? p.usd / total : null)}</small></td>
                      </tr>
                    )),
                    isOpen && r.nft && (
                      <tr key={`${r.key}|grid`} className="is-child">
                        <td colSpan={4}><NftGrid nfts={nfts} k={r.key.slice(5)} /></td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
          {rows.length > ROWS && <div className="pfo-foot"><ViewAll label={all ? 'Show fewer' : `Show all ${rows.length}`} dir={all ? 'up' : 'down'} onClick={() => setAll(!all)} /></div>}
        </div>
      )}
      {!d.c.address && <div className="pfa-connect"><Button variant="primary" icon="wallet" onClick={requestConnect}>Connect a wallet to see yours</Button></div>}
    </div>
  );
}

/** A collection's first picture, small, as its asset icon (its chain's icon when it has none). */
export function NftThumb({ nfts, k, icon }: { nfts: NftState; k: string; icon: string }) {
  const c = nfts.collections.find((x) => x.key === k);
  const pic = c?.items.find((n) => n.image)?.image ?? null;
  const [broken, setBroken] = useState(false);
  return pic && !broken
    ? <img className="pfa-nftthumb" src={pic} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    : <ChainIcon icon={icon} size={26} />;
}

/** The NFTs of one collection, as pictures (opened from its row). */
export function NftGrid({ nfts, k }: { nfts: NftState; k: string }) {
  const c = nfts.collections.find((x) => x.key === k);
  if (!c) return null;
  return (
    <ul className="pfo-nftgrid pfa-nftgrid">
      {c.items.map((n) => (
        <li key={`${n.contract}:${n.id}`} className="pfo-nft">
          <a href={n.link} target="_blank" rel="noopener noreferrer" title={`${n.name}, on the ${n.chainLabel} explorer`}>
            <span className="pfo-nft__img">
              {n.image ? <img src={n.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <span className="pfo-nft__none" aria-hidden="true"><ChainIcon icon={n.chainIcon} size={28} /></span>}
              {n.count > 1 && <span className="pfo-nft__n">×{n.count}</span>}
            </span>
            <span className="pfo-nft__t">
              <b>{n.name}</b>
              <small>{n.tier ? <span className="pfo-nft__tier">{n.tier}</span> : `#${n.id.length > 10 ? `${n.id.slice(0, 8)}…` : n.id}`}</small>
              {n.floorSoso !== null && <small className="pfo-nft__floor" title={n.floorOf === 'tier' ? `The lowest ${n.tier} listing on valuemint.store` : 'The collection floor on valuemint.store'}>{n.floorOf === 'tier' ? `${n.tier} floor` : 'Floor'} {fmt(n.floorSoso, n.floorSoso >= 100 ? 0 : 2)} SOSO{n.valueUsd !== null ? ` · ${fmtUsd(n.valueUsd)}` : ''}</small>}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
