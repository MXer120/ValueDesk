/**
 * The second wallet of a hedge, connected now (owner 2026-11-14): its leg to sign. The executor keeps every pair that
 * waits for this wallet (GET /algos/invites, owner 2026-11-15: any browser or phone); the main's browser also keeps it
 * (bots/hedge.ts pendingFor) for an executor that does not list them yet.
 *
 * The VALUEDESK code (owner: "If second wallet is created, make sure it uses our code VALUEDESK ... ONLY if we verified
 * that wallet doesnt already have a ref code"): SoDEX's own answer decides. A wallet with no inviter is offered the
 * code with what it gives (ReferralOffer); a NEW wallet (no SoDEX account yet) uses it before its leg starts. A wallet
 * that already has a code, or that SoDEX could not answer for, is never held for it.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { fmtUsd } from '../../format';
import { CoinIcon } from '../CoinIcon';
import { goBots } from '../../bots/routes';
import { PRACTICE_BOTS, refusalOf } from '../../bots/presets';
import { PENDING_EVENT, dropPending, pendingFor, type PendingPair } from '../../bots/hedge';
import { hedgeInvitesOn } from '../../algo/executorAlgos';
import { pollWhileShown } from '../../exchange/visibility';
import { mustTakeCode } from '../../bots/hedgeRules';
import { REFERRAL_CODE, REFERRAL_URL, useReferral } from '../../onboarding/referral';
import { offerReferral } from '../../onboarding/referralRules';
import { notify } from '../../toast';
import { requestDeposit } from '../account/actions';
import type { BotsCtx } from './BotsPage';
import { useHasSodexAccount } from './hedgeData';
import { Button, Icon, Panel, StatusPill } from './kit/kit';
import './hedge.css';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function usePending(wallet: string | null): PendingPair[] {
  const key = useSyncExternalStore(
    (l) => { window.addEventListener(PENDING_EVENT, l); window.addEventListener('storage', l); return () => { window.removeEventListener(PENDING_EVENT, l); window.removeEventListener('storage', l); }; },
    () => JSON.stringify(pendingFor(wallet).map((p) => p.pairId)),
    () => '[]',
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return (JSON.parse(key) as string[]).map((id) => pendingFor(wallet).find((p) => p.pairId === id)!).filter(Boolean);
}

/**
 * How often the executor's invitations are read while the Bots page is shown. Each read is a call of the site's /api
 * function (billed per call: 581 a day at 15 s on 2026-11-17, the cost map); an invite is made in another wallet's tab or
 * app, and the visitor switching over from there is read at once (pollWhileShown), so the interval only covers a
 * page left open and in view.
 */
const INVITES_POLL_MS = 60_000;

/** The executor's invitations for this wallet: on opening, every minute while the page is in view, and on coming back. */
function useServerInvites(wallet: string | null, ready: boolean): PendingPair[] {
  const [list, setList] = useState<PendingPair[]>([]);
  useEffect(() => {
    setList([]);
    if (!wallet || !ready) return;
    let on = true;
    const read = () => void hedgeInvitesOn('hosted').then((xs) => {
      if (on) setList(xs.map((x) => ({ pairId: x.pairId, main: x.main, partner: wallet.toLowerCase(), symbol: x.symbol, spec: x.spec, at: x.at })));
    });
    read();
    const stop = pollWhileShown(INVITES_POLL_MS, read);
    return () => { on = false; stop(); };
  }, [wallet, ready]);
  return list;
}

export function HedgeInvites({ ctx }: { ctx: BotsCtx }) {
  const local = usePending(ctx.address);
  const remote = useServerInvites(ctx.address, ctx.ready);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  // The executor's copy first (it is the one the main leg waits for); one card per pair.
  const seen = new Set<string>();
  const list = [...remote, ...local].filter((p) => !hidden.has(p.pairId) && !seen.has(p.pairId) && (seen.add(p.pairId), true));
  if (!ctx.address || !list.length) return null;
  const hide = (id: string) => { dropPending(id); setHidden((h) => new Set([...h, id])); };
  return <>{list.map((p) => <Invite key={p.pairId} p={p} ctx={ctx} onHide={() => hide(p.pairId)} />)}</>;
}


function Invite({ p, ctx, onHide }: { p: PendingPair; ctx: BotsCtx; onHide: () => void }) {
  const wallet = ctx.address!;
  const ref = useReferral(wallet);
  const hasAccount = useHasSodexAccount(wallet);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paper = p.spec.paper === true;
  const side = p.spec.side === 'buy' ? 'Long' : 'Short';
  const offered = useRef(false);
  // The popup with the benefits, once, for a wallet SoDEX says has no code (referralRules: never for 'other'/'unknown').
  useEffect(() => {
    if (ref !== 'none' || offered.current) return;
    offered.current = true;
    offerReferral(wallet, hasAccount === false
      ? 'This new wallet is the second leg of your hedge. It starts on ValueDesk\'s SoDEX code.'
      : 'The second wallet of your hedge has no SoDEX referral code yet.');
  }, [ref, wallet, hasAccount]);
  const needCode = mustTakeCode(ref, hasAccount);
  const why = ctx.setupWhy(paper);
  const block = paper && !PRACTICE_BOTS ? 'Practice bots are off, so this practice pair cannot start its second leg. Start a new hedge instead.'
    : needCode ? `A new wallet starts on ValueDesk's code: apply ${REFERRAL_CODE} on SoDEX first (then deposit).`
    : !paper && hasAccount === false ? 'This wallet has no SoDEX account yet: deposit first.'
    : why ?? (!ctx.ready ? 'The ValueDesk executor is not ready yet.' : null);
  const start = async () => {
    if (block) return;
    setBusy(true);
    setError(null);
    try {
      const v = await ctx.start(p.spec);
      onHide();
      notify('ok', `Leg 2 started. Both legs now open together. Switch back to ${short(p.main)} any time: either wallet can stop the pair.`);
      goBots({ page: 'bot', id: v.algo.id });
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : null;
      setError(refusalOf(code, e instanceof Error ? e.message : String(e), false).text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel className="hg-invite" role="region" aria-label="Hedge invitation">
      <div className="hg-invite__top">
        <CoinIcon coin={p.symbol} size={32} />
        <span>
          <b>Leg 2 of a hedge on {p.symbol.replace(/-USD$/, '')}</b>
          <small>From {short(p.main)}: this wallet holds the {side.toLowerCase()} side, up to {fmtUsd(Number(p.spec.sizeUsd) || 0, 0)}. {paper ? 'Practice.' : 'Real orders.'}</small>
        </span>
        <span style={{ marginLeft: 'auto' }}><StatusPill size="sm" tone={side === 'Long' ? 'positive' : 'negative'}>{side}</StatusPill></span>
      </div>
      {ref === 'none' && (
        <div className="hg-ref">
          <span className="hg-ref__k">SoDEX referral</span>
          <StatusPill size="sm" tone="warning" dot>No code yet</StatusPill>
          <small>{needCode ? `A new wallet starts on ${REFERRAL_CODE}: it adds 5% to the SoPoints you earn and puts you in ValueDesk's Squad. You confirm on sodex.com with this wallet.` : `You can use ${REFERRAL_CODE}: it adds 5% to the SoPoints you earn and puts you in ValueDesk's Squad.`}</small>
          <a className="bots-link" href={REFERRAL_URL} target="_blank" rel="noopener noreferrer">Apply {REFERRAL_CODE} on SoDEX</a>
          <button type="button" className="bots-link" onClick={() => offerReferral(wallet)}>What it gives</button>
        </div>
      )}
      {(ref === 'bound' || ref === 'pending') && <div className="hg-ref"><span className="hg-ref__k">SoDEX referral</span><StatusPill size="sm" tone="positive" dot>On {REFERRAL_CODE}</StatusPill></div>}
      {error && <p className="bots-err" role="alert">{error}</p>}
      {block && <p className="bots-fine" role="status">{block}</p>}
      <div className="hg-invite__act">
        <Button variant="go" size="md" icon="play" loading={busy} disabled={!!block || busy} onClick={() => void start()}>{paper ? 'Start practice leg 2' : 'Start leg 2'}</Button>
        {why && !needCode && <Button variant="secondary" size="md" onClick={() => ctx.setup(paper)}>Set up this wallet</Button>}
        {!paper && hasAccount === false && !needCode && <Button variant="secondary" size="md" onClick={() => requestDeposit()}>Deposit</Button>}
        <Button variant="quiet" size="md" icon="x" onClick={onHide}>Not now</Button>
      </div>
      <p className="hg-note"><Icon name="shield" size={13} />This wallet signs only its own leg. The pair runs once both legs name each other; stopping either stops and closes both.</p>
    </Panel>
  );
}
