/**
 * The Algos tab: every algo order this browser runs (or ran), one row each, as the account tables.
 *
 * A card says how far it is (filled of the target, a bar), how well it went
 * (average fill against the arrival price and against the market's own VWAP
 * over the same window, positive meaning better for you), what it is doing
 * now, and offers Pause / Resume / Cancel. Opened, it shows the facts and its
 * log - every child sent, every fill, every hold and why.
 *
 * Cancel all is the kill switch: every running algo is cancelled and its
 * resting children pulled from SoDEX; what filled stays filled.
 */
import { useEffect, useState } from 'react';
import { ALGO_NAMES, FINAL_STATUSES, type AlgoEvent, type AlgoSpec, type AlgoView } from '@copy-engine';
import { DASH, fmtTime, fmtUsd } from '../../format';
import { notify } from '../../toast';
import { actOn, eventsOn, listOn, type ExecutorMode } from '../../algo/executorAlgos';
import { useAlgos } from '../../algo/useAlgos';
import { fmtDuration, menuName, type UiKind } from './menu';
import { AlgoIcon } from './AlgoIcon';
import { RunningWindow } from './RunningWindow';
import { CoinIcon } from '../CoinIcon';
import { SidePill } from '../accountTables/cells';
import './algo.css';

type Place = 'browser' | ExecutorMode;

const PLACE_WORD: Record<Place, string> = { browser: 'this browser', hosted: 'ValueDesk 24/7', self: 'self-hosted' };

/** This wallet's algos on the executors it is signed in to, read every 5 s while the tab is open. */
function useExecutorAlgos(address: string | null): { hosted: AlgoView[]; self: AlgoView[]; reload: () => void } {
  const [rows, setRows] = useState<{ hosted: AlgoView[]; self: AlgoView[] }>({ hosted: [], self: [] });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!address) {
      setRows({ hosted: [], self: [] });
      return;
    }
    let gone = false;
    const load = async () => {
      const [hosted, self] = await Promise.all([listOn('hosted').catch(() => []), listOn('self').catch(() => [])]);
      if (!gone) setRows({ hosted, self });
    };
    void load();
    const t = window.setInterval(() => void load(), 5_000);
    return () => {
      gone = true;
      window.clearInterval(t);
    };
  }, [address, tick]);
  return { ...rows, reload: () => setTick((x) => x + 1) };
}

/** The ticket's order type a spec was made as: DCA is a scale and Chase TWAP a TWAP, each named by its label. */
export function uiKindOf(s: AlgoSpec): UiKind {
  if (s.kind === 'scale' && s.label === 'DCA') return 'dca';
  if (s.kind === 'twap' && s.label === 'Chase TWAP') return 'chasetwap';
  return s.kind;
}

const STATUS_WORD: Record<string, string> = {
  scheduled: 'Scheduled', running: 'Running', waiting: 'Held', paused: 'Paused', done: 'Done', cancelled: 'Cancelled', expired: 'Ended', failed: 'Failed',
};

function fmtPx(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return DASH;
  const a = Math.abs(p);
  return p.toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 1 : a >= 1 ? 4 : 6 });
}

function fmtBps(b: number | null): { text: string; cls: string } {
  if (b === null || !Number.isFinite(b)) return { text: DASH, cls: '' };
  const t = `${b > 0 ? '+' : b < 0 ? '−' : ''}${Math.abs(b).toFixed(1)} bp`;
  return { text: t, cls: b > 0.05 ? 'algo-pos' : b < -0.05 ? 'algo-neg' : '' };
}

const fmtQ = (q: number): string => (q === 0 ? '0' : Math.abs(q) >= 1 ? q.toLocaleString('en-US', { maximumFractionDigits: 4 }) : q.toPrecision(4).replace(/\.?0+$/, ''));

/** An instruction, wherever the algo runs: in this browser at once; on an executor, one wallet signature. */
async function act(place: Place, what: 'pause' | 'resume' | 'cancel' | 'cancelAll', id?: string): Promise<void> {
  try {
    if (place !== 'browser') {
      await actOn(place, what === 'cancelAll' ? 'cancel-all' : what, id);
      return;
    }
    const { browserAlgos } = await import('../../algo/browserAlgos');
    if (what === 'cancelAll') await browserAlgos.cancelAll();
    else await browserAlgos[what](id!);
  } catch (e) {
    notify('error', e instanceof Error ? e.message : String(e));
  }
}

function Log({ id, live, place }: { id: string; live: boolean; place: Place }) {
  const [events, setEvents] = useState<AlgoEvent[] | null>(null);
  useEffect(() => {
    let gone = false;
    const load = async () => {
      let e: AlgoEvent[] = [];
      if (place === 'browser') {
        const { browserAlgos } = await import('../../algo/browserAlgos');
        e = await browserAlgos.events(id, 200).catch(() => []);
      } else e = await eventsOn(place, id, 200).catch(() => []);
      if (!gone) setEvents(e);
    };
    void load();
    const t = live ? window.setInterval(() => void load(), place === 'browser' ? 2_000 : 5_000) : 0;
    return () => {
      gone = true;
      if (t) window.clearInterval(t);
    };
  }, [id, live, place]);
  if (!events) return <p className="oe-hint">Loading the log…</p>;
  if (!events.length) return <p className="oe-hint">Nothing logged yet.</p>;
  return (
    <ol className="algo-log" aria-label="Log">
      {events.map((e) => (
        <li key={e.id} className={`is-${e.kind}`}>
          <time>{fmtTime(e.at)}</time>
          <span>{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

function Card({ v, place, onActed }: { v: AlgoView; place: Place; onActed?: () => void }) {
  const [open, setOpen] = useState(false);
  const [win, setWin] = useState(false);
  const doAct = (what: 'pause' | 'resume' | 'cancel') => void act(place, what, v.algo.id).then(() => onActed?.());
  const a = v.algo;
  const s = a.spec;
  const live = !FINAL_STATUSES.has(a.status);
  const base = s.symbol.replace(/-USD$/, '');
  const pct = Math.round(v.progress * 100);
  const arr = fmtBps(v.vsArrivalBps);
  const vw = fmtBps(v.vsMarketVwapBps);
  const sideWord = s.side === 'buy' ? 'Buy' : 'Sell';
  const target = v.target;
  const now = Date.now();
  // A basket fills in its legs, on several markets: its progress is in USD.
  const basket = s.kind === 'basket' ? { done: (v.legs ?? []).reduce((x, l) => x + l.filledValue, 0), total: s.legs.reduce((x, l) => x + l.usd, 0) } : null;
  const facts = (
    <>
          <dl className="algo-card__facts">
            <dt>Started</dt>
            <dd>{a.startedAt ? fmtTime(a.startedAt) : s.startAt ? `at ${fmtTime(s.startAt)}` : s.triggerPrice ? `at ${fmtPx(s.triggerPrice)}` : DASH}</dd>
            {v.endsAt && (
              <>
                <dt>Ends</dt>
                <dd>{fmtTime(v.endsAt)}{live && v.endsAt > now ? ` (in ${fmtDuration(v.endsAt - now)})` : ''}</dd>
              </>
            )}
            {live && v.nextAt && (
              <>
                <dt>Next</dt>
                <dd>{v.nextAt > now ? `in ${fmtDuration(v.nextAt - now)}` : 'now'}</dd>
              </>
            )}
            {v.working && (
              <>
                <dt>Working</dt>
                <dd>{v.working}</dd>
              </>
            )}
            {v.triggerPrice !== null && (
              <>
                <dt>Stop at</dt>
                <dd>{fmtPx(v.triggerPrice)}</dd>
              </>
            )}
            <dt>Arrival</dt>
            <dd>{fmtPx(a.arrival)}</dd>
            <dt>Market VWAP</dt>
            <dd>{fmtPx(v.marketVwap)}</dd>
            <dt>vs VWAP</dt>
            <dd className={vw.cls}>{vw.text}</dd>
            <dt>Resting fills</dt>
            <dd>{a.filled > 0 ? `${Math.round((a.makerQty / a.filled) * 100)}%` : DASH}</dd>
            <dt>Value</dt>
            <dd>{a.filledValue > 0 ? fmtUsd(a.filledValue, 2) : DASH}</dd>
            <dt>Fees (est.)</dt>
            <dd>{a.fees > 0 ? fmtUsd(a.fees, 2) : DASH}</dd>
            <dt>Children</dt>
            <dd>{a.childCount}{a.rejects ? ` · ${a.rejects} refused` : ''}</dd>
          </dl>
          {v.exits && v.exits.length > 0 && (
            <ul className="algo-log" aria-label="Exits">
              {v.exits.map((x, i) => (
                <li key={`${x.kind}${i}`} className={x.filled > 0 ? 'is-fill' : ''}>
                  <time>{x.live ? (s.paper ? 'watching' : 'on SoDEX') : x.filled > 0 ? 'filled' : 'gone'}</time>
                  <span>
                    {x.kind === 'tp' ? 'Take-profit' : 'Stop-loss'} at {fmtPx(x.price)} for {fmtQ(x.quantity)} {base}
                    {x.filled > 0 ? ` (filled ${fmtQ(x.filled)})` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {v.legs && v.legs.length > 0 && (
            <ul className="algo-log" aria-label="Markets">
              {v.legs.map((l) => (
                <li key={l.id} className={l.status === 'done' ? 'is-fill' : ''}>
                  <time>{STATUS_WORD[l.status] ?? l.status}</time>
                  <span>
                    {l.side === 'buy' ? 'Long' : 'Short'} {l.symbol}: {l.filledValue > 0 ? `${fmtUsd(l.filledValue, 2)} at ${fmtPx(l.avgPrice)}` : 'nothing filled yet'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {v.conditions && (
            <ul className="algo-log" aria-label="Conditions">
              {v.conditions.map((c) => (
                <li key={c.text} className={c.ok ? 'is-fill' : ''}>
                  <time>{c.ok ? 'holds' : 'waits'}</time>
                  <span>{c.text}</span>
                </li>
              ))}
            </ul>
          )}
    </>
  );
  const next = live && v.nextAt ? (v.nextAt > now ? `next in ${fmtDuration(v.nextAt - now)}` : 'next now') : null;
  const ends = v.endsAt ? (live && v.endsAt > now ? `ends in ${fmtDuration(v.endsAt - now)}` : live ? null : `ended ${fmtTime(v.endsAt)}`) : null;
  return (
    <>
      <tr className={`algo-tr is-${s.side}${s.paper ? ' is-paper' : ''}${open ? ' is-open' : ''}`} onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        <td>
          <span className="algo-tr__name">
            <span className="algo-tr__mark" aria-hidden="true"><AlgoIcon kind={uiKindOf(s)} size={14} /></span>
            <span>{s.kind === 'basket' ? ALGO_NAMES[s.kind] : menuName(uiKindOf(s))}</span>
            {s.paper && <span className="acct-pill algo-pill--paper" title="A practice run: worked against the live market, nothing is sent to SoDEX">Practice</span>}
          </span>
        </td>
        <td>
          {s.kind === 'basket' ? (
            <span className="acct-mkt">{s.legs.length} markets</span>
          ) : (
            <span className="acct-mkt">
              <CoinIcon coin={base} size={16} />
              <span className="acct-mkt__n">{base}</span>
              <SidePill dir={s.side === 'buy' ? 'long' : 'short'} />
            </span>
          )}
        </td>
        <td>
          <span className={`algo-status is-${a.status}`}>{STATUS_WORD[a.status] ?? a.status}</span>
          {place !== 'browser' && <span className="acct-sub"> · {PLACE_WORD[place]}</span>}
        </td>
        <td className="num">
          <span className="algo-tr__fill">
            <span className="algo-tr__bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></span>
            <span>
              {basket ? (
                <>{fmtUsd(basket.done, 0)}<span className="acct-unit"> / {fmtUsd(basket.total, 0)}</span></>
              ) : (
                <>{fmtQ(a.filled)}<span className="acct-unit">{target !== null ? ` / ${fmtQ(target)}` : ''} {base}</span></>
              )}
            </span>
            <b>{pct}%</b>
          </span>
        </td>
        <td className="num">{v.avgPrice !== null ? fmtPx(v.avgPrice) : DASH}</td>
        <td className={`num ${arr.cls}`} title="Average fill against the mid when it started; positive is better for you">{arr.text}</td>
        <td className="acct-word algo-tr__now" title={v.working ?? undefined}>{(live ? v.working ?? next ?? ends : ends) ?? DASH}</td>
        <td className="num acct-time">{a.startedAt ? fmtTime(a.startedAt) : s.startAt ? `at ${fmtTime(s.startAt)}` : DASH}</td>
        <td className="acct-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="acct-act" onClick={() => setWin(true)} title="Its own window: the live chart, every order and the log">Open</button>
          {live && a.status !== 'paused' && <button type="button" className="acct-act" onClick={() => doAct('pause')} title="Pause: its resting children are pulled; nothing new is sent">Pause</button>}
          {a.status === 'paused' && <button type="button" className="acct-act" onClick={() => doAct('resume')}>Resume</button>}
          {live && <button type="button" className="acct-act acct-act--danger" onClick={() => doAct('cancel')} title="Cancel: resting children are cancelled; what filled stays filled">Cancel</button>}
          {win && (
            <RunningWindow
              v={v}
              kind={uiKindOf(s)}
              open={win}
              onClose={() => setWin(false)}
              facts={facts}
              log={<Log id={a.id} live={live} place={place} />}
              actions={
                <>
                  {live && a.status !== 'paused' && <button type="button" className="algo-chip" onClick={() => doAct('pause')}>Pause</button>}
                  {a.status === 'paused' && <button type="button" className="algo-chip" onClick={() => doAct('resume')}>Resume</button>}
                  {live && <button type="button" className="algo-chip" onClick={() => doAct('cancel')}>Cancel</button>}
                </>
              }
            />
          )}
        </td>
      </tr>
      {open && (
        <tr className="algo-tr__more">
          <td colSpan={9}>
            <div className="algo-card__body">
              {a.statusReason && <p className="algo-card__reason">{a.statusReason}</p>}
              {facts}
              <Log id={a.id} live={live} place={place} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

type Show = 'all' | 'running' | 'ended';

export default function AlgoTable({ address }: { address: string | null }) {
  const { role, views: here } = useAlgos(address);
  const remote = useExecutorAlgos(address);
  const [show, setShow] = useState<Show>('all');
  const all: Array<{ v: AlgoView; place: Place }> = [
    ...here.map((v) => ({ v, place: 'browser' as const })),
    ...remote.hosted.map((v) => ({ v, place: 'hosted' as const })),
    ...remote.self.map((v) => ({ v, place: 'self' as const })),
  ];
  // A basket's legs are shown inside the basket's row, not as rows of their own.
  const baskets = new Set(all.filter((r) => r.v.algo.spec.kind === 'basket').map((r) => r.v.algo.id));
  const rows = all.filter((r) => !(r.v.algo.parentId && baskets.has(r.v.algo.parentId))).sort((a, b) => b.v.algo.createdAt - a.v.algo.createdAt);
  const isLive = (r: { v: AlgoView }) => !FINAL_STATUSES.has(r.v.algo.status);
  const live = rows.filter(isLive);
  const ended = rows.filter((r) => !isLive(r)).slice(0, 50);
  const livePlaces = [...new Set(live.map((r) => r.place))];
  const cancelAll = async () => {
    for (const p of livePlaces) await act(p, 'cancelAll');
    remote.reload();
  };
  if (!address && !rows.length) {
    return (
      <div className="algos__empty">
        <b>No wallet connected</b>
        <span>Connect a wallet to run TWAP, VWAP, POV, iceberg, chase, scale, DCA, swarm, conditional, trailing, bracket and basket orders - or switch on Practice run in the ticket to try one without a wallet.</span>
      </div>
    );
  }
  const shown = show === 'running' ? live : show === 'ended' ? ended : [...live, ...ended];
  const where =
    livePlaces.length > 1
      ? livePlaces.map((p) => `${live.filter((r) => r.place === p).length} ${PLACE_WORD[p]}`).join(', ')
      : livePlaces[0] === 'browser'
        ? role === 'standby' ? 'Running in another tab of this browser' : role === 'runner' ? 'Running in this tab' : ''
        : livePlaces[0] ? `Running on ${PLACE_WORD[livePlaces[0]]}` : '';
  const SHOWS: ReadonlyArray<readonly [Show, string, number]> = [['all', 'All', live.length + ended.length], ['running', 'Running', live.length], ['ended', 'Ended', ended.length]];
  return (
    <div className="algos">
      <div className="algos__bar">
        <div className="algos__show" role="tablist" aria-label="Show">
          {SHOWS.map(([k, label, count]) => (
            <button key={k} type="button" role="tab" aria-selected={show === k} className={show === k ? 'is-on' : ''} onClick={() => setShow(k)}>
              {label} <span>{count}</span>
            </button>
          ))}
        </div>
        <span className="algos__where">{where}</span>
        {live.length > 0 && (
          <button type="button" className="algo-btn is-danger" onClick={() => void cancelAll()} title="Cancel every running algo, wherever it runs, and pull its resting children (an executor asks for one wallet signature)">
            Cancel all
          </button>
        )}
      </div>
      <div className="algos__list">
        {!shown.length ? (
          <div className="algos__empty">
            <b>{rows.length ? (show === 'running' ? 'Nothing running' : 'Nothing ended yet') : 'No algo orders yet'}</b>
            <span>Pick Algo in the order ticket: TWAP, VWAP, POV, iceberg, chase, scale, DCA, swarm, conditional, a trailing stop, a bracket or a basket.</span>
          </div>
        ) : (
          <table className="acct-table acct-t algo-t">
            <thead>
              <tr>
                <th>Algo</th>
                <th>Market</th>
                <th>Status</th>
                <th className="num">Filled</th>
                <th className="num">Avg price</th>
                <th className="num" title="Average fill against the mid when it started; positive is better for you">vs arrival</th>
                <th>Now</th>
                <th className="num">Started</th>
                <th className="acct-actions" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Card key={`${r.place}:${r.v.algo.id}`} v={r.v} place={r.place} onActed={r.place === 'browser' ? undefined : remote.reload} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
