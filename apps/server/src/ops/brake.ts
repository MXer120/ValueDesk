/**
 * The operator's emergency brake for the SITE, read from a small JSON file on
 * the server (deploy/server/bin/brake.sh writes it):
 *
 *   {"trading": true, "copies": true, "algos": true, "reason": "Investigating.", "since": 1761580800000}
 *
 * /api/health reports it and the web app obeys it within its 30 s health poll,
 * whatever the build says (trading/config.ts): `trading` switches every order
 * from the browser off (closing a position included - an incident can be in the
 * order path itself), `copies` stops the browser copier sending, `algos` holds
 * browser algos. The executor on the other server reads its own file
 * (apps/executor/src/brake.ts); brake.sh sets both.
 *
 * Fail closed: a file that is there but cannot be read or parsed is a full
 * brake. A missing file, or every switch false, is off. Read at most once a
 * second (a stat; the file only when it changed).
 */
import { readFileSync, statSync } from 'node:fs';

export interface SiteBrake {
  trading: boolean;
  copies: boolean;
  algos: boolean;
  reason: string;
  since: number | null;
}

const DEFAULT_REASON = 'ValueDesk has paused trading for now.';
const FULL = (why: string): SiteBrake => ({ trading: true, copies: true, algos: true, reason: `${DEFAULT_REASON} (${why})`, since: null });

/** null: off. Anything but an explicit false is on. */
export function parseSiteBrake(text: string): SiteBrake | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return FULL('the brake file cannot be read');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return FULL('the brake file is not an object');
  const r = raw as Record<string, unknown>;
  const b = { trading: r.trading !== false, copies: r.copies !== false, algos: r.algos !== false };
  if (!b.trading && !b.copies && !b.algos) return null;
  const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim().slice(0, 300) : DEFAULT_REASON;
  return { ...b, reason, since: typeof r.since === 'number' && Number.isFinite(r.since) ? r.since : null };
}

export function siteBrakeReader(file: string | null): () => SiteBrake | null {
  let state: SiteBrake | null = null;
  let mtime = -1;
  let at = 0;
  return (now = Date.now()) => {
    if (!file || now - at < 1_000) return state;
    at = now;
    try {
      const st = statSync(file, { throwIfNoEntry: false });
      if (!st) {
        mtime = -1;
        state = null;
      } else if (st.mtimeMs !== mtime) {
        mtime = st.mtimeMs;
        state = parseSiteBrake(readFileSync(file, 'utf8'));
      }
    } catch (e) {
      mtime = -2;
      state = FULL(`the brake file cannot be read: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    return state;
  };
}
