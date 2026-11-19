/**
 * Beta access on the main site (owner, 2026-11-06): Bots and the advanced algo orders are for wallets on
 * the beta list (the admin suite's Beta page); everyone else sees them locked, with "Get access", which
 * opens the Discord where testers apply. beta.valuedesk.so lets in listed wallets only, so there all is open.
 *
 * THIS IS WHAT THE PAGE OFFERS, NOT THE LOCK. A real bot starts on the executor, which asks the beta list
 * again for the wallet that signed the start (apps/executor/src/service.ts liveBotFor). A page made to say
 * "listed" still starts nothing real; the algo orders it unlocks are practice runs (algo/liveAlgos.ts).
 *
 * The answer comes from GET /api/vs/beta/listed (apps/server/src/routes/builder.ts), per address, kept a
 * minute and asked again when the tab comes back.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { FEEDBACK_URL } from '../feedback/url';

const env = (import.meta as { env?: { VITE_CHANNEL?: string } }).env;
/** beta.valuedesk.so: its door admits listed wallets only. */
const BETA_SITE = env?.VITE_CHANNEL === 'beta';

/** Where testers apply: the community Discord (the build's feedback link when it sets one). */
export const BETA_APPLY_URL = FEEDBACK_URL ?? 'https://discord.gg/TVJKHY9vhK';

/** The algo orders everyone has; the others are for the beta (owner, 2026-11-06). */
export const OPEN_ALGO_KINDS: ReadonlySet<string> = new Set(['twap', 'trailing', 'sweep', 'conditional']);

const TTL_MS = 60_000;
const known = new Map<string, { listed: boolean; bots: boolean; at: number }>();
/** Real bots open for every wallet (server VALUEDESK_BOTS_OPEN, owner 2026-11-13); null while not read. */
let botsAll: { open: boolean; at: number } | null = null;
let askingAll: Promise<void> | null = null;
const asking = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());

async function ask(wallet: string): Promise<void> {
  try {
    const r = await fetch(`/api/vs/beta/listed?address=${wallet}`, { cache: 'no-store' });
    const body = (await r.json().catch(() => null)) as { ok?: boolean; listed?: unknown; bots?: unknown } | null;
    // Unreadable: keep what was known, else not listed (the executor fails closed too).
    if (r.ok && body?.ok) known.set(wallet, { listed: body.listed === true, bots: body.bots === true || body.listed === true, at: Date.now() });
    else if (!known.has(wallet)) known.set(wallet, { listed: false, bots: false, at: Date.now() });
  } catch {
    if (!known.has(wallet)) known.set(wallet, { listed: false, bots: false, at: Date.now() });
  } finally {
    asking.delete(wallet);
    tell();
  }
}

/** Read it again if it is older than a minute (once at a time per wallet). */
export function refreshBetaAccess(address: string | null | undefined): void {
  const wallet = address?.toLowerCase();
  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet) || asking.has(wallet)) return;
  const k = known.get(wallet);
  if (k && Date.now() - k.at < TTL_MS) return;
  asking.set(wallet, ask(wallet));
}

/** What is known now, asking nothing: the beta site, or a wallet the list was read for. */
export function hasBetaAccess(address: string | null | undefined): boolean {
  if (BETA_SITE) return true;
  const wallet = address?.toLowerCase();
  return !!wallet && known.get(wallet)?.listed === true;
}

export type BetaAccess = 'open' | 'closed' | 'checking';

function accessOf(address: string | null | undefined): BetaAccess {
  if (BETA_SITE) return 'open';
  const wallet = address?.toLowerCase();
  if (!wallet) return 'closed';
  const k = known.get(wallet);
  return k ? (k.listed ? 'open' : 'closed') : 'checking';
}

/** Bots and the advanced orders are open for this wallet. Asks the list as needed. */
export function useBetaAccess(address: string | null | undefined): boolean {
  return useBetaAccessState(address) === 'open';
}

/** The same, telling "not known yet" apart from "not listed": nothing is reset for a wallet still being asked about. */
export function useBetaAccessState(address: string | null | undefined): BetaAccess {
  const open = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => accessOf(address),
    () => (BETA_SITE ? 'open' : 'checking'),
  );
  useEffect(() => {
    if (BETA_SITE || !address) return;
    refreshBetaAccess(address);
    const back = () => { if (document.visibilityState === 'visible') refreshBetaAccess(address); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [address]);
  return open;
}

async function askAll(): Promise<void> {
  try {
    const r = await fetch('/api/vs/bots/access', { cache: 'no-store' });
    const body = (await r.json().catch(() => null)) as { ok?: boolean; open?: unknown } | null;
    if (r.ok && body?.ok) botsAll = { open: body.open === true, at: Date.now() };
    else botsAll ??= { open: false, at: Date.now() };
  } catch {
    botsAll ??= { open: false, at: Date.now() };
  } finally {
    askingAll = null;
    tell();
  }
}
function refreshBotsAll(): void {
  if (askingAll || (botsAll && Date.now() - botsAll.at < TTL_MS)) return;
  askingAll = askAll();
}

/**
 * Real bots for this wallet (owner 2026-11-13: open for everyone, on his word): the beta site, bots open for all, or a
 * wallet the list lets in. Only the Bots page's offer: the executor asks server 1 again for the wallet that signs.
 */
function botsAccessOf(address: string | null | undefined): BetaAccess {
  if (BETA_SITE || botsAll?.open) return 'open';
  const wallet = address?.toLowerCase();
  const k = wallet ? known.get(wallet) : undefined;
  if (k?.bots) return 'open';
  if (!botsAll) return 'checking';
  if (!wallet) return 'closed';
  return k ? 'closed' : 'checking';
}

/** What is known now about real bots for this wallet, asking nothing. */
export function hasBotsAccess(address: string | null | undefined): boolean {
  return botsAccessOf(address) === 'open';
}

/** Real bots open for this wallet: 'open' | 'closed' | 'checking'. Asks the switch and the list as needed. */
export function useBotsAccessState(address: string | null | undefined): BetaAccess {
  const state = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => botsAccessOf(address),
    () => (BETA_SITE ? 'open' : 'checking'),
  );
  useEffect(() => {
    if (BETA_SITE) return;
    const read = () => { refreshBotsAll(); if (address) refreshBetaAccess(address); };
    read();
    const back = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [address]);
  return state;
}

/** Real bots open for this wallet (see useBotsAccessState). */
export function useBotsAccess(address: string | null | undefined): boolean {
  return useBotsAccessState(address) === 'open';
}

/** Open the Discord where testers apply, in a new tab. */
export function applyForBeta(): void {
  window.open(BETA_APPLY_URL, '_blank', 'noopener,noreferrer');
}

/** For tests: forget what was read. */
export function resetBetaAccess(): void {
  known.clear();
  asking.clear();
  botsAll = null;
  askingAll = null;
  tell();
}
