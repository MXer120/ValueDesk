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
import { useMemo, useState, type ReactNode } from 'react';
import type { AlgoView } from '@copy-engine';
import { FINAL_STATUSES } from '@copy-engine';
import type { Eip1193Provider } from '../../wallet';
import { fmtUsd } from '../../format';
import { useLiveCopy, readiness } from '../../copy/live';
import { liveBotsFor } from '../../algo/liveAlgos';
import { notify } from '../../toast';
import { useConfirm } from '../Modal';
import { useBots } from '../../bots/useBots';
import { BOTS_ON, goBots, useBotsView, type BotsView } from '../../bots/routes';
import { DEFAULT_BOT_FEE_TENTHS } from '../../bots/presets';
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
import { Button, EmptyState, Panel, Shell } from './kit/kit';
import './bots.css';
import './botsPages.css';

export interface BotsCtx {
  address: string | null;
  bots: AlgoView[];
  loading: boolean;
  error: string | null;
  /** The executor runs bots and this wallet is set up for practice ones. */
  ready: boolean;
  supported: boolean;
  liveAllowed: boolean;
  feeTenths: number;
  busy: string | null;
  setup: (paper: boolean) => void;
  setupWhy: (paper: boolean) => string | null;
  start: (spec: Record<string, unknown>) => Promise<AlgoView>;
  update: (id: string, patch: Record<string, unknown>) => Promise<void>;
  pause: (v: AlgoView) => Promise<void>;
  resume: (v: AlgoView) => Promise<void>;
  stop: (v: AlgoView, how?: 'ask' | 'close' | 'keep') => Promise<void>;
  remove: (v: AlgoView) => Promise<void>;
  stopAll: () => Promise<void>;
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

const STATE_TONE: Record<BotState, Tone> = { running: 'positive', waiting: 'warning', paused: 'neutral', closing: 'warning', ended: 'neutral', failed: 'negative' };

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
  const { bots, loading, error, start, act, stopAll, update } = useBots(address, signedIn);
  const [setup, setSetup] = useState<{ paper: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const supported = !live.hosted.info || !!live.hosted.info.features?.includes('bots');
  const ready = !!address && supported && signedIn && botReady(live, true).ready;

  const run = async (id: string, what: () => Promise<void>, done?: string) => {
    setBusy(id);
    try {
      await what();
      if (done) notify('ok', done);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const ctx: BotsCtx = useMemo(() => ({
    address,
    bots,
    loading,
    error,
    ready,
    supported,
    liveAllowed: liveBotsFor(address),
    feeTenths: live.hosted.info?.bots?.fee ?? DEFAULT_BOT_FEE_TENTHS,
    busy,
    live,
    setup: (paper) => setSetup({ paper }),
    setupWhy: (paper) => botReady(live, paper).why,
    start: async (spec) => {
      const v = await start(spec);
      notify('ok', `${botName(v)} started${v.algo.spec.paper ? ' (practice)' : ''}.`);
      return v;
    },
    update: async (id, patch) => {
      await update(id, patch);
      notify('ok', 'Changes saved. They apply at once.');
    },
    pause: (v) => run(v.algo.id, () => act('pause', v.algo.id), `${botName(v)} paused: its orders are pulled.`),
    resume: (v) => run(v.algo.id, () => act('resume', v.algo.id), `${botName(v)} resumed.`),
    stop: async (v, how = 'ask') => {
      const s = v.algo.spec;
      const holding = Math.abs(v.bot?.inventory ?? 0) > 0;
      let close = (s.kind === 'mm' || s.kind === 'grid') && s.onStop === 'close';
      if (how !== 'ask') {
        close = how === 'close';
        // Stopping the other way than the bot was set to: the setting first, then the stop.
        if ((s.kind === 'mm' || s.kind === 'grid') && (s.onStop === 'close') !== close) await update(v.algo.id, { onStop: close ? 'close' : 'keep' });
      } else {
        const ok = await confirm({
          title: `Stop ${botName(v)}?`,
          body: close && holding
            ? `It pulls its orders and closes what it holds (${fmtUsd(Math.abs(v.bot!.inventoryUsd), 2)}): resting at the best price first, a capped taker after a minute.`
            : holding ? `It pulls its orders. What it holds (${fmtUsd(Math.abs(v.bot!.inventoryUsd), 2)}) stays in your account as it is.` : 'It pulls its orders. It holds nothing.',
          confirmLabel: 'Stop bot',
          danger: true,
        });
        if (!ok) return;
      }
      await run(v.algo.id, () => act('cancel', v.algo.id), close && holding ? 'Stopping: closing what it holds.' : 'Bot stopped.');
    },
    remove: async (v) => {
      const ok = await confirm({ title: `Delete ${botName(v)}?`, body: 'It leaves your list. Its record and log stay kept on the executor.', confirmLabel: 'Delete', danger: true });
      if (ok) await run(v.algo.id, async () => {
        await act('archive', v.algo.id);
        if (view.page === 'bot' && view.id === v.algo.id) goBots({ page: 'overview' });
      }, 'Bot deleted.');
    },
    stopAll: async () => {
      const ok = await confirm({ title: 'Stop every bot?', body: 'Every bot pulls its orders at once. Nothing is closed: what they hold stays in your account.', confirmLabel: 'Stop all', danger: true });
      if (ok) await run('all', stopAll, 'Every bot stopped.');
    },
    pauseAll: (list) => run('all', async () => { for (const v of list) await act('pause', v.algo.id); }, `${list.length} bot${list.length === 1 ? '' : 's'} paused.`),
    resumeAll: (list) => run('all', async () => { for (const v of list) await act('resume', v.algo.id); }, `${list.length} bot${list.length === 1 ? '' : 's'} resumed.`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [address, bots, loading, error, ready, supported, live, busy, view]);

  let page: ReactNode;
  if (view.page === 'new') page = <BotNewPage ctx={ctx} view={view} />;
  else if (view.page === 'explore') page = <BotsExplore ctx={ctx} view={view} />;
  else if (view.page === 'savings') page = <BotsSavings ctx={ctx} view={view} />;
  else if (view.page === 'bot') page = <BotDetail ctx={ctx} view={view} id={view.id} />;
  else page = <BotsOverview ctx={ctx} view={view} />;

  return (
    <div className="tf bots-page" aria-busy={loading}>
      <div className="bots-col">{page}</div>
      <BotSetupSheet open={!!setup} onClose={() => setSetup(null)} live={live} paper={setup?.paper ?? true} />
      {dialog}
    </div>
  );
}

/** A running bot (not ended). */
export const isLive = (v: AlgoView): boolean => !FINAL_STATUSES.has(v.algo.status);
