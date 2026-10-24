/**
 * Sanctions screening of the connected wallet: is its address on a sanctions
 * list? Asked once per address and page load, of the Chainalysis sanctions
 * oracle - a public contract on Ethereum mainnet that Chainalysis keeps in line
 * with the crypto addresses on OFAC's SDN list - with one read-only eth_call
 * through the public Ethereum node the app already reads balances from
 * (ethereum-rpc.publicnode.com, in connect-src; no new host, no key):
 *
 *   isSanctioned(address) -> bool        selector 0xdf592f7d
 *   at 0x40C57923924B5c5c5455c48D93317139ADDaC8fb (checked live 2026-10-24:
 *   true for a Lazarus Group address on the SDN list, false for others)
 *
 * A listed wallet cannot be used here: trading/legalGate.ts signs nothing for
 * it, and AccountController says why and disconnects it. The answer stays in
 * this module's memory (privacy.ts section 6); nothing is sent to ValueDesk.
 *
 * FAILING OPEN. A node that does not answer, or answers nonsense, leaves the
 * address 'unknown', which restricts nothing: the screen is one control among
 * several (the edge, the declarations, the terms), and an outage of a public
 * node must not stop every user. It is asked again on the next connect.
 */
import { useSyncExternalStore } from 'react';
import { rpcCall } from '../trading/rpc';
import { logger } from '../log';

const log = logger('legal');

export const SANCTIONS_ORACLE = '0x40C57923924B5c5c5455c48D93317139ADDaC8fb';
export const IS_SANCTIONED_SELECTOR = '0xdf592f7d';
export const SCREENING_RPC = 'https://ethereum-rpc.publicnode.com';

export type Screening = 'clear' | 'sanctioned' | 'unknown';

const results = new Map<string, Screening>();
const pending = new Map<string, Promise<Screening>>();
const listeners = new Set<() => void>();
let revision = 0;

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** The eth_call data for `address`. */
export const screeningCall = (address: string): string => `${IS_SANCTIONED_SELECTOR}${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

/** The oracle's answer: a 32-byte bool. */
export function readScreening(result: unknown): Screening {
  if (typeof result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(result)) return 'unknown';
  const v = BigInt(result);
  return v === 1n ? 'sanctioned' : v === 0n ? 'clear' : 'unknown';
}

/** What is known about `address` now (no request). */
export function screeningOf(address: string | null | undefined): Screening {
  return address ? results.get(address.toLowerCase()) ?? 'unknown' : 'unknown';
}

/** Ask the oracle about `address` (once per page load; again after 'unknown'). */
export function screenWallet(address: string, call: typeof rpcCall = rpcCall): Promise<Screening> {
  const a = address.toLowerCase();
  if (!ADDRESS.test(a)) return Promise.resolve('unknown');
  const known = results.get(a);
  if (known && known !== 'unknown') return Promise.resolve(known);
  const inflight = pending.get(a);
  if (inflight) return inflight;
  const p = (async (): Promise<Screening> => {
    let s: Screening = 'unknown';
    try {
      const r = await call<string>(SCREENING_RPC, 'eth_call', [{ to: SANCTIONS_ORACLE, data: screeningCall(a) }, 'latest']);
      s = readScreening(r.result);
      if (s === 'sanctioned') log.warn('the connected wallet is on a sanctions list: ValueDesk cannot be used with it');
    } catch (e) {
      log.debug('sanctions screening unanswered', { error: String(e) });
    }
    results.set(a, s);
    pending.delete(a);
    revision++;
    for (const l of listeners) l();
    return s;
  })();
  pending.set(a, p);
  return p;
}

export function subscribeScreening(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const getRevision = () => revision;

/** The screening of `address`, re-rendering when the answer arrives. */
export function useScreening(address: string | null | undefined): Screening {
  useSyncExternalStore(subscribeScreening, getRevision, getRevision);
  return screeningOf(address);
}

/** For tests. */
export function _resetScreeningForTests(): void {
  results.clear();
  pending.clear();
}

/** The reason shown for a listed wallet. */
export const SANCTIONED_WALLET_REASON =
  'This wallet address is on a sanctions list, so ValueDesk cannot be used with it. If you believe this is a mistake, contact us at the address in the Impressum.';
