/** How the admin suite writes its figures. Micro-USD (the builder ledger's unit) in, text out. */

const MICRO = 1_000_000;

/** $1,234.56 for a micro-USD amount; cents shown below $100k, whole dollars above. */
export function usd(micro: number | null | undefined): string {
  if (micro === null || micro === undefined || !Number.isFinite(micro)) return '–';
  const v = micro / MICRO;
  const digits = Math.abs(v) >= 100_000 ? 0 : 2;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** $12.3M / $45.6K / $789 - for tiles and chart axes. */
export function usdShort(micro: number | null | undefined): string {
  if (micro === null || micro === undefined || !Number.isFinite(micro)) return '–';
  const v = micro / MICRO;
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(a >= 100 ? 0 : 2)}`;
}

export const int = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '–' : Math.round(n).toLocaleString('en-US'));

export const pct = (f: number | null | undefined, digits = 1): string => (f === null || f === undefined || !Number.isFinite(f) ? '–' : `${(f * 100).toFixed(digits)}%`);

/** A fee in tenths of a basis point (the ledger's unit): 15 -> "1.5 bp". */
export const bp = (tenths: number | null | undefined): string => (tenths === null || tenths === undefined ? '–' : `${(tenths / 10).toFixed(tenths % 10 ? 1 : 0)} bp`);

/** 1h 05m, 4m 12s, 38s. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** 2026-10-31 18:40 UTC. */
export const when = (ms: number | null | undefined): string => (!ms ? '–' : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`);

/** "3 min ago", "2 h ago", "5 d ago". */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '–';
  const d = Math.max(0, now - ms);
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 172_800_000) return `${Math.floor(d / 3_600_000)} h ago`;
  return `${Math.floor(d / 86_400_000)} d ago`;
}

/** A UTC day number (ms / 86 400 000) as "Oct 31". */
export const dayLabel = (day: number): string => new Date(day * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const short = (a: string | null | undefined): string => (!a ? '–' : a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export const bytes = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
};
