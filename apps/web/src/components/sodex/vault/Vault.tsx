/**
 * The Blind Box vault (owner 2026-11-28): everything SoDEX's own Blind Box page does for a wallet, here, so this page can
 * stand in for it. The wallet's boxes by tier with their price on valuemint.store and what each tier paid (from the
 * chain, NFT drops left out), opening and merging (one wallet signature a request; many requests queued for big
 * holders), claiming earned boxes, gifting boxes and Cybereators, the Cybereators with cybereator.com's card glare, and
 * the wallet's opens. Trading is always on valuemint.store.
 *
 * What runs where: boxes and Cybereators are read off the chain from this browser; everything else that needs SoDEX's
 * token passes our relay (boxVault.ts, server routes/sodexLotteryUser.ts). Nothing is ever signed or sent for the user.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  LEVELS, LEVEL_LABEL, mergeLadder, nextLevel, readWalletBoxes, valuechainRpc,
  type Level, type LotteryMeta,
} from '../../../blindBox';
import {
  CYBEREATOR, CYBEREATOR_SITE, TREASURE_BOX, batches, claimTreasure, fetchMarket, fetchRewards, gift, isAddress, mergeAdvice,
  readCybereators, readHistory, readProgress, readTreasures, runRequest, valuemintCollection,
  type Cybereator, type HistoryItem, type JobResult, type LevelRewards, type MarketDoc, type OpenedBox, type RewardsDoc,
} from '../../../boxVault';
import { DASH, fmt } from '../../../format';
import { NeedsPointsToken, clearPointsToken, getPointsToken, setPointsToken } from '../../../points';
import { signInToPoints } from '../../../pointsAuth';
import { coinPrices, priceOf } from '../../../trading/prices';
import { isUserRejection, type Eip1193Provider } from '../../../wallet';
import { warmWalletModal } from '../../../walletconnect';
import { openConnectDialog } from '../../account/connect';
import { usePolled } from '../../explore/cohorts/parts';
import { Button, EmptyState, Icon, ProgressBar, Segmented, Skeleton, StatusPill, Switch, TextInput } from '../../bots/kit/kit';
import { BoxArt } from '../BoxArt';
import { fmtAgo, fmtTokens, fmtUsdTight, useNow } from '../parts';
import { Holo } from './Holo';
import './vault.css';

const usd = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? DASH : fmtUsdTight(v.toFixed(d)));
const soso = (v: number | null | undefined) => (v == null ? DASH : `${fmt(v, v < 10 ? 2 : 0)} SOSO`);
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n, 0)} ${n === 1 ? one : many}`;
const errText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong.');

/* --- the SoDEX sign-in, the one SoPoints uses ---------------------------------------------------------------------- */

function useSodexSession(address: string | null, provider: Eip1193Provider | null) {
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = !!address && !!getPointsToken(address);
  const signIn = useCallback(async () => {
    if (!address || !provider) return;
    setBusy(true);
    setError(null);
    try {
      setPointsToken(address, await signInToPoints(provider, address));
    } catch (e) {
      if (!isUserRejection(e)) setError(errText(e));
    } finally {
      setBusy(false);
      setTick((n) => n + 1);
    }
  }, [address, provider]);
  const lost = useCallback(() => { clearPointsToken(); setTick((n) => n + 1); }, []);
  return { signedIn, signIn, busy, error, lost };
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

function useQueue(onFinish: () => void) {
  const [q, setQ] = useState<Queue | null>(null);
  const stop = useRef(false);
  const run = useCallback(async (kind: Queue['kind'], label: string, jobs: Array<(set: (s: Step) => void) => Promise<JobResult | string | null>>) => {
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

/* --- the vault ----------------------------------------------------------------------------------------------------- */

type Tab = 'boxes' | 'cybr' | 'opened';
type Action = { level: Level; kind: 'open' | 'merge' | 'gift' } | null;

export function Vault({ address, provider, meta, className, cybrOwner }: { address: string | null; provider: Eip1193Provider | null; meta: LotteryMeta | null; className?: string; /** Localhost's Sample: another wallet's Cybereators, shown read-only. */ cybrOwner?: string }) {
  const box = meta?.contracts?.treasureBox ?? TREASURE_BOX.address;
  const rules = meta?.rules ?? null;
  const session = useSodexSession(address, provider);
  const chain = usePolled(address ? `boxes:${address.toLowerCase()}:${box}` : null, (s) => readWalletBoxes(address as string, box, valuechainRpc(s)), 60_000);
  const market = usePolled('vault-market', (s) => fetchMarket(s), 300_000);
  const rewards = usePolled('vault-rewards', (s) => fetchRewards(s), 300_000);
  const cybrOf = cybrOwner ?? address;
  const cybr = usePolled(cybrOf ? `cybr:${cybrOf.toLowerCase()}` : null, () => readCybereators(cybrOf as string), 120_000);
  const [sosoUsd, setSosoUsd] = useState<number | null>(null);
  useEffect(() => { let off = false; void coinPrices().then((m) => { if (!off) setSosoUsd(priceOf(m, 'SOSO') ?? null); }).catch(() => undefined); return () => { off = true; }; }, []);
  const [tab, setTab] = useState<Tab>('boxes');
  const [paid, setPaid] = useState(true);
  const [action, setAction] = useState<Action>(null);
  const refresh = useCallback(() => { chain.retry(); cybr.retry(); }, [chain, cybr]);
  const queue = useQueue(refresh);
  const busy = !!queue.q?.running;

  const perOpen = rules?.limits.maxBoxOpen ?? 30;
  const ids = chain.data?.exact ? chain.data.byLevel : null;

  const start = (kind: 'open' | 'merge', level: Level, n: number) => {
    if (!address || !provider || !ids) return;
    const size = kind === 'open' ? perOpen : rules?.mergeSize[level] ?? 0;
    const pool = ids[level].slice(0, kind === 'open' ? n : n * size);
    const groups = batches(kind, pool, size);
    setAction(null);
    void queue.run(kind, kind === 'open' ? `Opening ${plural(pool.length, `${LEVEL_LABEL[level]} box`, `${LEVEL_LABEL[level]} boxes`)}` : `Merging ${plural(pool.length, `${LEVEL_LABEL[level]} box`, `${LEVEL_LABEL[level]} boxes`)} into ${plural(groups.length, LEVEL_LABEL[nextLevel(level)!])}`,
      groups.map((g) => (set) => { set('sign'); return runRequest({ action: kind, address, provider, ids: g, box, onSigned: () => set('wait') }); }));
  };
  const sendGift = (contract: string, tokenIds: string[], to: string, what: string) => {
    if (!address || !provider) return;
    setAction(null);
    void queue.run('gift', `Sending ${what} to ${to.slice(0, 6)}…${to.slice(-4)}`, tokenIds.map((id) => (set) => { set('gift'); return gift({ provider, from: address, to, contract, tokenId: id }); }));
  };

  return (
    <section className={`tf bv${className ? ` ${className}` : ''}`} aria-label="Your vault">
      <header className="bv-head">
        <div className="bv-head__t">
          <h2>Your vault</h2>
          <p>Open, merge, claim and gift here. Every request is one signature in your wallet; trading is on valuemint.store.</p>
        </div>
        <div className="bv-head__c">
          <Segmented<Tab> label="Show" value={tab} onChange={setTab} options={[
            { value: 'boxes', label: 'Boxes', ...(chain.data ? { count: chain.data.count } : {}) },
            { value: 'cybr', label: 'Cybereators', ...(cybr.data ? { count: cybr.data.length } : {}) },
            { value: 'opened', label: 'Opened' },
          ]} />
          {tab === 'boxes' && <Switch checked={paid} onChange={setPaid} label="What boxes paid" description="Our history from the chain, NFT drops left out" />}
        </div>
      </header>

      <SessionBar address={address} provider={provider} session={session} />
      {queue.q && <QueuePanel q={queue.q} onStop={queue.stop} onClose={queue.clear} />}
      {session.signedIn && address && <ProgressRow address={address} />}
      {session.signedIn && address && <Claim address={address} busy={busy} onClaim={(n) => void queue.run('claim', `Claiming ${plural(n, 'earned box', 'earned boxes')}`, [() => claimTreasure(address, n)])} />}

      {tab === 'boxes' && (
        !address ? <ConnectPrompt line="Connect a wallet to see its boxes." />
          : chain.error && !chain.data ? <EmptyState icon="warning" title="Your boxes could not be read" description={chain.error} actions={<Button onClick={chain.retry}>Try again</Button>} compact />
          : !chain.data ? <div className="bv-tiers">{LEVELS.map((l) => <Skeleton key={l} className="bv-tier__skel" />)}</div>
          : (
            <>
              {!chain.data.exact && <p className="bv-note">{plural(chain.data.count, 'box', 'boxes')} in this wallet. Their tiers could not be read just now, so nothing can be picked; try again in a minute.</p>}
              <div className="bv-tiers">
                {LEVELS.map((l) => (
                  <TierCard
                    key={l} level={l} ids={ids?.[l] ?? []} market={market.data} sosoUsd={sosoUsd} paid={paid} stats={rewards.data?.levels[l] ?? null}
                    band={rules?.rewardBands.find((b) => b.level === l) ?? null} mergeSize={rules?.mergeSize[l] ?? 0}
                    canAct={session.signedIn && !busy && !!provider} canGift={!busy && !!provider} action={action?.level === l ? action.kind : null}
                    setAction={(k) => setAction(k ? { level: l, kind: k } : null)} perOpen={perOpen}
                    onOpen={(n) => start('open', l, n)} onMerge={(n) => start('merge', l, n)}
                    onGift={(n, to) => sendGift(box, (ids?.[l] ?? []).slice(0, n), to, plural(n, `${LEVEL_LABEL[l]} box`, `${LEVEL_LABEL[l]} boxes`))}
                  />
                ))}
              </div>
              {paid && rules && <Advice rewards={rewards.data} error={rewards.error} ladder={mergeLadder(rules)} market={market.data} sosoUsd={sosoUsd} />}
            </>
          )
      )}
      {tab === 'cybr' && (
        <Cybereators address={cybrOf} list={cybr.data} error={cybr.error} retry={cybr.retry} market={market.data} sosoUsd={sosoUsd} canGift={!busy && !!provider && !cybrOwner}
          onGift={(id, to) => sendGift(CYBEREATOR, [id], to, `Cybereator #${id}`)} />
      )}
      {tab === 'opened' && <Opened address={address} signedIn={session.signedIn} />}
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

function SessionBar({ address, provider, session }: { address: string | null; provider: Eip1193Provider | null; session: ReturnType<typeof useSodexSession> }) {
  if (!address) return null;
  if (session.signedIn) return null;
  return (
    <div className="bv-signin">
      <Icon name="shield" size={16} />
      <span><b>Sign in to SoDEX to open, merge and claim.</b> One signature of SoDEX's sign-in text: no transaction, no gas, no access to funds. Seeing, gifting and trading your boxes needs none.</span>
      <Button variant="primary" loading={session.busy} disabled={!provider} onClick={() => void session.signIn()}>Sign in to SoDEX</Button>
      {session.error && <small className="bv-err">{session.error}</small>}
    </div>
  );
}

/** SoDEX's count toward the next box: the wallet's effective volume, what is left, the boxes earned so far. */
function ProgressRow({ address }: { address: string }) {
  const p = usePolled(`box-progress:${address.toLowerCase()}`, () => readProgress(address), 60_000);
  if (!p.data) return null;
  return (
    <dl className="bv-progress">
      <div><dt>Effective volume</dt><dd className="bv-num">{usd(p.data.effectiveU, 0)}</dd></div>
      <div><dt>To the next box</dt><dd className="bv-num">{usd(p.data.toNextBoxU, 0)}</dd></div>
      <div><dt>Boxes earned</dt><dd className="bv-num">{p.data.boxesEarned == null ? DASH : fmt(p.data.boxesEarned, 0)}</dd></div>
    </dl>
  );
}

function Claim({ address, busy, onClaim }: { address: string; busy: boolean; onClaim: (n: number) => void }) {
  const t = usePolled(`treasures:${address.toLowerCase()}`, () => readTreasures(address), 60_000);
  const n = t.data?.total ?? 0;
  if (!n) return null;
  const take = Math.min(n, t.data?.maxPerOpen ?? 100);
  return (
    <div className="bv-claim">
      <BoxArt level="Common" size={34} />
      <span><b>{plural(n, 'earned box', 'earned boxes')}</b> waiting to be claimed into your wallet{n > take ? ` (${fmt(take, 0)} a claim)` : ''}.</span>
      <Button variant="go" disabled={busy} onClick={() => onClaim(take)}>Claim {fmt(take, 0)}</Button>
    </div>
  );
}

function TierCard(p: {
  level: Level; ids: string[]; market: MarketDoc | null; sosoUsd: number | null; paid: boolean; stats: LevelRewards | null;
  band: { minUsd: string; maxUsd: string } | null; mergeSize: number; perOpen: number;
  canAct: boolean; canGift: boolean; action: 'open' | 'merge' | 'gift' | null; setAction: (k: 'open' | 'merge' | 'gift' | null) => void;
  onOpen: (n: number) => void; onMerge: (n: number) => void; onGift: (n: number, to: string) => void;
}) {
  const { level, ids } = p;
  const held = ids.length;
  const merges = p.mergeSize > 0 ? Math.floor(held / p.mergeSize) : 0;
  const col = p.market?.collections[TREASURE_BOX.address];
  const tier = col?.tiers[level];
  const floorUsd = tier && p.sosoUsd ? tier.floor * p.sosoUsd : null;
  const to = nextLevel(level);
  return (
    <article className={`bv-tier is-${level}${held ? '' : ' is-none'}`}>
      <Holo foil={false} className="bv-tier__art"><BoxArt level={level} size={112} /></Holo>
      <div className="bv-tier__name"><b>{LEVEL_LABEL[level]}</b><span className="bv-num">{fmt(held, 0)}</span></div>
      <dl className="bv-kv">
        {p.paid ? (
          p.stats ? (
            <>
              <div><dt>Paid, average</dt><dd className="bv-num">{usd(p.stats.avg)}</dd></div>
              <div><dt>Median</dt><dd className="bv-num">{usd(p.stats.median)}</dd></div>
              <div><dt>Low to high</dt><dd className="bv-num">{usd(p.stats.low)} – {usd(p.stats.high, 0)}</dd></div>
              <div className="bv-kv__n"><dt>Boxes opened</dt><dd className="bv-num">{fmt(p.stats.n, 0)}</dd></div>
            </>
          ) : <div><dt>Paid</dt><dd>{DASH}</dd></div>
        ) : (
          <div><dt>SoDEX's range</dt><dd className="bv-num">{p.band ? `${fmtUsdTight(p.band.minUsd)} – ${fmtUsdTight(p.band.maxUsd)}` : DASH}</dd></div>
        )}
        <div className="bv-kv__mk"><dt>Floor on valuemint</dt><dd className="bv-num">{tier ? <>{soso(tier.floor)}{floorUsd != null && <small> {usd(floorUsd)}</small>}</> : 'None listed'}</dd></div>
      </dl>
      {p.action === null ? (
        <div className="bv-tier__acts">
          <Button variant="primary" disabled={!p.canAct || held === 0} onClick={() => p.setAction('open')} title={p.canAct ? undefined : 'Sign in to SoDEX first'}>Open boxes</Button>
          {to && p.mergeSize > 0 && <Button disabled={!p.canAct || merges === 0} onClick={() => p.setAction('merge')} title={merges === 0 ? `${p.mergeSize} ${LEVEL_LABEL[level]} make 1 ${LEVEL_LABEL[to]}` : undefined}>Merge</Button>}
          <Button variant="quiet" icon="share" disabled={!p.canGift || held === 0} onClick={() => p.setAction('gift')}>Send</Button>
          <a className="tf-btn is-quiet is-sm" href={valuemintCollection(TREASURE_BOX.address)} target="_blank" rel="noopener noreferrer">Trade</a>
        </div>
      ) : p.action === 'gift' ? (
        <GiftForm max={held} unit={`${LEVEL_LABEL[level]} box`} onCancel={() => p.setAction(null)} onSend={p.onGift} />
      ) : (
        <CountForm
          max={p.action === 'open' ? held : merges}
          verb={p.action === 'open' ? 'Open' : 'Merge'}
          unit={p.action === 'open' ? `${LEVEL_LABEL[level]} box` : `merge into ${to ? LEVEL_LABEL[to] : ''}`}
          signatures={(n) => (p.action === 'open' ? Math.ceil(n / p.perOpen) : n)}
          note={p.action === 'merge' ? (n) => `Uses ${fmt(n * p.mergeSize, 0)} ${LEVEL_LABEL[level]}, burned.` : (n) => (n > p.perOpen ? `${fmt(p.perOpen, 0)} boxes a request, one after another.` : '')}
          onCancel={() => p.setAction(null)}
          onGo={(n) => (p.action === 'open' ? p.onOpen(n) : p.onMerge(n))}
        />
      )}
    </article>
  );
}

function CountForm({ max, verb, unit, signatures, note, onCancel, onGo }: { max: number; verb: string; unit: string; signatures: (n: number) => number; note: (n: number) => string; onCancel: () => void; onGo: (n: number) => void }) {
  const [raw, setRaw] = useState(String(max));
  const n = Math.max(0, Math.min(max, Math.floor(Number(raw) || 0)));
  const sigs = signatures(n);
  return (
    <form className="bv-form" onSubmit={(e) => { e.preventDefault(); if (n > 0) onGo(n); }}>
      <div className="bv-form__row">
        <TextInput inputMode="numeric" aria-label={`How many to ${verb.toLowerCase()}`} value={raw} onChange={(e) => setRaw(e.target.value.replace(/[^0-9]/g, ''))} />
        <Button variant="quiet" onClick={() => setRaw(String(max))}>All {fmt(max, 0)}</Button>
      </div>
      <small>{n > 0 ? `${plural(sigs, 'signature')} in your wallet. ${note(n)}` : `Up to ${fmt(max, 0)}.`}</small>
      <div className="bv-form__row">
        <Button variant="primary" type="submit" disabled={n === 0}>{verb} {fmt(n, 0)} {n === 1 ? unit : unit.startsWith('merge') ? unit.replace('merge', 'merges') : `${unit.replace(/box$/, 'boxes')}`}</Button>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function GiftForm({ max, unit, onCancel, onSend }: { max: number; unit: string; onCancel: () => void; onSend: (n: number, to: string) => void }) {
  const [to, setTo] = useState('');
  const [raw, setRaw] = useState('1');
  const n = Math.max(0, Math.min(max, Math.floor(Number(raw) || 0)));
  const ok = isAddress(to) && n > 0;
  return (
    <form className="bv-form" onSubmit={(e) => { e.preventDefault(); if (ok) onSend(n, to.trim()); }}>
      <TextInput placeholder="Their wallet address, 0x…" aria-label="Their wallet address" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} autoComplete="off" />
      {max > 1 && (
        <div className="bv-form__row">
          <TextInput inputMode="numeric" aria-label="How many" value={raw} onChange={(e) => setRaw(e.target.value.replace(/[^0-9]/g, ''))} />
          <small>of {fmt(max, 0)}</small>
        </div>
      )}
      <small>{n > 1 ? `${plural(n, 'transfer')} on ValueChain, each one shown in your wallet with its gas.` : 'A transfer on ValueChain, shown in your wallet with its gas.'} It cannot be undone.</small>
      <div className="bv-form__row">
        <Button variant="primary" type="submit" disabled={!ok}>Send {n === 1 ? unit : `${fmt(n, 0)} ${unit.replace(/box$/, 'boxes')}`}</Button>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
      {to && !isAddress(to) && <small className="bv-err">That is not a wallet address.</small>}
    </form>
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

/** Open, merge or sell, by what boxes paid (NFT drops left out) and the floor on valuemint.store. */
function Advice({ rewards, error, ladder, market, sosoUsd }: { rewards: RewardsDoc | null; error: string | null; ladder: ReturnType<typeof mergeLadder>; market: MarketDoc | null; sosoUsd: number | null }) {
  if (!rewards) return <p className="bv-note">{error ? `What boxes paid could not be read: ${error}` : 'Reading what boxes paid…'}</p>;
  const tiers = market?.collections[TREASURE_BOX.address]?.tiers;
  const rows = ladder.map((s) => {
    const a = mergeAdvice(rewards, s.from, s.to, s.consume);
    const sellFrom = tiers?.[s.from] && sosoUsd ? tiers[s.from]!.floor * sosoUsd * s.consume : null;
    return { s, a, sellFrom };
  }).filter((r) => r.a);
  if (!rows.length) return null;
  return (
    <section className="bv-advice" aria-label="Merge or open">
      <h3>Merge or open?</h3>
      <p className="bv-note">{`By what ${fmt(rewards.boxes, 0)} opened boxes paid on ValueChain, on average. A Cybereator a box may drop is not counted, which is part of why boxes list above what they pay. Past results, not a promise.`}</p>
      <ul>
        {rows.map(({ s, a, sellFrom }) => {
          const pick = a!.mergeAvg > a!.openAvg ? 'merge' : 'open';
          const thin = a!.n[1] < 30;
          return (
            <li key={s.from}>
              <span className="bv-advice__step"><BoxArt level={s.from} size={22} />{s.consume}<i aria-hidden="true">→</i><BoxArt level={s.to} size={22} />1</span>
              <span className={pick === 'open' ? 'is-best' : ''}><small>{`Open ${s.consume} ${LEVEL_LABEL[s.from]}`}</small><b className="bv-num">{usd(a!.openAvg)}</b><em>{`median ${usd(a!.openMedian)}`}</em></span>
              <span className={pick === 'merge' ? 'is-best' : ''}><small>{`Merge into 1 ${LEVEL_LABEL[s.to]}`}</small><b className="bv-num">{usd(a!.mergeAvg)}</b><em>{`median ${usd(a!.mergeMedian)}`}</em></span>
              <span><small>{`${s.consume} listed from`}</small><b className="bv-num">{usd(sellFrom)}</b><em>valuemint floor, an ask</em></span>
              <StatusPill size="sm" tone={pick === 'merge' ? 'positive' : 'neutral'}>{pick === 'merge' ? `Merge, ${usd(a!.gain)} more` : `Open, ${usd(-a!.gain)} more`}{thin ? ` · ${fmt(a!.n[1], 0)} ${LEVEL_LABEL[s.to]} seen` : ''}</StatusPill>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Cybereators({ address, list, error, retry, market, sosoUsd, canGift, onGift }: {
  address: string | null; list: Cybereator[] | null; error: string | null; retry: () => void; market: MarketDoc | null; sosoUsd: number | null; canGift: boolean; onGift: (id: string, to: string) => void;
}) {
  const [giving, setGiving] = useState<string | null>(null);
  const col = market?.collections[CYBEREATOR];
  const prices = market?.tokens?.[CYBEREATOR] ?? {};
  const head = (
    <div className="bv-cyhead">
      <span>Cybereator <small>CYBR</small></span>
      <span>Floor <b className="bv-num">{soso(col?.floor)}</b>{col?.floor != null && sosoUsd ? <small> {usd(col.floor * sosoUsd)}</small> : null}</span>
      <span>Best offer <b className="bv-num">{soso(col?.bestOffer)}</b></span>
      <a className="tf-btn is-secondary is-sm" href={valuemintCollection(CYBEREATOR)} target="_blank" rel="noopener noreferrer">Trade on valuemint</a>
      <a className="tf-btn is-quiet is-sm" href={CYBEREATOR_SITE} target="_blank" rel="noopener noreferrer">cybereator.com</a>
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
          const unopened = c.traits.some((t) => /^status$/i.test(t.type) && /unopened/i.test(t.value));
          return (
            <article key={c.id} className="bv-card">
              <Holo foil="strong" className="bv-card__art">
                {c.image ? <img src={c.image} alt={c.name} loading="lazy" decoding="async" draggable={false} /> : <span className="bv-card__none"><Icon name="star" size={28} /></span>}
              </Holo>
              <div className="bv-card__t"><b>{c.name}</b>{unopened && <StatusPill size="sm" tone="warning">Unrevealed</StatusPill>}</div>
              {c.traits.length > 0 && <ul className="bv-traits">{c.traits.slice(0, 4).map((t) => <li key={t.type}><small>{t.type}</small>{t.value}</li>)}</ul>}
              <dl className="bv-kv">
                <div><dt>Listed at</dt><dd className="bv-num">{ask != null ? soso(ask) : 'Not listed'}</dd></div>
                <div><dt>Best offer</dt><dd className="bv-num">{bid != null ? soso(bid) : col?.bestOffer != null ? `${soso(col.bestOffer)} (any)` : DASH}</dd></div>
              </dl>
              {giving === c.id ? (
                <GiftForm max={1} unit={`Cybereator #${c.id}`} onCancel={() => setGiving(null)} onSend={(_n, to) => { setGiving(null); onGift(c.id, to); }} />
              ) : (
                <div className="bv-tier__acts">
                  <a className="tf-btn is-primary is-sm" href={valuemintCollection(CYBEREATOR)} target="_blank" rel="noopener noreferrer">Trade</a>
                  {unopened && <a className="tf-btn is-secondary is-sm" href={CYBEREATOR_SITE} target="_blank" rel="noopener noreferrer">Reveal</a>}
                  <Button variant="quiet" icon="share" disabled={!canGift} onClick={() => setGiving(c.id)}>Send</Button>
                  <a className="tf-btn is-quiet is-sm" href={c.link} target="_blank" rel="noopener noreferrer">Explorer</a>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}

function Opened({ address, signedIn }: { address: string | null; signedIn: boolean }) {
  const h = usePolled(address && signedIn ? `box-history:${address.toLowerCase()}` : null, () => readHistory(address as string, 50), 60_000);
  const now = useNow(30_000);
  if (!address) return <ConnectPrompt line="Connect a wallet to see what it opened." />;
  if (!signedIn) return <p className="bv-note">Your opens are SoDEX's record: sign in to SoDEX above to see them.</p>;
  if (h.error && !h.data) return <EmptyState icon="warning" title="Your opens could not be read" description={h.error} actions={<Button onClick={h.retry}>Try again</Button>} compact />;
  if (!h.data) return <div className="bv-results">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="bv-result__skel" />)}</div>;
  if (!h.data.length) return <EmptyState icon="clock" title="Nothing opened yet" description="Opened boxes and what they paid show here." compact />;
  const total = h.data.reduce((a, b) => a + (b.rewardUsd ?? 0), 0);
  return (
    <>
      <div className="bv-won"><span>The latest {fmt(h.data.length, 0)} opens paid <b className="bv-num">{usd(total)}</b></span></div>
      <ul className="bv-results is-list">
        {h.data.map((x: HistoryItem, i) => (
          <li key={`${x.tokenId}:${i}`} className={`bv-result${x.pfpTokenId ? ' is-pfp' : ''}`}>
            <BoxArt level={x.level ?? 'Common'} size={36} />
            <span><b className="bv-num">{usd(x.rewardUsd)}</b><small>{x.level ?? DASH} · #{x.tokenId}{x.reward?.amount && x.reward.asset?.symbol ? ` · ${fmtTokens(x.reward.amount)} ${x.reward.asset.symbol}` : ''}</small></span>
            {x.pfpTokenId && <StatusPill tone="brand" size="sm">Cybereator #{x.pfpTokenId}</StatusPill>}
            <span className="bv-result__ago">{x.at ? fmtAgo(x.at, now) : ''}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The PFP drop element's links (owner: "needs a trade button too & a link to the official cybereator.com"). */
export function PfpLinks(): ReactNode {
  return (
    <div className="bv-pfplinks">
      <a className="rf-cta" href={valuemintCollection(CYBEREATOR)} target="_blank" rel="noopener noreferrer">Trade on valuemint</a>
      <a className="rf-howbtn" href={CYBEREATOR_SITE} target="_blank" rel="noopener noreferrer">cybereator.com</a>
    </div>
  );
}

