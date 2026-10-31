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
import { Empty, Note, Page, Pill, Search, Seg, useAdmin } from '../ui';
import type { TicketMessage, TicketRow, TicketStatus } from '../types';

const STATUS_TONE: Record<TicketStatus, 'warn' | 'dim' | 'pos'> = { open: 'warn', waiting: 'dim', closed: 'pos' };
const STATUS_WORD: Record<TicketStatus, string> = { open: 'Open', waiting: 'Answered', closed: 'Closed' };

export function Tickets({ selected }: { selected: number | null }) {
  const list = useAdmin<{ tickets: TicketRow[] }>('tickets', {}, 30_000);
  // Opened by a link to one ticket: every ticket, so that one is in the list whatever its status.
  const [status, setStatus] = useState<TicketStatus | 'all'>(selected ? 'all' : 'open');
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
    <Page
      title={counts.open ? `${counts.open} ticket${counts.open === 1 ? '' : 's'} waiting for you` : 'No ticket waiting'}
      line="Feedback chats from visitors. Answering or changing a status asks the builder wallet to sign that exact change; answers also go to the Telegram thread."
      tone={counts.open ? 'warn' : 'pos'}
      loaded={list}
      wide
      tools={
        <>
          <Seg
            label="Status"
            value={status}
            onChange={setStatus}
            options={(['open', 'waiting', 'closed', 'all'] as const).map((s) => ({ value: s, label: <>{s === 'all' ? 'All' : STATUS_WORD[s]} <span className="ad-count">{s === 'all' ? tickets.length : counts[s]}</span></> }))}
          />
          {categories.length > 1 && (
            <Seg label="Kind" value={category} onChange={setCategory} options={[{ value: 'all', label: 'Every kind' }, ...categories.map((c) => ({ value: c, label: c[0]!.toUpperCase() + c.slice(1) }))]} />
          )}
          <Search value={q} onChange={setQ} placeholder="Search text, wallet or #id" />
        </>
      }
    >
      {list.error && <div className="ad-section"><Note kind="error">{list.error}</Note></div>}
      <div className="ad-split">
        <ul className="ad-ticketlist">
          {shown.map((t) => (
            <li key={t.id}>
              <a href={`#/tickets/${t.id}`} className={t.id === selected ? 'is-on' : undefined}>
                <div className="ad-ticketlist__top">
                  <span className="ad-ticketlist__id">#{t.id}</span>
                  <span className="ad-ticketlist__kind">{t.category}</span>
                  <span className="st-ms ad-right">{ago(t.lastAt)}</span>
                </div>
                <div className="ad-ticketlist__text">{t.lastFrom === 'owner' ? 'You: ' : ''}{t.lastText}</div>
                <div className="ad-ticketlist__meta">
                  <Pill tone={STATUS_TONE[t.status]}>{STATUS_WORD[t.status]}</Pill>
                  <span>{t.wallet ? short(t.wallet) : t.claimedWallet ? `${short(t.claimedWallet)} (claimed)` : 'no wallet'} · {t.messages} message{t.messages === 1 ? '' : 's'}{t.images ? ` · ${t.images} screenshot${t.images === 1 ? '' : 's'}` : ''}</span>
                </div>
              </a>
            </li>
          ))}
          {!shown.length && !list.loading && <li className="ad-ticketlist__none"><Empty>{q ? 'No ticket matches the search.' : !tickets.length ? 'No visitor has written yet. A message sent with "Send feedback" on the site appears here and in Telegram.' : status === 'all' ? 'No ticket.' : `No ${STATUS_WORD[status as TicketStatus].toLowerCase()} ticket.`}</Empty></li>}
        </ul>
        <div className="ad-thread">{selected ? <Thread id={selected} onChanged={list.reload} /> : <div className="ad-thread__none"><Empty>{tickets.length ? 'Pick a ticket on the left.' : 'Answers you write here reach the visitor\'s feedback chat and the Telegram thread.'}</Empty></div>}</div>
      </div>
    </Page>
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

  if (t.error) return <div className="ad-thread__none"><Note kind="error">{t.error}</Note></div>;
  if (!t.data) return <div className="ad-thread__none"><Empty>Loading…</Empty></div>;
  const { ticket, messages } = t.data;
  return (
    <div className="ad-thread__inner">
      <div className="ad-thread__head">
        <div className="ad-thread__who">
          <span className="ad-thread__title">#{ticket.id} · {ticket.category}</span>
          <span className="st-ms">since {when(ticket.createdAt)} · {ticket.wallet ? <>wallet <span className="ad-mono" title={ticket.wallet}>{short(ticket.wallet)}</span> (proven)</> : 'not kept on a wallet'}</span>
        </div>
        <Pill tone={STATUS_TONE[ticket.status]}>{STATUS_WORD[ticket.status]}</Pill>
        <div className="lbp-seg" role="group" aria-label="Set the status (signed)">
          {(['open', 'waiting', 'closed'] as const).map((s) => (
            <button key={s} type="button" className={s === ticket.status ? 'is-on' : ''} disabled={!!busy || s === ticket.status} onClick={() => void setStatus(s)}>
              {busy === s ? 'Signing…' : STATUS_WORD[s]}
            </button>
          ))}
        </div>
      </div>
      <ol className="ad-messages">
        {messages.map((m) => <Message key={m.id} id={id} m={m} />)}
      </ol>
      <form className="ad-reply" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void reply(); }}>
        <textarea className="ad-textarea" rows={4} maxLength={4000} placeholder="Your answer - the visitor sees it in their feedback chat; it also goes to the Telegram thread." value={text} onChange={(e) => setText(e.target.value)} aria-label="Answer" />
        <div className="ad-row">
          <span className="st-ms">{text.length}/4000 · the signature names this ticket and this exact text</span>
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
        <b>{m.from === 'owner' ? 'ValueDesk' : 'Visitor'}</b>
        <span>{when(m.at)}</span>
        {m.from === 'user' && m.wallet && <span>{short(m.wallet)} {m.proven ? '(proven)' : '(claimed)'}</span>}
        {m.category && <span>{m.category}{m.areas.length ? `: ${m.areas.join(', ')}` : ''}</span>}
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
  return src ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="Screenshot from the visitor" className="ad-shot" /></a> : <span className="st-ms">loading screenshot…</span>;
}
