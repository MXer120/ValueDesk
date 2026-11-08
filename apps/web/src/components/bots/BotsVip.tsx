/**
 * VIP servers (owner 2026-11-08): a wallet with $1M of its own 14-day volume, or on the beta's 30 days of VIP, may
 * move its bots to the VIP executor (never named by host on the page: "VIP servers"). The panel shows how close the wallet is; the move is one signature, run
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
import { Button, Icon, Panel, Shell, ShellHeader, StatusPill } from './kit/kit';
import { GoldMark, VipGround, VipPass, vipPerks } from './VipScene';

interface Eligibility { eligible: boolean; volumeUsd: number; minUsd: number; days: number; promo?: { until: number | null; label: string } | null }

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

function MoveScene({ job, onClose }: { job: VipMoveView | null; onClose: () => void }) {
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
  const progress = real.length ? Math.min(1, shown / real.length) : 0;
  const done = state === 'done';
  return (
    <div className={`bots-vipmove vipx is-${state}`} role="dialog" aria-modal="true" aria-label="Moving your bots to the VIP servers">
      {/* The gold comes up as the move goes: dim while it runs, full once the bots are on VIP. */}
      <VipGround lit={done ? 1 : 0.25 + progress * 0.45} />
      {done && <div className="vipx-burst" aria-hidden="true">{Array.from({ length: 22 }, (_, i) => <i key={i} style={{ ['--a' as string]: `${i * (360 / 22)}deg`, ['--d' as string]: `${(i % 5) * 60}ms` }} />)}</div>}
      <div className="bots-vipmove__in">
        <header className="bots-vipmove__head">
          <span className={`vipx-pill${done ? ' is-gold' : state === 'failed' ? ' is-bad' : ''}`}><i />{done ? 'On VIP' : state === 'failed' ? 'Stopped' : 'Moving'}</span>
          <h2 className={done ? 'vipx-goldtext' : undefined}>{done ? 'Your bots run on the VIP servers' : state === 'failed' ? 'The move stopped' : 'Moving your bots to the VIP servers'}</h2>
          <p>{done ? job?.bots === 1 ? '1 bot moved with its book. Nothing was closed.' : `${job?.bots ?? 0} bots moved with their books. Nothing was closed.` : state === 'failed' ? (job?.error ?? 'Something went wrong.') : 'Your bots pause for a few seconds and go on where they were.'}</p>
        </header>

        <div className="bots-vipmove__stage">
          <svg viewBox="0 0 900 300" aria-hidden="true">
            <defs>
              <linearGradient id="vipline" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="rgba(255,255,255,0.25)" />
                <stop offset="1" stopColor="#f6dc8e" />
              </linearGradient>
              <radialGradient id="vipcore" cx="0.35" cy="0.3" r="0.8">
                <stop offset="0" stopColor="#fff1c2" /><stop offset="0.45" stopColor="#f6dc8e" /><stop offset="0.8" stopColor="#d4a748" /><stop offset="1" stopColor="#8a651f" />
              </radialGradient>
              <path id="viproute" d="M150,170 C330,40 570,40 750,170" />
            </defs>
            <use href="#viproute" className="bots-vipmove__track" />
            <use href="#viproute" className={`bots-vipmove__flow${state === 'running' ? ' is-on' : ''}`} stroke="url(#vipline)" />
            {sending && state !== 'failed' && Array.from({ length: bots }, (_, i) => (
              <g key={i} className="bots-vipmove__pkt" style={{ opacity: arrived ? 0 : 1 }}>
                <rect x="-6" y="-7.5" width="12" height="15" rx="3" />
                <animateMotion dur="1.4s" begin={`${i * 0.18}s`} repeatCount={arrived ? '1' : 'indefinite'} fill="freeze" rotate="auto">
                  <mpath href="#viproute" />
                </animateMotion>
              </g>
            ))}
            <g className={`bots-vipmove__node is-from${released ? ' is-off' : ''}`} transform="translate(150,170)">
              <circle className="bots-vipmove__halo" r="54" />
              <rect className="bots-vipmove__core" x="-38" y="-38" width="76" height="76" rx="20" />
              <text y="6">STD</text>
            </g>
            <g className={`bots-vipmove__node is-to${arrived ? ' is-lit' : ''}`} transform="translate(750,170)">
              <circle className="bots-vipmove__ring" r="58" />
              <circle className="bots-vipmove__ring is-2" r="58" />
              <circle className="bots-vipmove__halo" r="58" />
              <rect className="bots-vipmove__core" x="-40" y="-40" width="80" height="80" rx="22" fill={arrived ? 'url(#vipcore)' : undefined} />
              <text y="7">VIP</text>
            </g>
          </svg>
          <div className="bots-vipmove__sites">
            <span><b>Standard servers</b><small>Shared</small></span>
            <span className="bots-vipmove__clock"><b>{secs.toFixed(1)}<small>s</small></b><small>{done ? `the servers took ${serverSecs !== null ? (serverSecs < 1 ? `${Math.max(1, Math.round(serverSecs * 1000))} ms` : `${serverSecs.toFixed(1)} s`) : '–'}` : 'elapsed'}</small></span>
            <span><b>VIP servers</b><small>Dedicated, orders 1.6× faster</small></span>
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
            {done ? <button type="button" className="vipx-cta" onClick={onClose}><Icon name="check" size={15} />Done</button>
              : <Button variant="secondary" size="md" onClick={onClose}>Close</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ the unlock, full screen ----- */

/**
 * Becoming VIP, in the launch post's look: the gold mark and the words on the left, the gold pass on the right.
 * `promo`: the beta's VIP for 30 days (every product's lowest fee, until a date); otherwise the $1M milestone.
 */
function UnlockScene({ onMove, onClose, volume, promo }: { onMove: () => void; onClose: () => void; volume: number | null; promo: { until: number | null } | null }) {
  const days = promo?.until ? Math.max(1, Math.ceil((promo.until - Date.now()) / 86_400_000)) : null;
  return (
    <div className="bots-vipmove vipx vipx-win" role="dialog" aria-modal="true" aria-label="You are VIP">
      <VipGround />
      <div className="vipx-win__in">
        <div className="vipx-win__say">
          <div className="vipx-lockup"><GoldMark size={56} /><span className="vipx-lockup__rule" /><span className="vipx-lockup__name">ValueDesk</span></div>
          <h2 className="vipx-win__h">You are VIP.<br /><span className="vipx-goldtext">{promo ? `VIP for ${days ?? 30} days.` : 'Bot fees slashed.'}</span></h2>
          <p className="vipx-win__p">{promo
            ? 'The lowest fees on futures, spot, copy trading and bots, the VIP servers and new features first.'
            : `${volume !== null ? fmtUsd(volume, 0) : '$1M'} traded in 14 days. Your bots pay the lowest fee and may move to the VIP servers. It holds while you stay above $1M.`}</p>
          <div className="vipx-win__act">
            <button type="button" className="vipx-cta" onClick={onMove}><Icon name="bolt" size={15} />Move my bots to VIP servers</button>
            <button type="button" className="vipx-later" onClick={onClose}>Later</button>
          </div>
        </div>
        <VipPass delay={260} pill={promo ? `${days ?? 30} days` : '$1M · 14 days'} line={promo ? 'Early access pass' : 'Volume milestone'} perks={vipPerks(!!promo)} />
      </div>
    </div>
  );
}

/** A made-up move for the demo: every step done in a few hundred ms (the scene paces them). */
function demoJob(bots: number): VipMoveView {
  const t = Date.now();
  const ms = [140, 60, 90, 210, 120, 70];
  const labels = ['Checking your VIP status', 'Pausing your bots', 'Sealing your key to the VIP servers', 'Handing over bots and books', 'Starting on the VIP servers', 'Releasing the standard servers'];
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

const PERK_ICON = { tag: 'coins', server: 'layers', bolt: 'bolt', star: 'star' } as const;

/** The card (Overview compact, Savings full); `stage`: no card, only the scenes, listening to the demo controls and showing the unlock once. */
export function BotsVip({ ctx, compact, stage }: { ctx: BotsCtx; compact?: boolean; stage?: boolean }) {
  const real = useEligibility(ctx.demo ? null : ctx.address);
  // Example bots: a wallet most of the way there.
  const el = ctx.demo ? { eligible: false, volumeUsd: 684_000, minUsd: 1_000_000, days: 14 } : real;
  const [unlock, setUnlock] = useState(false);
  // The demo plays either unlock: the $1M milestone, or the beta's 30 days.
  const [demoPromo, setDemoPromo] = useState(false);
  const info = ctx.live.hosted.info;
  const onVip = hostedExecutor.base === VIP_BASE || info?.vip?.tier === 'vip';
  const canMove = !!info?.vip?.canMove && (el?.eligible || !!info.vip.open);
  const [job, setJob] = useState<VipMoveView | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  // The demo controls beside "Demo data" (bots/vipDemo.ts).
  useEffect(() => (!stage ? undefined : onVipPlay((p) => {
    if (p === 'unlock' || p === 'unlock-promo') { setDemoPromo(p === 'unlock-promo'); setUnlock(true); return; }
    setJob(demoJob(Math.max(1, ctx.bots.filter((v) => !v.algo.endedAt).length)));
    setOpen(true);
  })), [stage, ctx.bots]);
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
      body: 'Your bots pause for a few seconds, then go on from the VIP servers with the same books and settings. Nothing is closed. One signature.',
      confirmLabel: 'Move to VIP',
    });
    if (!ok) return;
    setErr(null);
    setJob(null);
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
      {open && <MoveScene job={job} onClose={() => { setOpen(false); setJob(null); }} />}
      {unlock && <UnlockScene promo={ctx.demo ? (demoPromo ? { until: Date.now() + 30 * 86_400_000 } : null) : el?.promo ?? null} volume={el && el.volumeUsd >= el.minUsd ? el.volumeUsd : null} onClose={() => setUnlock(false)} onMove={() => { setUnlock(false); if (ctx.demo) { setJob(demoJob(Math.max(1, ctx.bots.filter((v) => !v.algo.endedAt).length))); setOpen(true); } else void move(); }} />}
      {!stage && <Shell className={`bots-vip${compact ? ' is-compact' : ''}`}>
        <ShellHeader icon="bolt" title={onVip ? 'VIP' : 'Become VIP'} subtitle={onVip ? 'Your bots run on the VIP servers, at the lowest bot fee.' : el?.promo ? 'Your beta VIP: the lowest fee on everything, and VIP servers.' : 'At $1M of your volume in 14 days: bot fees slashed, and VIP servers.'} aside={onVip ? <StatusPill tone="warning" dot>VIP servers</StatusPill> : el?.eligible ? <StatusPill tone="positive" dot>Unlocked</StatusPill> : null} />
        <Panel className="bots-vip__b">
          {onVip ? (
            <div className="bots-vip__on">
              <span className="bots-vip__badge" aria-hidden="true"><GoldMark size={26} /></span>
              <p>Your bots run on the dedicated VIP servers: orders 1.6× faster, latency down 37% in our tests.</p>
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
                  {vipPerks(!!el?.promo).map((p) => <li key={p.title}><Icon name={PERK_ICON[p.icon]} size={13} /><b>{p.title}</b>{p.sub ? <span>{p.sub}</span> : p.chips ? <span>{p.chips.join(' · ')}</span> : null}</li>)}
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
