/**
 * The Portfolio's On-chain tab (owner 2026-11-27: "Perps spot wealth add evm ... make valuedesk support non evm chains
 * too, a lot of them while keeping it highly efficient. Also, users need to be able to see their nfts on valuechain (or
 * other chains if thats easy to support).").
 *
 * - The addresses read: the wallet (every EVM chain) and the ones its owner adds for other chains, as chips. Adding one
 *   takes a paste: the chain is read from the address's shape (Sui and Aptos share one, so both are offered).
 * - Where it is, by chain: one bar in shades of the On-chain colour, largest first, and the chains under it.
 * - What it is: every coin and token with its chain, amount, price (and the price's source) and value. Coins no source
 *   prices are listed apart and not counted; tokens a source does not verify (airdropped spam) are hidden.
 * - NFTs: ValueChain's, and on a click the other EVM chains whose explorers answer.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button, EmptyState, Icon, IconButton, Segmented, SegmentedBar, Skeleton, StatusPill, TextInput } from '../../bots/kit/kit';
import { CoinIcon } from '../../CoinIcon';
import { chainLogo, coinLogo } from '../../../logos';
import { DASH, fmt, fmtUsd } from '../../../format';
import { Private } from '../../../privacy';
import { chainOf, detectAddress, supportedChains, type ChainHolding, type Detected, type Family } from '../../../trading/chainHoldings';
import { share, shortAddr, useMasks, ViewAll } from './blocks';
import type { OnchainState } from './useOnchain';
import type { NftState } from './nfts';
import { NftGrid, NftThumb } from './AllView';
import { ShareButton } from '../../share/host';
import type { ShareAs } from '../PortfolioPage';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
/** Rows before "Show all". */
const ROWS = 12;
/** Chains named in the bar before the rest are "Other". */
const BAR_CHAINS = 6;

const amountText = (v: number) => fmt(v, v >= 1000 ? 2 : v >= 1 ? 4 : 6);
/** Two significant digits past the zeros, however small (a memecoin at $0.00000024 is not $0.00). */
const priceText = (v: number | null) => (v === null ? DASH : fmtUsd(v, v >= 1 ? 2 : Math.min(14, Math.max(4, Math.ceil(-Math.log10(v)) + 2))));

/**
 * A chain's icon: its own logo, else its coin's from any of the app's icon sets (Cosmos Hub has no chain logo, ATOM has
 * a coin one), else the app's fallback.
 */
export function ChainIcon({ icon, size, className }: { icon: string; size: number; className?: string }) {
  return chainLogo(icon) || !coinLogo(icon) ? <CoinIcon chain={icon} size={size} className={className} /> : <CoinIcon coin={icon} size={size} className={className} />;
}

/**
 * A token's icon with its chain's as a badge. A token none of the app's icon sets knows shows its chain's icon alone:
 * the app's fallback mark is SoDEX's, which would say the token is SoDEX's.
 */
export function TokenIcon({ symbol, chainIcon, size = 26 }: { symbol: string; chainIcon: string; size?: number }) {
  return (
    <span className="pfv-coins__ic">
      {coinLogo(symbol)
        ? <><CoinIcon coin={symbol} size={size} /><ChainIcon icon={chainIcon} size={12} className="pfv-coins__chain" /></>
        : <ChainIcon icon={chainIcon} size={size} />}
    </span>
  );
}

// --- addresses ---------------------------------------------------------------------------------------------------

function AddressChips({ o, adding, onAdd }: { o: OnchainState; adding: boolean; onAdd: () => void }) {
  const m = useMasks();
  return (
    <div className="pfo-addrs" role="list" aria-label="Addresses read">
      {o.watched.map((w, i) => {
        const ch = chainOf(w);
        const read = o.reads.filter((r) => r.owner === w.address);
        const busy = read.some((r) => r.status === 'loading');
        const failed = read.length > 0 && read.every((r) => r.status === 'failed');
        return (
          <span key={`${w.family}:${w.address}`} className={cx('pfo-chip', failed && 'is-failed')} role="listitem" title={w.address}>
            <ChainIcon icon={i === 0 ? 'VALUECHAIN' : ch.icon} size={16} />
            <span className="pfo-chip__t">
              <b>{w.label || (i === 0 ? 'Your wallet' : ch.label)}</b>
              <small>{i === 0 ? 'EVM chains' : w.label ? ch.label : ''} {m.address(shortAddr(w.address))}</small>
            </span>
            {busy && <span className="tf-spin pfo-chip__spin" role="status" aria-label="Reading" />}
            {failed && <StatusPill tone="negative" size="sm">Not read</StatusPill>}
            {i > 0 && o.canAdd && <IconButton icon="x" label={`Remove ${ch.label} address`} className="pfo-chip__x" onClick={() => o.remove(w.address)} />}
          </span>
        );
      })}
      {o.canAdd && !adding && <Button variant="secondary" icon="plus" onClick={onAdd}>Add address</Button>}
    </div>
  );
}

/** Paste an address: its chain is read from its shape; Sui and Aptos share one shape, so the owner picks. */
function AddForm({ o, onDone }: { o: OnchainState; onDone: () => void }) {
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [pick, setPick] = useState<Family | null>(null);
  const [showAll, setShowAll] = useState(false);
  const found: Detected[] = useMemo(() => detectAddress(text), [text]);
  const evm = found.length === 1 && found[0]!.family === 'evm';
  const family = found.length === 1 ? found[0]!.family : pick && found.some((f) => f.family === pick) ? pick : null;
  const dup = family !== null && o.added.some((w) => w.family === family && w.address.toLowerCase() === text.trim().toLowerCase());
  const ok = family !== null && !evm && !dup;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    o.add({ family: family!, address: text.trim(), label });
    onDone();
  };
  const note = !text.trim() ? 'Bitcoin, Solana, Tron, TON, Sui, Aptos, XRP, Stellar, NEAR, Litecoin, Dogecoin and 20 Cosmos chains.'
    : evm ? 'An EVM address: your wallet’s EVM chains are already read. Connect that wallet to see it.'
      : found.length === 0 ? 'Not an address of a chain this page reads.'
        : dup ? 'This address is already read.'
          : found.length > 1 && !family ? 'This shape is used by two chains: pick one.' : null;
  const chains = useMemo(() => supportedChains(), []);
  return (
    <form className="pfo-add" onSubmit={submit}>
      <div className="pfo-add__row">
        <TextInput className="pfo-add__addr" value={text} onChange={(e) => { setText(e.target.value); setPick(null); }} placeholder="Paste an address" aria-label="Address" autoFocus spellCheck={false} autoComplete="off" />
        <TextInput className="pfo-add__name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (optional)" aria-label="Name" maxLength={32} />
        <Button type="submit" variant="primary" disabled={!ok}>Add</Button>
        <Button variant="quiet" onClick={onDone}>Cancel</Button>
      </div>
      <div className="pfo-add__foot">
        {found.length > 1 && !evm
          ? <Segmented options={found.map((f) => ({ value: f.family, label: f.label }))} value={(family ?? '') as Family} onChange={setPick} label="Chain" />
          : family && !evm && <StatusPill tone="positive" size="sm" icon="check">{found[0]!.label}</StatusPill>}
        {note && <small className="pfo-add__note">{note}</small>}
        <button type="button" className="pfo-add__more" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>{showAll ? 'Hide' : 'All'} {chains.length} chains</button>
      </div>
      {showAll && (
        <ul className="pfo-supported" aria-label="Chains this page reads">
          {chains.map((c) => <li key={c.key}><ChainIcon icon={c.icon} size={14} />{c.label}</li>)}
        </ul>
      )}
    </form>
  );
}

// --- where it is, by chain ---------------------------------------------------------------------------------------

function ChainSplit({ o }: { o: OnchainState }) {
  const m = useMasks();
  const [all, setAll] = useState(false);
  const total = o.total ?? 0;
  if (!(total > 0)) return null;
  // Only chains that hold something (owner 2026-11-28); past the first few, "+N more" opens the rest.
  const chips = all ? o.byChain : o.byChain.slice(0, BAR_CHAINS);
  const rest = o.byChain.length - BAR_CHAINS;
  const restUsd = o.byChain.slice(BAR_CHAINS).reduce((t, c) => t + c.usd, 0);
  const bar = [...o.byChain.slice(0, BAR_CHAINS), ...(rest > 0 ? [{ key: 'OTHER', label: `${rest} more`, icon: '', usd: restUsd }] : [])];
  return (
    <div className="pfo-split">
      <Private k="charts">
        <SegmentedBar
          className="pfo-bar"
          size="md"
          max={total}
          label="On-chain value by chain"
          segments={bar.map((p, i) => ({ id: p.key, value: p.usd, label: p.label, color: `var(--pfo-c${Math.min(i, 6)})` }))}
        />
      </Private>
      <ul className="pfo-chips" aria-label="Chains with funds">
        {chips.map((p, i) => (
          <li key={p.key} className="pfo-chainchip">
            <i className="pfo-dot" style={{ background: `var(--pfo-c${Math.min(i, 6)})` }} aria-hidden="true" />
            <ChainIcon icon={p.icon} size={16} />
            <span>{p.label}</span>
            <b>{m.funds(fmtUsd(p.usd))}</b>
            <small>{share(p.usd / total)}</small>
          </li>
        ))}
        {rest > 0 && (
          <li>
            <button type="button" className="pfo-chainchip is-more" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? 'Fewer' : <><span className="pfo-chainchip__stack" aria-hidden="true">{o.byChain.slice(BAR_CHAINS, BAR_CHAINS + 3).map((c) => <ChainIcon key={c.key} icon={c.icon} size={16} />)}</span>+{rest} more<b>{m.funds(fmtUsd(restUsd))}</b></>}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

// --- what it is --------------------------------------------------------------------------------------------------

function Rows({ rows, dim }: { rows: ChainHolding[]; dim?: boolean }) {
  const m = useMasks();
  return (
    <>
      {rows.map((h) => (
        <tr key={`${h.owner}|${h.chain}|${h.token}|${h.symbol}`} className={cx(dim && 'is-dim')}>
          <td><div className="pfo-tbl__asset">
            <TokenIcon symbol={h.symbol} chainIcon={h.chainIcon} />
            <span className="pfo-tbl__t"><b>{h.symbol}</b><small>{h.name !== h.symbol ? h.name : h.chainLabel}<span className="pfo-tbl__onchain"> · {h.chainLabel}</span></small></span>
          </div></td>
          <td className="pfo-tbl__chain">{h.chainLabel}</td>
          <td className="pfo-tbl__num">{m.funds(amountText(h.amount))}</td>
          <td className="pfo-tbl__num pfo-tbl__px" title={h.priceSource ? `Price: ${h.priceSource}` : 'No source prices this token'}>{priceText(h.price)}{h.priceSource && <small>{h.priceSource}</small>}</td>
          <td className="pfo-tbl__num"><b>{h.usd === null ? DASH : m.funds(fmtUsd(h.usd))}</b></td>
        </tr>
      ))}
    </>
  );
}

function NftRows({ nfts }: { nfts: NftState }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (k: string) => setOpen((x) => { const n = new Set(x); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <>
      {nfts.collections.map((c) => [
        <tr key={c.key} className={cx('is-group', open.has(c.key) && 'is-open')} onClick={() => toggle(c.key)}>
          <td><div className="pfo-tbl__asset">
            <span className="pfv-coins__ic"><NftThumb nfts={nfts} k={c.key} icon={c.chainIcon} /></span>
            <span className="pfo-tbl__t"><b>{c.name}</b><small>NFT collection<span className="pfo-tbl__onchain"> · {c.chainLabel}</span></small></span>
          </div></td>
          <td className="pfo-tbl__chain">{c.chainLabel}</td>
          <td className="pfo-tbl__num"><button type="button" className="pfa-where__more" aria-expanded={open.has(c.key)} onClick={(e) => { e.stopPropagation(); toggle(c.key); }}>{c.count} NFT{c.count === 1 ? '' : 's'}<Icon name="down" size={12} /></button></td>
          <td className="pfo-tbl__num pfo-tbl__px" title="No source publishes a floor price for this collection yet.">{c.floorUsd === null ? DASH : fmtUsd(c.floorUsd)}<small>{c.floorSource ?? 'floor'}</small></td>
          <td className="pfo-tbl__num">{c.floorUsd === null ? <span className="pfa-nofloor">No floor price</span> : <b>{fmtUsd(c.floorUsd * c.count)}</b>}</td>
        </tr>,
        open.has(c.key) && <tr key={`${c.key}|grid`} className="is-child"><td colSpan={5}><NftGrid nfts={nfts} k={c.key} /></td></tr>,
      ])}
    </>
  );
}

function Holdings({ o, nfts }: { o: OnchainState; nfts: NftState }) {
  const [all, setAll] = useState(false);
  const [extra, setExtra] = useState<'none' | 'unpriced' | 'hidden'>('none');
  if (o.total === null && o.loading) return <div className="pfv-skels">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="pfv-skel-row" />)}</div>;
  if (!o.counted.length && !o.unpriced.length && !o.loading && !nfts.collections.length) {
    return <div className="pfv-empty"><EmptyState icon="wallet" title="Nothing on chain" description={o.failed.length ? 'Some chains could not be read just now; they are tried again in a moment.' : 'No coins on the chains read for these addresses.'} /></div>;
  }
  const shown = all ? o.counted : o.counted.slice(0, ROWS);
  return (
    <div className="pfo-hold">
      <div className="pfv-scroll">
        <table className="pfo-tbl">
          <thead><tr><th>Asset</th><th className="pfo-tbl__chain">Chain</th><th className="pfo-tbl__num">Amount</th><th className="pfo-tbl__num pfo-tbl__px">Price</th><th className="pfo-tbl__num">Value</th></tr></thead>
          <tbody>
            <Rows rows={shown} />
            <NftRows nfts={nfts} />
            {extra === 'unpriced' && <Rows rows={o.unpriced} dim />}
            {extra === 'hidden' && <Rows rows={o.hidden} dim />}
          </tbody>
        </table>
      </div>
      <div className="pfo-foot">
        {o.counted.length > ROWS && <ViewAll label={all ? 'Show fewer' : `Show all ${o.counted.length}`} dir={all ? 'up' : 'down'} onClick={() => setAll(!all)} />}
        {o.unpriced.length > 0 && (
          <button type="button" className="pfo-more" aria-pressed={extra === 'unpriced'} onClick={() => setExtra(extra === 'unpriced' ? 'none' : 'unpriced')}>
            {o.unpriced.length} without a price, not counted
          </button>
        )}
        {o.hidden.length > 0 && (
          <button type="button" className="pfo-more" aria-pressed={extra === 'hidden'} onClick={() => setExtra(extra === 'hidden' ? 'none' : 'hidden')} title="Tokens their source does not verify, mostly airdropped spam. Never counted.">
            {o.hidden.length} unverified hidden
          </button>
        )}
        {o.failed.map((f) => <StatusPill key={f.id} tone="warning" size="sm" icon="warning" title={f.error}>{f.label}: not read, retrying</StatusPill>)}
        {nfts.loading && <StatusPill size="sm" dot pulse>Reading NFTs</StatusPill>}
      </div>
    </div>
  );
}

// --- the tab -----------------------------------------------------------------------------------------------------

export function OnchainPanel({ o, nfts, shareAs }: { o: OnchainState; nfts: NftState; shareAs?: ShareAs }) {
  const m = useMasks();
  const [adding, setAdding] = useState(false);
  if (!o.watched.length) {
    return <div className="pfv-empty"><EmptyState icon="wallet" title="Connect a wallet" description="Its coins and NFTs on ValueChain and every EVM chain show here, with any address you add for Bitcoin, Solana and 20 more chains." /></div>;
  }
  const n = o.byChain.length;
  return (
    <div className="pfo">
      <div className="pfo-top">
        <AddressChips o={o} adding={adding} onAdd={() => setAdding(true)} />
        <span className="pfo-total">
          <small>Total value on chain{n ? ` · ${n} chain${n === 1 ? '' : 's'}` : ''}</small>
          <span className="pfo-total__v">
            <b>{o.total === null ? (o.loading ? <Skeleton className="pfv-skel-num" /> : DASH) : m.funds(fmtUsd(o.total))}</b>
            {o.total !== null && o.total > 0 && (
              <ShareButton label="Share these holdings" make={(b) => b.holdingsCard({ title: shareAs?.title ?? 'My wallets', total: o.total!, parts: o.byChain.map((c) => ({ label: c.label, usd: c.usd })), wallet: o.watched[0]?.address ?? null, link: shareAs?.link, label: shareAs?.label ?? 'On-chain' })} />
            )}
          </span>
        </span>
      </div>
      {adding && <AddForm o={o} onDone={() => setAdding(false)} />}
      <ChainSplit o={o} />
      <Holdings o={o} nfts={nfts} />
    </div>
  );
}
