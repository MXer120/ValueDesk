/**
 * The macro widgets' reads (server valuescan/fedwatch.ts, indicators.ts,
 * sosovalue/etf.ts): the FOMC's rate odds from Kalshi (Polymarket beside it),
 * an indicator's history from FRED, and the US spot ETFs' flows from SoSoValue.
 */
export interface FedOutcome {
  key: string;
  label: string;
  /** Signed change in basis points; 0 = hold. */
  bp: number;
  prob: number;
  /** The target range it leads to ("3.50–3.75"). */
  target: string | null;
}
export interface FedMeeting {
  meeting: string;
  statementAt: number;
  title: string;
  outcomes: FedOutcome[];
  polymarket?: Record<string, number>;
  source: 'kalshi';
  updatedAt: number;
}
export interface FedWatch {
  now: number;
  current: { lower: number; upper: number } | null;
  meetings: FedMeeting[];
}
export interface FedHistory {
  meeting: string;
  series: Array<{ key: string; label: string; bp: number; points: Array<[number, number]> }>;
}

export interface IndicatorInfo {
  id: string;
  name: string;
  unit: string;
  frequency: string;
  /** The calendar's `short` (CPI, NFP...) and the release field it matches. */
  kind: string;
  field: string;
}
export interface Indicator extends Omit<IndicatorInfo, 'kind' | 'field'> {
  source: { name: string; series: string; href: string };
  points: Array<[number, number]>;
  table: Array<{ period: string; value: number; prior: number | null }>;
  latest: { period: string; value: number; prior: number | null } | null;
  next: { time: number; eventId: string } | null;
  updatedAt: number;
}

export interface EtfDay {
  date: string;
  netInflow: number;
  cumNetInflow: number | null;
  totalNetAssets: number | null;
  valueTraded: number | null;
}
export interface EtfFund {
  ticker: string;
  name: string;
  exchange?: string;
  date?: string | null;
  netInflow: number | null;
  netAssets: number | null;
  share?: number | null;
  price?: number | null;
  change?: number | null;
}
export interface EtfFlows {
  asset: string;
  days: EtfDay[];
  funds: EtfFund[];
  assets: string[];
  updatedAt: number;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  const j = (await r.json().catch(() => null)) as ({ ok?: boolean; message?: string; error?: string } & T) | null;
  if (!j || !j.ok) throw new Error(j?.message ?? j?.error ?? `The request failed (${r.status})`);
  return j;
}

export const macroApi = {
  fedwatch: () => get<FedWatch>('/api/vs/fedwatch'),
  fedHistory: (meeting: string, range: string) => get<FedHistory>(`/api/vs/fedwatch/history?meeting=${encodeURIComponent(meeting)}&range=${range}`),
  indicators: () => get<{ indicators: IndicatorInfo[] }>('/api/vs/indicators'),
  indicator: (id: string, range: string) => get<Indicator>(`/api/vs/indicator?id=${encodeURIComponent(id)}&range=${range}`),
  etf: (asset: string, range: string) => get<EtfFlows>(`/api/vs/etf/flows?asset=${encodeURIComponent(asset)}&range=${range}`),
};

/** "+$1.24B", "-$310.5M": a flow. */
export function fmtUsd(v: number | null | undefined, sign = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(0);
  return `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}$${s}`;
}

/** An indicator's value with its unit: "3.0%", "+177k", "7.1". */
export function fmtValue(unit: string, v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (unit === 'k') return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('en-US')}k`;
  const n = `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
  return unit === '%' ? `${n}%` : unit === 'M' ? `${n}M` : n;
}
