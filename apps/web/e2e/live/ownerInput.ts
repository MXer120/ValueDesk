/**
 * What the owner types while a live run waits for a deposit they send by hand:
 * `s` skips that deposit, `skip all` every one still to come. Nothing else is
 * read, and nothing typed can make the run sign or send anything - a typed line
 * only ever ENDS a wait early.
 *
 * Read from this process's stdin (a console, or the guided launcher, which
 * forwards the lines typed during the live run). Started only while such a wait
 * runs, paused again after it.
 */
export interface OwnerInput {
  /** Start listening (lines typed before this are not answers); `what` names the wait (e.g. "SOL|SOL"). */
  start(what?: string): void;
  /** The next line typed since start(), or null. Never blocks. */
  take(): string | null;
  stop(): void;
}

export type OwnerWord = 'skip' | 'skip-all' | null;

/** What a typed line means. */
export function ownerWord(line: string | null): OwnerWord {
  const s = (line ?? '').trim().toLowerCase();
  if (s === 'skip all' || s === 'skipall' || s === 'sa' || s === 's all') return 'skip-all';
  if (s === 's' || s === 'skip') return 'skip';
  return null;
}

export function stdinOwnerInput(stdin: NodeJS.ReadStream = process.stdin): OwnerInput {
  const queue: string[] = [];
  let buf = '';
  let on = false;
  const onData = (chunk: string | Buffer): void => {
    buf += String(chunk);
    for (;;) {
      const i = buf.search(/\r\n|\n|\r/);
      if (i < 0) break;
      queue.push(buf.slice(0, i));
      buf = buf.slice(i + (buf.startsWith('\r\n', i) ? 2 : 1));
    }
  };
  return {
    start() {
      queue.length = 0;
      buf = '';
      if (on) return;
      on = true;
      try {
        stdin.setEncoding('utf8');
        stdin.on('data', onData);
        stdin.on('error', () => undefined);
        stdin.resume();
      } catch {
        /* no stdin: the wait runs to its time-out */
      }
    },
    take() {
      return queue.length ? queue.shift()! : null;
    },
    stop() {
      if (!on) return;
      on = false;
      try {
        stdin.off('data', onData);
        stdin.pause();
      } catch {
        /* gone */
      }
    },
  };
}

/** A scripted owner, for the offline simulation: what they type during the wait named `what` (once). */
export function scriptedOwnerInput(script: Readonly<Record<string, string>>): OwnerInput & { given: string[] } {
  const given: string[] = [];
  const used = new Set<string>();
  let current = '';
  return {
    given,
    start(what = '') {
      current = what;
    },
    take() {
      const l = script[current];
      if (l === undefined || used.has(current)) return null;
      used.add(current);
      given.push(`${current}: ${l}`);
      return l;
    },
    stop() {
      current = '';
    },
  };
}
