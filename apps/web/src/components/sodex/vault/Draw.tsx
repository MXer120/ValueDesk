/**
 * The weekly live draw, on the page's side (owner 2026-11-28, SoDEX's own side tab: "Round tickets ×0, Draw snapshot
 * 2d 22:36"). The tab shows the wallet's tickets and the time to the snapshot; its popup the round, the countdown, the
 * wallet's entries and which of them won, or that none did. SoDEX's draw: snapshot Tuesday 13:00 UTC+2, live draw
 * Wednesday 13:00 UTC+2 (its page text); when SoDEX answers a deadline, that is used.
 */
import { useCallback, useState } from 'react';
import { LEVEL_LABEL, isLevel } from '../../../blindBox';
import { readDraw, type DrawRead } from '../../../boxVault';
import { DASH, fmt } from '../../../format';
import type { Eip1193Provider } from '../../../wallet';
import { usePolled } from '../../explore/cohorts/parts';
import { Button, EmptyState, StatusPill } from '../../bots/kit/kit';
import { BoxArt } from '../BoxArt';
import { useNow } from '../parts';
import { Popup, useSodexSession } from './Vault';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The next weekday `dow` (0 Sunday) at 11:00 UTC (13:00 UTC+2), after `now`. */
export function nextAt(now: number, dow: number): number {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11);
  let add = (dow - d.getUTCDay() + 7) % 7;
  if (add === 0 && t <= now) add = 7;
  return t + add * DAY;
}

export const clock = (ms: number): string => {
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const hm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return d > 0 ? `${d}d ${hm}` : `${hm}:${String(s).padStart(2, '0')}`;
};

export function DrawTab({ address, provider, demo }: { address: string | null; provider: Eip1193Provider | null; demo?: DrawRead | null }) {
  const session = useSodexSession(address, provider, !!demo);
  const r = usePolled(!demo && address && session.signedIn ? `box-draw:${address.toLowerCase()}` : null, () => readDraw(address as string), 60_000);
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const d = demo ?? r.data;
  const snapshot = nextAt(now, 2);
  const draw = nextAt(now, 3);
  const deadline = d?.deadlineMs && d.deadlineMs > now ? d.deadlineMs : snapshot;
  return (
    <>
      <button type="button" className="bv-drawtab" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span className="bv-drawtab__t">Round tickets</span>
        <b className="bv-num">{`×${d?.tickets != null ? fmt(d.tickets, 0) : session.signedIn ? '0' : DASH}`}</b>
        <span className="bv-drawtab__c"><small>Draw snapshot</small><span className="bv-num">{clock(deadline - now)}</span></span>
      </button>
      {open && (
        <Popup label="Weekly live draw" size="small" onClose={close} head={<b>Weekly live draw</b>}>
          <div className="bv-draw">
            <div className="bv-draw__clocks">
              <div><small>Snapshot</small><b className="bv-num">{clock(deadline - now)}</b><em>Tuesday 13:00 UTC+2</em></div>
              <div><small>Live draw</small><b className="bv-num">{clock(draw - now)}</b><em>Wednesday 13:00 UTC+2</em></div>
            </div>
            <dl className="bv-progress">
              <div><dt>Round</dt><dd className="bv-num">{d?.round ?? DASH}</dd></div>
              <div><dt>Your tickets</dt><dd className="bv-num">{d?.tickets != null ? fmt(d.tickets, 0) : DASH}</dd></div>
              <div><dt>Wins</dt><dd className="bv-num">{d?.wins != null ? fmt(d.wins, 0) : DASH}</dd></div>
            </dl>
            <p className="bv-note">Every box still unopened at the snapshot is a ticket. Prizes are boxes of all four tiers; winners and the random seed are published after the draw.</p>
            {!address && !demo ? <p className="bv-note">Connect a wallet to see its tickets.</p>
              : !session.signedIn ? <Button variant="primary" loading={session.busy} disabled={!provider} onClick={() => void session.signIn()}>Sign in to SoDEX to see your tickets</Button>
              : !d ? <p className="bv-note">{r.error ?? 'Reading your tickets…'}</p>
              : d.entries.length === 0 ? <EmptyState icon="clock" title={d.status === 'none' ? 'No draw yet' : 'No entries this round'} description="Keep boxes unopened until the snapshot to enter." compact />
              : (
                <>
                  {(d.wins ?? d.entries.filter((e) => e.won).length) === 0
                    ? <div className="bv-draw__none"><b>No wins this round</b><span>Your tickets stay in until the snapshot; the next draw starts fresh.</span></div>
                    : <div className="bv-draw__won"><b>{`You won ${fmt(d.entries.filter((e) => e.won).length, 0)}`}</b><span>Prizes go to the winning wallet.</span></div>}
                  <ul className="bv-draw__list">
                    {[...d.entries].sort((a, b) => Number(b.won) - Number(a.won)).map((e, i) => (
                      <li key={`${e.tokenId}:${i}`} className={e.won ? 'is-won' : ''}>
                        <BoxArt level={e.level ?? 'Common'} size={30} />
                        <span><b>{e.level && isLevel(e.level) ? LEVEL_LABEL[e.level] : e.level ?? DASH}</b><small>{e.tokenId ? `#${e.tokenId}` : ''}</small></span>
                        {e.won ? <StatusPill tone="positive" size="sm">{`Won ${e.prizeLevel && isLevel(e.prizeLevel) ? LEVEL_LABEL[e.prizeLevel] : 'a box'}`}</StatusPill> : <small className="bv-draw__ticket">Ticket</small>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
          </div>
        </Popup>
      )}
    </>
  );
}
