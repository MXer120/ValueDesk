/**
 * The operator's emergency brake and global stop, read from a small JSON file
 * the operator writes on the server (deploy/server/bin/brake.sh):
 *
 *   {"copies": true, "algos": true, "reason": "Investigating a fill problem.", "since": 1761580800000, "cause": "operator"}
 *
 * While `copies` is on, no live copy sends an order; while `algos` is on, every
 * live algo is held (nothing new is sent). Stops already resting on SoDEX stay,
 * an algo's exits are still placed, and what a follower does by hand (pause,
 * stop, stop and close, cancel, delete the key) keeps working. New copies, new
 * algos, resumes and size changes are refused while it is on. Released, copies
 * go on from their leader's next trade and held algos by themselves.
 *
 * WHY A FILE. It is changed without a restart, a deploy or a request that
 * could be forged: whoever can write it can also stop the service. It is read
 * at most once a second (a stat, then the file only when it changed).
 *
 * FAIL CLOSED. A file that exists but cannot be read or parsed is a brake on
 * everything: an operator who meant to switch it on and made a typo has still
 * switched it on. Only a missing file, or one with both switches false, is off.
 *
 * WHY IT IS ON. "cause" is "maintenance" for planned work (ship.sh over an executor restart:
 * brake.sh on --maintenance); anything else - none, a typo, a garbled file - is an operator's
 * emergency stop. Only that one is an alert of the executor's (service.ts): planned work is
 * told on Telegram by whoever set it.
 */
import { readFileSync, statSync } from 'node:fs';

export interface BrakeState {
  copies: boolean;
  algos: boolean;
  /** Shown to followers as it is. */
  reason: string;
  /** When it was switched on (ms), as the file says. */
  since: number | null;
  /** Planned work, or an operator's emergency stop. */
  cause: BrakeCause;
}

export type BrakeCause = 'maintenance' | 'operator';

const READ_EVERY_MS = 1_000;
const DEFAULT_REASON = 'ValueDesk has paused trading on this executor for now.';

/** Parse the file's text: null when both switches are off. A garbled file is a full brake. */
export function parseBrake(text: string): BrakeState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { copies: true, algos: true, reason: `${DEFAULT_REASON} (the brake file cannot be read)`, since: null, cause: 'operator' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { copies: true, algos: true, reason: `${DEFAULT_REASON} (the brake file is not an object)`, since: null, cause: 'operator' };
  const r = raw as Record<string, unknown>;
  // Anything but an explicit false is on: {"copies": "yes"} brakes.
  const copies = r.copies !== false;
  const algos = r.algos !== false;
  if (!copies && !algos) return null;
  const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim().slice(0, 300) : DEFAULT_REASON;
  const since = typeof r.since === 'number' && Number.isFinite(r.since) ? r.since : null;
  const cause: BrakeCause = r.cause === 'maintenance' ? 'maintenance' : 'operator';
  return { copies, algos, reason, since, cause };
}

export class Brake {
  private state: BrakeState | null = null;
  /** What the file was when last read: its time, size and identity (-1: none, -2: unreadable). */
  private mtime: number | string = -1;
  private checkedAt = 0;

  /**
   * @param file the brake file; null: there is none (a self-hosted copier without one configured).
   * @param onChange told when the state changes (for the audit log and the service log).
   */
  constructor(
    private readonly file: string | null,
    private readonly onChange?: (now: BrakeState | null, before: BrakeState | null) => void,
  ) {
    this.read(Date.now(), true);
  }

  /** The brake now (null: off). Cheap: re-reads at most once a second. */
  current(now = Date.now()): BrakeState | null {
    if (now - this.checkedAt >= READ_EVERY_MS) this.read(now, false);
    return this.state;
  }

  /** Why a live copy may not trade now, or null. */
  copies(now = Date.now()): string | null {
    const b = this.current(now);
    return b?.copies ? b.reason : null;
  }

  /** Why a live algo may not trade now, or null. */
  algos(now = Date.now()): string | null {
    const b = this.current(now);
    return b?.algos ? b.reason : null;
  }

  private read(now: number, first: boolean): void {
    this.checkedAt = now;
    if (!this.file) return;
    let next: BrakeState | null;
    try {
      const st = statSync(this.file, { throwIfNoEntry: false });
      if (!st) {
        if (this.mtime === -1 && !first && this.state === null) return;
        this.mtime = -1;
        next = null;
      } else {
        // Time, size and identity, not the time alone: two writes inside one clock tick (a brake set and
        // changed at once, or a coarse file system) keep the time but not the size, and an atomic
        // replace (brake.sh writes a new file and moves it in) is a new file.
        const seen = `${st.mtimeMs}:${st.size}:${st.ino}`;
        if (seen === this.mtime) return;
        this.mtime = seen;
        next = parseBrake(readFileSync(this.file, 'utf8'));
      }
    } catch (e) {
      // There, but unreadable (permissions): on, and read again next time.
      this.mtime = -2;
      next = { copies: true, algos: true, reason: `${DEFAULT_REASON} (the brake file cannot be read: ${(e as NodeJS.ErrnoException).code ?? 'error'})`, since: null, cause: 'operator' };
    }
    const before = this.state;
    this.state = next;
    if (JSON.stringify(before) !== JSON.stringify(next)) this.onChange?.(next, before);
  }
}
