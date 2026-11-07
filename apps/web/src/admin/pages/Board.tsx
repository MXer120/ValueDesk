/**
 * The kanban board: every feature planned, being worked on, done, and reviewed. Claude's sessions
 * keep it current (apps/server/tools/board.ts); the owner adds plans and moves cards here, signed in,
 * with no signature per card (owner 2026-11-05: "I dont want to sign to add stuff"). Only the owner, or
 * a session quoting the owner's confirmation, can mark a card reviewed: the store enforces that,
 * whichever way the change comes in.
 */
import { useMemo, useState } from 'react';
import { call } from '../api';
import { ago, int, when } from '../format';
import { Empty, Figure, Figures, Note, Page, Search, Section, useAdmin } from '../ui';

type Status = 'planned' | 'working' | 'done' | 'reviewed';

interface Card {
  id: number;
  title: string;
  detail: string;
  area: string;
  status: Status;
  session: string;
  ref: string;
  createdAt: number;
  updatedAt: number;
  reviewedAt: number | null;
  reviewedBy: string | null;
}

const COLUMNS: ReadonlyArray<{ id: Status; label: string; empty: string }> = [
  { id: 'planned', label: 'Planned', empty: 'Nothing planned.' },
  { id: 'working', label: 'Working on', empty: 'Nothing in progress.' },
  { id: 'done', label: 'Done', empty: 'Nothing waiting for your review.' },
  { id: 'reviewed', label: 'Reviewed', empty: 'Nothing reviewed yet.' },
];

/** The moves a card offers, the most likely first. */
export function boardMoves(status: Status): Array<{ to: Status; label: string }> {
  switch (status) {
    case 'planned': return [{ to: 'working', label: 'Start' }];
    case 'working': return [{ to: 'done', label: 'Mark done' }, { to: 'planned', label: 'Back to planned' }];
    case 'done': return [{ to: 'reviewed', label: 'Mark reviewed' }, { to: 'working', label: 'Needs work' }];
    case 'reviewed': return [{ to: 'done', label: 'Reopen' }];
  }
}

export function Board() {
  const board = useAdmin<{ cards: Card[] }>('board', {}, 30_000);
  const [title, setTitle] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cards = board.data?.cards ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? cards.filter((c) => `${c.title} ${c.detail} ${c.area} ${c.session} ${c.ref}`.toLowerCase().includes(q)) : cards;
  }, [cards, query]);
  const count = (s: Status) => cards.filter((c) => c.status === s).length;

  const write = async (what: string, run: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await run();
      board.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const add = () => write('add', async () => {
    await call('board/add', { title: title.replace(/\s+/g, ' ').trim(), detail: '', area: '' });
    setTitle('');
  });
  const move = (card: Card, to: Status) => write(`${card.id}:${to}`, async () => {
    await call('board/move', { id: card.id, status: to });
  });

  return (
    <Page
      wide
      title={`${int(count('working'))} in progress, ${int(count('done'))} to review`}
      line="Every feature from plan to reviewed. Claude keeps this current from all sessions; only you can mark a card reviewed, or Claude after you confirm it."
      tone={count('done') ? 'warn' : count('working') ? 'pos' : 'unknown'}
      loaded={board}
    >
      {board.error && <Section><Note kind="error">{board.error}</Note></Section>}
      <Section>
        <Figures>
          {COLUMNS.map((col) => <Figure key={col.id} label={col.label} value={int(count(col.id))} />)}
        </Figures>
      </Section>
      <Section>
        <form className="dv-beta__form" onSubmit={(e) => { e.preventDefault(); if (title.trim()) void add(); }}>
          <label className="lbp-search dv-beta__address">
            <input type="text" value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} placeholder="Plan a feature…" aria-label="New feature" autoComplete="off" />
          </label>
          <button type="submit" className="dv-btn dv-btn--primary" disabled={!title.trim() || !!busy}>
            {busy === 'add' ? 'Adding…' : 'Add'}
          </button>
          <Search value={query} onChange={setQuery} placeholder="Search cards" />
        </form>
        {error && <p className="dv-error" role="alert">{error}</p>}
      </Section>
      <Section flush>
        <div className="dv-board">
          {COLUMNS.map((col) => {
            const list = shown.filter((c) => c.status === col.id);
            return (
              <section key={col.id} className="dv-board__col" aria-label={col.label}>
                <h3 className="dv-board__head"><span>{col.label}</span><span className="dv-count">{int(list.length)}</span></h3>
                {list.length === 0 && !board.loading && <Empty>{col.empty}</Empty>}
                <ul className="dv-board__list">
                  {list.map((c) => (
                    <li key={c.id} className="dv-board__card">
                      <button type="button" className="dv-board__title" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{c.title}</button>
                      <p className="dv-board__meta">
                        {c.area && <span>{c.area}</span>}
                        {c.session && <span>{c.session}</span>}
                        {c.ref && <span className="dv-mono">{c.ref}</span>}
                        <span title={when(c.updatedAt)}>{ago(c.updatedAt)}</span>
                      </p>
                      {open === c.id && (
                        <div className="dv-board__more">
                          {c.detail && <p className="dv-board__detail">{c.detail}</p>}
                          {c.reviewedAt !== null && <p className="dv-quiet" title={when(c.reviewedAt)}>Reviewed {ago(c.reviewedAt)}{c.reviewedBy ? ` by ${c.reviewedBy.startsWith('owner') ? 'you' : c.reviewedBy}` : ''}</p>}
                          <div className="dv-row">
                            {boardMoves(c.status).map((m) => (
                              <button key={m.to} type="button" className={`dv-btn${m.to === 'reviewed' ? ' dv-btn--primary' : ''}`} disabled={!!busy} onClick={() => void move(c, m.to)}>
                                {busy === `${c.id}:${m.to}` ? 'Moving…' : m.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </Section>
    </Page>
  );
}
