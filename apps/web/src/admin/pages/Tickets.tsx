/**
 * Feedback tickets: every chat visitors started (ops/feedbackThreads.ts), with the
 * status the owner gives it. Answering or changing a status asks the builder
 * wallet for a signature that names the ticket and the exact text (admin/signIn.ts).
 */
import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { signAction } from '../wallet';
import { useWallet } from '../WalletPicker';
import { isUserRejection } from '../../wallet';
import { ago, short, when } from '../format';
import { Badge, Note, PageHead, useAdmin } from '../ui';
import type { TicketMessage, TicketRow, TicketStatus } from '../types';

const STATUS_TONE: Record<TicketStatus, 'warn' | 'dim' | 'pos'> = { open: 'warn', waiting: 'dim', closed: 'pos' };

export function Tickets({ selected }: { selected: number | null }) {
  const list = useAdmin<{ tickets: TicketRow[] }>('tickets', {}, 30_000);
  const [status, setStatus] = useState<TicketStatus | 'all'>('open');
  const [category, setCategory] = useState('all');
  const [q, setQ] = useState('');
  const tickets = list.data?.tickets ?? [];
  const categories = useMemo(() => [...new Set(tickets.map((t) => t.category))].sort(), [tickets]);
  const shown = tickets.filter((t) =>
    (status === 'all' || t.status === status) && (category === 'all' || t.category === category) &&
    (!q || `${t.id} ${t.wallet ?? ''} ${t.claimedWallet ?? ''} ${t.lastText}`.toLowerCase().includes(q.toLowerCase())));
  const counts = { open: 0, waiting: 0, closed: 0 } as Record<TicketStatus, number>;
  for (const t of tickets) counts[t.status] += 1;
  return (
    <>
      <PageHead title="Tickets" loaded={list}>
        <input className="ad-input ad-input--small" placeholder="Search text, wallet, #id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tickets" />
      </PageHead>
      {list.error && <Note kind="error">{list.error}</Note>}
      <div className="ad-filters" role="group" aria-label="Status">
        {(['open', 'waiting', 'closed', 'all'] as const).map((s) => (
          <button key={s} type="button" className={`ad-chip${status === s ? ' is-on' : ''}`} onClick={() => setStatus(s)}>
            {s}{s !== 'all' ? ` ${counts[s]}` : ` ${tickets.length}`}
          </button>
        ))}
        <select className="ad-input ad-input--small" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="all">every category</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="ad-split">
        <ul className="ad-ticketlist">
          {shown.map((t) => (
            <li key={t.id}>
              <a href={`#/tickets/${t.id}`} className={t.id === selected ? 'is-on' : undefined}>
                <div className="ad-ticketlist__top">
                  <span className="ad-mono">#{t.id}</span>
                  <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
                  <span className="ad-dim">{t.category}</span>
                  <span className="ad-dim ad-right">{ago(t.lastAt)}</span>
                </div>
                <div className="ad-ticketlist__text">{t.lastFrom === 'owner' ? 'You: ' : ''}{t.lastText}</div>
                <div className="ad-dim">{t.wallet ? short(t.wallet) : t.claimedWallet ? `${short(t.claimedWallet)} (claimed)` : 'no wallet'} · {t.messages} messages{t.images ? ` · ${t.images} screenshots` : ''}</div>
              </a>
            </li>
          ))}
          {!shown.length && !list.loading && <li className="ad-dim ad-pad">No ticket here.</li>}
        </ul>
        <div className="ad-thread">{selected ? <Thread id={selected} onChanged={list.reload} /> : <p className="ad-dim ad-pad">Pick a ticket.</p>}</div>
      </div>
    </>
  );
}

function Thread({ id, onChanged }: { id: number; onChanged: () => void }) {
  const t = useAdmin<{ ticket: { id: number; category: string; wallet: string | null; createdAt: number; status: TicketStatus }; messages: TicketMessage[] }>('ticket', { id });
  const { ensure } = useWallet();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const write = async (what: string, run: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await run();
      t.reload();
      onChanged();
    } catch (e) {
      setError(isUserRejection(e) ? 'You declined the signature in the wallet - nothing was changed.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const reply = () => write('reply', async () => {
    const c = await ensure();
    const payload = { id, text };
    const action = await signAction(c, 'ticket.reply', `ticket ${id}`, payload, `Reply: ${text}`);
    await call('ticket/reply', { ...payload, action });
    setText('');
  });
  const setStatus = (status: TicketStatus) => write(status, async () => {
    const c = await ensure();
    const payload = { id, status };
    const action = await signAction(c, 'ticket.status', `ticket ${id}`, payload, `Mark ticket ${id} ${status}`);
    await call('ticket/status', { ...payload, action });
  });

  if (t.error) return <Note kind="error">{t.error}</Note>;
  if (!t.data) return <p className="ad-dim ad-pad">Loading…</p>;
  const { ticket, messages } = t.data;
  return (
    <div className="ad-thread__inner">
      <div className="ad-thread__head">
        <div>
          <span className="ad-mono">#{ticket.id}</span> <Badge tone={STATUS_TONE[ticket.status]}>{ticket.status}</Badge> <span className="ad-dim">{ticket.category} · since {when(ticket.createdAt)}</span>
          <div className="ad-dim">{ticket.wallet ? <>wallet <span className="ad-mono">{ticket.wallet}</span> (proven)</> : 'not kept on a wallet'}</div>
        </div>
        <div className="ad-row">
          {(['open', 'waiting', 'closed'] as const).filter((s) => s !== ticket.status).map((s) => (
            <button key={s} type="button" className="ad-btn" disabled={!!busy} onClick={() => void setStatus(s)}>{busy === s ? 'Signing…' : `Mark ${s}`}</button>
          ))}
        </div>
      </div>
      <ol className="ad-messages">
        {messages.map((m) => <Message key={m.id} id={id} m={m} />)}
      </ol>
      <form className="ad-reply" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void reply(); }}>
        <textarea className="ad-input" rows={4} maxLength={4000} placeholder="Your answer - the visitor sees it in their feedback chat; it also goes to the Telegram thread." value={text} onChange={(e) => setText(e.target.value)} aria-label="Answer" />
        <div className="ad-row">
          <span className="ad-dim">{text.length}/4000 · signing names this ticket and this exact text</span>
          <button type="submit" className="ad-btn ad-btn--primary ad-right" disabled={!text.trim() || !!busy}>{busy === 'reply' ? 'Waiting for the signature…' : 'Sign and send'}</button>
        </div>
        {error && <p className="ad-error" role="alert">{error}</p>}
      </form>
    </div>
  );
}

function Message({ id, m }: { id: number; m: TicketMessage }) {
  const ctx = m.context;
  return (
    <li className={`ad-msg ad-msg--${m.from}`}>
      <div className="ad-msg__meta">
        <span>{m.from === 'owner' ? 'ValueDesk' : 'Visitor'}</span>
        <span className="ad-dim">{when(m.at)}</span>
        {m.from === 'user' && m.wallet && <span className="ad-dim">{short(m.wallet)} {m.proven ? '(proven)' : '(claimed)'}</span>}
        {m.category && <span className="ad-dim">{m.category}{m.areas.length ? `: ${m.areas.join(', ')}` : ''}</span>}
      </div>
      <div className="ad-msg__text">{m.text}</div>
      {m.images.length > 0 && <div className="ad-msg__imgs">{m.images.map((img) => <Shot key={img} id={id} image={img} />)}</div>}
      {ctx && (
        <details className="ad-msg__ctx">
          <summary>Page info</summary>
          <dl>{Object.entries(ctx).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></div>)}</dl>
        </details>
      )}
    </li>
  );
}

/** A screenshot, fetched with the session (never a plain URL) and shown from memory. */
function Shot({ id, image }: { id: number; image: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    void call<Blob>('ticket/image', { id, image }, { blob: true }).then((b) => {
      url = URL.createObjectURL(b);
      if (live) setSrc(url);
    }).catch(() => null);
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, image]);
  return src ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="Screenshot from the visitor" className="ad-shot" /></a> : <span className="ad-dim">loading screenshot…</span>;
}
