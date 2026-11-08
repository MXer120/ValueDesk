/**
 * VIP servers (owner 2026-11-08): a wallet with $1M of its own 14-day volume may move its
 * bots to the VIP executor on AWS Tokyo. The panel shows how close the wallet is; the move is one signature, run
 * server to server (apps/executor vip.ts), and the page follows it full screen: the two server sites, the bots
 * travelling between them, each step as it lands and the clock (the owner's bar: under 20 seconds).
 */
import { useEffect, useRef, useState } from 'react';
import { onVipPlay } from '../../bots/vipDemo';
import type { VipMoveView } from '@copy-engine';
import { fmtUsd } from '../../format';
import { VIP_BASE, hostedExecutor } from '../../copy/executor';
import { finishVipMove, readVipMove, startVipMove } from '../../copy/live';
import { useConfirm } from '../Modal';
import type { BotsCtx } from './BotsPage';
import { Button, Icon, Panel, ProgressBar, Shell, ShellHeader, StatusPill } from './kit/kit';

interface Eligibility { eligible: boolean; volumeUsd: number; minUsd: number; days: number }

/** The wallet's VIP standing (server routes/builder.ts /api/vs/bots/vip); null while unknown or unreadable. */
function useEligibility(address: string | null): Eligibility | null {
  const [e, setE] = useState<Eligibility | null>(null);
  useEffect(() => {
    if (!address) return setE(null);
    let live = true;
    fetch(`/api/vs/bots/vip?address=${address.toLowerCase()}`, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: (Eligibility & { ok?: boolean }) | null) => { if (live) setE(b?.ok ? b : null); })
      .catch(() => live && setE(null));
    return () => { live = false; };
  }, [address]);
  return e;
}

/* ------------------------------------------------------------------ the move, full screen ----- */

const STEP_ICON = { check: 'shield', pause: 'pause', seal: 'shield', send: 'layers', start: 'bolt', finish: 'check' } as const;

/** Each step is shown for at least this long, so a move that took 80 ms on the servers still reads step by step. */
const STEP_SHOW_MS = 550;

function MoveScene({ job, onClose, from, to }: { job: VipMoveView | null; onClose: () => void; from: string; to: string }) {
  const [now, setNow] = useState(Date.now());
  const t0 = useRef(Date.now());
  // How many steps the scene has shown: one more every STEP_SHOW_MS, never past what the servers finished.
  const [shown, setShown] = useState(0);
  const [doneAt, setDoneAt] = useState<number | null>(null);
  const real = job?.steps ?? [];
  const finished = real.filter((x) => x.state === 'done' || x.state === 'fail').length;
  useEffect(() => {
    if (shown >= finished) return;
    const id = window.setTimeout(() => setShown((n) => n + 1), STEP_SHOW_MS);
    return () => window.clearTimeout(id);
  }, [shown, finished]);
  const revealed = job !== null && shown >= finished && job.state !== 'running';
  useEffect(() => { if (revealed && doneAt === null) setDoneAt(Date.now()); }, [revealed, doneAt]);
  useEffect(() => {
    if (doneAt !== null) return;
    const id = window.setInterval(() => setNow(Date.now()), 50);
    return () => window.clearInterval(id);
  }, [doneAt]);
  const secs = ((doneAt ?? now) - t0.current) / 1000;
  const serverSecs = job?.endedAt ? (job.endedAt - job.startedAt) / 1000 : null;
  const state = !job ? 'running' : revealed ? job.state : 'running';
  // A step as the scene shows it: the real state for those it reached, running for the next, waiting after.
  const view = real.map((x, i) => ({ ...x, ms: i < shown ? x.ms : null, state: i < shown ? x.state : i === shown && state === 'running' ? 'run' : 'wait' } as typeof x));
  const step = (id: string) => view.find((s) => s.id === id)?.state ?? 'wait';
  const sending = step('send') === 'run' || step('send') === 'done';
  const arrived = step('start') === 'done';
  const released = step('finish') === 'done';
  const bots = Math.max(1, Math.min(8, job?.bots || 3));
  return (
    <div className={`bots-vipmove is-${state}`} role="dialog" aria-modal="true" aria-label="Moving your bots to the VIP servers">
      <div className="bots-vipmove__bg" aria-hidden="true" />
      <div className="bots-vipmove__in">
        <header className="bots-vipmove__head">
          <StatusPill tone={state === 'failed' ? 'negative' : state === 'done' ? 'positive' : 'neutral'} dot>{state === 'done' ? 'On VIP' : state === 'failed' ? 'Stopped' : 'Moving'}</StatusPill>
          <h2>{state === 'done' ? 'Your bots run on the VIP servers' : state === 'failed' ? 'The move stopped' : 'Moving your bots to the VIP servers'}</h2>
          <p>{state === 'done' ? job?.bots === 1 ? '1 bot moved with its book. Nothing was closed.' : `${job?.bots ?? 0} bots moved with their books. Nothing was closed.` : state === 'failed' ? (job?.error ?? 'Something went wrong.') : 'Your bots pause for a few seconds and go on where they were.'}</p>
        </header>

        <div className="bots-vipmove__stage">
          <svg viewBox="0 0 900 300" aria-hidden="true">
            <defs>
              <linearGradient id="vipline" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="rgb(var(--ink) / 0.35)" />
                <stop offset="1" stopColor="var(--pos)" />
              </linearGradient>
              <path id="viproute" d="M150,170 C330,40 570,40 750,170" />
            </defs>
            <use href="#viproute" className="bots-vipmove__track" />
            <use href="#viproute" className={`bots-vipmove__flow${state === 'running' ? ' is-on' : ''}`} stroke="url(#vipline)" />
            {sending && state !== 'failed' && Array.from({ length: bots }, (_, i) => (
              <g key={i} className="bots-vipmove__pkt" style={{ opacity: arrived ? 0 : 1 }}>
                <circle r="7" />
                <animateMotion dur="1.4s" begin={`${i * 0.18}s`} repeatCount={arrived ? '1' : 'indefinite'} fill="freeze" rotate="auto">
                  <mpath href="#viproute" />
                </animateMotion>
              </g>
            ))}
            <g className={`bots-vipmove__node is-from${released ? ' is-off' : ''}`} transform="translate(150,170)">
              <circle className="bots-vipmove__halo" r="54" />
              <circle className="bots-vipmove__core" r="36" />
              <text y="6">STD</text>
            </g>
            <g className={`bots-vipmove__node is-to${arrived ? ' is-lit' : ''}`} transform="translate(750,170)">
              <circle className="bots-vipmove__ring" r="54" />
              <circle className="bots-vipmove__halo" r="54" />
              <circle className="bots-vipmove__core" r="36" />
              <text y="6">VIP</text>
            </g>
          </svg>
          <div className="bots-vipmove__sites">
            <span><b>Standard servers</b><small>{from}</small></span>
            <span className="bots-vipmove__clock"><b>{secs.toFixed(1)}<small>s</small></b><small>{state === 'done' ? `the servers took ${serverSecs !== null ? (serverSecs < 1 ? `${Math.max(1, Math.round(serverSecs * 1000))} ms` : `${serverSecs.toFixed(1)} s`) : '–'}` : 'elapsed'}</small></span>
            <span><b>VIP servers</b><small>{to}</small></span>
          </div>
        </div>

        <ol className="bots-vipmove__steps">
          {view.map((s) => (
            <li key={s.id} className={`is-${s.state}`}>
              <span className="bots-vipmove__dot">{s.state === 'done' ? <Icon name="check" size={13} /> : s.state === 'fail' ? <Icon name="x" size={13} /> : <Icon name={STEP_ICON[s.id as keyof typeof STEP_ICON] ?? 'layers'} size={13} />}</span>
              <span className="bots-vipmove__lab">{s.label}</span>
              <span className="bots-vipmove__ms">{s.ms !== null ? (s.ms < 1000 ? `${Math.max(1, Math.round(s.ms))} ms` : `${(s.ms / 1000).toFixed(1)} s`) : s.state === 'run' ? '…' : ''}</span>
            </li>
          ))}
          {!job && <li className="is-run"><span className="bots-vipmove__dot"><Icon name="wallet" size={13} /></span><span className="bots-vipmove__lab">Waiting for your signature</span><span className="bots-vipmove__ms">…</span></li>}
        </ol>

        {state !== 'running' && (
          <div className="bots-vipmove__act">
            <Button variant={state === 'done' ? 'go' : 'secondary'} size="md" icon={state === 'done' ? 'check' : undefined} onClick={onClose}>{state === 'done' ? 'Done' : 'Close'}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ the unlock, full screen ----- */

const PERKS = [
  { icon: 'coins' as const, t: 'The lowest ValueDesk fee', s: 'On futures, spot, copy trading and bots' },
  { icon: 'bolt' as const, t: 'VIP servers', s: 'Your bots next to SoDEX on AWS Tokyo' },
  { icon: 'clock' as const, t: 'Faster orders', s: 'About 265 ms against 420 ms in our tests' },
];

/** Becoming VIP: a gold burst, the badge, what it brings, and the move one press away. */
function UnlockScene({ onMove, onClose, volume }: { onMove: () => void; onClose: () => void; volume: number | null }) {
  return (
    <div className="bots-vipmove bots-vipwin" role="dialog" aria-modal="true" aria-label="You are VIP">
      <div className="bots-vipwin__bg" aria-hidden="true" />
      <div className="bots-vipwin__sparks" aria-hidden="true">{Array.from({ length: 18 }, (_, i) => <i key={i} style={{ ['--a' as string]: `${i * 20}deg`, ['--d' as string]: `${(i % 6) * 70}ms` }} />)}</div>
      <div className="bots-vipmove__in">
        <div className="bots-vipwin__badge" aria-hidden="true"><span>VIP</span><i /><i /></div>
        <header className="bots-vipmove__head">
          <StatusPill tone="warning" dot>Unlocked</StatusPill>
          <h2>You are VIP</h2>
          <p>{volume !== null ? `${fmtUsd(volume, 0)} traded in 14 days.` : '$1M traded in 14 days.'} It holds while you stay above $1M.</p>
        </header>
        <ul className="bots-vipwin__perks">
          {PERKS.map((x, i) => (
            <li key={x.t} style={{ animationDelay: `${600 + i * 140}ms` }}>
              <span className="bots-vipwin__ic"><Icon name={x.icon} size={16} /></span>
              <span><b>{x.t}</b><small>{x.s}</small></span>
            </li>
          ))}
        </ul>
        <div className="bots-vipmove__act bots-vipwin__act">
          <Button variant="go" size="md" icon="bolt" onClick={onMove}>Move my bots to VIP servers</Button>
          <Button variant="secondary" size="md" onClick={onClose}>Later</Button>
        </div>
      </div>
    </div>
  );
}

/** A made-up move for the demo: every step done in a few hundred ms (the scene paces them). */
function demoJob(bots: number): VipMoveView {
  const t = Date.now();
  const ms = [140, 60, 90, 210, 120, 70];
  const labels = ['Checking your VIP status', 'Pausing your bots', 'Sealing your key to the VIP servers', 'Handing over bots and books', 'Starting on AWS Tokyo', 'Releasing the standard servers'];
  const ids = ['check', 'pause', 'seal', 'send', 'start', 'finish'];
  return { id: 'demo', state: 'done', startedAt: t, endedAt: t + ms.reduce((a, b) => a + b, 0), steps: ids.map((id, i) => ({ id, label: labels[i]!, state: 'done', ms: ms[i]! })), bots, error: null, session: null };
}

/** The progress to VIP: a gold bar with a glare running across it. */
function GoldBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className={`bots-goldbar${v >= 1 ? ' is-full' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label="Progress to VIP">
      <i style={{ width: `${Math.max(v > 0 ? 2 : 0, v * 100)}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ the panel ----- */

/** The card (Overview compact, Savings full); `stage`: no card, only the scenes, listening to the demo controls and showing the unlock once. */
export function BotsVip({ ctx, compact, stage }: { ctx: BotsCtx; compact?: boolean; stage?: boolean }) {
  const real = useEligibility(ctx.demo ? null : ctx.address);
  // Example bots: a wallet most of the way there.
  const el = ctx.demo ? { eligible: false, volumeUsd: 684_000, minUsd: 1_000_000, days: 14 } : real;
  const [unlock, setUnlock] = useState(false);
  const info = ctx.live.hosted.info;
  const onVip = hostedExecutor.base === VIP_BASE || info?.vip?.tier === 'vip';
  const canMove = !!info?.vip?.canMove && (el?.eligible || !!info.vip.open);
  const [job, setJob] = useState<VipMoveView | null>(null);
  const [open, setOpen] = useState(false);
  // Where the bots leave from, as it was when the move began (the page talks to the VIP side once it is done).
  const [fromAt, setFromAt] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  // The demo controls beside "Demo data" (bots/vipDemo.ts).
  useEffect(() => (!stage ? undefined : onVipPlay((p) => {
    if (p === 'unlock') { setUnlock(true); return; }
    setFromAt(info?.location ?? 'Tokyo, Japan (Contabo)');
    setJob(demoJob(Math.max(1, ctx.bots.filter((v) => !v.algo.endedAt).length)));
    setOpen(true);
  })), [stage, info?.location, ctx.bots]);
  // A wallet that just became VIP sees the unlock once (this browser).
  useEffect(() => {
    if (!stage || !ctx.address || !real?.eligible) return;
    const k = `vs.vip.seen.${ctx.address.toLowerCase()}`;
    try { if (!localStorage.getItem(k)) { localStorage.setItem(k, '1'); setUnlock(true); } } catch { /* private mode */ }
  }, [stage, ctx.address, real?.eligible]);

  // Follow the move: the standard executor's job, every quarter second until it ends.
  useEffect(() => {
    if (!open || !job || job.state !== 'running') return;
    let live = true;
    const id = window.setInterval(() => {
      readVipMove().then((j) => {
        if (!live || !j) return;
        setJob(j);
        if (j.state === 'done') finishVipMove(j);
      }).catch(() => undefined);
    }, 250);
    return () => { live = false; window.clearInterval(id); };
  }, [open, job]);

  const move = async () => {
    const ok = await confirm({
      title: 'Move your bots to the VIP servers?',
      body: 'Your bots pause for a few seconds, then go on from AWS Tokyo with the same books and settings. Nothing is closed. One signature.',
      confirmLabel: 'Move to VIP',
    });
    if (!ok) return;
    setErr(null);
    setJob(null);
    setFromAt(info?.location ?? 'Contabo');
    setOpen(true);
    try {
      setJob(await startVipMove());
    } catch (e) {
      setOpen(false);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const volPct = el ? Math.min(1, el.volumeUsd / el.minUsd) : 0;
  return (
    <>
      {dialog}
      {open && <MoveScene job={job} from={fromAt} to="AWS Tokyo" onClose={() => { setOpen(false); setJob(null); }} />}
      {unlock && <UnlockScene volume={el && el.volumeUsd >= el.minUsd ? el.volumeUsd : null} onClose={() => setUnlock(false)} onMove={() => { setUnlock(false); if (ctx.demo) { setFromAt(info?.location ?? 'Tokyo, Japan (Contabo)'); setJob(demoJob(Math.max(1, ctx.bots.filter((v) => !v.algo.endedAt).length))); setOpen(true); } else void move(); }} />}
      {!stage && <Shell className={`bots-vip${compact ? ' is-compact' : ''}`}>
        <ShellHeader icon="bolt" title={onVip ? 'VIP' : 'Become VIP'} subtitle={onVip ? 'Your bots run on AWS Tokyo, at the lowest fee.' : 'At $1M of your volume in 14 days: the lowest fee on everything, and VIP servers.'} aside={onVip ? <StatusPill tone="positive" dot>VIP · AWS Tokyo</StatusPill> : el?.eligible ? <StatusPill tone="positive" dot>Unlocked</StatusPill> : null} />
        <Panel className="bots-vip__b">
          {onVip ? (
            <div className="bots-vip__on">
              <span className="bots-vip__badge" aria-hidden="true"><Icon name="bolt" size={20} /></span>
              <p>Your bots run next to SoDEX on AWS Tokyo. In our tests an order was answered in about 265 ms from there, against about 420 ms from the standard servers (median, Nov 6).</p>
            </div>
          ) : (
            <>
              <div className="bots-vip__prog">
                <div className="bots-vip__nums"><b>{el ? fmtUsd(el.volumeUsd, 0) : '—'}</b><span>of {fmtUsd(el?.minUsd ?? 1_000_000, 0)} in 14 days</span><em>{el ? `${Math.floor(volPct * 100)}%` : ''}</em></div>
                <GoldBar value={volPct} />
                {el && !el.eligible && <small className="bots-fine">{fmtUsd(Math.max(0, el.minUsd - el.volumeUsd), 0)} to go.</small>}
              </div>
              {!compact && (
                <ul className="bots-vip__perks">
                  <li><Icon name="coins" size={13} />The lowest ValueDesk fee on futures, spot, copy and bots</li>
                  <li><Icon name="bolt" size={13} />VIP servers on AWS Tokyo, next to SoDEX</li>
                  <li><Icon name="clock" size={13} />Orders answered faster: about 265 ms against 420 ms in our tests</li>
                </ul>
              )}
              {err && <p className="bots-err" role="alert">{err}</p>}
              {(!compact || canMove) && <div className="bots-vip__act">
                <Button variant="primary" size="md" icon="bolt" disabled={!canMove || !ctx.ready} onClick={() => void move()}>Move to VIP</Button>
                {!info?.vip?.canMove && <small className="bots-fine">The VIP servers open soon.</small>}
                {info?.vip?.canMove && !canMove && <small className="bots-fine">Unlocks at $1M in 14 days.</small>}
              </div>}
            </>
          )}
        </Panel>
      </Shell>}
    </>
  );
}
