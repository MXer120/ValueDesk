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
import { coinLogo } from '../../../logos';
import { DASH, fmt, fmtUsd } from '../../../format';
import { Private } from '../../../privacy';
import { NFT_CHAINS, chainOf, detectAddress, readNfts, supportedChains, type ChainHolding, type Detected, type Family, type Nft } from '../../../trading/chainHoldings';
import { share, shortAddr, useMasks, ViewAll } from './blocks';
import type { OnchainState } from './useOnchain';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
/** Rows before "Show all". */
const ROWS = 12;
/** Chains named in the bar before the rest are "Other". */
const BAR_CHAINS = 6;

const amountText = (v: number) => fmt(v, v >= 1000 ? 2 : v >= 1 ? 4 : 6);
/** Two significant digits past the zeros, however small (a memecoin at $0.00000024 is not $0.00). */
const priceText = (v: number | null) => (v === null ? DASH : fmtUsd(v, v >= 1 ? 2 : Math.min(14, Math.max(4, Math.ceil(-Math.log10(v)) + 2))));

/**
 * A token's icon with its chain's as a badge. A token none of the app's icon sets knows shows its chain's icon alone:
 * the app's fallback mark is SoDEX's, which would say the token is SoDEX's.
 */
export function TokenIcon({ symbol, chainIcon, size = 26 }: { symbol: string; chainIcon: string; size?: number }) {
  return (
    <span className="pfv-coins__ic">
      {coinLogo(symbol)
        ? <><CoinIcon coin={symbol} size={size} /><CoinIcon chain={chainIcon} size={12} className="pfv-coins__chain" /></>
        : <CoinIcon chain={chainIcon} size={size} />}
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
            <CoinIcon chain={i === 0 ? 'VALUECHAIN' : ch.icon} size={16} />
            <span className="pfo-chip__t">
              <b>{w.label || (i === 0 ? 'Your wallet' : ch.label)}</b>
              <small>{i === 0 ? 'EVM chains' : w.label ? ch.label : ''} {m.address(shortAddr(w.address))}</small>
            </span>
            {busy && <span className="tf-spin pfo-chip__spin" role="status" aria-label="Reading" />}
            {failed && <StatusPill tone="negative" size="sm">Not read</StatusPill>}
            {i > 0 && <IconButton icon="x" label={`Remove ${ch.label} address`} className="pfo-chip__x" onClick={() => o.remove(w.address)} />}
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
          {chains.map((c) => <li key={c.key}><CoinIcon chain={c.icon} size={14} />{c.label}</li>)}
        </ul>
      )}
    </form>
  );
}

// --- where it is, by chain ---------------------------------------------------------------------------------------

function ChainSplit({ o }: { o: OnchainState }) {
  const m = useMasks();
  const total = o.total ?? 0;
  const top = o.byChain.slice(0, BAR_CHAINS);
  const rest = o.byChain.slice(BAR_CHAINS).reduce((s, c) => s + c.usd, 0);
  const parts = [...top.map((c) => ({ ...c })), ...(rest > 0 ? [{ key: 'OTHER', label: `${o.byChain.length - BAR_CHAINS} more`, icon: 'ETH', usd: rest }] : [])];
  if (!(total > 0)) return null;
  return (
    <div className="pfo-split">
      <Private k="charts">
        <SegmentedBar
          className="pfo-bar"
          size="md"
          max={total}
          label="On-chain value by chain"
          segments={parts.map((p, i) => ({ id: p.key, value: p.usd, label: p.label, color: `var(--pfo-c${Math.min(i, 6)})` }))}
        />
      </Private>
      <ul className="pfo-legend">
        {parts.map((p, i) => (
          <li key={p.key}>
            <i className="pfo-dot" style={{ background: `var(--pfo-c${Math.min(i, 6)})` }} aria-hidden="true" />
            {p.key !== 'OTHER' && <CoinIcon chain={p.icon} size={14} />}
            <span>{p.label}</span>
            <b>{m.funds(fmtUsd(p.usd))}</b>
            <small>{share(p.usd / total)}</small>
          </li>
        ))}
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

function Holdings({ o }: { o: OnchainState }) {
  const [all, setAll] = useState(false);
  const [extra, setExtra] = useState<'none' | 'unpriced' | 'hidden'>('none');
  if (o.total === null && o.loading) return <div className="pfv-skels">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="pfv-skel-row" />)}</div>;
  if (!o.counted.length && !o.unpriced.length && !o.loading) {
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
      </div>
    </div>
  );
}

// --- NFTs --------------------------------------------------------------------------------------------------------

function NftCard({ n }: { n: Nft }) {
  const [broken, setBroken] = useState(false);
  return (
    <li className="pfo-nft">
      <a href={n.link} target="_blank" rel="noopener noreferrer" title={`${n.name}, on the ${n.chainLabel} explorer`}>
        <span className="pfo-nft__img">
          {n.image && !broken
            ? <img src={n.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
            : <span className="pfo-nft__none" aria-hidden="true"><CoinIcon chain={n.chainIcon} size={28} /></span>}
          {n.count > 1 && <span className="pfo-nft__n">×{n.count}</span>}
        </span>
        <span className="pfo-nft__t">
          <b>{n.name}</b>
          <small><CoinIcon chain={n.chainIcon} size={12} />{n.collection}</small>
        </span>
      </a>
    </li>
  );
}

function Nfts({ owner }: { owner: string }) {
  const [wide, setWide] = useState(false);
  const [byChain, setByChain] = useState<Record<string, Nft[] | 'loading' | 'failed'>>({});
  const [filter, setFilter] = useState<string>('all');
  const chains = wide ? NFT_CHAINS : NFT_CHAINS.slice(0, 1);
  useEffect(() => {
    let off = false;
    for (const c of chains) {
      if (byChain[c.key] && byChain[c.key] !== 'failed') continue;
      setByChain((p) => ({ ...p, [c.key]: 'loading' }));
      readNfts(c.key, owner)
        .then((list) => { if (!off) setByChain((p) => ({ ...p, [c.key]: list })); })
        .catch(() => { if (!off) setByChain((p) => ({ ...p, [c.key]: 'failed' })); });
    }
    return () => { off = true; };
  }, [owner, wide]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setByChain({}); setWide(false); setFilter('all'); }, [owner]);

  const lists = chains.map((c) => ({ c, v: byChain[c.key] }));
  const items = lists.flatMap((x) => (Array.isArray(x.v) ? x.v : []));
  const withAny = lists.filter((x) => Array.isArray(x.v) && x.v.length > 0);
  const loading = lists.some((x) => x.v === 'loading' || x.v === undefined);
  const shown = filter === 'all' ? items : items.filter((n) => n.chain === filter);
  return (
    <section className="pfo-nfts" aria-label="NFTs">
      <header className="pfo-nfts__h">
        <span><b>NFTs</b><small>{wide ? `ValueChain and ${NFT_CHAINS.length - 1} more EVM chains` : 'On ValueChain'}</small></span>
        {withAny.length > 1 && (
          <Segmented
            options={[{ value: 'all', label: 'All', count: items.length }, ...withAny.map((x) => ({ value: x.c.key, label: x.c.label, count: (x.v as Nft[]).length }))]}
            value={filter}
            onChange={setFilter}
            label="Chain"
            size="sm"
          />
        )}
      </header>
      {shown.length > 0 && <ul className="pfo-nftgrid">{shown.map((n) => <NftCard key={`${n.chain}:${n.contract}:${n.id}`} n={n} />)}</ul>}
      {loading && !shown.length && <div className="pfo-nftgrid is-wait">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="pfo-nft__skel" />)}</div>}
      {!loading && !items.length && <p className="pfv-quiet pfo-nfts__empty">{wide ? 'No NFTs on these chains.' : 'No NFTs on ValueChain.'}</p>}
      {lists.some((x) => x.v === 'failed') && <p className="pfv-quiet">{lists.filter((x) => x.v === 'failed').map((x) => x.c.label).join(', ')}: the explorer did not answer.</p>}
      {!wide && <div className="pfo-nfts__more"><Button variant="secondary" icon="search" onClick={() => setWide(true)}>Look on {NFT_CHAINS.length - 1} more chains</Button></div>}
    </section>
  );
}

// --- the tab -----------------------------------------------------------------------------------------------------

export function OnchainPanel({ o }: { o: OnchainState }) {
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
          <small>On chain{n ? ` · ${n} chain${n === 1 ? '' : 's'}` : ''}</small>
          <b>{o.total === null ? (o.loading ? <Skeleton className="pfv-skel-num" /> : DASH) : m.funds(fmtUsd(o.total))}</b>
        </span>
      </div>
      {adding && <AddForm o={o} onDone={() => setAdding(false)} />}
      <ChainSplit o={o} />
      <Holdings o={o} />
      <Nfts owner={o.watched[0]!.address} />
      <p className="pfo-src"><Icon name="info" size={13} />Read from your browser: LI.FI (EVM chains, prices), ValueChain’s and Blockscout’s explorers, and each chain’s public node. Addresses you add stay in this browser.</p>
    </div>
  );
}
