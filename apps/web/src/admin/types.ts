/**
 * What the admin routes answer (apps/server/src/routes/admin.ts and the modules it
 * reads: admin/builderStats.ts, admin/store.ts, ops/analytics.ts, ops/feedbackThreads.ts,
 * admin/statusView.ts). Written out here rather than imported, so the web's type check
 * never pulls the server's node:sqlite modules in. Amounts are micro-USD.
 */

export type TicketStatus = 'open' | 'waiting' | 'closed';

export interface TicketRow {
  id: number;
  category: string;
  wallet: string | null;
  claimedWallet: string | null;
  createdAt: number;
  lastAt: number;
  messages: number;
  ownerMessages: number;
  lastFrom: 'user' | 'owner' | null;
  lastText: string;
  images: number;
  status: TicketStatus;
}

export interface TicketMessage {
  id: number;
  from: 'user' | 'owner';
  text: string;
  at: number;
  images: string[];
  category: string | null;
  areas: string[];
  proven: boolean;
  wallet: string | null;
  context: Record<string, unknown> | null;
}

export interface VolumeDay { day: number; perps: number; spot: number; feePerps: number; feeSpot: number; wallets: number }

export interface BuilderOverview {
  builderId: number;
  volume: { lifetime: { perps: number; spot: number }; d1: number; d7: number; d30: number };
  fees: { lifetime: { perps: number; spot: number }; d1: number; d7: number; d30: number };
  wallets: { total: number; traded7d: number; traded30d: number; flagged: number };
  tiers: Array<{ index: number; minVolumeUsd: number; perps: number; spot: number; wallets: number }>;
  days: VolumeDay[];
  ledgerSince: number | null;
}

export interface BuilderUser {
  address: string;
  accountId: number;
  firstSeen: number;
  verifiedAt: number;
  volume: { perps: number; spot: number };
  windowVolume: number;
  volume30d: number;
  fees: { perps: number; spot: number };
  orders: number;
  lastTradeAt: number | null;
  tier: { index: number; fee: { perps: number; spot: number }; nextAtUsd: number | null };
  signedFee: { perps: number; spot: number; at: number } | null;
  flags: string[];
  pending: number;
}

export interface WalletActivity {
  visits: number;
  activeMs: number;
  lastSeen: number;
  countries: string[];
  features: Array<{ key: string; n: number }>;
}

export interface UserRow {
  address: string;
  builder: BuilderUser | null;
  activity: WalletActivity | null;
  ticket: number | null;
}

export interface Count { key: string; n: number }

export interface AnalyticsSummary {
  from: number;
  to: number;
  totals: { visitors: number; newVisitors: number; visits: number; views: number; bounceRate: number | null; avgVisitMs: number | null; pagesPerVisit: number | null; wallets: number; liveVisits: number };
  days: Array<{ day: number; visitors: number; visits: number; views: number }>;
  pages: Array<{ path: string; views: number; visitors: number; avgMs: number | null }>;
  countries: Count[];
  regions: Count[];
  sources: Count[];
  campaigns: Count[];
  landing: Count[];
  devices: Count[];
  browsers: Count[];
  os: Count[];
  langs: Count[];
  screens: Count[];
  features: Array<{ key: string; label: string; n: number; visitors: number }>;
  vitals: Array<{ name: string; n: number; p50: number; p75: number }>;
  returning: { visitors: number; returning: number };
}

export interface RecentVisit {
  started_at: number;
  last_at: number;
  country: string | null;
  region: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  ref: string | null;
  landing: string | null;
  pages: number;
  active_ms: number;
  wallet: string | null;
}

export interface AuditRow {
  id: number;
  at: number;
  kind: string;
  ok: boolean;
  wallet: string | null;
  client: string | null;
  country: string | null;
  detail: Record<string, unknown> | null;
}

export interface OpenSession { id: string; wallet: string; createdAt: number; expiresAt: number; client: string; country: string | null }

export interface ServiceStatus {
  id: string; name: string; state: 'up' | 'degraded' | 'down' | 'unknown'; checkedAt: number | null; latencyMs: number | null; uptime: number | null;
  /** The last 90 UTC days: [YYYY-MM-DD, up minutes, degraded minutes, down minutes]. */
  days?: Array<[string, number, number, number]>;
}

export interface Notice {
  id: number;
  kind: 'incident' | 'maintenance';
  title: string;
  impact?: string;
  components: string[];
  startsAt: number;
  endsAt?: number;
  closedAt?: number | null;
  updates: Array<{ at: number; stage: string; text?: string }>;
}

export interface EverythingStatus {
  at: number;
  report: { services?: ServiceStatus[]; notices?: Notice[]; error?: string };
  indexer: Record<string, unknown> | null;
  executor: { reachable: boolean; ms?: number; status?: number; error?: string; health?: Record<string, unknown> };
  brake: { trading: boolean; copies: boolean; algos: boolean; reason: string; since: number | null } | null | { error: string };
  releases: { current: string | null; previous: string | null; installed: Array<{ tag: string; at: number }> } | { error: string };
  system: {
    host: string; cores: number; load: number[]; memory: { totalBytes: number; freeBytes: number }; uptimeS: number;
    disk: { path: string; totalBytes: number; freeBytes: number } | null;
    api: { pid: number; uptimeS: number; rssBytes: number; heapUsedBytes: number; node: string };
  } | { error: string };
  clientErrors: Array<{ fp: string; kind: string; name: string; message: string; count: number; lastAt: number; firstAt: number; lastRoute: string; lastBrowser: string; lastBuild: string }> | { error: string };
}
