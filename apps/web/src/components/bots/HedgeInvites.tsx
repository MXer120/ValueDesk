/**
 * The second wallet of a hedge, connected now (owner 2026-11-14): its leg to sign, kept in this browser by the main's
 * New hedge page (bots/hedge.ts pendingFor).
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

export function HedgeInvites({ ctx }: { ctx: BotsCtx }) {
  const list = usePending(ctx.address);
  if (!ctx.address || !list.length) return null;
  return <>{list.map((p) => <Invite key={p.pairId} p={p} ctx={ctx} />)}</>;
}


function Invite({ p, ctx }: { p: PendingPair; ctx: BotsCtx }) {
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
      dropPending(p.pairId);
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
        <Button variant="quiet" size="md" icon="x" onClick={() => dropPending(p.pairId)}>Not this wallet</Button>
      </div>
      <p className="hg-note"><Icon name="shield" size={13} />This wallet signs only its own leg. The pair runs once both legs name each other; stopping either stops and closes both.</p>
    </Panel>
  );
}
