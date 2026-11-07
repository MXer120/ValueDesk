/** What the history notification says (HistoryNote.tsx), apart from the card so it is testable without its CSS. */
import type { WalkScope, WalkState } from '../exchange/allTime';

export const day = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

/** How far back each part has come, against the first trade SoDEX states. Below 100 until a part really reached it. */
export function share(s: WalkScope, first: number | null, now: number): number | null {
  if (s.complete) return 1;
  if (first === null) return null;
  if (s.oldest === null) return 0;
  return Math.max(0, Math.min(0.99, (now - s.oldest) / Math.max(1, now - first)));
}

/** What the card says for a state: whether it shows, the share read (null: not known yet), the line under the title. */
export function noteView(state: WalkState, now: number): { visible: boolean; pct: number | null; detail: string } {
  const done = state.scopes.every((s) => s.complete);
  const shares = state.scopes.map((s) => share(s, state.firstTradeAt, now));
  const known = shares.filter((x): x is number => x !== null);
  const pct = done ? 100 : known.length === shares.length ? Math.min(99, Math.floor((known.reduce((a, b) => a + b, 0) / known.length) * 100)) : null;
  const rows = state.scopes.reduce((a, s) => a + s.rows, 0);
  const behind = state.scopes.filter((s) => !s.complete);
  const oldest = behind.reduce<number | null>((m, s) => (s.oldest !== null && (m === null || s.oldest > m) ? s.oldest : m), null);
  const failed = state.scopes.find((s) => s.error && s.error !== 'Paused on this device.' && !s.running && !s.complete);
  const detail = state.held
    ? `${rows.toLocaleString('en-US')} rows kept on this device. Resume to read the rest.`
    : failed
      ? `Waiting on SoDEX: ${failed.error}`
      : [`${rows.toLocaleString('en-US')} rows`, done ? '' : oldest !== null ? `back to ${day(oldest)}` : 'starting', state.firstTradeAt ? `first trade ${day(state.firstTradeAt)}` : '']
          .filter(Boolean).join(' · ');
  return { visible: !done || state.held, pct, detail };
}

