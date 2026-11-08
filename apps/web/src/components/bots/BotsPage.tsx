/**
 * Bots: market makers that run around the clock on the ValueDesk executor (Contabo, Tokyo, the official SoDEX
 * route) in the trader's own SoDEX account. The section (bots/routes.ts):
 *
 *   Overview   every bot, however many: the fleet's figures, the executor's latency to SoDEX, the list with
 *              search, filter, sort and pages, and controls for one bot or all of them
 *   New bot    the market maker (R10, with the market gate) or a grid: market, size, limits, practice or real,
 *              and what it is estimated to cost there, before it starts
 *   A bot      full control: pause, resume, every setting the executor lets change while it runs, stop (and
 *              close or keep what it holds), delete; its chart, trades and log
 *   Explore    what a market maker costs on every market, from that market's own trades, without running there
 *   Savings    what lowers the cost: the next fee tier, staking, a cheaper market, the market gate
 *
 * One shell holds what every page needs (the wallet's executor setup, the bots, the confirm dialog), so moving
 * between pages keeps the list on screen.
 */
import { playVip } from '../../bots/vipDemo';
import { BotsVip } from './BotsVip';
import { ErrorBoundary } from '../ErrorBoundary';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AlgoView } from '@copy-engine';
import { FINAL_STATUSES } from '@copy-engine';
import type { Eip1193Provider } from '../../wallet';
import { fmtUsd } from '../../format';
import { useLiveCopy, readiness, signIn as signInExecutor } from '../../copy/live';
import { COPY_TERMS_VERSION } from '@copy-engine';
import { liveBotsFor } from '../../algo/liveAlgos';
import { notify } from '../../toast';
import { useConfirm } from '../Modal';
import { useBots } from '../../bots/useBots';
import { BOTS_ON, goBots, useBotsView, type BotsView } from '../../bots/routes';
import { specOf, draftOfSpec, strategyOf } from '../../bots/presets';
import { BotSetupSheet, botReady } from './BotSetupSheet';
import { botName } from './botWords';
import { BotsOverview } from './BotsOverview';
import { BotNewPage } from './BotNewPage';
import { BotDetail } from './BotDetail';
import { BotsExplore } from './BotsExplore';
import { BotsSavings } from './BotsSavings';
import { StatusPill, type Tone } from './kit/kit';
import type { BotState } from './botWords';
import { STATE_WORD } from './botWords';
import { applyForBeta, useBetaAccessState } from '../../beta/access';
import { openConnectDialog } from '../account/connect';
import { Button, EmptyState, Icon, IconButton, Panel, Shell, Skeleton, StatusPill as Pill, Switch } from './kit/kit';
import { demoBots, demoDefault, demoStarted, saveDemo } from '../../bots/demo';
import { listBotsOn } from '../../algo/executorAlgos';
import { ExecutorError, hostedExecutor, meBots } from '../../copy/executor';
import { requestDeposit } from '../account/actions';
import './bots.css';
import './botsPages.css';

export interface BotsCtx {
  address: string | null;
  bots: AlgoView[];
  loading: boolean;
  error: string | null;
  /** The executor runs bots and this wallet is set up for practice ones. */
  ready: boolean;
  /** Signed in to the executor: the bots show and can be paused, stopped and closed - whatever the terms (owner
   *  2026-11-08: "users always need to be able to stop bots or reduce positions"). Starting needs `ready`. */
  seen: boolean;
  /** One free signature that only reads (30 days in this browser). */
  signIn: () => Promise<void>;
  supported: boolean;
  liveAllowed: boolean;
  /** This wallet's bot fee now, tenths of a bp: the executor's /me (its ladder step or VIP), else the ladder's first step. */
  feeTenths: number;
  busy: string | null;
  setup: (paper: boolean) => void;
  setupWhy: (paper: boolean) => string | null;
  start: (spec: Record<string, unknown>) => Promise<AlgoView>;
  /** New settings by restart (feature 'bot-restart'): 'clean' closes first, 'takeover' hands what it holds to the new bot. */
  restart: (v: AlgoView, spec: Record<string, unknown>, how: 'clean' | 'takeover') => Promise<AlgoView>;
  canRestart: boolean;
  /** Demo data (local builds): example bots, nothing sent anywhere. */
  demo?: boolean;
  update: (id: string, patch: Record<string, unknown>) => Promise<void>;
  pause: (v: AlgoView) => Promise<void>;
  resume: (v: AlgoView) => Promise<void>;
  /**
   * 'close' (Clean stop: rests at the best price, a capped taker after a minute), 'instant' (closes now with a capped
   * taker), 'keep' (stops, the position stays), 'now' (a bot already closing: it ends, what is left stays).
   */
  stop: (v: AlgoView, how?: StopHow | 'ask' | 'now') => Promise<void>;
  remove: (v: AlgoView) => Promise<void>;
  /** Every running bot, the same three ways as one bot ('keep' when not given). */
  stopAll: (how?: StopHow) => Promise<void>;
  /** A stopped bot again, or a practice bot with real orders: New bot opens filled with its settings. */
  runAgain: (v: AlgoView, real?: boolean) => void;
  pauseAll: (list: AlgoView[]) => Promise<void>;
  resumeAll: (list: AlgoView[]) => Promise<void>;
  live: ReturnType<typeof useLiveCopy>;
}

/** A page's title, its line and its actions. The section's pages are in the top bar (BotsNavSeg) and the rail's foot. */
export function BotsHead({ title, sub, actions, lead }: { view?: BotsView; title: ReactNode; sub?: ReactNode; actions?: ReactNode; lead?: ReactNode }) {
  return (
    <header className="bots-head">
      {lead && <div className="bots-head__lead">{lead}</div>}
      <div className="bots-head__t">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="bots-head__act">{actions}</div>}
    </header>
  );
}

export type StopHow = 'close' | 'instant' | 'keep';

/** The ladder's first step (0.5 bp), the fee a wallet pays before its volume lowers it; never the old flat 0.1 bp. */
export const BOT_FEE_FIRST_STEP_TENTHS = 5;

/**
 * Where New bot reads a bot to start again (Run again, Run with real orders): its spec, kept for this tab only.
 * BotNewPage owns reading it (bots/routes.ts has no room for a whole spec in the URL).
 */
export const BOTS_PREFILL_KEY = 'vs.bots.prefill';

/** A refusal or a warning the page shows above its content: one plain sentence and the one button that helps. */
export interface BotsNotice { id: string; tone: Tone; text: string; action?: { label: string; run: () => void } }

/**
 * The executor's refusal codes (apps/executor service.ts BotRefusalCode, and the first contract's names) as a
 * sentence and the one button that helps, in the page's words. The executor's own sentence is kept where it names
 * the bot or the figures; null: not a refusal this page knows (shown as it came).
 */
export function refusalOf(e: unknown, act: { setup: () => void; deposit: () => void; beta: () => void; open: (id: string) => void; signIn: () => void; vip: () => void }): BotsNotice | null {
  if (!(e instanceof ExecutorError)) return null;
  const said = e.message;
  const algoId = typeof e.detail?.algoId === 'string' ? e.detail.algoId : null;
  const n = (id: string, text: string, action?: BotsNotice['action']): BotsNotice => ({ id, tone: 'warning', text, action });
  switch (e.code) {
    case 'session': return n('session', said, { label: 'Sign in', run: act.signIn });
    case 'key': return n('key', 'Your trading key is missing or has expired, so real orders cannot be sent. Approve a new one in the bot setup.', { label: 'Open setup', run: act.setup });
    case 'account': return n('account', 'This wallet has no SoDEX account yet. Deposit first: the first deposit opens it.', { label: 'Deposit', run: act.deposit });
    case 'beta': return n('beta', 'Bots with real orders are for wallets on the beta list for now. Practice bots work for everyone.', { label: 'Get access', run: act.beta });
    case 'limit': return n('limit', 'This wallet runs as many bots and algo orders as it may. Stop one to start another.');
    case 'margin': return n('margin', `${said} Lower its size or holding cap, stop another bot, or add funds.`, { label: 'Deposit', run: act.deposit });
    case 'margin-unknown': return n('margin-unknown', 'SoDEX did not tell your account balance just now, so the margin could not be checked. Try again in a moment.');
    case 'bot-market': return n('bot-market', said, algoId ? { label: 'Open that bot', run: () => act.open(algoId) } : undefined);
    case 'market-copy': return n('market-copy', `${said} Stop that copy in Copy trading, or pick another market.`);
    case 'market-algo': return n('market-algo', `${said} Cancel it in Trade, or pick another market.`);
    case 'market-position': return n('market-position', `${said} Close it in Trade, or pick another market.`);
    case 'bot-capacity':
    case 'live-cap': return n('bot-capacity', 'The servers run as many bots with real orders as they safely can right now. Try again later, or start it as practice.');
    case 'vip-moving':
    case 'move': return n('vip-moving', 'Your bots are moving to the VIP servers. Try again in a minute, once the move is done.');
    case 'moved': return n('moved', /standard/i.test(said) ? 'Your bots moved back to the standard servers (VIP ended). Reload to manage them there.' : 'Your bots run on the VIP servers now. Reload to talk to them there.', { label: 'Reload', run: act.vip });
    default: return null;
  }
}

/** One notice: an icon, the sentence, its button and a close. */
export function BotsNoticeBar({ n, onClose }: { n: BotsNotice; onClose?: () => void }) {
  return (
    <div className={`bots-notice is-${n.tone}`} role={n.tone === 'negative' ? 'alert' : 'status'}>
      <span className={`tf-tile is-${n.tone} bots-notice__ic`} aria-hidden="true"><Icon name={n.tone === 'negative' || n.tone === 'warning' ? 'warning' : 'bolt'} size={15} /></span>
      <p className="bots-notice__t">{n.text}</p>
      {n.action && <Button variant="secondary" onClick={n.action.run}>{n.action.label}</Button>}
      {onClose && <IconButton icon="x" label="Dismiss" onClick={onClose} />}
    </div>
  );
}

/** Days before the trading key expires that the page starts to say so. */
const KEY_WARN_MS = 7 * 86_400_000;

const STATE_TONE: Record<BotState, Tone> = { running: 'positive', waiting: 'warning', paused: 'neutral', closing: 'warning', ended: 'neutral', failed: 'negative' };

/** The page's shape while the wallet's state is read: no signed-out or setup view flashes first. */
function BotsSettling() {
  return (
    <div className="bots-settling" aria-busy="true" aria-label="Loading your bots">
      <div className="bots-head"><div className="bots-head__t"><Skeleton className="bots-skel is-title" /><Skeleton className="bots-skel is-line" /></div></div>
      <Shell><div className="bots-kpigrid">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="bots-skel is-kpi" />)}</div></Shell>
      <div className="bots-two"><Shell><Skeleton className="bots-skel is-chart" /></Shell><Shell><Skeleton className="bots-skel is-chart" /></Shell></div>
    </div>
  );
}

/** A bot's state as a pill: a live dot while it runs. */
export function StatePill({ s, size = 'md' }: { s: BotState; size?: 'sm' | 'md' }) {
  return <StatusPill tone={STATE_TONE[s]} size={size} dot pulse={s === 'running'} className={`bots-state is-${s}`}>{STATE_WORD[s]}</StatusPill>;
}

/** Bots are in beta (owner, 2026-11-06): a wallet on the beta list gets the page, everyone else the way to apply. */
export function BotsPage({ address, provider }: { address: string | null; provider: Eip1193Provider | null }) {
  const listed = useBetaAccessState(address);
  // Local builds of the section (BOTS_ON: dev, or VITE_BOTS) open it for any wallet; real orders stay the executor's call.
  const access = BOTS_ON ? 'open' : listed;
  if (access === 'open') return <BotsPageOpen address={address} provider={provider} />;
  return (
    <div className="tf bots-page">
      <div className="bots-col">
        <BotsHead title="Bots" sub="Market makers that run around the clock in your SoDEX account, from the ValueDesk executor." />
        <Shell className="bots-locked">
          <Panel>
            <EmptyState
              icon="robot"
              title={access === 'checking' ? 'Checking beta access' : 'Bots are in beta'}
              description={access === 'checking'
                ? 'Checking whether this wallet has beta access…'
                : <>Market-making and grid strategies that run around the clock, for beta testers for now. Apply on our Discord{address ? '; once your wallet is added, this page opens for it.' : ', then connect the wallet that was added.'}</>}
              actions={access === 'checking' ? undefined : (
                <>
                  <Button variant="primary" onClick={applyForBeta}>Get access</Button>
                  {!address && <Button variant="secondary" icon="wallet" onClick={() => void openConnectDialog()}>Connect wallet</Button>}
                </>
              )}
            />
          </Panel>
        </Shell>
      </div>
    </div>
  );
}

function BotsPageOpen({ address, provider }: { address: string | null; provider: Eip1193Provider | null }) {
  const view = useBotsView();
  const live = useLiveCopy(address, provider);
  const signedIn = readiness(live, 'hosted').connected;
  const { bots: read, loading, error, start, act, stopAll, update, focus } = useBots(address, signedIn);
  // A stopped bot holds nothing any more (it closed or handed over what it held; a test runner may have flattened it),
  // and an amount under half a cent is 0, not -0.00 (owner 2026-11-08).
  const bots = useMemo(() => read.map((v) => (!v.bot ? v : FINAL_STATUSES.has(v.algo.status)
    ? { ...v, bot: { ...v.bot, inventory: 0, inventoryUsd: 0, orders: [] } }
    : Math.abs(v.bot.inventoryUsd) < 0.005 ? { ...v, bot: { ...v.bot, inventoryUsd: 0 } } : v)), [read]);
  // The bot whose page is open is read every second.
  const focusId = view.page === 'bot' ? view.id : null;
  useEffect(() => { focus(focusId); }, [focus, focusId]);
  // Until the wallet's state is read (owner 2026-11-07: it showed the signed-out page, then the setup, then the
  // bots): the live state follows the wallet, a stored session is checked with the executor, the first list loads.
  const settling = !!address && (
    live.owner !== address.toLowerCase()
    || (!live.hosted.info && !live.hosted.infoError)
    || (!signedIn && !!hostedExecutor.token(address) && !live.hosted.infoError)
    || (signedIn && loading && !bots.length)
  );
  const [setup, setSetup] = useState<{ paper: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const supported = !live.hosted.info || !!live.hosted.info.features?.includes('bots');
  const seen = !!address && supported && signedIn;
  const ready = seen && botReady(live, true).ready;
  // A new version of terms the wallet accepted before: the setup opens once as a popup, over the bots (which stay
  // visible and stoppable). A first visit gets the "Start here" card instead.
  const recorded = live.hosted.me?.terms ?? null;
  const outdated = seen && !!recorded && recorded.termsVersion !== COPY_TERMS_VERSION && !live.terms;
  useEffect(() => {
    if (!outdated || !address) return;
    const k = `vd.bots.termsPopup:${address.toLowerCase()}:${COPY_TERMS_VERSION}`;
    try { if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); } catch { /* private mode */ }
    setSetup({ paper: true });
  }, [outdated, address]);

  // A refusal the executor gave a code (contract 2026-11-08): a sentence and a button above the page.
  const [notice, setNotice] = useState<BotsNotice | null>(null);
  useEffect(() => { setNotice(null); }, [address]);
  const signInNow = async () => {
    try { await signInExecutor('hosted'); setNotice(null); } catch (e) { notify('error', e instanceof Error ? e.message : String(e)); }
  };
  const said = (e: unknown) => {
    const n = refusalOf(e, { setup: () => setSetup({ paper: false }), deposit: () => requestDeposit(), beta: applyForBeta, open: (id) => goBots({ page: 'bot', id }), signIn: () => void signInNow(), vip: () => window.location.reload() });
    if (n) setNotice(n);
    else notify('error', e instanceof Error ? e.message : String(e));
  };
  const run = async (id: string, what: () => Promise<void>, done?: string) => {
    setBusy(id);
    try {
      await what();
      if (done) notify('ok', done);
    } catch (e) {
      said(e);
    } finally {
      setBusy(null);
    }
  };
  /** A stop the bot was not set for: its on-stop setting first (never behind the terms), then the stop itself. */
  const stopAs = async (v: AlgoView, how: StopHow) => {
    const s = v.algo.spec;
    const close = how !== 'keep';
    if ((s.kind === 'mm' || s.kind === 'grid') && (s.onStop === 'close') !== close) {
      try {
        await update(v.algo.id, { onStop: close ? 'close' : 'keep' }, { terms: false });
      } catch (e) {
        // The stop would go out the other way than chosen: nothing is sent, and the page says why.
        throw new Error(`${botName(v)} was not stopped: its stop setting could not be changed (${e instanceof Error ? e.message : String(e)}). Try again, or pick ${close ? '"Stop and keep position"' : 'a stop that closes'}.`);
      }
    }
    await act('cancel', v.algo.id, { now: how === 'instant' });
  };

  const ctx: BotsCtx = useMemo(() => ({
    address,
    bots,
    loading,
    error,
    ready,
    seen,
    signIn: async () => {
      try { await signInExecutor('hosted'); } catch (e) { notify('error', e instanceof Error ? e.message : String(e)); }
    },
    supported,
    liveAllowed: liveBotsFor(address),
    feeTenths: meBots(live.hosted.me)?.feeTenths ?? live.hosted.info?.bots?.ladder?.[0]?.fee ?? BOT_FEE_FIRST_STEP_TENTHS,
    busy,
    live,
    setup: (paper) => setSetup({ paper }),
    setupWhy: (paper) => botReady(live, paper).why,
    start: async (spec) => {
      const v = await start(spec);
      notify('ok', `${botName(v)} started${v.algo.spec.paper ? ' (practice)' : ''}.`);
      return v;
    },
    restart: async (v, spec, how) => {
      if (live.hosted.info?.features?.includes('bot-restart')) {
        const n = await start(spec, { from: v.algo.id, how });
        notify('ok', how === 'clean' ? 'Restarting: the old bot closes, then the new one starts.' : 'Restarted: the new bot took over.');
        goBots({ page: 'bot', id: n.algo.id });
        return n;
      }
      // An executor without restarts: the same steps from here. The old bot stops the way the restart says, the new
      // one starts once it has ended (one live bot per market). An instant one leaves the position in the account.
      const s0 = v.algo.spec;
      const want = how === 'clean' ? 'close' : 'keep';
      if (!FINAL_STATUSES.has(v.algo.status)) {
        if ((s0.kind === 'mm' || s0.kind === 'grid') && s0.onStop !== want) await update(v.algo.id, { onStop: want }, { terms: false });
        await act('cancel', v.algo.id);
      }
      notify('info', how === 'clean' ? 'Closing the old bot. The new one starts when it has: keep this page open.' : 'Stopping the old bot…');
      const until = Date.now() + 20 * 60_000;
      for (;;) {
        const now = (await listBotsOn('hosted', false)).algos.find((x) => x.algo.id === v.algo.id);
        if (!now || FINAL_STATUSES.has(now.algo.status)) break;
        if (Date.now() > until) throw new Error('The old bot has not ended after 20 minutes. Start the new one when it has.');
        await new Promise((res) => setTimeout(res, 2_000));
      }
      const n = await start(spec);
      notify('ok', 'Restarted with the new settings.');
      goBots({ page: 'bot', id: n.algo.id });
      return n;
    },
    canRestart: true,
    update: async (id, patch) => {
      await update(id, patch);
      notify('ok', 'Changes saved. They apply at once.');
    },
    pause: (v) => run(v.algo.id, () => act('pause', v.algo.id), `${botName(v)} paused: its orders are pulled.`),
    resume: (v) => run(v.algo.id, () => act('resume', v.algo.id), `${botName(v)} resumed.`),
    stop: async (v, how = 'ask') => {
      const s = v.algo.spec;
      const held = Math.abs(v.bot?.inventoryUsd ?? 0);
      const holding = Math.abs(v.bot?.inventory ?? 0) > 0;
      // Already closing: a second stop ends it where it is (runtime cancel on a closing bot), what is left stays.
      if (how === 'now' || (how === 'ask' && v.bot?.closing)) {
        const ok = await confirm({
          title: `Stop closing ${botName(v)}?`,
          body: holding ? `It stops closing and ends now. What it still holds (${fmtUsd(held, 2)}) stays in your account as it is: close it yourself in Trade.` : 'It ends now. It holds nothing.',
          confirmLabel: 'Stop now',
          danger: true,
        });
        if (ok) await run(v.algo.id, () => act('cancel', v.algo.id), holding ? 'Stopped. What it still held stays in your account.' : 'Bot stopped.');
        return;
      }
      let way: StopHow;
      if (how !== 'ask') way = how;
      else {
        const close = (s.kind === 'mm' || s.kind === 'grid') && s.onStop === 'close';
        const ok = await confirm({
          title: `Stop ${botName(v)}?`,
          body: close && holding
            ? `It pulls its orders and closes what it holds (${fmtUsd(held, 2)}): resting at the best price first, a capped taker after a minute.`
            : holding ? `It pulls its orders. What it holds (${fmtUsd(held, 2)}) stays in your account as it is.` : 'It pulls its orders. It holds nothing.',
          confirmLabel: 'Stop bot',
          danger: true,
        });
        if (!ok) return;
        way = close ? 'close' : 'keep';
      }
      const closes = way !== 'keep' && holding;
      await run(v.algo.id, () => stopAs(v, way), closes ? (way === 'instant' ? 'Stopping: closing what it holds now.' : 'Stopping: closing what it holds.') : 'Bot stopped.');
    },
    remove: async (v) => {
      const ok = await confirm({ title: `Delete ${botName(v)}?`, body: 'It leaves your list. Its record and log stay kept on the executor.', confirmLabel: 'Delete', danger: true });
      if (ok) await run(v.algo.id, async () => {
        await act('archive', v.algo.id);
        if (view.page === 'bot' && view.id === v.algo.id) goBots({ page: 'overview' });
      }, 'Bot deleted.');
    },
    stopAll: async (how = 'keep') => {
      const live = bots.filter((v) => !FINAL_STATUSES.has(v.algo.status));
      const body = how === 'keep'
        ? 'Every bot pulls its orders at once. Nothing is closed: what they hold stays in your account.'
        : how === 'instant'
          ? `Every bot pulls its orders and closes what it holds now, with a capped taker. One signature per bot (${live.length}), more where a bot was set to keep its position.`
          : `Every bot pulls its orders and closes what it holds: resting at the best price first, a capped taker after a minute. One signature per bot (${live.length}), more where a bot was set to keep its position.`;
      const ok = await confirm({ title: 'Stop every bot?', body, confirmLabel: 'Stop all', danger: true });
      if (!ok) return;
      if (how === 'keep') { await run('all', stopAll, 'Every bot stopped.'); return; }
      await run('all', async () => {
        const failed: string[] = [];
        for (const v of live) {
          try { await stopAs(v, how); } catch (e) { failed.push(`${botName(v)}: ${e instanceof Error ? e.message : String(e)}`); }
        }
        if (failed.length) throw new Error(`${failed.length} of ${live.length} not stopped. ${failed.join(' ')}`);
      }, how === 'instant' ? 'Every bot is stopping and closing what it holds now.' : 'Every bot is stopping and closing what it holds.');
    },
    runAgain: (v, real) => {
      const spec = { ...specOf({ ...draftOfSpec(v.algo.spec), paper: real ? false : v.algo.spec.paper }, null), bot: true };
      try { sessionStorage.setItem(BOTS_PREFILL_KEY, JSON.stringify({ from: v.algo.id, at: Date.now(), spec })); } catch { /* private mode: New bot opens on the market and kind */ }
      goBots({ page: 'new', market: v.algo.spec.symbol, kind: strategyOf(v.algo.spec) ?? null });
    },
    pauseAll: (list) => run('all', async () => { for (const v of list) await act('pause', v.algo.id); }, `${list.length} bot${list.length === 1 ? '' : 's'} paused.`),
    resumeAll: (list) => run('all', async () => { for (const v of list) await act('resume', v.algo.id); }, `${list.length} bot${list.length === 1 ? '' : 's'} resumed.`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [address, bots, loading, error, ready, seen, supported, live, busy, view, update, act, stopAll, start, confirm]);

  // Demo data (owner 2026-11-07), local builds only: on by default, the switch at the top right.
  const [demo, setDemoOn] = useState(() => BOTS_ON && demoDefault());
  const [demoList, setDemoList] = useState<AlgoView[]>(() => demoBots());
  const setDemo = (on: boolean) => { setDemoOn(on); saveDemo(on); };
  const demoCtx: BotsCtx = useMemo(() => {
    const set = (id: string, f: (v: AlgoView) => AlgoView) => setDemoList((l) => l.map((x) => (x.algo.id === id ? f(x) : x)));
    const status = (v: AlgoView, st: AlgoView['algo']['status'], why: string | null): AlgoView => ({
      ...v,
      algo: { ...v.algo, status: st, statusReason: why, endedAt: FINAL_STATUSES.has(st) ? Date.now() : v.algo.endedAt },
      working: st === 'running' ? v.working ?? '2 orders working' : null,
      bot: v.bot ? { ...v.bot, orders: st === 'running' ? v.bot.orders : [], ...(FINAL_STATUSES.has(st) ? { inventory: 0, inventoryUsd: 0 } : {}) } : v.bot,
    });
    const said = (t: string) => notify('ok', `${t} (demo: nothing sent)`);
    return {
      ...ctx,
      demo: true,
      address: ctx.address ?? '0xdemo',
      bots: demoList,
      loading: false,
      error: null,
      ready: true,
      seen: true,
      signIn: async () => said('Sign in'),
      supported: true,
      liveAllowed: true,
      busy: null,
      setup: () => said('Set up'),
      setupWhy: () => null,
      start: async (spec) => { const n = demoStarted(spec); setDemoList((l) => [n, ...l]); said(`${botName(n)} started`); return n; },
      restart: async (v, spec, how) => {
        const n = demoStarted(spec);
        setDemoList((l) => [n, ...l.map((x) => (x.algo.id === v.algo.id ? status(x, 'cancelled', how === 'clean' ? 'Restarted: closed first.' : 'Restarted: handed over.') : x))]);
        said(how === 'clean' ? 'Clean restart' : 'Instant restart');
        goBots({ page: 'bot', id: n.algo.id });
        return n;
      },
      canRestart: true,
      update: async () => said('Saved'),
      pause: async (v) => { set(v.algo.id, (x) => status(x, 'paused', 'Paused by you.')); said('Paused'); },
      resume: async (v) => { set(v.algo.id, (x) => status(x, 'running', null)); said('Resumed'); },
      stop: async (v) => { set(v.algo.id, (x) => status(x, 'cancelled', 'Stopped by you.')); said('Stopped'); },
      remove: async (v) => { setDemoList((l) => l.filter((x) => x.algo.id !== v.algo.id)); if (view.page === 'bot') goBots({ page: 'overview' }); said('Deleted'); },
      stopAll: async () => { setDemoList((l) => l.map((x) => (FINAL_STATUSES.has(x.algo.status) ? x : status(x, 'cancelled', 'Stopped by you.')))); said('Every bot stopped'); },
      runAgain: (v, real) => { said(real ? 'Run with real orders' : 'Run again'); goBots({ page: 'new', market: v.algo.spec.symbol, kind: strategyOf(v.algo.spec) ?? null }); },
      pauseAll: async (list) => { for (const v of list) set(v.algo.id, (x) => status(x, 'paused', 'Paused by you.')); said(`${list.length} paused`); },
      resumeAll: async (list) => { for (const v of list) set(v.algo.id, (x) => status(x, 'running', null)); said(`${list.length} resumed`); },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, demoList, view]);
  const base = demo ? demoCtx : ctx;
  // Confirmations (owner 2026-11-07): pause and resume ask first; a stop asks in BotsCtx.stop (real) and here (demo).
  const c: BotsCtx = useMemo(() => ({
    ...base,
    pause: async (v) => {
      if (await confirm({ title: `Pause ${botName(v)}?`, body: 'It pulls its orders and keeps what it holds. Resume any time.', confirmLabel: 'Pause bot' })) await base.pause(v);
    },
    resume: async (v) => {
      if (await confirm({ title: `Resume ${botName(v)}?`, body: `It quotes again on ${v.algo.spec.symbol} with the same settings.`, confirmLabel: 'Resume bot' })) await base.resume(v);
    },
    pauseAll: async (list) => {
      if (await confirm({ title: `Pause ${list.length} bot${list.length === 1 ? '' : 's'}?`, body: 'Each pulls its orders and keeps what it holds.', confirmLabel: 'Pause all' })) await base.pauseAll(list);
    },
    resumeAll: async (list) => {
      if (await confirm({ title: `Resume ${list.length} bot${list.length === 1 ? '' : 's'}?`, body: 'Each quotes again with its own settings.', confirmLabel: 'Resume all' })) await base.resumeAll(list);
    },
    stop: base.demo
      ? async (v, how) => { if (how !== 'ask' && how !== undefined) return base.stop(v, how); if (await confirm({ title: `Stop ${botName(v)}?`, body: 'It pulls its orders and closes what it holds.', confirmLabel: 'Stop bot', danger: true })) await base.stop(v, 'close'); }
      : base.stop,
    stopAll: base.demo
      ? async (how) => { if (await confirm({ title: 'Stop every bot?', body: how && how !== 'keep' ? 'Every bot pulls its orders and closes what it holds.' : 'Every bot pulls its orders. What they hold stays as it is.', confirmLabel: 'Stop all', danger: true })) await base.stopAll(how); }
      : base.stopAll,
    remove: base.demo
      ? async (v) => { if (await confirm({ title: `Delete ${botName(v)}?`, body: 'It leaves your list.', confirmLabel: 'Delete', danger: true })) await base.remove(v); }
      : base.remove,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [base]);

  // The trading key's end, said before it comes (audit B): real bots stop sending orders once it has expired.
  const keyEnds = live.hosted.me?.key?.registered ? live.hosted.me.key.expiresAt : null;
  const realLive = bots.some((v) => !v.algo.spec.paper && !FINAL_STATUSES.has(v.algo.status));
  const [keyNow] = useState(() => Date.now());
  const keyWarn: BotsNotice | null = !demo && seen && keyEnds !== null && keyEnds - keyNow < KEY_WARN_MS && (realLive || keyEnds - keyNow < 3 * 86_400_000) && (view.page === 'overview' || view.page === 'bot')
    ? {
        id: 'key-expiry',
        tone: keyEnds <= keyNow ? 'negative' : 'warning',
        text: keyEnds <= keyNow
          ? 'Your trading key has expired: real bots cannot send or pull orders. Renew it now.'
          : `Your trading key expires in ${Math.max(1, Math.round((keyEnds - keyNow) / 86_400_000))} day${Math.round((keyEnds - keyNow) / 86_400_000) === 1 ? '' : 's'} (${new Date(keyEnds).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}). Real bots stop sending orders then: renew it before.`,
        action: { label: 'Renew', run: () => setSetup({ paper: false }) },
      }
    : null;

  let page: ReactNode;
  if (view.page === 'new') page = <BotNewPage ctx={c} view={view} />;
  else if (view.page === 'explore') page = <BotsExplore ctx={c} view={view} />;
  else if (view.page === 'savings') page = <BotsSavings ctx={c} view={view} />;
  else if (view.page === 'bot') page = <BotDetail ctx={c} view={view} id={view.id} />;
  else page = <BotsOverview ctx={c} view={view} />;

  return (
    <div className="tf bots-page" aria-busy={loading}>
      <div className="bots-col">
        {BOTS_ON && (
          <div className="bots-demobar">
            {demo && (
              <span className="bots-demobar__play" aria-label="Play the VIP animations">
                <Button variant="quiet" size="sm" icon="play" onClick={() => playVip('unlock')}>VIP unlock</Button>
                <Button variant="quiet" size="sm" icon="play" onClick={() => playVip('unlock-promo')}>Beta VIP unlock</Button>
                <Button variant="quiet" size="sm" icon="play" onClick={() => playVip('move')}>Move to VIP</Button>
              </span>
            )}
            {demo && <Pill tone="brand" size="sm" dot>Example bots</Pill>}
            <Switch checked={demo} onChange={setDemo} label="Demo data" />
          </div>
        )}
        {/* One section failing never takes the Bots pages down (owner 2026-11-08): the page has its own boundary, reset
            when another page is opened, and the Overview one per panel. */}
        {!demo && notice && <BotsNoticeBar n={notice} onClose={() => setNotice(null)} />}
        {keyWarn && <BotsNoticeBar n={keyWarn} />}
        <ErrorBoundary key={view.page} name="This page" bare>{settling && !demo && view.page !== 'explore' ? <BotsSettling /> : page}</ErrorBoundary>
      </div>
      {BOTS_ON && <ErrorBoundary name="VIP" bare><BotsVip ctx={c} stage /></ErrorBoundary>}
      <BotSetupSheet open={!!setup} onClose={() => setSetup(null)} live={live} paper={setup?.paper ?? true} />
      {dialog}
    </div>
  );
}

/** A running bot (not ended). */
export const isLive = (v: AlgoView): boolean => !FINAL_STATUSES.has(v.algo.status);
