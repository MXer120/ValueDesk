/**
 * Live copy trading, as the UI sees it: one store over the three modes.
 *
 *   browser  the copier in this tab (browserCopier.ts)
 *   hosted   ValueDesk's executor in Tokyo (executor.ts, /api/copy/v1)
 *   self     the follower's own executor (executor.ts, a loopback URL)
 *
 * Setup is the same four steps in every mode, each one the follower's own
 * signature: accept the copy terms (once, every mode), approve the copy fee
 * ceiling on SoDEX (once per account), connect (self-hosted: pair with the
 * code the copier printed; hosted: sign in), and approve the copy key - a key
 * registered on the follower's own SoDEX account for that mode only.
 */
import { parsePrivateKey, sealForImport } from './keyImport';
import { useEffect, useSyncExternalStore } from 'react';
import {
  COPY_TERMS_VERSION,
  canonicalSettings,
  type ActivityEntry,
  type CopySettings,
  type CopyView,
  type ExecutorInfo,
  type MeResponse,
} from '@copy-engine';
import { tradingConfig } from '../trading/config';
import { sodexAccountId } from '../trading/session';
import type { Eip1193Provider } from '../wallet';
import { logger } from '../log';
import { pollEvery } from '../exchange/visibility';
import { BROWSER_KEY_NAME, browserCopier, type BrowserKey, type CopierRole, type PendingConfirm } from './browserCopier';
import { DEFAULT_SELF_URL, ExecutorClient, ExecutorError, hostedExecutor, selfBase, selfUrlProblem, signCopy } from './executor';
import { MAX_BROWSER_KEY_DAYS, approveCopyFee, copyFeeApproval, copyKeyRegistered, registerCopyKey, revokeCopyKey } from './sodexSetup';
import { acceptCopyTerms, adoptRecordedTerms, localTerms, recordPendingTerms, sendTermsTo, type LocalTerms } from './terms';
import { requireTermsOrThrow } from '../legal/acceptance';
import { track } from '../analytics/usage';

const log = logger('copy');

export type CopyModeId = 'browser' | 'hosted' | 'self';

export interface ExecutorSide {
  info: ExecutorInfo | null;
  /** Why info could not be read. */
  infoError: string | null;
  me: MeResponse | null;
  signedIn: boolean;
}

export interface LiveCopy {
  owner: string | null;
  /** The wallet can sign here. False for an address restored read-only (no provider): every step is a signature. */
  canSign: boolean;
  terms: LocalTerms | null;
  viewerCountry: string | null;
  fee: { checked: boolean; perps: number | null; covers: boolean; builderId: number | null };
  browser: { role: CopierRole; key: BrowserKey | null; views: CopyView[]; confirms: PendingConfirm[]; persistent: boolean; keyRegistered: boolean | null };
  hosted: ExecutorSide;
  self: ExecutorSide & { url: string };
  /** What is being waited for (a wallet prompt, a read). */
  busy: string | null;
}

export interface CopyRow {
  mode: CopyModeId;
  view: CopyView;
}

const SELF_URL_KEY = 'vd.copy.selfUrl';
const readSelfUrl = (): string => {
  try {
    return localStorage.getItem(SELF_URL_KEY) || DEFAULT_SELF_URL;
  } catch {
    return DEFAULT_SELF_URL;
  }
};

const emptySide = (): ExecutorSide => ({ info: null, infoError: null, me: null, signedIn: false });

let state: LiveCopy = {
  owner: null,
  canSign: false,
  terms: null,
  viewerCountry: null,
  fee: { checked: false, perps: null, covers: false, builderId: null },
  browser: { role: 'off', key: null, views: [], confirms: [], persistent: true, keyRegistered: null },
  hosted: emptySide(),
  self: { ...emptySide(), url: readSelfUrl() },
  busy: null,
};
let provider: Eip1193Provider | null = null;
let selfClient: ExecutorClient | null = null;
const listeners = new Set<() => void>();
/** Stops the executor-view refresh (exchange/visibility.ts pollEvery: paused while the tab is hidden). */
let poll: (() => void) | null = null;

const set = (patch: Partial<LiveCopy>) => {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
};

function syncBrowser(): void {
  set({
    browser: {
      ...state.browser,
      role: browserCopier.role,
      key: browserCopier.key,
      views: browserCopier.views,
      confirms: browserCopier.confirms,
      persistent: browserCopier.persistent,
    },
  });
}
browserCopier.subscribe(syncBrowser);

function needWallet(): { owner: string; provider: Eip1193Provider } {
  if (!state.owner || !provider) throw new Error('Connect your wallet first.');
  return { owner: state.owner, provider };
}

async function busyWith<T>(what: string, fn: () => Promise<T>): Promise<T> {
  set({ busy: what });
  try {
    return await fn();
  } finally {
    set({ busy: null });
  }
}

/* ------------------------------------------------------------- wallet ----- */

/** Follow the connected wallet (App mounts this once, through useCopyLive). */
export async function setCopyWallet(owner: string | null, p: Eip1193Provider | null): Promise<void> {
  provider = p;
  const o = owner ? owner.toLowerCase() : null;
  const canSign = !!o && !!p;
  if (o === state.owner) {
    if (canSign !== state.canSign) set({ canSign });
    return;
  }
  set({
    owner: o,
    canSign,
    terms: localTerms(o),
    fee: { checked: false, perps: null, covers: false, builderId: null },
    hosted: { ...emptySide(), info: state.hosted.info, infoError: state.hosted.infoError },
    self: { ...emptySide(), url: state.self.url, info: state.self.info, infoError: state.self.infoError },
  });
  await browserCopier.follow(o);
  syncBrowser();
  if (o) {
    void recordPendingTerms(o);
    void refreshFee();
    void refreshBrowserKey();
    void refreshHosted();
    if (selfClient) void refreshSelf();
  }
}

export async function refreshFee(): Promise<void> {
  if (!state.owner) return;
  try {
    const a = await copyFeeApproval(state.owner);
    set({ fee: { checked: true, perps: a.perps, covers: a.covers, builderId: a.builderId } });
  } catch (e) {
    log.warn('copy: builder approval read failed', { error: String(e) });
  }
}

async function refreshBrowserKey(): Promise<void> {
  const k = browserCopier.key;
  if (!k || !state.owner) {
    set({ browser: { ...state.browser, keyRegistered: null } });
    return;
  }
  const r = await copyKeyRegistered(state.owner, k.name, k.address).catch(() => null);
  set({ browser: { ...state.browser, keyRegistered: r ? r.ok : null } });
}

/* ------------------------------------------------------------- hosted ----- */

export async function refreshHosted(): Promise<void> {
  try {
    const info = await hostedExecutor.info();
    browserCopier.viewerCountry = info.viewerCountry;
    set({ hosted: { ...state.hosted, info, infoError: null }, viewerCountry: info.viewerCountry });
  } catch (e) {
    set({ hosted: { ...state.hosted, infoError: e instanceof Error ? e.message : String(e) } });
    return;
  }
  const token = state.owner ? hostedExecutor.token(state.owner) : null;
  if (token) await loadMe('hosted', token);
}

async function loadMe(mode: 'hosted' | 'self', token: string): Promise<void> {
  const client = mode === 'hosted' ? hostedExecutor : selfClient;
  if (!client) return;
  try {
    const me = await client.me(token);
    set({ [mode]: { ...state[mode], me, signedIn: true } } as Partial<LiveCopy>);
    // Accepted in another browser: ValueDesk's record of the current terms counts here too.
    if (mode === 'hosted' && !state.terms && state.owner === me.owner.toLowerCase()) {
      const t = adoptRecordedTerms(me.owner, me.terms);
      if (t) set({ terms: t });
    }
  } catch (e) {
    if (e instanceof ExecutorError && (e.status === 401 || e.status === 403)) set({ [mode]: { ...state[mode], me: null, signedIn: false } } as Partial<LiveCopy>);
    else log.warn(`copy: ${mode} executor read failed`, { error: String(e) });
  }
}

/** Sign in to an executor (one signature) and read this wallet's copies there. */
export async function signIn(mode: 'hosted' | 'self', pairing?: string): Promise<void> {
  const { owner, provider: p } = needWallet();
  const client = mode === 'hosted' ? hostedExecutor : selfClient;
  const info = state[mode].info;
  if (!client || !info) throw new Error(mode === 'self' ? 'Connect your copier first.' : 'The ValueDesk executor is not reachable right now.');
  await busyWith('wallet', async () => {
    const token = await client.session(p, owner, info.executorId, pairing ?? null);
    await loadMe(mode, token);
  });
  if (mode === 'self') {
    const info2 = await client.info();
    set({ self: { ...state.self, info: info2 } });
    // The copier needs the same signed acceptance of the terms (one signature, made once).
    if (state.terms) await sendTermsTo(client, owner).catch((e) => log.warn('copy: terms not sent to the copier', { error: String(e) }));
  }
}

/* --------------------------------------------------------------- self ----- */

export async function connectSelf(url: string): Promise<ExecutorInfo> {
  const problem = selfUrlProblem(url);
  if (problem) throw new Error(problem);
  const client = new ExecutorClient(selfBase(url), 'self');
  const info = await client.info();
  if (info.kind !== 'self') throw new Error('That address answers as a hosted executor, not a self-hosted copier.');
  if (info.network !== tradingConfig().network) throw new Error(`Your copier trades on ${info.network}, this site on ${tradingConfig().network}. Set SODEX_NETWORK to match.`);
  if (info.owner && state.owner && info.owner !== state.owner) throw new Error('This copier is paired with another wallet.');
  selfClient = client;
  try {
    localStorage.setItem(SELF_URL_KEY, url.trim());
  } catch {
    /* private mode */
  }
  set({ self: { ...emptySide(), url: url.trim(), info } });
  const token = state.owner ? client.token(state.owner) : null;
  if (token) await loadMe('self', token);
  return info;
}

export async function refreshSelf(): Promise<void> {
  if (!selfClient) return;
  try {
    const info = await selfClient.info();
    set({ self: { ...state.self, info, infoError: null } });
  } catch (e) {
    set({ self: { ...state.self, infoError: e instanceof Error ? e.message : String(e) } });
    return;
  }
  const token = state.owner ? selfClient.token(state.owner) : null;
  if (token) await loadMe('self', token);
}

/* --------------------------------------------------------------- steps ----- */

export async function acceptTerms(country: string): Promise<void> {
  const { owner, provider: p } = needWallet();
  // ValueDesk's own terms first (the popup, as a gate): copy trading adds to them.
  await requireTermsOrThrow({ owner, reason: 'start copy trading' });
  const t = await busyWith('wallet', () => acceptCopyTerms({ provider: p, owner, country }));
  set({ terms: t });
  if (selfClient && state.self.signedIn) await sendTermsTo(selfClient, owner).catch((e) => log.warn('copy: terms not sent to the copier', { error: String(e) }));
  if (state.hosted.signedIn) await refreshHosted();
}

export async function approveFee(): Promise<void> {
  const { owner, provider: p } = needWallet();
  // ValueDesk's own terms first (the popup, as a gate): copy trading adds to them.
  await requireTermsOrThrow({ owner, reason: 'approve the copy fee' });
  await busyWith('wallet', () => approveCopyFee({ owner, provider: p }));
  await refreshFee();
}

/** Approve the copy key of `mode` for `days`. Two signatures for an executor (its request, then SoDEX's), one for this browser. */
export async function approveKey(mode: CopyModeId, days: number): Promise<void> {
  const { owner, provider: p } = needWallet();
  // ValueDesk's own terms first (the popup, as a gate): copy trading adds to them.
  await requireTermsOrThrow({ owner, reason: 'set up the copy key' });
  if (mode === 'browser') {
    await busyWith('wallet', async () => {
      const k = browserCopier.newKey();
      try {
        const reg = await registerCopyKey({ owner, provider: p, address: k.address, name: BROWSER_KEY_NAME, days: Math.min(days, MAX_BROWSER_KEY_DAYS) });
        await browserCopier.adoptKey(owner, k, reg);
      } finally {
        k.privateKey.fill(0);
      }
    });
    syncBrowser();
    await refreshBrowserKey();
    return;
  }
  const client = mode === 'hosted' ? hostedExecutor : selfClient;
  const info = state[mode].info;
  if (!client || !info) throw new Error('Connect to the executor first.');
  if (mode === 'self') await sendTermsTo(client, owner);
  await busyWith('wallet', async () => {
    const id = await sodexAccountId(owner);
    if (!id) throw new Error('This wallet has no SoDEX account yet. Deposit first; the first deposit opens it.');
    const created = await client.createKey(await signCopy(p, owner, info.executorId, 'create-key', { accountId: id, days }));
    await registerCopyKey({ owner, provider: p, address: created.address, name: created.name, days: created.days });
  });
  // SoDEX lists a new key after a moment: ask the executor to look until it does.
  const token = client.token(owner);
  if (token) {
    for (const wait of [500, 1000, 1500, 2500, 4000, 6000]) {
      await new Promise((r) => setTimeout(r, wait));
      const r = await client.verifyKey(token).catch(() => null);
      if (r?.key?.registered) break;
    }
    await loadMe(mode, token);
  }
}

/**
 * Use a SoDEX API key the follower made themselves (sodex.com -> API keys) on an
 * executor, instead of one the executor makes. The private key is sealed to the
 * executor here, in the browser (keyImport.ts), and sent with the session: only
 * the executor can open it. It must be listed on this wallet's SoDEX account
 * under `name`, valid for at most the executor's longest key lifetime.
 */
export async function importKey(mode: 'hosted' | 'self', name: string, privateKeyText: string): Promise<void> {
  const { owner, provider: p } = needWallet();
  await requireTermsOrThrow({ owner, reason: 'set up the copy key' });
  const client = mode === 'hosted' ? hostedExecutor : selfClient;
  const info = state[mode].info;
  if (!client || !info) throw new Error('Connect to the executor first.');
  if (!info.keyImport) throw new Error(mode === 'self' ? 'This copier is too old to take a key of your own: download the current one and start it again.' : 'The ValueDesk executor does not take keys of your own yet.');
  const pk = parsePrivateKey(privateKeyText);
  if (!pk) throw new Error("Paste the API key's private key: 64 hexadecimal characters, as sodex.com showed it when you made the key.");
  try {
    if (mode === 'self') await sendTermsTo(client, owner);
    const token = await busyWith('wallet', () => client.session(p, owner, info.executorId));
    const envelope = await sealForImport(info.keyImport.publicKey, info.keyImport.info.replace('<owner>', owner), pk);
    await client.importKey(token, name.trim(), envelope);
    await loadMe(mode, token);
  } finally {
    pk.fill(0);
  }
}

/** Revoke a mode's copy key on SoDEX (the hard stop) and forget it there. Every copy of that mode stops. */
export async function revokeKey(mode: CopyModeId, closePositions: boolean): Promise<void> {
  const { owner, provider: p } = needWallet();
  if (mode === 'browser') {
    await browserCopier.stopAll(closePositions).catch(() => {});
    const name = browserCopier.key?.name ?? BROWSER_KEY_NAME;
    await busyWith('wallet', () => revokeCopyKey({ owner, provider: p, name }));
    await browserCopier.dropKey();
    syncBrowser();
    return;
  }
  const client = mode === 'hosted' ? hostedExecutor : selfClient;
  const info = state[mode].info;
  if (!client || !info) throw new Error('Connect to the executor first.');
  const name = state[mode].me?.key?.name ?? info.keyName;
  await busyWith('wallet', async () => {
    const me = await client.deleteKey(await signCopy(p, owner, info.executorId, 'delete-key', { close: closePositions }));
    set({ [mode]: { ...state[mode], me } } as Partial<LiveCopy>);
    await revokeCopyKey({ owner, provider: p, name });
  });
}

/* -------------------------------------------------------------- copies ----- */

/**
 * Whether a mode can run a counter-trade. The browser runs this build's engine;
 * an executor must say so in its info ('counter' in features): one from before
 * counter-trading ignores the direction and would COPY the trader instead.
 */
export function supportsCounter(s: LiveCopy, mode: CopyModeId): boolean {
  if (mode === 'browser') return true;
  return !!s[mode].info?.features?.includes('counter');
}

/**
 * Whether a mode can size by a multiple of the trader (settings.multiplier other than 1). An
 * executor from before it ('multiplier' not in its features) ignores the field and would copy
 * at 1x, and its signature check would not match the rules signed here.
 */
export function supportsMultiplier(s: LiveCopy, mode: CopyModeId): boolean {
  if (mode === 'browser') return true;
  return !!s[mode].info?.features?.includes('multiplier');
}

const multiplierRefusal = (mode: CopyModeId): string => (mode === 'self'
  ? 'Your copier is older than the size multiplier: download the current copier and start it again, or copy at 1x.'
  : 'This executor does not size by a multiplier yet: copy at 1x, or run it in this browser.');

export async function startCopy(mode: CopyModeId, settings: CopySettings): Promise<void> {
  const { owner, provider: p } = needWallet();
  // ValueDesk's own terms first (the popup, as a gate): copy trading adds to them.
  await requireTermsOrThrow({ owner, reason: 'start this copy' });
  const t = state.terms;
  if (!t) throw new Error('Accept the copy trading terms first.');
  if (settings.direction === 'counter' && !supportsCounter(state, mode)) {
    throw new Error(mode === 'self'
      ? 'Your copier is older than counter-trading: download the current copier and start it again.'
      : 'This executor does not run counter-trades yet.');
  }
  if ((settings.multiplier ?? 1) !== 1 && !supportsMultiplier(state, mode)) throw new Error(multiplierRefusal(mode));
  if (mode === 'browser') {
    await browserCopier.start({ owner, settings, country: t.country, termsVersion: COPY_TERMS_VERSION });
    syncBrowser();
    track('copy.start', { mode, direction: settings.direction });
    return;
  }
  const client = mode === 'hosted' ? hostedExecutor : selfClient;
  const info = state[mode].info;
  if (!client || !info) throw new Error('Connect to the executor first.');
  if (mode === 'self') await sendTermsTo(client, owner);
  await busyWith('wallet', async () => {
    await client.subscribe(await signCopy(p, owner, info.executorId, 'subscribe', { settings: canonicalSettings(settings), termsVersion: COPY_TERMS_VERSION }));
  });
  const token = client.token(owner);
  if (token) await loadMe(mode, token);
  track('copy.start', { mode, direction: settings.direction });
}

export type CopyCommand = 'pause' | 'resume' | 'stop' | 'stop-close';

export async function commandCopy(mode: CopyModeId, id: string, cmd: CopyCommand): Promise<void> {
  // Resuming copies again: the terms first. Pausing and stopping never wait for them.
  if (cmd === 'resume' && state.owner) await requireTermsOrThrow({ owner: state.owner, reason: 'resume this copy' });
  if (cmd === 'stop' || cmd === 'stop-close') track('copy.stop', { mode });
  if (mode === 'browser') {
    if (cmd === 'pause') await browserCopier.pause(id);
    else if (cmd === 'resume') await browserCopier.resume(id);
    else await browserCopier.stop(id, cmd === 'stop-close');
    syncBrowser();
    return;
  }
  const { owner, provider: p } = needWallet();
  const client = mode === 'hosted' ? hostedExecutor : selfClient;
  const info = state[mode].info;
  if (!client || !info) throw new Error('The executor is not connected.');
  const action = cmd === 'stop-close' ? 'stop' : cmd;
  const payload = cmd === 'stop' || cmd === 'stop-close' ? { id, close: cmd === 'stop-close' } : { id };
  await busyWith('wallet', async () => {
    await client.act(await signCopy(p, owner, info.executorId, action, payload));
  });
  const token = client.token(owner);
  if (token) await loadMe(mode, token);
}

export async function updateCopy(mode: CopyModeId, id: string, settings: CopySettings): Promise<void> {
  if (state.owner) await requireTermsOrThrow({ owner: state.owner, reason: 'change this copy' });
  if ((settings.multiplier ?? 1) !== 1 && !supportsMultiplier(state, mode)) throw new Error(multiplierRefusal(mode));
  if (mode === 'browser') {
    await browserCopier.update(id, settings);
    syncBrowser();
    return;
  }
  const { owner, provider: p } = needWallet();
  const client = mode === 'hosted' ? hostedExecutor : selfClient;
  const info = state[mode].info;
  if (!client || !info) throw new Error('The executor is not connected.');
  await busyWith('wallet', async () => {
    await client.act(await signCopy(p, owner, info.executorId, 'update', { id, settings: canonicalSettings(settings) }));
  });
  const token = client.token(owner);
  if (token) await loadMe(mode, token);
}

/** The kill switch: every copy in every mode stops (optionally closing copied positions). */
export async function stopAllCopies(close: boolean): Promise<string[]> {
  const failed: string[] = [];
  if (state.browser.views.some((v) => v.subscription.status !== 'stopped')) {
    await browserCopier.stopAll(close).catch((e) => failed.push(`This browser: ${e instanceof Error ? e.message : String(e)}`));
  }
  for (const mode of ['hosted', 'self'] as const) {
    const live = state[mode].me?.copies.some((v) => v.subscription.status !== 'stopped');
    if (!live) continue;
    const client = mode === 'hosted' ? hostedExecutor : selfClient;
    const info = state[mode].info;
    if (!client || !info || !provider || !state.owner) continue;
    try {
      await busyWith('wallet', async () => client.act(await signCopy(provider!, state.owner!, info.executorId, 'stop-all', { close })));
      const token = client.token(state.owner);
      if (token) await loadMe(mode, token);
    } catch (e) {
      failed.push(`${mode === 'hosted' ? 'ValueDesk executor' : 'Your copier'}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  syncBrowser();
  return failed;
}

export async function copyActivity(mode: CopyModeId, id: string): Promise<ActivityEntry[]> {
  if (mode === 'browser') return browserCopier.activity(id);
  const client = mode === 'hosted' ? hostedExecutor : selfClient;
  const token = client && state.owner ? client.token(state.owner) : null;
  if (!client || !token) throw new Error('Sign in to the executor to see this copy’s activity.');
  return (await client.activity(token, id)).entries;
}

export const answerConfirm = (id: string, yes: boolean): void => browserCopier.answer(id, yes);

/* ---------------------------------------------------------------- view ----- */

/** Every copy of this wallet, newest first, across the modes. */
export function copyRows(s: LiveCopy): CopyRow[] {
  const rows: CopyRow[] = [
    ...s.browser.views.map((view) => ({ mode: 'browser' as const, view })),
    ...(s.hosted.me?.copies ?? []).map((view) => ({ mode: 'hosted' as const, view })),
    ...(s.self.me?.copies ?? []).map((view) => ({ mode: 'self' as const, view })),
  ];
  return rows.sort((a, b) => b.view.subscription.createdAt - a.view.subscription.createdAt);
}

/** Where a mode stands in its setup. */
export interface ModeReadiness {
  terms: boolean;
  fee: boolean;
  connected: boolean;
  key: boolean;
  /** Everything a live copy needs. Paper copies need only terms and connection. */
  ready: boolean;
}

export function readiness(s: LiveCopy, mode: CopyModeId): ModeReadiness {
  const terms = !!s.terms;
  const fee = !tradingConfig().builder || s.fee.covers;
  if (mode === 'browser') {
    const key = !!s.browser.key && s.browser.key.expiresAt > Date.now() && s.browser.keyRegistered !== false;
    return { terms, fee, connected: true, key, ready: terms && fee && key };
  }
  const side = s[mode];
  const connected = !!side.info && side.signedIn && (mode === 'hosted' || side.info.owner === s.owner);
  const key = !!side.me?.key?.registered;
  return { terms, fee, connected, key, ready: terms && fee && connected && key };
}

export function getLiveCopy(): LiveCopy {
  return state;
}

export function subscribeLiveCopy(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The live copy state, following the connected wallet. Refreshes executor views every 15 s while mounted. */
export function useLiveCopy(owner: string | null, p: Eip1193Provider | null): LiveCopy {
  const s = useSyncExternalStore(subscribeLiveCopy, getLiveCopy, getLiveCopy);
  useEffect(() => {
    void setCopyWallet(owner, p);
  }, [owner, p]);
  useEffect(() => {
    // Where the executor is and which country it sees: shown before any wallet connects.
    if (!state.hosted.info && !state.hosted.infoError) void refreshHosted();
  }, []);
  useEffect(() => {
    if (poll) return;
    // Views only (the executors run on their own): nothing is read while the tab is
    // hidden, and a refresh that fell due meanwhile runs the moment it is shown.
    poll = pollEvery(15_000, () => {
      if (!state.owner) return;
      const th = hostedExecutor.token(state.owner);
      if (th) void loadMe('hosted', th);
      const ts = selfClient?.token(state.owner);
      if (ts) void loadMe('self', ts);
    });
    return () => {
      poll?.();
      poll = null;
    };
  }, []);
  return s;
}
