/**
 * @valuescan/copy-engine - the live copy-trading engine of every ValueDesk
 * copier. See README.md.
 */
export * from './types.ts';
export * from './io.ts';
export * from './confirm.ts';
export * from './policy.ts';
export * from './sanctions.ts';
export * from './settings.ts';
export * from './markets.ts';
export * from './planner.ts';
export * from './sodex.ts';
export * from './socket.ts';
export * from './feeds.ts';
export * from './orders.ts';
export * from './store.ts';
export * from './runtime.ts';
export * from './api.ts';
export * from './priceGuard.ts';
export * from './oracle.ts';
export * from './algo/index.ts';
export * from './notices.ts';
export * from './terms/index.ts';

/** Shown by every copier and sent in the executor's info. 1.1: counter-trading. */
export const COPY_ENGINE_VERSION = '1.1.0';
