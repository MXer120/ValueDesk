/**
 * A hedge on its bot page: both legs as the executor last read them (size, equity, how far each liquidation is), the
 * pair's net PnL, and the settings that save in place (size, buffers, limits; runtime BOT_UPDATABLE.hedge).
 */
import { useEffect, useState } from 'react';
import type { AlgoView, HedgeView } from '@copy-engine';
import { DASH, fmtUsd } from '../../format';
import { notify } from '../../toast';
import type { BotsCtx } from './BotsPage';
import { NumberField, Panel, Segmented, Shell, ShellHeader, StatusPill, Button, Icon } from './kit/kit';
import { marginWarning } from '../../bots/hedge';
import { requestDeposit, requestWithdraw } from '../account/actions';
import './hedge.css';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? DASH : `${(x * 100).toFixed(2)}%`);

export function HedgeLegs({ v, me }: { v: AlgoView; me: string | null }) {
  const h: HedgeView | undefined = v.bot?.hedge;
  if (!h) return null;
  const s = v.algo.spec as { minLiqPct?: number; growLiqPct?: number; partner?: string | null };
  const buffer = (s.minLiqPct ?? 0) / 100;
  const warn = h.shape === 'pair' && h.paired ? marginWarning(h.legs, s.minLiqPct ?? 0, s.growLiqPct ?? 0) : null;
  const mine = (a: string) => !!me && a === me.toLowerCase();
  const who = (a: string) => (mine(a) ? 'this wallet' : short(a));
  const copy = (a: string) => { void navigator.clipboard?.writeText(a).then(() => notify('ok', `Copied ${short(a)}.`), () => notify('error', 'Could not copy.')); };
  return (
    <Shell className="bots-sidecard is-plain">
      <ShellHeader icon="layers" title="Legs" subtitle={h.shape === 'pair' ? (h.paired ? 'Both wallets, as last read from SoDEX' : `Waiting for ${s.partner ? short(s.partner) : 'the second wallet'} to start its leg`) : 'The short and the coin that backs it'} />
      <Panel className="bots-sidepanel">
        {warn && (
          <div className={`hg-warn${warn.urgent ? ' is-urgent' : ''}`} role="alert">
            <div className="hg-warn__h"><Icon name="warning" size={14} /><b>{who(warn.low) === 'this wallet' ? 'This wallet' : short(warn.low)} is low on margin</b><StatusPill size="sm" tone={warn.urgent ? 'negative' : 'warning'} dot>{warn.urgent ? 'Shrinking both legs' : 'Holding size back'}</StatusPill></div>
            <p>Move about {fmtUsd(warn.moveUsd, 0)} USDC from {who(warn.rich)} to {who(warn.low)}: withdraw it from SoDEX in {who(warn.rich)}, send it to {short(warn.low)}, and deposit it there. SoDEX cannot move margin between two wallets, so the bot cannot do it for you.</p>
            <div className="hg-warn__act">
              {mine(warn.rich) && <Button variant="primary" size="sm" onClick={() => requestWithdraw({ from: 'perps', coin: 'USDC' })}>Withdraw</Button>}
              {mine(warn.low) && <Button variant="primary" size="sm" onClick={() => requestDeposit()}>Deposit</Button>}
              <Button variant="secondary" size="sm" onClick={() => copy(warn.low)}>Copy {short(warn.low)}</Button>
            </div>
          </div>
        )}
        <div className="hg-legs">
          {h.legs.length === 0 && <p className="bots-fine">Read on its next step.</p>}
          {h.legs.map((l) => {
            const near = l.liqDistance !== null && buffer > 0 && l.liqDistance < buffer * 1.5;
            return (
              <div key={l.owner} className="hg-leg">
                <StatusPill size="sm" tone={l.qty > 0 ? 'positive' : l.qty < 0 ? 'negative' : 'neutral'}>{l.qty > 0 ? 'Long' : l.qty < 0 ? 'Short' : 'Flat'}</StatusPill>
                <span>{me && l.owner === me.toLowerCase() ? 'This wallet' : short(l.owner)}{l.equity !== null ? ` · equity ${fmtUsd(l.equity, 0)}` : ''}</span>
                <b>{fmtUsd(Math.abs(l.usd), 0)}</b>
                <span />
                <span className="hg-leg__d">{h.shape === 'spot' ? `${l.coin ?? 0} coin as margin` : `liquidation ${pct(l.liqDistance)} away`}</span>
                {near ? <StatusPill size="sm" tone="warning" dot>near buffer</StatusPill> : <span />}
              </div>
            );
          })}
        </div>
        <div className="bots-rc__tiles">
          <div className="bots-rc__tile"><span>Pair net PnL</span><b className={h.pairNet > 0.004 ? 'pos' : h.pairNet < -0.004 ? 'neg' : ''}>{fmtUsd(h.pairNet, 2)}</b></div>
          <div className="bots-rc__tile"><span>Pair volume</span><b>{fmtUsd(h.pairVolume, 0)}</b></div>
        </div>
        {h.last && <p className="bots-fine">{h.last}{h.at ? ` · ${new Date(h.at).toLocaleTimeString('en-GB')}` : ''}</p>}
      </Panel>
    </Shell>
  );
}

/** What a running hedge changes in place: size, buffers, step, slippage, limits. Its shape, pair and side never. */
export function HedgeSettings({ v, ctx }: { v: AlgoView; ctx: BotsCtx }) {
  const s = v.algo.spec as unknown as { sizeUsd: number; minLiqPct: number; growLiqPct: number; sliceUsd: number; maxSlipBps: number; maxLossUsd: number | null; takeProfitUsd?: number | null; onStop: 'close' | 'keep'; role: 'main' | 'partner' };
  const pick = () => ({ sizeUsd: s.sizeUsd, minLiqPct: s.minLiqPct, growLiqPct: s.growLiqPct, sliceUsd: s.sliceUsd, maxSlipBps: s.maxSlipBps, maxLossUsd: s.maxLossUsd, takeProfitUsd: s.takeProfitUsd ?? null, onStop: s.onStop });
  const [d, setD] = useState(pick);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setD(pick()), [v.algo.spec]);
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(d) as Array<keyof typeof d>) if (d[k] !== pick()[k]) patch[k] = d[k];
  const n = Object.keys(patch).length;
  const save = async () => {
    setBusy(true);
    try {
      await ctx.update(v.algo.id, patch);
      notify('ok', 'Saved: it goes on with the new settings.');
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const partner = s.role === 'partner';
  return (
    <Shell className="bots-detailcard">
      <ShellHeader icon="gear" title="Settings" subtitle={partner ? 'The main wallet sets the pair. This leg can stop the pair, which closes both legs.' : 'These save in place. A new shape, market or second wallet is a new hedge.'} />
      <Panel className="hg-form">
        <Row title="Size per leg"><NumberField label="Size per leg" value={d.sizeUsd} onChange={(x) => x !== null && setD({ ...d, sizeUsd: x })} unit="USD" disabled={partner} /></Row>
        <Row title="Liquidation buffer"><NumberField label="Liquidation buffer" value={d.minLiqPct} onChange={(x) => x !== null && setD({ ...d, minLiqPct: x })} unit="%" disabled={partner} /></Row>
        <Row title="Grow back at"><NumberField label="Grow back at" value={d.growLiqPct} onChange={(x) => x !== null && setD({ ...d, growLiqPct: x })} unit="%" disabled={partner} /></Row>
        <Row title="Step"><NumberField label="Step" value={d.sliceUsd} onChange={(x) => x !== null && setD({ ...d, sliceUsd: x })} unit="USD" disabled={partner} /></Row>
        <Row title="Max slippage"><NumberField label="Max slippage" value={d.maxSlipBps} onChange={(x) => x !== null && setD({ ...d, maxSlipBps: x })} unit="bp" disabled={partner} /></Row>
        <Row title="Stop if it loses"><NumberField label="Loss" value={d.maxLossUsd} optional onChange={(x) => setD({ ...d, maxLossUsd: x })} unit="USD" disabled={partner} /></Row>
        <Row title="Take profit"><NumberField label="Profit" value={d.takeProfitUsd} optional onChange={(x) => setD({ ...d, takeProfitUsd: x !== null && x > 0 ? x : null })} unit="USD" disabled={partner} /></Row>
        <Row title="On stop"><Segmented label="On stop" value={d.onStop} onChange={(x) => setD({ ...d, onStop: x })} options={[{ value: 'close', label: 'Close both' }, { value: 'keep', label: 'Keep' }]} /></Row>
        <div className="hg-actions">
          <Button variant="primary" size="md" disabled={!n || busy} loading={busy} onClick={() => void save()}>{n ? `Save ${n} change${n === 1 ? '' : 's'}` : 'No changes'}</Button>
          {n > 0 && <Button variant="quiet" size="md" onClick={() => setD(pick())}>Undo</Button>}
        </div>
      </Panel>
    </Shell>
  );
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="hg-row"><div className="hg-row__t"><b>{title}</b></div><div className="hg-row__c">{children}</div></div>;
}
