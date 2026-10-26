/**
 * The Algos tab: every algo order this browser runs (or ran), one card each.
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
import { ALGO_NAMES, FINAL_STATUSES, type AlgoEvent, type AlgoView } from '@copy-engine';
import { DASH, fmtTime, fmtUsd } from '../../format';
import { notify } from '../../toast';
import { actOn, eventsOn, listOn, type ExecutorMode } from '../../algo/executorAlgos';
import { useAlgos } from '../../algo/useAlgos';
import { fmtDuration } from './menu';
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

const MARK: Record<string, string> = { twap: 'TW', vwap: 'VW', pov: 'PV', iceberg: 'IC', chase: 'CH', scale: 'SC', dca: 'DC', swarm: 'SW', conditional: 'IF', trailing: 'TS', basket: 'BK', bracket: 'BR' };

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
  return (
    <article className={`algo-card is-${s.side}`}>
      <button type="button" className="algo-card__head" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        <span className="algo-card__mark" aria-hidden="true">{MARK[s.kind] ?? '··'}</span>
        <span className="algo-card__name">
          <b>
            {s.kind === 'basket' ? (
              <>{ALGO_NAMES[s.kind]} · {s.legs.length} markets</>
            ) : (
              <>{s.kind === 'scale' && s.label === 'DCA' ? 'DCA' : ALGO_NAMES[s.kind]} <span className="algo-card__dir">{sideWord}</span> {base}</>
            )}
            {s.paper ? ' · paper' : ''}
            {place !== 'browser' ? ` · ${PLACE_WORD[place]}` : ''}
          </b>
          <span className={`algo-status is-${a.status}`}>{STATUS_WORD[a.status] ?? a.status}</span>
        </span>
        <span className="algo-card__prog">
          <span className="algo-card__bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${pct}%` }} />
          </span>
          <span className="algo-card__nums">
            {basket ? (
              <span>
                <b>{fmtUsd(basket.done, 0)}</b> / {fmtUsd(basket.total, 0)}
              </span>
            ) : (
              <span>
                <b>{fmtQ(a.filled)}</b>
                {target !== null ? ` / ${fmtQ(target)}` : ''} {base}
              </span>
            )}
            <span>{pct}%</span>
          </span>
        </span>
        <span className="algo-card__q">
          <b>{v.avgPrice !== null ? fmtPx(v.avgPrice) : DASH}</b>
          <span className={arr.cls} title="Average fill against the mid when it started; positive is better for you">vs arrival {arr.text}</span>
        </span>
        <span className="algo-card__acts" onClick={(e) => e.stopPropagation()}>
          {live && a.status !== 'paused' && (
            <button type="button" className="oe-mini" onClick={() => doAct('pause')} title="Pause: its resting children are pulled; nothing new is sent">
              Pause
            </button>
          )}
          {a.status === 'paused' && (
            <button type="button" className="oe-mini" onClick={() => doAct('resume')}>
              Resume
            </button>
          )}
          {live && (
            <button type="button" className="oe-mini" onClick={() => doAct('cancel')} title="Cancel: resting children are cancelled on SoDEX; what filled stays filled">
              Cancel
            </button>
          )}
        </span>
      </button>
      {open && (
        <div className="algo-card__body">
          {a.statusReason && <p className="algo-card__reason">{a.statusReason}</p>}
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
          <Log id={a.id} live={live} place={place} />
        </div>
      )}
    </article>
  );
}

export default function AlgoTable({ address }: { address: string | null }) {
  const { role, views: here } = useAlgos(address);
  const remote = useExecutorAlgos(address);
  const all: Array<{ v: AlgoView; place: Place }> = [
    ...here.map((v) => ({ v, place: 'browser' as const })),
    ...remote.hosted.map((v) => ({ v, place: 'hosted' as const })),
    ...remote.self.map((v) => ({ v, place: 'self' as const })),
  ];
  // A basket's legs are shown inside the basket's card, not as cards of their own.
  const baskets = new Set(all.filter((r) => r.v.algo.spec.kind === 'basket').map((r) => r.v.algo.id));
  const rows = all.filter((r) => !(r.v.algo.parentId && baskets.has(r.v.algo.parentId))).sort((a, b) => b.v.algo.createdAt - a.v.algo.createdAt);
  const isLive = (r: { v: AlgoView }) => !FINAL_STATUSES.has(r.v.algo.status);
  const live = rows.filter(isLive);
  const ended = rows.filter((r) => !isLive(r)).slice(0, 30);
  const livePlaces = [...new Set(live.map((r) => r.place))];
  const cancelAll = async () => {
    for (const p of livePlaces) await act(p, 'cancelAll');
    remote.reload();
  };
  const views = rows;
  if (!address && !views.length) {
    return (
      <div className="algos__empty">
        <b>No wallet connected</b>
        <span>Connect a wallet to run TWAP, VWAP, POV, iceberg, chase, scale, DCA, swarm, conditional, trailing, bracket and basket orders - or switch on Paper in the ticket to try one without a wallet.</span>
      </div>
    );
  }
  return (
    <div className="algos">
      <div className="algos__bar">
        <span>
          <b>{live.length}</b> running
          {livePlaces.length > 1
            ? ` (${livePlaces.map((p) => `${live.filter((r) => r.place === p).length} ${PLACE_WORD[p]}`).join(', ')})`
            : livePlaces[0] === 'browser'
              ? role === 'standby' ? ' in another tab of this browser' : role === 'runner' ? ' in this tab' : ''
              : livePlaces[0] ? ` on ${PLACE_WORD[livePlaces[0]]}` : ''}
        </span>
        {live.length > 0 && (
          <button type="button" className="oe-mini" onClick={() => void cancelAll()} title="Cancel every running algo, wherever it runs, and pull its resting children (an executor asks for one wallet signature)">
            Cancel all
          </button>
        )}
      </div>
      <div className="algos__list">
        {!views.length && (
          <div className="algos__empty">
            <b>No algo orders yet</b>
            <span>Pick Algo in the order ticket: TWAP, VWAP, POV, iceberg, chase, scale, DCA, swarm, conditional, a trailing stop, a bracket or a basket.</span>
          </div>
        )}
        {live.map((r) => (
          <Card key={`${r.place}:${r.v.algo.id}`} v={r.v} place={r.place} onActed={r.place === 'browser' ? undefined : remote.reload} />
        ))}
        {ended.map((r) => (
          <Card key={`${r.place}:${r.v.algo.id}`} v={r.v} place={r.place} />
        ))}
      </div>
    </div>
  );
}
