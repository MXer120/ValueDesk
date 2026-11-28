/**
 * Recurring Buy on the Wealth page, the same feature sodex.com has and nothing more (owner 2026-11-27: "exactly what
 * their ui does nothing else"): the eligible assets with their minimum, market clock and SoDEX's historical recurring
 * return; one pre-funded balance shared by every plan (add funds, withdraw); a plan per asset and schedule (every
 * trading day, weekly or every 2 weeks Monday-Friday, monthly on days 1-30); edit, pause, resume, end; each plan's
 * history. The words of the rules and confirmations follow sodex.com's own (its en/wealth.json, read 2026-11-27).
 * Contracts and reads: trading/recurring.ts. Each change is one wallet transaction on ValueChain.
 */
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { NoWallet, EmptyState } from '../EmptyState';
import { ReadFailed } from '../AccountHistory';
import { requestTransfer } from '../account/actions';
import { decimalInput } from '../numberInput';
import { CoinIcon } from '../CoinIcon';
import { Chevron, FxSelect, Spinner, useStepLabel, type FxOption } from '../funds/ui';
import { ViewSeg } from './RangePicker';
import { logLoadFailure } from '../LoadFailed';
import { useAsync } from '../../hooks';
import { DASH, fmt, fmtUsd, num } from '../../format';
import { useMask } from '../../privacy';
import { formatUnits, parseUnits } from '../../trading/onboard';
import { fundLabel, type WealthFund } from '../../trading/wealth';
import {
  MARKET_LABEL, PLAN_LABEL, PLAN_TYPES, WEEKDAYS, addFunds, createPlan, firstRunDate, fundsProblem, planAction, planProblem,
  readDcaReturn, readExecutions, readPrefund, readRecurring, readTargets, scheduleWords, updatePlan, withdrawPrefund,
  type PlanType, type PrefundFacts, type RecurringPlan, type RecurringRead, type RecurringTarget,
} from '../../trading/recurring';
import type { FundsStep } from '../../trading/funds';
import { isUserRejection, type Eip1193Provider } from '../../wallet';
import '../funds/funds.css';
import './recurring.css';

const USDC_DP = 6;
const dayTime = (at: string | undefined): string => {
  if (!at) return DASH;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? DASH : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const dateOnly = (iso: string): string => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const usdUnits = (v: string): bigint => { try { return v ? parseUnits(v, USDC_DP) : 0n; } catch { return 0n; } };
const usd = (u: bigint): string => fmtUsd(Number(formatUnits(u, USDC_DP)));

// --- reads ------------------------------------------------------------------------------------------

let targetsCache: { key: string; at: number; list: RecurringTarget[] } | null = null;

export interface RecurringState {
  active: RecurringRead | null;
  ended: RecurringRead | null;
  targets: RecurringTarget[] | null;
  error: string | null;
  refresh: () => void;
}

/** The wallet's plans (running and paused; ended ones once asked for) and the eligible assets. */
export function useRecurring(address: string | null, refreshToken: number, funds: readonly WealthFund[] | null, wantEnded: boolean): RecurringState {
  const [active, setActive] = useState<RecurringRead | null>(null);
  const [ended, setEnded] = useState<RecurringRead | null>(null);
  const [targets, setTargets] = useState<RecurringTarget[] | null>(targetsCache?.list ?? null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fundKey = funds?.map((f) => f.share.address).join(',') ?? '';

  useEffect(() => {
    if (!funds || !fundKey) return;
    if (targetsCache && targetsCache.key === fundKey && Date.now() - targetsCache.at < 10 * 60_000) { setTargets(targetsCache.list); return; }
    let off = false;
    readTargets(funds)
      .then((list) => { targetsCache = { key: fundKey, at: Date.now(), list }; if (!off) setTargets(list); })
      .catch((e) => { logLoadFailure('Recurring buy assets', e); if (!off) setTargets([]); });
    return () => { off = true; };
  }, [fundKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setActive(null); setEnded(null); setError(null); }, [address]);
  useEffect(() => {
    if (!address) return;
    let off = false;
    readRecurring(address, 'active')
      .then((d) => { if (!off) { setActive(d); setError(null); } })
      .catch((e) => { if (!off) setError((e as Error).message); logLoadFailure('Recurring buys', e); });
    return () => { off = true; };
  }, [address, refreshToken, tick]);
  useEffect(() => {
    if (!address || !wantEnded) return;
    let off = false;
    readRecurring(address, 'history').then((d) => { if (!off) setEnded(d); }).catch((e) => logLoadFailure('Ended recurring buys', e));
    return () => { off = true; };
  }, [address, refreshToken, tick, wantEnded]);

  return { active, ended, targets, error, refresh: () => setTick((t) => t + 1) };
}

// --- the sheet's targets ------------------------------------------------------------------------------

export type RecurringSheetTarget =
  | { kind: 'create'; fundId?: string }
  | { kind: 'edit'; plan: RecurringPlan }
  | { kind: 'funds'; side: 'add' | 'withdraw' }
  | { kind: 'confirm'; plan: RecurringPlan; action: 'pause' | 'resume' | 'cancel' }
  | { kind: 'history'; plan: RecurringPlan };

export const nameOf = (funds: readonly WealthFund[] | null, plan: Pick<RecurringPlan, 'fundId' | 'share' | 'target'>): string => {
  const f = funds?.find((x) => x.fundId === plan.fundId);
  return f ? fundLabel(f).name : plan.share?.coin ?? plan.target;
};
export const STATUS_WORD: Readonly<Record<string, string>> = { ACTIVE: 'Active', PAUSED: 'Paused', CANCELLED: 'Ended' };

// --- the panel (Wealth > Recurring buys) ---------------------------------------------------------------

export function RecurringPanel({ rec, funds, address, onOpen, ended, setEnded }: {
  rec: RecurringState;
  funds: readonly WealthFund[] | null;
  address: string | null;
  onOpen: (t: RecurringSheetTarget) => void;
  ended: boolean;
  setEnded: (v: boolean) => void;
}) {
  const maskFunds = useMask('funds');
  if (!address) return <NoWallet line="Connect your wallet to create and manage Recurring Buy plans." compact />;
  const read = ended ? rec.ended : rec.active;
  const plans = read?.plans ?? null;
  const balance = rec.active?.availableAssets ?? null;
  const canStart = (rec.targets?.length ?? 0) > 0;
  return (
    <div className="rc">
      <div className="rc-head">
        <div className="rc-bal">
          <span>Pre-funded balance</span>
          <b>{balance === null ? (rec.error ? DASH : <Spinner />) : maskFunds(fmtUsd(num(balance)))}</b>
          <small>Shared by all your recurring plans</small>
        </div>
        <div className="rc-acts">
          <ViewSeg value={ended ? 'ended' : 'active'} options={[['active', 'My plans'], ['ended', 'Ended']] as const} onChange={(v) => setEnded(v === 'ended')} label="Plans" />
          <button type="button" className="acct-act" onClick={() => onOpen({ kind: 'funds', side: 'add' })}>Add funds</button>
          <button type="button" className="acct-act" disabled={balance === null || num(balance) <= 0} onClick={() => onOpen({ kind: 'funds', side: 'withdraw' })}>Withdraw</button>
          <button type="button" className="pf-btn" disabled={!canStart} onClick={() => onOpen({ kind: 'create' })}>Start a plan</button>
        </div>
      </div>
      {rec.error && !read ? <ReadFailed what="Recurring buys" error={rec.error} onRetry={rec.refresh} />
        : !plans ? <div className="pfx-bones" aria-busy="true"><span className="pfx-bone" /><span className="pfx-bone" /></div>
        : plans.length === 0 ? (
          ended
            ? <EmptyState icon="history" title="No ended plans yet." compact />
            : <EmptyState icon="history" title="No recurring plans yet" line="Set up a recurring buy to invest automatically on schedule." compact action={canStart ? <button type="button" className="empty-state__cta" onClick={() => onOpen({ kind: 'create' })}>Choose an asset</button> : undefined} />
        ) : (
          <div className="pfx-tablewrap">
            <table className="acct-table acct-t pfx-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Schedule</th>
                  <th className="num">Amount per purchase</th>
                  <th className="num pfx-hide-phone">Bought</th>
                  <th className="num pfx-hide-phone">Avg cost</th>
                  <th className="num pfx-hide-phone">{ended ? 'Started' : 'Next'}</th>
                  <th>Status</th>
                  <th className="acct-actions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => {
                  const f = funds?.find((x) => x.fundId === p.fundId);
                  return (
                    <tr key={`${p.dcaAddress ?? ''}:${p.planIndex}`}>
                      <td><span className="acct-mkt"><CoinIcon coin={p.share?.coin ?? f?.share.coin ?? ''} size={18} /><span className="acct-mkt__n">{nameOf(funds, p)}</span></span></td>
                      <td className="rc-sched">{scheduleWords(p.planType, p.dayOfPeriod)}</td>
                      <td className="num">{maskFunds(fmtUsd(num(p.amount)))}</td>
                      <td className="num pfx-hide-phone">{maskFunds(p.totalBuyAmount ? `${fmtUsd(num(p.totalBuyAmount))} · ${p.successfulExecutionCount}×` : `${p.successfulExecutionCount}×`)}</td>
                      <td className="num pfx-hide-phone">{p.avgCost ? fmtUsd(num(p.avgCost)) : DASH}</td>
                      <td className="num acct-time pfx-hide-phone">{ended ? dayTime(p.createdAt) : p.status === 'PAUSED' ? DASH : dayTime(p.nextScheduledAt)}</td>
                      <td><span className={`pfx-status ${p.status === 'ACTIVE' ? 'pos' : ''}`}><i aria-hidden="true" />{STATUS_WORD[p.status] ?? p.status}</span></td>
                      <td className="acct-actions">
                        <button type="button" className="acct-act" onClick={() => onOpen({ kind: 'history', plan: p })}>History</button>
                        {p.status !== 'CANCELLED' && (
                          <>
                            <button type="button" className="acct-act" onClick={() => onOpen({ kind: 'edit', plan: p })}>Edit</button>
                            <button type="button" className="acct-act" onClick={() => onOpen({ kind: 'confirm', plan: p, action: p.status === 'PAUSED' ? 'resume' : 'pause' })}>{p.status === 'PAUSED' ? 'Resume' : 'Pause'}</button>
                            <button type="button" className="acct-act" onClick={() => onOpen({ kind: 'confirm', plan: p, action: 'cancel' })}>End</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// --- the sheet ---------------------------------------------------------------------------------------

const TITLE = (t: RecurringSheetTarget, funds: readonly WealthFund[] | null): string => {
  switch (t.kind) {
    case 'create': return 'Recurring Buy';
    case 'edit': return `Edit ${nameOf(funds, t.plan)} plan`;
    case 'funds': return t.side === 'add' ? 'Add funds' : 'Withdraw';
    case 'confirm': return t.action === 'pause' ? 'Pause this plan?' : t.action === 'resume' ? 'Resume this plan?' : 'End this plan?';
    case 'history': return `${nameOf(funds, t.plan)} plan`;
  }
};

export function RecurringSheet({ target, onClose, rec, funds, address, provider, onDone }: {
  target: RecurringSheetTarget | null;
  onClose: () => void;
  rec: RecurringState;
  funds: readonly WealthFund[] | null;
  address: string | null;
  provider: Eip1193Provider | null;
  onDone: () => void;
}) {
  const done = () => { rec.refresh(); onDone(); };
  return (
    <Modal open={!!target} title={target ? TITLE(target, funds) : ''} onClose={onClose} size="sm" className="fx fx-money rc-sheet">
      {!address ? <NoWallet line="Connect your wallet to create and manage Recurring Buy plans." compact />
        : !target ? null
        : target.kind === 'history' ? <History plan={target.plan} address={address} />
        : target.kind === 'confirm' ? <Confirm key={`${target.plan.planIndex}:${target.action}`} plan={target.plan} action={target.action} address={address} provider={provider} onDone={done} onClose={onClose} />
        : target.kind === 'funds' ? <Funds key={target.side} side={target.side} address={address} provider={provider} onDone={done} onClose={onClose} />
        : <PlanForm key={target.kind === 'edit' ? `e${target.plan.planIndex}` : `c${target.fundId ?? ''}`} target={target} rec={rec} funds={funds} address={address} provider={provider} onDone={done} onClose={onClose} />}
    </Modal>
  );
}

function useSend() {
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<FundsStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = useStepLabel();
  const run = async (f: (onStep: (s: FundsStep) => void) => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try { await f(setStep); return true; } catch (e) { if (!isUserRejection(e)) setError((e as Error).message); return false; } finally { setBusy(false); setStep(null); }
  };
  return { busy, step, error, label, run };
}

const Rules = () => {
  const [open, setOpen] = useState(false);
  return (
    <div className={`fx-info${open ? ' is-open' : ''}`}>
      <button type="button" className="fx-info__sum" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>Recurring Buy rules</span>
        <Chevron />
      </button>
      {open && (
        <div className="fx-info__body rc-rules">
          <p><b>When it buys.</b> SoDEX buys from midnight to 09:30 in the asset’s market time. Non-trading days are skipped, without postponing or making up the purchase. If the selected monthly date does not exist, that month is skipped.</p>
          <p><b>If a purchase fails.</b> If the pre-funded balance is too low, or the asset is suspended or no longer supports Recurring Buy, that purchase fails and is not made up later. Later cycles stay scheduled while the plan is active.</p>
          <p><b>Pre-funded balance.</b> Active plans share the balance. Three months of funding, including the new plan, is recommended. Unused funds can be withdrawn.</p>
          <p><b>Fees and price.</b> US assets have no separate handling fee; the subscription quote may include hedging costs. China assets follow the asset’s spot purchase fee rules. Check each purchase in the plan’s history.</p>
          <p><b>Managing a plan.</b> Edit the amount and frequency, or pause and resume it; changes apply to future purchases. Ending a plan stops future purchases without selling your holdings.</p>
        </div>
      )}
    </div>
  );
};

/**
 * sodex.com's plan summary, one whole sentence per frequency so each translates as one (the language layer looks
 * a sentence's values up as they are: a weekday or a day number does, "every Monday" inside a sentence would not).
 */
function summaryText(type: PlanType, day: number, date: string, amount: string, name: string): string {
  const weekday = WEEKDAYS[day - 1] ?? '';
  switch (type) {
    case 'DAILY': return `Schedule: every trading day, starting ${date}. The system deducts ${amount} USDC from your pre-funded balance and subscribes you to ${name}, until you end the plan. Every step happens automatically, so no action is needed each cycle.`;
    case 'WEEKLY': return `Schedule: every ${weekday}, starting ${date}. The system deducts ${amount} USDC from your pre-funded balance and subscribes you to ${name}, until you end the plan. Every step happens automatically, so no action is needed each cycle.`;
    case 'BI_WEEKLY': return `Schedule: every second ${weekday}, starting ${date}. The system deducts ${amount} USDC from your pre-funded balance and subscribes you to ${name}, until you end the plan. Every step happens automatically, so no action is needed each cycle.`;
    case 'MONTHLY': return `Schedule: on day ${day} of every month, starting ${date}. The system deducts ${amount} USDC from your pre-funded balance and subscribes you to ${name}, until you end the plan. Every step happens automatically, so no action is needed each cycle.`;
  }
}

/** Purchases in three months on a schedule (sodex.com's funding advice): about 63 trading days, 13 weeks, 6 fortnights, 3 months. */
const PER_QUARTER: Readonly<Record<PlanType, number>> = { DAILY: 63, WEEKLY: 13, BI_WEEKLY: 7, MONTHLY: 3 };

function PlanForm({ target, rec, funds, address, provider, onDone, onClose }: {
  target: Extract<RecurringSheetTarget, { kind: 'create' | 'edit' }>;
  rec: RecurringState;
  funds: readonly WealthFund[] | null;
  address: string;
  provider: Eip1193Provider | null;
  onDone: () => void;
  onClose: () => void;
}) {
  const editing = target.kind === 'edit' ? target.plan : null;
  const targets = rec.targets ?? [];
  const [picked, setFundId] = useState<string>(editing?.fundId ?? (target.kind === 'create' ? target.fundId : undefined) ?? '');
  // Opened before the allowlist arrived (a link straight to the sheet): the first eligible asset once it is there.
  const fundId = picked || targets[0]?.fund.fundId || '';
  const t = targets.find((x) => x.fund.fundId === fundId) ?? (editing ? targets.find((x) => x.vault.toLowerCase() === editing.target.toLowerCase()) : undefined) ?? null;
  const [amount, setAmount] = useState(editing ? String(num(editing.amount)) : '');
  const [type, setType] = useState<PlanType>(editing?.planType ?? 'WEEKLY');
  const [day, setDay] = useState<number>(editing?.dayOfPeriod ?? 1);
  const [pf, setPf] = useState<PrefundFacts | null>(null);
  const [fund, setFund] = useState('');
  const [sent, setSent] = useState(false);
  const s = useSend();
  const returns = useAsync(() => Promise.all(targets.map((x) => readDcaReturn(x.fund.fundId).then((r) => [x.fund.fundId, r.returnRate] as const).catch(() => [x.fund.fundId, null] as const))).then((rows) => new Map(rows)), [targets.length], { enabled: !editing && targets.length > 0 });

  useEffect(() => { let off = false; readPrefund(address).then((f) => { if (!off) setPf(f); }).catch(() => undefined); return () => { off = true; }; }, [address]);

  // A day that fits the frequency: none for daily, Monday for the weekly kinds, the 1st for monthly.
  const pickType = (v: PlanType) => { setType(v); setDay(v === 'DAILY' ? 0 : v === 'MONTHLY' ? (day >= 1 && day <= 30 ? day : 1) : day >= 1 && day <= 5 ? day : 1); };
  const units = usdUnits(amount);
  const problem = t ? (amount ? planProblem(t, units, type, day) : null) : 'This asset does not take recurring buys right now.';
  const available = pf?.available ?? null;
  const short = available !== null && units > available ? units - available : 0n;
  const addUnits = usdUnits(fund);
  const quarter = units * BigInt(PER_QUARTER[type]);
  const fundProblem = pf && fund ? fundsProblem('add', addUnits, pf) : null;
  const covered = available !== null && units > 0n && available + addUnits >= units;
  const start = t ? firstRunDate(type, day, t.market) : null;

  useEffect(() => { if (!editing && short > 0n && !fund) setFund(formatUnits(short, USDC_DP)); }, [short]); // eslint-disable-line react-hooks/exhaustive-deps

  const assetOptions: FxOption[] = targets.map((x) => {
    const r = returns.data?.get(x.fund.fundId);
    return {
      value: x.fund.fundId,
      label: fundLabel(x.fund).name,
      icon: x.fund.share.coin,
      hint: `${x.market === 0 ? 'CN' : 'US'} · min ${usd(x.minAmount)}${r !== undefined && r !== null ? ` · 1y ${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%` : ''}`,
    };
  });
  const dayOptions: FxOption[] = type === 'MONTHLY'
    ? Array.from({ length: 30 }, (_, i) => ({ value: String(i + 1), label: `Day ${i + 1}` }))
    : WEEKDAYS.map((w, i) => ({ value: String(i + 1), label: w }));

  const submit = async () => {
    if (!provider || !t) return;
    const ok = await s.run(async (onStep) => {
      if (!editing && addUnits > 0n) await addFunds({ provider, owner: address, amount: addUnits, onStep });
      if (editing) await updatePlan({ provider, owner: address, plan: editing, target: t, amount: units, type, day, onStep });
      else await createPlan({ provider, owner: address, target: t, amount: units, type, day, onStep });
    });
    if (ok) { setSent(true); onDone(); }
  };

  if (sent) {
    return (
      <div className="fx-stack">
        <p className="fx-note fx-note--ok">{editing ? 'Plan updated. Changes apply to future purchases.' : `Recurring plan created: ${usd(units)} per purchase into ${t ? fundLabel(t.fund).name : 'the asset'}.`}</p>
        <button type="button" className="fx-cta" onClick={onClose}>Done</button>
      </div>
    );
  }
  if (!rec.targets) return <div className="fx-stack"><p className="fx-note"><Spinner /> Reading the eligible assets</p></div>;
  if (!targets.length) return <div className="fx-stack"><p className="fx-note">No eligible assets are available for Recurring Buy yet.</p></div>;

  return (
    <div className="fx-stack">
      {editing ? (
        <div className="rc-asset"><CoinIcon coin={editing.share?.coin ?? ''} size={20} /><b>{nameOf(funds, editing)}</b>{t && <small>{MARKET_LABEL[t.market]}</small>}</div>
      ) : (
        <div className="rc-field">
          <span className="rc-field__k">Asset</span>
          <FxSelect value={fundId} options={assetOptions} onChange={setFundId} label="Asset" loading={!assetOptions.length} listMinWidth={320} />
          {t && <small className="rc-field__sub">{`${MARKET_LABEL[t.market]} · minimum per purchase ${usd(t.minAmount)}`}</small>}
          <small className="rc-field__sub">1y: SoDEX’s historical Recurring Buy return (a weekly buy over one year), not a forecast.</small>
        </div>
      )}

      <div className="fx-box">
        <div className="fx-box__head"><span>Amount per purchase</span>{t && <span className="fx-max">Minimum {usd(t.minAmount)}</span>}</div>
        <div className="fx-amount">
          <input value={amount} onChange={(e) => setAmount(decimalInput(e.target.value, { prev: amount }))} inputMode="decimal" placeholder="0.00" aria-label="Amount per purchase" />
          <span className="fx-amount__unit pfx-unit"><CoinIcon coin="USDC" size={16} /> USDC</span>
        </div>
      </div>

      <div className="rc-field">
        <span className="rc-field__k">Frequency</span>
        <ViewSeg value={type} options={PLAN_TYPES.map((p) => [p, PLAN_LABEL[p]] as const)} onChange={pickType} label="Frequency" />
      </div>
      {type !== 'DAILY' && (
        <div className="rc-field">
          <span className="rc-field__k">{type === 'MONTHLY' ? 'Day of the month' : 'Day'}</span>
          <FxSelect value={String(day)} options={dayOptions} onChange={(v) => setDay(Number(v))} label={type === 'MONTHLY' ? 'Day of the month' : 'Weekday'} searchable={false} />
        </div>
      )}

      <div className="fx-kv">
        <div><span>Schedule</span><b>{scheduleWords(type, day)}</b></div>
        {!editing && start && <div><span>Starting</span><b>{dateOnly(start)}</b></div>}
        <div><span>Pre-funded balance</span><b>{available === null ? <Spinner /> : usd(available)}</b></div>
        {units > 0n && <div><span>Three months of purchases</span><b>{usd(quarter)}</b></div>}
      </div>

      {!editing && (
        <div className="fx-box">
          <div className="fx-box__head">
            <span>Add to the balance now</span>
            <span className="fx-max">{pf ? `EVM wallet balance: ${usd(pf.walletUsdc)}` : <Spinner />}</span>
          </div>
          <div className="fx-amount">
            <input value={fund} onChange={(e) => setFund(decimalInput(e.target.value, { prev: fund }))} inputMode="decimal" placeholder="0.00" aria-label="Add to the balance" />
            <span className="fx-amount__unit pfx-unit"><CoinIcon coin="USDC" size={16} /> USDC</span>
            {units > 0n && <button type="button" className="fx-chip" onClick={() => setFund(formatUnits(quarter > (available ?? 0n) ? quarter - (available ?? 0n) : 0n, USDC_DP))}>3 months</button>}
          </div>
        </div>
      )}

      {!editing && units > 0n && !covered && <p className="fx-note fx-note--warn">The first purchase is not covered. Add funds before creating the plan.</p>}
      {!editing && t && units > 0n && start && (
        <p className="fx-note">{summaryText(type, day, dateOnly(start), usd(units), fundLabel(t.fund).name)}</p>
      )}

      {!provider ? <p className="fx-note">Reconnect your wallet: Recurring Buy is set up from your wallet on ValueChain.</p> : (
        <button type="button" className="fx-cta" disabled={s.busy || !t || !units || !!problem || !!fundProblem || (!editing && !covered)} onClick={() => void submit()}>
          {s.busy ? (s.step ? s.label(s.step) : <Spinner label="Sending" />) : editing ? 'Save changes' : addUnits > 0n ? 'Add funds and create plan' : 'Create plan'}
        </button>
      )}
      {(problem || fundProblem) && <p className="fx-note fx-note--err">{problem ?? fundProblem}</p>}
      {s.error && <p className="fx-note fx-note--err" role="alert">{s.error}</p>}
      {!editing && addUnits > 0n && <p className="fx-note">Funding and creating a plan are separate confirmations in your wallet. <button type="button" className="fx-link" onClick={() => requestTransfer({ to: 'evm', coin: 'USDC' })}>Move USDC to your wallet</button>.</p>}
      <Rules />
    </div>
  );
}

function Funds({ side, address, provider, onDone, onClose }: { side: 'add' | 'withdraw'; address: string; provider: Eip1193Provider | null; onDone: () => void; onClose: () => void }) {
  const [pf, setPf] = useState<PrefundFacts | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [sent, setSent] = useState(false);
  const s = useSend();
  useEffect(() => { let off = false; readPrefund(address).then((f) => { if (!off) setPf(f); }).catch((e) => { if (!off) setReadError((e as Error).message); }); return () => { off = true; }; }, [address]);
  const units = usdUnits(amount);
  const max = pf ? (side === 'add' ? pf.walletUsdc : pf.available) : null;
  const problem = pf && amount ? fundsProblem(side, units, pf) : null;
  const go = async () => {
    if (!provider) return;
    const ok = await s.run((onStep) => (side === 'add' ? addFunds({ provider, owner: address, amount: units, onStep }) : withdrawPrefund({ provider, owner: address, amount: units, onStep })));
    if (ok) { setSent(true); onDone(); }
  };
  if (sent) {
    return (
      <div className="fx-stack">
        <p className="fx-note fx-note--ok">Funds updated. The transaction is confirmed. {side === 'add' ? 'Funding does not create a plan.' : 'The USDC is back in your wallet on ValueChain.'}</p>
        <button type="button" className="fx-cta" onClick={onClose}>Done</button>
      </div>
    );
  }
  return (
    <div className="fx-stack">
      <div className="fx-kv">
        <div><span>Pre-funded balance</span><b>{pf ? usd(pf.available) : <Spinner />}</b></div>
        <div><span>EVM wallet balance</span><b>{pf ? usd(pf.walletUsdc) : <Spinner />}</b></div>
      </div>
      <div className="fx-box">
        <div className="fx-box__head"><span>Amount</span></div>
        <div className="fx-amount">
          <input value={amount} onChange={(e) => setAmount(decimalInput(e.target.value, { prev: amount }))} inputMode="decimal" placeholder="0.00" aria-label="Amount" />
          <span className="fx-amount__unit pfx-unit"><CoinIcon coin="USDC" size={16} /> USDC</span>
          <button type="button" className="fx-chip" disabled={!max} onClick={() => setAmount(formatUnits(max ?? 0n, USDC_DP))}>Max</button>
        </div>
      </div>
      {!provider ? <p className="fx-note">Reconnect your wallet: this is a wallet transaction on ValueChain.</p> : (
        <button type="button" className="fx-cta" disabled={s.busy || !units || !!problem || !pf} onClick={() => void go()}>
          {s.busy ? (s.step ? s.label(s.step) : <Spinner label="Sending" />) : side === 'add' ? 'Add funds' : 'Withdraw'}
        </button>
      )}
      {problem && <p className="fx-note fx-note--err">{problem}</p>}
      {(s.error ?? readError) && <p className="fx-note fx-note--err" role="alert">{s.error ?? readError}</p>}
      <p className="fx-note">
        {side === 'add'
          ? <>Move USDC from your EVM wallet into the shared recurring balance. <button type="button" className="fx-link" onClick={() => requestTransfer({ to: 'evm', coin: 'USDC' })}>Move USDC to your wallet</button>.</>
          : 'Withdraw unused USDC to your EVM wallet. This reduces the funds available to every active plan. Purchases already in progress are separate.'}
      </p>
    </div>
  );
}

function Confirm({ plan, action, address, provider, onDone, onClose }: {
  plan: RecurringPlan; action: 'pause' | 'resume' | 'cancel'; address: string; provider: Eip1193Provider | null; onDone: () => void; onClose: () => void;
}) {
  const s = useSend();
  const [sent, setSent] = useState(false);
  const go = async () => {
    if (!provider) return;
    if (await s.run((onStep) => planAction({ provider, owner: address, plan, action, onStep }))) { setSent(true); onDone(); }
  };
  if (sent) {
    return (
      <div className="fx-stack">
        <p className="fx-note fx-note--ok">{action === 'pause' ? 'Plan paused' : action === 'resume' ? 'Plan resumed' : 'Plan ended'}.</p>
        <button type="button" className="fx-cta" onClick={onClose}>Done</button>
      </div>
    );
  }
  return (
    <div className="fx-stack">
      <p className="rc-confirm">
        {action === 'pause' ? 'Pause future purchases. You can resume this plan at any time.'
          : action === 'resume' ? 'Purchases start again on the plan’s schedule. You can pause it again at any time.'
          : 'Ending this plan stops future purchases permanently. Completed purchases are unaffected.'}
      </p>
      {!provider ? <p className="fx-note">Reconnect your wallet: this is a wallet transaction on ValueChain.</p> : (
        <div className="rc-confirm__acts">
          <button type="button" className="fx-cta fx-cta--ghost" onClick={onClose}>Keep plan</button>
          <button type="button" className={`fx-cta${action === 'cancel' ? ' fx-cta--danger' : ''}`} disabled={s.busy} onClick={() => void go()}>
            {s.busy ? (s.step ? s.label(s.step) : <Spinner label="Sending" />) : action === 'pause' ? 'Pause plan' : action === 'resume' ? 'Resume plan' : 'End plan'}
          </button>
        </div>
      )}
      {s.error && <p className="fx-note fx-note--err" role="alert">{s.error}</p>}
    </div>
  );
}

const EXEC_WORD: Readonly<Record<string, string>> = { completed: 'Completed', skipped: 'Skipped', failed: 'Failed', scheduled: 'Scheduled', processing: 'Processing', pending: 'Pending' };

function History({ plan, address }: { plan: RecurringPlan; address: string }) {
  const rows = useAsync(() => readExecutions(address, plan), [address, plan.planIndex, plan.dcaAddress]);
  const maskFunds = useMask('funds');
  const dp = plan.share?.decimals ?? 18;
  const list = useMemo(() => rows.data ?? [], [rows.data]);
  return (
    <div className="fx-stack">
      <div className="fx-kv">
        <div><span>Schedule</span><b>{scheduleWords(plan.planType, plan.dayOfPeriod)}</b></div>
        <div><span>Amount per purchase</span><b>{maskFunds(fmtUsd(num(plan.amount)))}</b></div>
        <div><span>Bought so far</span><b>{maskFunds(plan.totalBuyAmount ? fmtUsd(num(plan.totalBuyAmount)) : DASH)}</b></div>
        {plan.totalBuyShares && <div><span>Shares</span><b>{maskFunds(fmt(num(plan.totalBuyShares), 4))} {plan.share?.coin ?? ''}</b></div>}
      </div>
      {rows.error && !rows.data ? <ReadFailed what="Plan history" error={rows.error} onRetry={rows.refresh} />
        : !rows.data ? <p className="fx-note"><Spinner /> Reading</p>
        : list.length === 0 ? <p className="fx-note">No purchases yet.</p>
        : (
          <ul className="rc-exec">
            {list.map((e) => (
              <li key={`${e.scheduledLocalDate}:${e.txHash ?? ''}`}>
                <span className="rc-exec__d">{e.scheduledLocalDate}</span>
                <span className={`pfx-status ${e.status === 'completed' ? 'pos' : e.status === 'failed' ? 'neg' : ''}`}><i aria-hidden="true" />{EXEC_WORD[e.status] ?? e.status}</span>
                <span className="rc-exec__a">{maskFunds(fmtUsd(num(e.amount)))}{e.finalSharesRaw ? <small> · {fmt(Number(formatUnits(BigInt(e.finalSharesRaw), dp)), 4)} {plan.share?.coin ?? ''}</small> : null}</span>
                {e.txHash ? <a className="acct-act" href={`https://main-scan.valuechain.xyz/tx/${e.txHash}`} target="_blank" rel="noopener noreferrer">Tx</a> : <span />}
                {e.message && e.status !== 'completed' && <small className="rc-exec__why">{e.message}</small>}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
