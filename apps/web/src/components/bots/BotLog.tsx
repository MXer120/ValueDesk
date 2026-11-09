/**
 * A bot's log as the bot sees it (owner 2026-11-08): a scrolling feed of its quotes, fills, pulls and decisions,
 * newest on top, each line a side, a price, a size and what kind of order it was; a press opens what is known of
 * it. Older lines load as the feed is scrolled to its end, new ones arrive every two seconds (useBotLog: only what
 * is new is read). Order ids are not shown, and the feed is not selectable or copyable in one go: the bot's moves
 * are the user's to see, not a dump of how it works.
 */
import { useEffect, useRef, useState } from 'react';
import type { AlgoEvent } from '@copy-engine';
import { fmtDateTime, fmtQty, fmtUsd } from '../../format';
import { EmptyState, Icon, Skeleton, type Tone } from './kit/kit';

type Filter = 'all' | 'fill' | 'order' | 'status';
const FILTERS: Array<{ id: Filter; label: string }> = [{ id: 'all', label: 'Everything' }, { id: 'fill', label: 'Fills' }, { id: 'order', label: 'Quotes' }, { id: 'status', label: 'Decisions' }];

const KIND: Record<AlgoEvent['kind'], { word: string; tone: Tone; icon: 'check' | 'layers' | 'x' | 'pause' | 'warning' | 'bolt' | 'pulse' }> = {
  fill: { word: 'Filled', tone: 'positive', icon: 'check' },
  order: { word: 'Quote', tone: 'neutral', icon: 'layers' },
  cancel: { word: 'Pulled', tone: 'neutral', icon: 'x' },
  skip: { word: 'Waited', tone: 'warning', icon: 'pause' },
  error: { word: 'Refused', tone: 'negative', icon: 'warning' },
  status: { word: 'Status', tone: 'brand', icon: 'pulse' },
  info: { word: 'Note', tone: 'neutral', icon: 'bolt' },
};
const TIF: Record<string, string> = { gtx: 'Post-only limit', gtc: 'Limit', ioc: 'Taker (IOC)', fok: 'Fill or kill' };

/** The kind of order a line was about, in words. */
function orderType(e: AlgoEvent): string | null {
  if (e.kind === 'fill') return e.maker === true ? 'Rested (maker)' : e.maker === false ? 'Took (taker)' : /\(maker\)/.test(e.text) ? 'Rested (maker)' : null;
  return e.tif ? (TIF[e.tif] ?? e.tif.toUpperCase()) : null;
}
/** Its text without the machine parts the row shows on its own. */
const plain = (e: AlgoEvent): string => e.text.replace(/\s*\(maker\)/, '');
const priceText = (p: number) => (!Number.isFinite(p) ? '–' : p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 2 }) : p.toPrecision(6).replace(/\.?0+$/, ''));
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Row({ e, open, toggle }: { e: AlgoEvent; open: boolean; toggle: () => void }) {
  const k = KIND[e.kind];
  const trade = typeof e.price === 'number' && typeof e.qty === 'number' && (e.side === 'buy' || e.side === 'sell');
  const type = orderType(e);
  return (
    <li className={`bots-flog__row is-${e.kind}${open ? ' is-open' : ''}`}>
      <button type="button" className="bots-flog__line" aria-expanded={open} onClick={toggle}>
        <time>{clock(e.at)}</time>
        <span className={`bots-flog__ic is-${k.tone}`} aria-hidden="true"><Icon name={k.icon} size={12} /></span>
        <span className="bots-flog__what">
          <b>{k.word}</b>
          {trade ? (
            <>
              <span className={`bots-flog__side is-${e.side}`}>{e.side === 'buy' ? 'Buy' : 'Sell'}</span>
              <span className="bots-flog__num">{fmtQty(e.qty!)} @ {priceText(e.price!)}</span>
            </>
          ) : <span className="bots-flog__txt">{plain(e)}</span>}
        </span>
        {trade && <span className="bots-flog__val">{fmtUsd(e.price! * e.qty!, 2)}</span>}
        <Icon name="down" size={11} className="bots-flog__chev" />
      </button>
      {open && (
        <dl className="bots-flog__more">
          <div><dt>When</dt><dd>{fmtDateTime(e.at)}</dd></div>
          {type && <div><dt>Order type</dt><dd>{type}</dd></div>}
          {trade && <div><dt>Side</dt><dd>{e.side === 'buy' ? 'Buy' : 'Sell'}</dd></div>}
          {trade && <div><dt>Price</dt><dd>{priceText(e.price!)}</dd></div>}
          {trade && <div><dt>Size</dt><dd>{fmtQty(e.qty!)}</dd></div>}
          {trade && <div><dt>Value</dt><dd>{fmtUsd(e.price! * e.qty!, 2)}</dd></div>}
          {e.paper && <div><dt>Practice</dt><dd>No order sent</dd></div>}
          <div className="is-wide"><dt>What happened</dt><dd>{plain(e)}</dd></div>
        </dl>
      )}
    </li>
  );
}

export function BotLog({ events, error, more, loading, loadMore, only }: { events: AlgoEvent[] | null; error: string | null; more: boolean; loading: boolean; loadMore: () => void; only?: 'fill' }) {
  const [filter, setFilter] = useState<Filter>(only ?? 'all');
  const [open, setOpen] = useState<string | null>(null);
  const end = useRef<HTMLLIElement>(null);
  const box = useRef<HTMLOListElement>(null);
  // More lines as the end comes into view, within the feed's own scroll.
  useEffect(() => {
    const el = end.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((xs) => { if (xs.some((x) => x.isIntersecting)) loadMore(); }, { root: box.current, rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more, loadMore, events]);
  if (error && !events) return <EmptyState tone="error" icon="warning" title="The log could not be read" description={error} />;
  if (!events) return <div className="bots-skels"><Skeleton className="bots-skel" /><Skeleton className="bots-skel" /><Skeleton className="bots-skel" /></div>;
  const shown = events.filter((e) => filter === 'all' || (filter === 'fill' ? e.kind === 'fill' : filter === 'order' ? e.kind === 'order' || e.kind === 'cancel' : e.kind !== 'fill' && e.kind !== 'order' && e.kind !== 'cancel'));
  return (
    <div className="bots-flog" onCopy={(ev) => ev.preventDefault()} onContextMenu={(ev) => ev.preventDefault()}>
      {!only && (
        <div className="bots-flog__bar" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`bots-chip${filter === f.id ? ' is-on' : ''}`} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
          <span className="bots-flog__live"><i aria-hidden="true" />Live</span>
        </div>
      )}
      {!shown.length && !more ? <EmptyState compact icon="clock" title={filter === 'fill' ? 'No fill yet' : 'Nothing yet'} /> : (
        <ol className="bots-flog__list" ref={box}>
          {shown.map((e) => <Row key={e.id} e={e} open={open === e.id} toggle={() => setOpen((x) => (x === e.id ? null : e.id))} />)}
          <li ref={end} className="bots-flog__end" aria-hidden={!more}>{more ? (loading ? 'Loading older lines…' : '') : 'The start of its log'}</li>
        </ol>
      )}
      {!shown.length && more && <p className="bots-fine">Scroll for older lines.</p>}
    </div>
  );
}

