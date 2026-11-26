/**
 * Wealth, version "Shelves" (localhost switch): SoDEX Wealth as a shop window, on the Referrals stage's look. The
 * stage leads with the yield funds' live APYs and the wallet's own totals; under it every fund is a card on its shelf
 * with 30 days of real closes, and a card opens the whole fund in a sheet. The wallet's holdings and history follow.
 */
import { useMemo, useState } from 'react';
import { openConnectDialog } from '../../account/connect';
import { Button, Panel, Shell, StatusPill, Tabs } from '../../bots/kit/kit';
import { DASH, fmtUsd } from '../../../format';
import { useMask } from '../../../privacy';
import type { FundShelf } from '../../../trading/wealth';
import { SodexMark } from '../../funds/ui';
import { SODEX_SITE } from '../../../sodexProgrammes';
import { useNow } from '../parts';
import { SHELVES, dayTime, pctText, useFundViews, val, type FundView } from './data';
import { Activity, ApyBars, ChannelPill, FundAct, FundMark, FundSheet, MaintNote, Signed, WideSpark, pledgedValue, signedUsd, type VersionProps, type WealthCtx } from './parts';

function FundCard({ v, ctx, now, onOpen }: { v: FundView; ctx: WealthCtx; now: number; onOpen: () => void }) {
  const maskFunds = useMask('funds');
  const price = val(v.quote?.price);
  const d24 = val(v.quote?.roi24h);
  const roi = v.head.kind === 'roi';
  return (
    <article className="wv-card">
      <button type="button" className="wv-card__open" onClick={onOpen} aria-label={`${v.name}, open the fund`} />
      <header className="wv-card__h">
        <FundMark v={v} size={38} />
        <span className="wv-card__n"><b>{v.name}</b><small>{v.ticker}</small></span>
        {v.holding && <StatusPill tone="positive" size="sm" icon="check" className="wv-card__held">{maskFunds(v.holding.marketValue !== null ? fmtUsd(v.holding.marketValue) : 'Yours')}</StatusPill>}
      </header>
      <div className="wv-card__mid">
        <div className="wv-card__fig">
          <Signed v={roi ? v.head.value : null}><b>{pctText(v.head.value, roi)}</b></Signed>
          <small>{v.head.label}</small>
        </div>
        <span className="wv-card__act"><FundAct v={v} ctx={ctx} /></span>
      </div>
      <div className="wv-card__viz">{v.fund.fundType === 'bridged_vault' ? <ApyBars q={v.quote} /> : <WideSpark v={v} />}</div>
      <footer className="wv-card__f">
        <span className="wv-card__px">
          {price !== null ? fmtUsd(price) : DASH}
          {d24 !== null && <Signed v={d24}>{pctText(d24)}</Signed>}
        </span>
        <ChannelPill v={v} now={now} />
      </footer>
    </article>
  );
}

/** The yield funds' rates, on the stage. */
function RateBoard({ earn, ctx, onOpen }: { earn: FundView[] | null; ctx: WealthCtx; onOpen: (id: string) => void }) {
  return (
    <div className="wv-rates" aria-label="Stable Earn rates">
      <p className="wv-rates__k">Stable Earn · live rates</p>
      {(earn ?? [null, null]).map((v, i) => (v ? (
        <div key={v.id} className="wv-rate">
          <button type="button" className="wv-rate__open" onClick={() => onOpen(v.id)} aria-label={`${v.name}, open the fund`} />
          <FundMark v={v} size={40} />
          <span className="wv-rate__n"><b>{v.name}</b><small>{v.head.label}{v.quote?.yieldBasis === 'net_excluding_rewards' ? ', net' : ''}</small></span>
          <b className="wv-rate__v">{pctText(v.head.value, false)}</b>
          <span className="wv-rate__a"><FundAct v={v} ctx={ctx} variant="primary" /></span>
        </div>
      ) : <div key={i} className="wv-rate is-skel" aria-hidden="true" />))}
    </div>
  );
}

export function Shelves({ w, value, slp, ctx, maint }: VersionProps) {
  const views = useFundViews(w);
  const now = useNow(15_000);
  const maskEquity = useMask('equity');
  const maskPnl = useMask('pnl');
  const maskFunds = useMask('funds');
  const [shelf, setShelf] = useState<'All' | FundShelf>('All');
  const [open, setOpen] = useState<string | null>(null);
  const openView = views?.find((v) => v.id === open) ?? null;
  const earn = useMemo(() => views?.filter((v) => v.isYield) ?? null, [views]);
  const groups = useMemo(() => SHELVES.map((s) => ({ shelf: s, funds: (views ?? []).filter((v) => v.shelf === s) })).filter((g) => g.funds.length > 0), [views]);
  const shown = shelf === 'All' ? groups : groups.filter((g) => g.shelf === shelf);
  const p = w.pnl;
  const asOf = views?.map((v) => v.quote?.asOf).filter((x): x is string => !!x).sort().at(-1);
  const pnl = val(p?.totalPnl);
  const d24 = val(p?.totalPnl24h);
  const inFlight = val(p?.inFlightValue);
  const pledged = pledgedValue(w.holdings);

  return (
    <div className="wv-col">
      <section className="wv-stage">
        <span className="wv-stage__light" aria-hidden="true" /><span className="wv-stage__ribs" aria-hidden="true" />
        <header className="wv-stage__k">
          <SodexMark size={22} />
          <h1>Wealth</h1>
          {maint?.state === 'maintenance' && <StatusPill tone="warning" size="sm" dot>Maintenance</StatusPill>}
          <a className="wv-ghost" href={SODEX_SITE.wealth} target="_blank" rel="noopener noreferrer">SoDEX Wealth<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 11 11 5M6.5 5H11v4.5" /></svg></a>
        </header>
        <div className="wv-stage__body">
          <div className="wv-stage__t">
            <h2>Yield on dollars.<br />Index funds on-chain.</h2>
            <p>Tokenised funds, vaults and on-chain yield from SoDEX.</p>
            {views && <p className="wv-stage__meta"><b>{views.length}</b> funds on {groups.length} shelves{asOf ? ` · prices as of ${dayTime(asOf)}` : ''}</p>}
          </div>
          <RateBoard earn={earn} ctx={ctx} onOpen={setOpen} />
        </div>
        <div className="wv-stage__bar">
          {ctx.address ? (
            <>
              <div><span>Your Wealth</span><b>{maskEquity(value === null ? DASH : fmtUsd(value))}</b></div>
              {pledged > 0 && <div title="Fund shares pledged as Perps margin count under Perps in your Portfolio, each dollar once."><span>Pledged as Perps margin</span><b>{maskFunds(fmtUsd(pledged))}</b></div>}
              <div><span>Total PnL</span><b><Signed v={pnl}>{maskPnl(pnl === null ? DASH : signedUsd(pnl))}</Signed></b></div>
              <div><span>24h change</span><b><Signed v={d24}>{maskPnl(d24 === null ? DASH : signedUsd(d24))}</Signed></b></div>
              <div><span>On its way</span><b>{maskFunds(inFlight ? fmtUsd(inFlight) : DASH)}</b></div>
              {slp !== null && <div title="MAG7.ssi or sMAG7.ssi in the liquidity vault: SoDEX's account-value series minus what it is known to hold."><span>SLP vault, inferred</span><b>{maskPnl(fmtUsd(slp))}</b></div>}
            </>
          ) : (
            <div className="wv-stage__connect">
              <span>Connect a wallet to see your Wealth value, PnL and holdings here.</span>
              <Button variant="primary" onClick={() => openConnectDialog()}>Connect wallet</Button>
            </div>
          )}
        </div>
      </section>
      {p?.complete === false && <p className="wv-note">SoDEX could not price every fund, so the figures leave those out.</p>}
      {maint?.state === 'maintenance' && <MaintNote message={maint.message} />}

      <div className="wv-shelfbar">
        <Tabs
          label="Shelf"
          value={shelf}
          onChange={setShelf}
          tabs={[{ value: 'All', label: 'All', count: views?.length }, ...groups.map((g) => ({ value: g.shelf, label: g.shelf, count: g.funds.length }))]}
        />
      </div>

      {!views ? (
        <div className="wv-grid" aria-busy="true">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="wv-card is-skel" />)}</div>
      ) : shown.map((g) => (
        <section key={g.shelf} className="wv-shelf" aria-label={g.shelf}>
          {shelf === 'All' && <h2 className="wv-shelf__h">{g.shelf}<span>{g.funds.length}</span></h2>}
          <div className="wv-grid">{g.funds.map((v) => <FundCard key={v.id} v={v} ctx={ctx} now={now} onOpen={() => setOpen(v.id)} />)}</div>
        </section>
      ))}

      {/* Without a wallet the stage already asks for one; no second empty panel. */}
      {ctx.address && (
        <Shell className="wv-actshell wv-yours">
          <Panel className="wv-actshell__p"><Activity w={w} views={views} ctx={ctx} title={<h2 className="wv-h2">Yours</h2>} /></Panel>
        </Shell>
      )}
      <FundSheet v={openView} onClose={() => setOpen(null)} ctx={ctx} now={now} />
    </div>
  );
}
