/**
 * The Blind Box vault (owner 2026-11-28): everything SoDEX's own Blind Box page does for a wallet, here, so this page can
 * stand in for it. The wallet's boxes by tier with what each tier paid (from the chain, NFT drops left out) and its floor
 * on valuemint.store, opening and merging (one wallet signature a request; many requests queued for big holders),
 * claiming earned boxes, gifting boxes and Cybereators (with cybereator.com's card glare), the wallet's own history and
 * its progress to the next box.
 *
 * What runs where: boxes and Cybereators are read off the chain from this browser; everything else that needs SoDEX's
 * token passes our relay (boxVault.ts, server routes/sodexLotteryUser.ts). Nothing is ever signed or sent for the user.
 * `demo` (localhost's Sample only) fills every part with made-up data and plays requests without a wallet.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  LEVELS, LEVEL_LABEL, mergeLadder, nextLevel, readWalletBoxes, valuechainRpc,
  type Level, type LotteryMeta, type LotteryRules, type WalletBoxes,
} from '../../../blindBox';
import {
  CYBEREATOR, CYBEREATOR_SITE, SESSION_EVENT, TREASURE_BOX, announceSession, batches, claimTreasure, fetchMarket, fetchRewards, gift, isAddress,
  mergeAdvice, readCybereators, readProgress, readRecords, readTreasures, runRequest, valuemintCollection,
  type Cybereator, type HistoryKind, type JobResult, type LevelRewards, type MarketDoc, type OpenedBox, type Progress, type RecordRow, type RewardsDoc,
} from '../../../boxVault';
import { DASH, fmt } from '../../../format';
import { NeedsPointsToken, clearPointsToken, getPointsToken, setPointsToken } from '../../../points';
import { signInToPoints } from '../../../pointsAuth';
import { coinPrices, priceOf } from '../../../trading/prices';
import { isUserRejection, type Eip1193Provider } from '../../../wallet';
import { warmWalletModal } from '../../../walletconnect';
import { openConnectDialog } from '../../account/connect';
import { usePolled } from '../../explore/cohorts/parts';
import { Button, EmptyState, Icon, IconButton, ProgressBar, Segmented, Skeleton, StatusPill, TextInput } from '../../bots/kit/kit';
import { BoxArt, boxArtSrc } from '../BoxArt';
import { fmtAgo, fmtTokens, fmtUsdTight, useNow } from '../parts';
import { Holo } from './Holo';
import { BoxPicker } from './BoxPicker';
import { ShareButton } from '../../share/host';
import './vault.css';

const usd = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? DASH : fmtUsdTight(v.toFixed(d)));
const soso = (v: number | null | undefined) => (v == null ? DASH : `${fmt(v, v < 10 ? 2 : 0)} SOSO`);
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n, 0)} ${n === 1 ? one : many}`;
const errText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong.');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Localhost's Sample: a made-up wallet's everything. */
export interface VaultDemo {
  boxes: WalletBoxes;
  cybrOwner: string;
  progress: Progress & { at: number };
  records: RecordRow[];
  treasures: number;
}

/* --- the SoDEX sign-in, the one SoPoints uses; every part of the page hears it change ------------------------------ */

export function useSodexSession(address: string | null, provider: Eip1193Provider | null, demo = false) {
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener(SESSION_EVENT, on);
    return () => window.removeEventListener(SESSION_EVENT, on);
  }, []);
  const signedIn = demo || (!!address && !!getPointsToken(address));
  const signIn = useCallback(async () => {
    if (!address || !provider) return;
    setBusy(true);
    setError(null);
    try {
      setPointsToken(address, await signInToPoints(provider, address));
      announceSession();
    } catch (e) {
      if (!isUserRejection(e)) setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [address, provider]);
  const lost = useCallback(() => { clearPointsToken(); announceSession(); }, []);
  return { signedIn, signIn, busy, error, lost };
}
type Session = ReturnType<typeof useSodexSession>;

/* --- a popup in the copy window's shell (Copy.css .cpk) ------------------------------------------------------------ */

export function Popup({ label, size, onClose, head, children }: { label: string; size: 'window' | 'small'; onClose: () => void; head: ReactNode; children: ReactNode }) {
  const [inView, setIn] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const raf = requestAnimationFrame(() => { setIn(true); panel.current?.focus(); });
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return createPortal(
    <div className={`cpk is-window bv-pop is-${size}${inView ? ' is-in' : ''}`}>
      <div className="cpk__veil" onClick={onClose} aria-hidden="true" />
      <section ref={panel} className="cpk__panel" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <header className="cpk__h tf"><span className="bv-pop__t">{head}</span><IconButton icon="x" label="Close" onClick={onClose} /></header>
        <div className="bv-pop__body tf">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

/* --- requests, one at a time ------------------------------------------------------------------------------------- */

type Step = 'sign' | 'wait' | 'gift';
interface Queue {
  kind: 'open' | 'merge' | 'claim' | 'gift';
  label: string;
  total: number;
  done: number;
  step: Step | null;
  results: JobResult[];
  gifts: string[];
  error: string | null;
  stopped: boolean;
  running: boolean;
}
type Job = (set: (s: Step) => void) => Promise<JobResult | string | null>;

function useQueue(onFinish: () => void) {
  const [q, setQ] = useState<Queue | null>(null);
  const stop = useRef(false);
  const run = useCallback(async (kind: Queue['kind'], label: string, jobs: Job[]) => {
    stop.current = false;
    setQ({ kind, label, total: jobs.length, done: 0, step: null, results: [], gifts: [], error: null, stopped: false, running: true });
    for (let i = 0; i < jobs.length; i += 1) {
      if (stop.current) { setQ((x) => x && { ...x, stopped: true, running: false, step: null }); onFinish(); return; }
      try {
        const out = await jobs[i]!((step) => setQ((x) => x && { ...x, step }));
        setQ((x) => x && {
          ...x, done: i + 1, step: null,
          results: out && typeof out === 'object' ? [...x.results, out] : x.results,
          gifts: typeof out === 'string' ? [...x.gifts, out] : x.gifts,
        });
      } catch (e) {
        const msg = e instanceof NeedsPointsToken ? 'Your SoDEX sign-in ran out. Sign in again to go on.' : isUserRejection(e) ? 'Stopped in your wallet. Nothing else was asked.' : errText(e);
        setQ((x) => x && { ...x, error: msg, running: false, step: null });
        onFinish();
        return;
      }
    }
    setQ((x) => x && { ...x, running: false, step: null });
    onFinish();
  }, [onFinish]);
  return { q, run, stop: () => { stop.current = true; }, clear: () => setQ(null) };
}

/** Sample only: what a request would answer, drawn from what boxes really paid. */
function demoJob(kind: 'open' | 'merge', level: Level, ids: string[], rewards: RewardsDoc | null, size: number): Job {
  return async (set) => {
    set('sign'); await sleep(700);
    set('wait'); await sleep(1100);
    if (kind === 'merge') return { jobId: 'demo', status: 'done', opened: [], merged: [{ tokenId: String(200_000 + Math.floor(Math.random() * 9000)), level: nextLevel(level), consumed: ids.slice(0, size) }] };
    const pool = rewards?.levels[level]?.common ?? [];
    const draw = () => { let r = Math.random(); for (const c of pool) { r -= c.share; if (r <= 0) return c.usd; } return rewards?.levels[level]?.median ?? 1; };
    return { jobId: 'demo', status: 'revealed', merged: [], opened: ids.map((id, i) => ({ tokenId: id, level, rewardUsd: draw(), reward: { asset: { symbol: i % 3 ? 'vsoUSDC' : 'vANT' }, amount: '1.0' }, pfpTokenId: Math.random() < 0.08 ? String(3000 + i) : null })) };
  };
}

/* --- the vault ----------------------------------------------------------------------------------------------------- */

type Tab = 'all' | 'boxes' | 'cybr';
interface GiftTarget { contract: string; title: string; level: Level | null; image: string | null; ids: string[] }

export function Vault({ address, provider, meta, className, demo }: { address: string | null; provider: Eip1193Provider | null; meta: LotteryMeta | null; className?: string; demo?: VaultDemo | null }) {
  const box = meta?.contracts?.treasureBox ?? TREASURE_BOX.address;
  const rules = meta?.rules ?? null;
  const session = useSodexSession(address, provider, !!demo);
  const chain = usePolled(!demo && address ? `boxes:${address.toLowerCase()}:${box}` : null, (s) => readWalletBoxes(address as string, box, valuechainRpc(s)), 60_000);
  const market = usePolled('vault-market', (s) => fetchMarket(s), 300_000);
  const rewards = usePolled('vault-rewards', (s) => fetchRewards(s), 300_000);
  const cybrOf = demo ? demo.cybrOwner : address;
  const cybr = usePolled(cybrOf ? `cybr:${cybrOf.toLowerCase()}` : null, () => readCybereators(cybrOf as string), 120_000);
  const [sosoUsd, setSosoUsd] = useState<number | null>(null);
  useEffect(() => { let off = false; void coinPrices().then((m) => { if (!off) setSosoUsd(priceOf(m, 'SOSO') ?? null); }).catch(() => undefined); return () => { off = true; }; }, []);
  const [tab, setTab] = useState<Tab>('all');
  const [action, setAction] = useState<{ level: Level; kind: 'open' | 'merge' | 'gift' } | null>(null);
  const [openTier, setOpenTier] = useState<Level | null>(null);
  const [giving, setGiving] = useState<GiftTarget | null>(null);
  const refresh = useCallback(() => { chain.retry(); cybr.retry(); }, [chain, cybr]);
  const queue = useQueue(refresh);
  const busy = !!queue.q?.running;
  const boxes = demo ? demo.boxes : chain.data;
  const perOpen = rules?.limits.maxBoxOpen ?? 30;
  const ids = boxes?.exact ? boxes.byLevel : null;
  const who = demo ? 'demo' : address;

  const start = (kind: 'open' | 'merge', level: Level, pool: string[]) => {
    if (!who || (!provider && !demo) || !ids) return;
    const size = kind === 'open' ? perOpen : rules?.mergeSize[level] ?? 0;
    const groups = batches(kind, pool, size);
    setAction(null);
    const label = kind === 'open'
      ? `Opening ${plural(pool.length, `${LEVEL_LABEL[level]} box`, `${LEVEL_LABEL[level]} boxes`)}`
      : `Merging ${plural(pool.length, `${LEVEL_LABEL[level]} box`, `${LEVEL_LABEL[level]} boxes`)} into ${plural(groups.length, LEVEL_LABEL[nextLevel(level)!])}`;
    void queue.run(kind, label, groups.map((g): Job => (demo
      ? demoJob(kind, level, g, rewards.data, size)
      : (set) => { set('sign'); return runRequest({ action: kind, address: address as string, provider: provider as Eip1193Provider, ids: g, box, onSigned: () => set('wait') }); })));
  };
  const sendGift = (t: GiftTarget, to: string) => {
    setGiving(null);
    const what = t.ids.length === 1 ? t.title : `${fmt(t.ids.length, 0)} ${t.title}`;
    void queue.run('gift', `Gifting ${what} to ${to.slice(0, 6)}…${to.slice(-4)}`, t.ids.map((id): Job => (demo
      ? async (set) => { set('gift'); await sleep(900); return `0x${id.padStart(64, '0')}`; }
      : (set) => { set('gift'); return gift({ provider: provider as Eip1193Provider, from: address as string, to, contract: t.contract, tokenId: id }); })));
  };

  const tiers = !address && !demo ? <ConnectPrompt line="Connect a wallet to see its boxes." />
    : chain.error && !boxes ? <EmptyState icon="warning" title="Your boxes could not be read" description={chain.error} actions={<Button onClick={chain.retry}>Try again</Button>} compact />
    : !boxes ? <div className="bv-tiers">{LEVELS.map((l) => <Skeleton key={l} className="bv-tier__skel" />)}</div>
    : (
      <>
        {!boxes.exact && <p className="bv-note">{plural(boxes.count, 'box', 'boxes')} in this wallet. Their tiers could not be read just now, so nothing can be picked; try again in a minute.</p>}
        <div className="bv-tiers">
          {LEVELS.map((l) => (
            <TierCard
              key={l} level={l} ids={ids?.[l] ?? []} market={market.data} sosoUsd={sosoUsd} stats={rewards.data?.levels[l] ?? null}
              mergeSize={rules?.mergeSize[l] ?? 0} perOpen={perOpen}
              canAct={session.signedIn && !busy && (!!provider || !!demo)} canGift={!busy && (!!provider || !!demo)}
              setAction={(k) => setAction(k ? { level: l, kind: k } : null)}
              expanded={openTier === l} onToggle={() => setOpenTier(openTier === l ? null : l)} wallet={address}
              onGift={() => setAction({ level: l, kind: 'gift' })}
            />
          ))}
        </div>
      </>
    );

  return (
    <section className={`tf bv${className ? ` ${className}` : ''}`} aria-label="Your vault">
      <header className="bv-head">
        <span className="bv-head__t">
          <h2>Your vault</h2>
          {boxes && boxes.count > 0 && <ShareButton label="Share all your boxes" make={(b) => b.boxCard({ tier: [...LEVELS].reverse().find((l) => boxes.byLevel[l].length > 0) ?? 'Common', label: 'My Blind Boxes', title: `${fmt(boxes.count, 0)} boxes`, lines: [LEVELS.filter((l) => boxes.byLevel[l].length > 0).map((l) => `${fmt(boxes.byLevel[l].length, 0)} ${LEVEL_LABEL[l]}`).join(' · '), ...(cybr.data?.length ? [`${fmt(cybr.data.length, 0)} Cybereator${cybr.data.length === 1 ? '' : 's'}`] : [])], image: boxArtSrc([...LEVELS].reverse().find((l) => boxes.byLevel[l].length > 0) ?? 'Common') })} />}
        </span>
        <Segmented<Tab> label="Show" value={tab} onChange={setTab} options={[
          { value: 'all', label: 'All', ...(boxes && cybr.data ? { count: boxes.count + cybr.data.length } : {}) },
          { value: 'boxes', label: 'Boxes', ...(boxes ? { count: boxes.count } : {}) },
          { value: 'cybr', label: 'Cybereators', ...(cybr.data ? { count: cybr.data.length } : {}) },
        ]} />
      </header>

      {!demo && <SessionBar address={address} provider={provider} session={session} />}
      {queue.q && <QueuePanel q={queue.q} onStop={queue.stop} onClose={queue.clear} />}
      {session.signedIn && who && <Claim address={who} demo={demo?.treasures ?? null} onDone={refresh} />}

      {tab !== 'cybr' && tiers}
      {tab !== 'boxes' && (
        <>
          {tab === 'all' && <h3 className="bv-sub">Cybereators</h3>}
          <Cybereators address={cybrOf} list={cybr.data} error={cybr.error} retry={cybr.retry} market={market.data} sosoUsd={sosoUsd} canGift={!busy && (!!provider || !!demo)}
            onGift={(c) => setGiving({ contract: CYBEREATOR, title: c.name, level: null, image: c.image, ids: [c.id] })} />
        </>
      )}
      {action && ids && (
        <BoxPicker kind={action.kind} level={action.level} ids={ids[action.level]} mergeSize={rules?.mergeSize[action.level] ?? 0} perOpen={perOpen}
          onClose={() => setAction(null)} onGo={(chosen, to) => (action.kind === 'gift' ? (setAction(null), sendGift({ contract: box, title: `${LEVEL_LABEL[action.level]} box`, level: action.level, image: null, ids: chosen }, to)) : start(action.kind, action.level, chosen))} />
      )}
      {giving && <GiftPopup t={giving} onClose={() => setGiving(null)} onSend={(to, n) => sendGift({ ...giving, ids: giving.ids.slice(0, n) }, to)} />}
    </section>
  );
}

/* --- pieces -------------------------------------------------------------------------------------------------------- */

function ConnectPrompt({ line }: { line: string }) {
  return (
    <div className="bv-empty">
      <p>{line}</p>
      <Button variant="primary" onPointerEnter={warmWalletModal} onFocus={warmWalletModal} onClick={() => void openConnectDialog()}>Connect wallet</Button>
    </div>
  );
}

function SessionBar({ address, provider, session }: { address: string | null; provider: Eip1193Provider | null; session: Session }) {
  if (!address || session.signedIn) return null;
  return (
    <div className="bv-signin">
      <Icon name="shield" size={16} />
      <span><b>Sign in to SoDEX to open, merge and claim.</b> One signature of SoDEX's sign-in text: no transaction, no gas, no access to funds. Seeing and gifting your boxes needs none.</span>
      <Button variant="primary" loading={session.busy} disabled={!provider} onClick={() => void session.signIn()}>Sign in to SoDEX</Button>
      {session.error && <small className="bv-err">{session.error}</small>}
    </div>
  );
}

const CLAIMED = 'vs:box-claimed';

/**
 * Earned boxes to claim (owner 2026-11-28: "just make the claim load ... also show it in the trade xyz to unlock more.
 * If there are any unclaimed it should expand"). The button itself loads while SoDEX claims; no progress panel. In the
 * vault and in the hero's progress card, which opens smoothly to show it when any are waiting; a claim in one refreshes
 * both. `onDone` refreshes the wallet's boxes.
 */
export function Claim({ address, demo, compact, onDone }: { address: string; demo: number | null; compact?: boolean; onDone?: () => void }) {
  const t = usePolled(demo === null ? `treasures:${address.toLowerCase()}` : null, () => readTreasures(address), 60_000);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const on = () => { t.retry(); if (demo !== null) setDone(true); };
    window.addEventListener(CLAIMED, on);
    return () => window.removeEventListener(CLAIMED, on);
  }, [t, demo]);
  const n = done ? 0 : demo ?? t.data?.total ?? 0;
  const take = Math.min(n, t.data?.maxPerOpen ?? 100);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (demo !== null) await sleep(1400); else await claimTreasure(address, take);
      if (demo !== null) setDone(true);
      window.dispatchEvent(new Event(CLAIMED));
      onDone?.();
    } catch (e) {
      setErr(e instanceof NeedsPointsToken ? 'Your SoDEX sign-in ran out. Sign in again.' : errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`bv-claimwrap${n > 0 ? ' is-open' : ''}${compact ? ' is-compact' : ''}`} aria-hidden={n === 0}>
      <div>
        <div className="bv-claim">
          <BoxArt level="Common" size={compact ? 28 : 34} />
          <span><b>{plural(n, 'earned box', 'earned boxes')}</b>{compact ? ' to claim' : ` waiting to be claimed into your wallet${n > take ? ` (${fmt(take, 0)} a claim)` : ''}.`}</span>
          <Button variant="go" loading={busy} onClick={() => void go()}>{busy ? 'Claiming' : `Claim ${fmt(take, 0)}`}</Button>
          {err && <small className="bv-err">{err}</small>}
        </div>
      </div>
    </div>
  );
}

/** Light specks above a box on hover: a few blue for Rare, gold stars for SuperRare. Fixed places, no randomness. */
const SPECKS: Partial<Record<Level, Array<[number, number, number, number]>>> = {
  Rare: [[22, 30, 6, 0], [74, 22, 5, 0.5], [66, 70, 4, 1.1], [30, 72, 5, 1.6]],
  SuperRare: [[16, 24, 10, 0], [80, 18, 8, 0.35], [70, 66, 7, 0.8], [26, 70, 9, 1.2], [50, 12, 6, 0.6], [88, 48, 6, 1.5], [10, 50, 7, 1.9], [44, 82, 5, 1]],
};

function TierCard(p: {
  level: Level; ids: string[]; market: MarketDoc | null; sosoUsd: number | null; stats: LevelRewards | null; mergeSize: number; perOpen: number;
  canAct: boolean; canGift: boolean; setAction: (k: 'open' | 'merge' | null) => void;
  expanded: boolean; onToggle: () => void; wallet: string | null; onGift: () => void;
}) {
  const { level, ids } = p;
  const held = ids.length;
  const merges = p.mergeSize > 0 ? Math.floor(held / p.mergeSize) : 0;
  const to = nextLevel(level);
  const name = LEVEL_LABEL[level];
  const floor = p.market?.collections[TREASURE_BOX.address]?.tiers[level]?.floor ?? null;
  const facts = (n: number) => [
    { label: 'Tier', value: name },
    ...(p.stats ? [{ label: 'Paid on average', value: usd(p.stats.avg) }] : []),
    ...(floor != null ? [{ label: 'Floor', value: soso(floor) }] : []),
    ...(n > 1 && p.stats ? [{ label: 'Worth on average', value: usd(p.stats.avg * n) }] : []),
  ];
  return (
    <article className={`bv-tier is-${level}${held ? '' : ' is-none'}${p.expanded ? ' is-open' : ''}`}>
      <button type="button" className="bv-tier__hit" aria-expanded={p.expanded} disabled={held === 0} onClick={p.onToggle} aria-label={`${name} boxes, ${held}: show each`}>
        <div className="bv-tier__art">
          <span className="bv-tier__shine" aria-hidden="true" />
          {SPECKS[level]?.map(([x, y, s, d], i) => (
            <svg key={i} className={`bv-speck is-${level}`} style={{ left: `${x}%`, top: `${y}%`, width: s * 1.6, height: s * 1.6, animationDelay: `${d}s` }} viewBox="-9 -9 18 18" aria-hidden="true">
              <path d="M0-9 2.300-2.300 9 0 2.300 2.300 0 9-2.300 2.300-9 0-2.300-2.300z" />
            </svg>
          ))}
          <BoxArt level={level} size={112} />
        </div>
      </button>
      <div className="bv-tier__name">
        <b>{name}</b>
        {held > 0 && <ShareButton label={`Share your ${name} boxes`} make={(b) => b.boxCard({ tier: level, label: `${name} boxes`, title: `${fmt(held, 0)} ${name}`, lines: [held > 1 ? `Boxes #${ids[0]} … #${ids[held - 1]}` : `Box #${ids[0]}`], image: boxArtSrc(level) })} />}
        <span className="bv-num">{fmt(held, 0)}</span>
      </div>
      <div className="bv-tier__more" aria-hidden={!p.expanded}>
        <div>
          <ul className="bv-tier__ids">
            {ids.map((id) => (
              <li key={id} className="bv-chip is-box">
                <span>{`#${id}`}</span>
                <ShareButton label={`Share box #${id}`} make={(b) => b.boxCard({ tier: level, label: `${name} box`, title: `#${id}`, lines: ['SoDEX Blind Box'], image: boxArtSrc(level) })} />
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="bv-tier__acts">
        <Button variant="primary" disabled={!p.canAct || held === 0} onClick={() => p.setAction('open')} title={p.canAct ? undefined : 'Sign in to SoDEX first'}>Open boxes</Button>
        {to && p.mergeSize > 0 && <Button disabled={!p.canAct || merges === 0} onClick={() => p.setAction('merge')} title={merges === 0 ? `${p.mergeSize} ${name} make 1 ${LEVEL_LABEL[to]}` : undefined}>Merge</Button>}
        <Button variant="quiet" disabled={!p.canGift || held === 0} onClick={p.onGift}>Gift</Button>
      </div>
    </article>
  );
}

/** The gift, as SoDEX's own popup: the item, the recipient's ValueChain address, how many (boxes), confirm. */
function GiftPopup({ t, onClose, onSend }: { t: GiftTarget; onClose: () => void; onSend: (to: string, n: number) => void }) {
  const [to, setTo] = useState('');
  const [raw, setRaw] = useState('1');
  const max = t.ids.length;
  const n = Math.max(0, Math.min(max, Math.floor(Number(raw) || 0)));
  const ok = isAddress(to) && n > 0;
  return (
    <Popup label={`Gift ${t.title}`} size="small" onClose={onClose} head={<b>{t.level ? 'Gift box' : 'Gift Cybereator'}</b>}>
      <form className="bv-gift" onSubmit={(e) => { e.preventDefault(); if (ok) onSend(to.trim(), n); }}>
        <div className={`bv-gift__item${t.level ? ` is-${t.level}` : ''}`}>
          {t.level ? <BoxArt level={t.level} size={52} /> : t.image ? <img src={t.image} alt="" /> : <Icon name="star" size={24} />}
          <span>
            <b>{t.level ? <><i className="bv-dot" aria-hidden="true" />{LEVEL_LABEL[t.level]}</> : t.title}</b>
            <small>{max === 1 ? `#${t.ids[0]}` : `${fmt(max, 0)} in this wallet, the lowest ids first`}</small>
          </span>
        </div>
        <label className="bv-gift__l" htmlFor="bv-gift-to">Recipient address</label>
        <TextInput id="bv-gift-to" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} autoComplete="off" autoFocus />
        <small className={to && !isAddress(to) ? 'bv-err' : 'bv-gift__hint'}>{to && !isAddress(to) ? 'That is not an EVM address.' : "Enter the recipient's EVM address on ValueChain."}</small>
        {max > 1 && (
          <>
            <label className="bv-gift__l" htmlFor="bv-gift-n">How many</label>
            <div className="bv-form__row">
              <TextInput id="bv-gift-n" inputMode="numeric" value={raw} onChange={(e) => setRaw(e.target.value.replace(/[^0-9]/g, ''))} />
              <Button variant="quiet" onClick={() => setRaw(String(max))}>All {fmt(max, 0)}</Button>
            </div>
          </>
        )}
        <small className="bv-gift__hint">{n > 1 ? `${plural(n, 'transfer')}, each shown in your wallet with its gas.` : 'One transfer, shown in your wallet with its gas.'} It cannot be undone.</small>
        <Button variant="primary" size="md" type="submit" disabled={!ok} className="bv-gift__go">Confirm gift</Button>
      </form>
    </Popup>
  );
}

function QueuePanel({ q, onStop, onClose }: { q: Queue; onStop: () => void; onClose: () => void }) {
  const opened = q.results.flatMap((r) => r.opened);
  const merged = q.results.flatMap((r) => r.merged);
  const total = opened.reduce((a, b) => a + (b.rewardUsd ?? 0), 0);
  const pfps = opened.filter((o) => o.pfpTokenId);
  const step = q.step === 'sign' ? 'Waiting for your signature' : q.step === 'wait' ? 'SoDEX is on it' : q.step === 'gift' ? 'Waiting for your wallet' : null;
  return (
    <div className="bv-queue" role="status" aria-live="polite">
      <div className="bv-queue__head">
        <b>{q.label}</b>
        {q.running ? <StatusPill tone="brand" dot pulse size="sm">{step ?? 'Starting'}</StatusPill>
          : q.error ? <StatusPill tone="negative" size="sm">Stopped</StatusPill>
          : q.stopped ? <StatusPill tone="warning" size="sm">Stopped by you</StatusPill>
          : <StatusPill tone="positive" size="sm" icon="check">Done</StatusPill>}
        <span className="bv-queue__n bv-num">{fmt(q.done, 0)} / {fmt(q.total, 0)}</span>
        {q.running && q.total - q.done > 1 ? <Button variant="quiet" onClick={onStop}>Stop after this one</Button> : !q.running && <Button variant="quiet" icon="x" onClick={onClose}>Close</Button>}
      </div>
      {q.total > 1 && <ProgressBar value={q.done} max={q.total} size="sm" label={q.label} />}
      {q.error && <p className="bv-err">{q.error}{q.done > 0 ? ` ${plural(q.done, 'request')} went through before that.` : ''}</p>}
      {opened.length > 0 && (
        <>
          <div className="bv-won">
            <span>Won <b className="bv-num">{usd(total)}</b> from {plural(opened.length, 'box', 'boxes')}</span>
            {pfps.length > 0 && <StatusPill tone="brand" size="sm">{plural(pfps.length, 'Cybereator')} dropped</StatusPill>}
          </div>
          <ul className="bv-results">{opened.map((o) => <Result key={o.tokenId} o={o} />)}</ul>
        </>
      )}
      {merged.length > 0 && (
        <ul className="bv-results">
          {merged.map((m) => (
            <li key={m.tokenId} className="bv-result">
              <BoxArt level={m.level ?? 'Common'} size={40} />
              <span><b>{m.level ?? 'New box'}</b><small>#{m.tokenId} · from {plural(m.consumed.length, 'box', 'boxes')}</small></span>
            </li>
          ))}
        </ul>
      )}
      {q.kind === 'gift' && q.gifts.length > 0 && <p className="bv-note">{plural(q.gifts.length, 'transfer')} sent. They arrive once ValueChain confirms them.</p>}
    </div>
  );
}

function Result({ o }: { o: OpenedBox }) {
  const sym = o.reward?.asset?.symbol;
  return (
    <li className={`bv-result${o.pfpTokenId ? ' is-pfp' : ''}`}>
      <BoxArt level={o.level ?? 'Common'} size={40} />
      <span><b className="bv-num">{usd(o.rewardUsd)}</b><small>{o.reward?.amount && sym ? `${fmtTokens(o.reward.amount)} ${sym}` : DASH} · #{o.tokenId}</small></span>
      {o.pfpTokenId && <StatusPill tone="brand" size="sm">Cybereator #{o.pfpTokenId}</StatusPill>}
    </li>
  );
}

/**
 * Merge math (owner 2026-11-28, his slide "Merge math"): for each merge step, what the boxes put in paid on average
 * against what the box out paid, a bar of the difference, and a verdict: Merge when the box out pays more on average and
 * at the median, Lottery when only its average is higher (a few large wins), Keep when it pays less. From what opened
 * boxes paid on ValueChain, NFT drops left out: an estimate.
 */
export function MergeMath({ rules }: { rules: LotteryRules | null }) {
  const rewards = usePolled('vault-rewards', (s) => fetchRewards(s), 300_000);
  const doc = rewards.data;
  const rows = rules && doc ? mergeLadder(rules).map((s) => ({ s, a: mergeAdvice(doc, s.from, s.to, s.consume) })).filter((r) => r.a) : [];
  const top = Math.max(0.01, ...rows.map((r) => Math.abs(r.a!.gain / r.a!.openAvg)));
  return (
    <section className="tf bv-math" aria-label="Merge math">
      <header className="bv-math__h">
        <h2>Merge math</h2>
        {doc && <StatusPill size="sm" tone="neutral">{`Based on ${fmt(doc.boxes, 0)} opened boxes`}</StatusPill>}
      </header>
      {!doc ? (rewards.error ? <p className="bv-note">{rewards.error}</p> : <div className="bv-math__rows">{[0, 1, 2].map((i) => <Skeleton key={i} className="bv-math__skel" />)}</div>) : (
        <>
          <div className="bv-math__cols" aria-hidden="true"><span>In</span><span>Out</span><span>Average paid, out vs in</span></div>
          <ul className="bv-math__rows">
            {rows.map(({ s, a }) => {
              const pct = a!.gain / a!.openAvg;
              const verdict = pct <= 0 ? 'keep' : a!.mergeMedian > a!.openMedian ? 'merge' : 'lottery';
              const w = `${Math.min(100, (Math.abs(pct) / top) * 100).toFixed(1)}%`;
              return (
                <li key={s.from} className={`bv-math__row is-${verdict}`}>
                  <span className="bv-math__in">
                    <span className="bv-math__stack"><BoxArt level={s.from} size={48} /><BoxArt level={s.from} size={48} /><BoxArt level={s.from} size={48} /><em>×{s.consume}</em></span>
                    <span><b>{LEVEL_LABEL[s.from]}</b><small className="bv-num">{usd(a!.openAvg)}</small></span>
                  </span>
                  <i className="bv-math__arrow" aria-hidden="true">→</i>
                  <span className="bv-math__out"><BoxArt level={s.to} size={48} /><span><b>{LEVEL_LABEL[s.to]}</b><small className="bv-num">{usd(a!.mergeAvg)}</small></span></span>
                  <span className="bv-math__bar">
                    <span className="bv-math__neg">{pct < 0 && <><em className="bv-num">{`${(pct * 100).toFixed(0)}%`}</em><i style={{ width: w }} /></>}</span>
                    <span className="bv-math__axis" />
                    <span className="bv-math__pos">{pct > 0 && <><i style={{ width: w }} /><em className="bv-num">{`+${(pct * 100).toFixed(0)}%`}</em></>}</span>
                  </span>
                  <StatusPill size="sm" tone={verdict === 'merge' ? 'positive' : verdict === 'lottery' ? 'warning' : 'negative'}>{verdict === 'merge' ? 'Merge' : verdict === 'lottery' ? 'Lottery' : 'Keep'}</StatusPill>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

const rarityOf = (c: Cybereator): string | null => c.traits.find((t) => /^(rarity|tier|grade)$/i.test(t.type))?.value ?? null;

/** A revealed Cybereator's foil by its rarity trait, if it has one; none without (the card still tilts). */
function foilOf(c: Cybereator): 'normal' | 'strong' | 'gold' | false {
  const r = rarityOf(c)?.toLowerCase();
  if (!r) return false;
  return /legend|mythic|super|epic/.test(r) ? 'gold' : /rare/.test(r) ? 'strong' : 'normal';
}

/** Sealed ones sell as the collection's common floor; revealed ones at their rarity's floor when one is listed. */
function floorOf(c: Cybereator, col: MarketDoc['collections'][string] | undefined): number | null {
  if (!col) return null;
  const r = rarityOf(c);
  return (!c.sealed && r && col.tiers[r]?.floor) || col.floor;
}

function Pic({ c }: { c: Cybereator }) {
  return c.image ? <img src={c.image} alt={c.name} loading="lazy" decoding="async" draggable={false} /> : <span className="bv-card__none"><Icon name="star" size={28} /></span>;
}

function Cybereators({ address, list, error, retry, market, sosoUsd, canGift, onGift }: {
  address: string | null; list: Cybereator[] | null; error: string | null; retry: () => void; market: MarketDoc | null; sosoUsd: number | null; canGift: boolean; onGift: (c: Cybereator) => void;
}) {
  const col = market?.collections[CYBEREATOR];
  const prices = market?.tokens?.[CYBEREATOR] ?? {};
  const head = (
    <div className="bv-cyhead">
      <span>Floor <b className="bv-num">{soso(col?.floor)}</b>{col?.floor != null && sosoUsd ? <small> {usd(col.floor * sosoUsd)}</small> : null}</span>
      <span>Best offer <b className="bv-num">{soso(col?.bestOffer)}</b></span>
    </div>
  );
  if (!address) return <>{head}<ConnectPrompt line="Connect a wallet to see its Cybereators." /></>;
  if (error && !list) return <>{head}<EmptyState icon="warning" title="Your Cybereators could not be read" description={error} actions={<Button onClick={retry}>Try again</Button>} compact /></>;
  if (!list) return <>{head}<div className="bv-cards">{[0, 1, 2].map((i) => <Skeleton key={i} className="bv-card__skel" />)}</div></>;
  if (!list.length) return <>{head}<EmptyState icon="star" title="No Cybereators yet" description="Every box opened has a chance to drop one; the earlier, the better the odds." compact /></>;
  return (
    <>
      {head}
      <div className="bv-cards">
        {list.map((c) => {
          const [ask, bid] = prices[c.id] ?? [null, null];
          return (
            <article key={c.id} className="bv-card">
              {c.sealed
                ? <div className="bv-card__art"><Pic c={c} /></div>
                : <Holo foil={foilOf(c)} className="bv-card__art"><Pic c={c} /></Holo>}
              <div className="bv-card__t"><b>{c.name}</b>{c.sealed && <StatusPill size="sm" tone="warning">Sealed</StatusPill>}<ShareButton label={`Share ${c.name}`} make={(b) => b.boxCard({ tier: 'Cybereator', label: c.sealed ? 'Cybereator · sealed' : 'Cybereator', title: c.name, lines: c.traits.filter((t) => t.value !== 'None').slice(0, 3).map((t) => `${t.type}: ${t.value}`), image: c.image })} /></div>
              {c.traits.length > 0 && !c.sealed && <ul className="bv-traits">{c.traits.filter((t) => t.value !== 'None').slice(0, 4).map((t) => <li key={t.type}><small>{t.type}</small>{t.value}</li>)}</ul>}
              <dl className="bv-kv">
                <div><dt>Floor</dt><dd className="bv-num">{soso(floorOf(c, col))}</dd></div>
                <div><dt>Listed at</dt><dd className="bv-num">{ask != null ? soso(ask) : 'Not listed'}</dd></div>
                <div><dt>Best offer</dt><dd className="bv-num">{bid != null ? soso(bid) : col?.bestOffer != null ? `${soso(col.bestOffer)} (any)` : DASH}</dd></div>
              </dl>
              <div className="bv-tier__acts">
                <a className="tf-btn is-primary is-sm" href={valuemintCollection(CYBEREATOR)} target="_blank" rel="noopener noreferrer">Trade</a>
                {c.sealed && <a className="tf-btn is-secondary is-sm" href={CYBEREATOR_SITE} target="_blank" rel="noopener noreferrer">Unseal</a>}
                <Button variant="quiet" disabled={!canGift} onClick={() => onGift(c)}>Gift</Button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

/* --- the wallet's history: opens, claims, merges, transfers, referral rewards ------------------------------------- */

type HFilter = 'all' | HistoryKind;
const H_FILTERS: Array<{ value: HFilter; label: string }> = [
  { value: 'all', label: 'All' }, { value: 'open', label: 'Opens' }, { value: 'claim', label: 'Claims' },
  { value: 'merge', label: 'Merges' }, { value: 'transfer', label: 'Transfers' }, { value: 'referral', label: 'Referrals' },
];
const KIND_LABEL: Record<HistoryKind, string> = { open: 'Opened', claim: 'Claimed', merge: 'Merged', transfer: 'Transfer', referral: 'Referral reward' };

export function BoxHistory({ address, provider, demo }: { address: string | null; provider: Eip1193Provider | null; demo?: VaultDemo | null }) {
  const session = useSodexSession(address, provider, !!demo);
  const h = usePolled(!demo && address && session.signedIn ? `box-records:${address.toLowerCase()}` : null, () => readRecords(address as string, 100), 60_000);
  const [filter, setFilter] = useState<HFilter>('all');
  const [full, setFull] = useState(false);
  const rows = demo ? demo.records : h.data;
  const close = useCallback(() => setFull(false), []);
  const list = (all: boolean) => (
    !address && !demo ? <ConnectPrompt line="Connect a wallet to see its history." />
      : !session.signedIn ? (
        <div className="bv-empty">
          <p>Your opens, claims, merges, transfers and referral rewards are SoDEX's record of your wallet.</p>
          <Button variant="primary" loading={session.busy} disabled={!provider} onClick={() => void session.signIn()}>Sign in to SoDEX</Button>
        </div>
      )
      : h.error && !rows ? <EmptyState icon="warning" title="Your history could not be read" description={h.error} actions={<Button onClick={h.retry}>Try again</Button>} compact />
      : !rows ? <div className="bv-results is-list">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="bv-result__skel" />)}</div>
      : <HistoryList rows={rows} filter={filter} capped={!all} />
  );
  return (
    <section className="bv-hist tf" aria-label="History">
      <header className="bv-hist__h">
        <h3>History</h3>
        <IconButton icon="expand" label="Full screen" onClick={() => setFull(true)} />
      </header>
      <Segmented<HFilter> label="Show" value={filter} onChange={setFilter} options={H_FILTERS} className="bv-hist__f" />
      {list(false)}
      {full && (
        <Popup label="History" size="window" onClose={close} head={<b>History</b>}>
          <div className="bv-hist__full">
            {rows && <HistorySummary rows={rows} />}
            <Segmented<HFilter> label="Show" value={filter} onChange={setFilter} options={H_FILTERS} />
            {list(true)}
          </div>
        </Popup>
      )}
    </section>
  );
}

function HistorySummary({ rows }: { rows: RecordRow[] }) {
  const opens = rows.filter((r) => r.kind === 'open');
  const won = opens.reduce((a, b) => a + (b.usd ?? 0), 0);
  const count = (k: HistoryKind) => rows.filter((r) => r.kind === k).reduce((a, b) => a + (b.count ?? 1), 0);
  return (
    <dl className="bv-progress is-four">
      <div><dt>Opened</dt><dd className="bv-num">{fmt(opens.length, 0)}</dd></div>
      <div><dt>Won</dt><dd className="bv-num">{usd(won)}</dd></div>
      <div><dt>Claimed</dt><dd className="bv-num">{fmt(count('claim'), 0)}</dd></div>
      <div><dt>Cybereators</dt><dd className="bv-num">{fmt(opens.filter((o) => o.pfpTokenId).length, 0)}</dd></div>
    </dl>
  );
}

function HistoryList({ rows, filter, capped }: { rows: RecordRow[]; filter: HFilter; capped: boolean }) {
  const now = useNow(30_000);
  const shown = rows.filter((r) => filter === 'all' || r.kind === filter);
  if (!shown.length) return <EmptyState icon="clock" title="Nothing here yet" description="What this wallet does with its boxes shows here." compact />;
  const box = (r: RecordRow) => (r.tokenIds.length ? (r.tokenIds.length > 1 ? `${fmt(r.tokenIds.length, 0)} boxes` : `#${r.tokenIds[0]}`) : r.count ? plural(r.count, 'box', 'boxes') : '');
  const detail = (r: RecordRow): ReactNode => (r.pfpTokenId ? <StatusPill tone="brand" size="sm">{`Cybereator #${r.pfpTokenId}`}</StatusPill>
    : r.other ? `${r.direction === 'out' ? 'To' : r.direction === 'in' ? 'From' : 'Friend'} ${r.other.slice(0, 6)}…${r.other.slice(-4)}` : DASH);
  return (
    <div className={`bv-htable${capped ? ' is-capped' : ''}`} role="table" aria-label="History">
      <div className="bv-htable__row is-head" role="row">
        <span role="columnheader">Type</span><span role="columnheader">Box</span><span role="columnheader">Detail</span>
        <span role="columnheader" className="is-num">Reward</span><span role="columnheader" className="is-num">When</span>
      </div>
      {shown.map((r, i) => (
        <div key={`${r.kind}:${r.tokenIds.join(',')}:${r.at}:${i}`} className="bv-htable__row" role="row">
          <span role="cell" className="bv-htable__type"><BoxArt level={r.level ?? 'Common'} size={26} /><b>{`${KIND_LABEL[r.kind]}${r.kind === 'transfer' && r.direction ? (r.direction === 'out' ? ' out' : ' in') : ''}`}</b></span>
          <span role="cell" className="bv-htable__two"><b>{r.level ?? DASH}</b><small>{box(r)}</small></span>
          <span role="cell">{detail(r)}</span>
          <span role="cell" className="bv-htable__two is-num">{r.usd != null ? <><b className="bv-num">{usd(r.usd)}</b><small className="bv-num">{r.reward?.amount && r.reward.asset?.symbol ? `${fmtTokens(r.reward.amount)} ${r.reward.asset.symbol}` : ''}</small></> : <b>{DASH}</b>}</span>
          <span role="cell" className="bv-htable__when is-num">{r.at ? fmtAgo(r.at, now) : DASH}</span>
        </div>
      ))}
    </div>
  );
}

/* --- the hero's progress card (owner's screenshot of SoDEX's) ------------------------------------------------------ */

export function ProgressCard({ address, provider, rules, demo }: { address: string | null; provider: Eip1193Provider | null; rules: LotteryRules | null; demo?: VaultDemo | null }) {
  const session = useSodexSession(address, provider, !!demo);
  const p = usePolled(!demo && address && session.signedIn ? `box-progress:${address.toLowerCase()}` : null, () => readProgress(address as string).then((x) => ({ ...x, at: Date.now() })), 60_000);
  const now = useNow(30_000);
  const data = demo ? demo.progress : p.data;
  const per = rules?.volumePerBoxU ?? null;
  const left = data?.toNextBoxU ?? null;
  const share = per && left != null ? Math.min(1, Math.max(0, (per - left) / per)) : 0;
  return (
    <div className="bv-hero">
      {!address && !demo ? (
        <>
          <b className="bv-hero__t">Trade to win Blind Boxes</b>
          <p className="bv-hero__l">{per ? `Every ${usd(per, 0)} of effective volume wins a box.` : DASH}</p>
          <Button variant="primary" size="md" onPointerEnter={warmWalletModal} onClick={() => void openConnectDialog()}>Connect wallet</Button>
        </>
      ) : !session.signedIn ? (
        <>
          <b className="bv-hero__t">See how close your next box is</b>
          <p className="bv-hero__l">One signature of SoDEX's sign-in text, no gas.</p>
          <Button variant="primary" size="md" loading={session.busy} disabled={!provider} onClick={() => void session.signIn()}>Sign in to SoDEX</Button>
        </>
      ) : (
        <>
          <b className="bv-hero__t">{left != null ? <>Trade <em className="bv-num">{usd(left, 0)}</em> more to unlock your next Blind Box</> : 'Your next Blind Box'}</b>
          <div className="bv-hero__bar">
            <span className="bv-hero__track"><i style={{ width: `${(share * 100).toFixed(1)}%` }} /></span>
            <BoxArt level="Common" size={30} />
          </div>
          <div className="bv-hero__meta">
            <span>Effective volume {usd(data?.effectiveU ?? null, 0)}{per ? ` · every ${usd(per, 0)} = 1 box` : ''}</span>
            {data && <span>Updated {fmtAgo(data.at, now)}</span>}
          </div>
          <a className="tf-btn is-primary is-md bv-hero__go" href="/trade">Keep trading</a>
          {address || demo ? <Claim address={demo ? 'demo' : (address as string)} demo={demo?.treasures ?? null} compact /> : null}
        </>
      )}
    </div>
  );
}

/** The PFP drop's links (owner: "needs a trade button too & a link to the official cybereator.com"). */
export function PfpLinks(): ReactNode {
  return (
    <div className="bv-pfplinks">
      <a className="rf-cta" href={valuemintCollection(CYBEREATOR)} target="_blank" rel="noopener noreferrer">Trade on valuemint</a>
      <a className="rf-howbtn" href={CYBEREATOR_SITE} target="_blank" rel="noopener noreferrer">cybereator.com</a>
    </div>
  );
}
