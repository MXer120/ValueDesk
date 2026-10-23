import type { CopySettings, LeaderEvent, MarketInfo, SubState, Subscription } from '../src/index.ts';
import { DEFAULT_SETTINGS, freshState } from '../src/index.ts';

export const LEADER = '0x1111111111111111111111111111111111111111';
export const FOLLOWER = '0x2222222222222222222222222222222222222222';

export const BTC: MarketInfo = {
  id: 1,
  name: 'BTC-USD',
  base: 'BTC',
  tickSize: '1',
  stepSize: '0.00001',
  minQuantity: '0.00001',
  maxQuantity: '1000',
  marketMaxQuantity: null,
  minNotional: 10,
  maxNotional: 5_000_000,
  maxLeverage: 50,
  buyLimitUpRatio: 0.05,
  sellLimitDownRatio: 0.05,
  takerFee: 0.0004,
  status: 'TRADING',
};

export const ETH: MarketInfo = { ...BTC, id: 2, name: 'ETH-USD', base: 'ETH', tickSize: '0.1', stepSize: '0.0001', minQuantity: '0.0001' };

export function settings(over: Partial<CopySettings> = {}): CopySettings {
  return { ...DEFAULT_SETTINGS, leader: { venue: 'sodex', address: LEADER }, slippageBps: 50, ...over };
}

export function sub(over: Partial<CopySettings> = {}, extra: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub1',
    owner: FOLLOWER,
    accountId: 42,
    mode: 'hosted',
    settings: settings(over),
    status: 'active',
    statusReason: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: 0,
    country: 'SG',
    observedCountry: null,
    termsVersion: 'test',
    consent: null,
    ...extra,
  };
}

export function state(over: Partial<SubState> = {}, allocation = 1000): SubState {
  return { ...freshState('sub1', allocation), leaderEquity: 100_000, ...over };
}

let n = 0;
export function ev(symbol: string, before: number | null, after: number, price: number, venue: 'sodex' | 'hyperliquid' = 'sodex'): LeaderEvent {
  return { leader: { venue, address: LEADER }, symbol, before, after, price, time: 1_000 + n, id: `e${++n}`, source: 'stream' };
}

export const marks = (m: Record<string, number>) => (s: string): number | null => m[s] ?? null;
