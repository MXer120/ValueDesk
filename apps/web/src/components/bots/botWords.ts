/** A bot's name, its state in words and its PnL as the page prints them. */
import { FINAL_STATUSES, type AlgoView } from '@copy-engine';
import { DASH, fmtUsd } from '../../format';
import { STRATEGY_INFO, strategyOf } from '../../bots/presets';

export function botName(v: AlgoView): string {
  const s = v.algo.spec;
  if (s.label) return s.label;
  const st = strategyOf(s);
  return `${st ? STRATEGY_INFO[st].name : 'Bot'} ${s.symbol.replace(/-USD$/, '')}`;
}

/** +$1.23 / −$1.23; a dash when unknown. */
export function fmtPnl(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const body = fmtUsd(Math.abs(v), 2);
  return v > 0.004 ? `+${body}` : v < -0.004 ? `−${body}` : body;
}

export type BotState = 'running' | 'waiting' | 'paused' | 'closing' | 'ended' | 'failed';

export function botState(v: AlgoView): BotState {
  const a = v.algo;
  if (a.status === 'failed') return 'failed';
  if (FINAL_STATUSES.has(a.status)) return 'ended';
  if (v.bot?.closing) return 'closing';
  if (a.status === 'paused') return 'paused';
  if (a.status === 'waiting' || a.status === 'scheduled') return 'waiting';
  return 'running';
}

export const STATE_WORD: Record<BotState, string> = { running: 'Running', waiting: 'Waiting', paused: 'Paused', closing: 'Closing', ended: 'Stopped', failed: 'Failed' };

/** The state, and why where there is a reason. */
export function statusWords(v: AlgoView): string {
  const st = botState(v);
  const why = v.algo.statusReason;
  if (st === 'running') return v.working ? `Running · ${v.working}` : 'Running';
  return why ? `${STATE_WORD[st]} · ${why}` : STATE_WORD[st];
}
