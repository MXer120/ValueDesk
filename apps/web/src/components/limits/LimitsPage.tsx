/**
 * Trading limits & conditions (More > Trading limits, /limits; owner 2026-11-05): SoDEX's rules for
 * every market, read straight from its own feeds while the page is on screen.
 *
 * WHAT IS ON HERE IS WHAT SODEX PUBLISHES, AS IT PUBLISHES IT (model.ts). Nothing is worked out or
 * filled in. A maximum SoDEX leaves at "0" reads "None listed". A rule only SoDEX's documentation
 * states, with no feed behind it, stands in a block marked "SoDEX docs, not live" (DocsNote) with
 * the date it was read. When a read fails the page keeps what it has and says it stopped updating,
 * so an old figure never passes for a live one.
 *
 * Laid out as the excluded wallets page is (excluded.css: one card, toned hero, four figures), with
 * the app's own switch, search and market dropdown (lbp-seg, lbp-search, FxSelect). On a phone each
 * table row becomes a small card of label + value.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { gwGet } from '../../exchange/sodexGateway';
import { fmtDecimalString } from '../../numStyle';
import { CoinIcon } from '../CoinIcon';
import { usePolled, type Read } from '../explore/cohorts/parts';
import { FxSelect, type FxOption } from '../funds/ui';
import { bandOf, bracketsOf, capOf, coinName, collateralOf, intervalOf, isTrading, matches, ordered, pctOf, placeSearch, readPlace, shortPrice, topLeverage, type LimitCoin, type LimitSymbol, type LimitsTab } from './model';
import '../excluded/excluded.css';
import './limits.css';

/** Market rules change rarely and the list is SoDEX's largest public read; prices move. */
const SYMBOLS_MS = 30_000;
const COINS_MS = 15_000;
/** When SoDEX's documentation was last read for the marked blocks below. */
const DOCS_READ = '2026-11-05';
const DOCS = 'https://docs.sodex.com';

const TABS: ReadonlyArray<readonly [LimitsTab, string]> = [['leverage', 'Leverage & margin'], ['rules', 'Trading rules'], ['collateral', 'Collateral']];

interface Stamped<T> { rows: T[]; at: number }

/* No cache between reads, and few retries: the next poll is the retry, and a failure must show soon. */
const read = <T,>(path: string) => gwGet<T[]>(path, { ttlMs: 0, attempts: 2 }).then((rows): Stamped<T> => ({ rows: Array.isArray(rows) ? rows : [], at: Date.now() }));

const num = (raw: string | null | undefined): string => (raw ? fmtDecimalString(raw) : '–');
/** A percentage or band from model.ts in the reader's number style (0,012%). */
const pc = (t: string | null | undefined): string => (t ? t.replace(/\d+(?:\.\d+)?/g, (m) => fmtDecimalString(m)) : '–');
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function LimitsPage() {
  const perps = usePolled('limits:perps', () => read<LimitSymbol>('/api/v1/perps/markets/symbols'), SYMBOLS_MS);
  const spot = usePolled('limits:spot', () => read<LimitSymbol>('/api/v1/spot/markets/symbols'), SYMBOLS_MS);
  const coins = usePolled('limits:coins', () => read<LimitCoin>('/api/v1/perps/markets/coins'), COINS_MS);
  const [place, setPlace] = useState(() => readPlace(window.location.search));
  const { tab, market } = place;

  useEffect(() => {
    const s = placeSearch(tab, market);
    if (s !== window.location.search) window.history.replaceState(null, '', `${window.location.pathname}${s}`);
  }, [tab, market]);

  const perpRows = useMemo(() => ordered(perps.data?.rows ?? []), [perps.data]);
  const spotRows = useMemo(() => ordered(spot.data?.rows ?? []), [spot.data]);
  const collateral = useMemo(() => collateralOf(coins.data?.rows ?? []), [coins.data]);
  const top = useMemo(() => topLeverage(perpRows), [perpRows]);
  const reads: Read<Stamped<unknown>>[] = [perps, spot, coins];

  return (
    <main className="ex lim">
      <article className="ex-card">
        <div className="ex-view">
          <header className="ex-hero">
            <svg className="ex-hero__icon" viewBox="0 0 20 20" width="34" height="34" aria-hidden="true">
              <path d="M1.6 15.800a8.400 8.400 0 0 1 16.800 0" />
              <path d="M10 15.800 13.600 9" />
            </svg>
            <div className="ex-hero__text">
              <h1 className="ex-hero__title">Trading limits &amp; conditions</h1>
              <p className="ex-hero__line">The rules SoDEX sets for every market, read live from its own data. ValueDesk changes none of them.</p>
            </div>
            <Live reads={reads} />
          </header>

          {!perps.data && perps.error ? (
            <div className="ex-state">
              <b>SoDEX's market data could not be read</b>
              <span>{perps.error}</span>
              <button type="button" className="ex-retry" onClick={perps.retry}>Try again</button>
            </div>
          ) : !perps.data ? (
            <div className="ex-skel" aria-hidden="true">
              <div className="ex-stats">{[0, 1, 2, 3].map((i) => <div key={i} className="ex-stat ex-skel__block" />)}</div>
              <ul className="ex-rows">{[0, 1, 2, 3, 4].map((i) => <li key={i} className="ex-row ex-skel__row" />)}</ul>
            </div>
          ) : (
            <>
              <section className="ex-stats" aria-label="Summary">
                <Stat label="Futures markets" value={String(perpRows.length)} sub={tradingLine(perpRows)} />
                <Stat label="Spot markets" value={spot.data ? String(spotRows.length) : '–'} sub={spot.data ? tradingLine(spotRows) : 'not read yet'} />
                <Stat label="Top leverage" value={top ? `${top.leverage}x` : '–'} sub={top ? top.coins.join(', ') : ''} />
                <Stat label="Collateral assets" value={coins.data ? String(collateral.length) : '–'} sub="count as futures margin" />
              </section>

              <div className="lbp ex-bar">
                <div className="lbp-bar">
                  <div className="lbp-seg" role="radiogroup" aria-label="Section">
                    {TABS.map(([id, label]) => (
                      <button key={id} type="button" role="radio" aria-checked={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => setPlace((p) => ({ ...p, tab: id }))}>{label}</button>
                    ))}
                  </div>
                </div>
              </div>

              {tab === 'leverage' && <LeverageTab rows={perpRows} market={market} onMarket={(m) => setPlace((p) => ({ ...p, market: m }))} />}
              {tab === 'rules' && <RulesTab perps={perpRows} spot={spotRows} onTiers={(m) => setPlace({ tab: 'leverage', market: m })} />}
              {tab === 'collateral' && <CollateralTab read={coins} rows={collateral} />}
            </>
          )}
        </div>
      </article>
    </main>
  );
}

const tradingLine = (rows: readonly LimitSymbol[]) => {
  const halted = rows.filter((s) => !isTrading(s)).length;
  return `${rows.length - halted} trading · ${halted} halted`;
};

/** Live, or stopped: the oldest of the three reads, so "Updated" never flatters. */
function Live({ reads }: { reads: Read<Stamped<unknown>>[] }) {
  const ats = reads.flatMap((r) => (r.data ? [r.data.at] : []));
  if (!ats.length) return <span className="ex-updated" />;
  const failing = reads.some((r) => r.error);
  const at = Math.min(...ats);
  return (
    <span className={`lim-live${failing ? ' is-off' : ''}`} title={failing ? 'A read from SoDEX failed. These are the last figures it sent.' : 'Read from SoDEX while this page is on screen'}>
      <i aria-hidden="true" />
      {failing ? `Not updating · last read ${clock(at)}` : `Live · updated ${clock(at)}`}
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="ex-stat">
      <span className="ex-stat__label">{label}</span>
      <span className="ex-stat__value">{value}</span>
      <span className="ex-stat__sub">{sub}</span>
    </div>
  );
}

const Status = ({ s }: { s: LimitSymbol }) => isTrading(s)
  ? <span className="lim-status is-on"><i aria-hidden="true" />Trading</span>
  : <span className="lim-status is-halt"><i aria-hidden="true" />{s.status === 'HALT' ? 'Halted' : s.status}</span>;

/** A rule SoDEX's documentation states and no feed carries: marked, dated, and linked. */
function DocsNote({ href, children }: { href: string; children: ReactNode }) {
  return (
    <aside className="lim-docs">
      <span className="lim-docs__tag">SoDEX docs, not live</span>
      <ul>{children}</ul>
      <p>Read {DOCS_READ}. <a href={`${DOCS}${href}`} target="_blank" rel="noreferrer">The current text</a> is what counts.</p>
    </aside>
  );
}

/* --- Leverage & margin ------------------------------------------------------------------- */

function LeverageTab({ rows, market, onMarket }: { rows: readonly LimitSymbol[]; market: string | null; onMarket: (m: string) => void }) {
  const s = rows.find((r) => r.name === market) ?? rows[0];
  const options: FxOption[] = useMemo(() => rows.map((r) => ({ value: r.name, label: r.displayName, icon: r.baseCoin, hint: r.maxLeverage ? `${r.maxLeverage}x` : undefined })), [rows]);
  const tiers = useMemo(() => bracketsOf(s?.marginTiers), [s]);
  if (!s) return <div className="ex-state"><b>No futures market listed</b><span>SoDEX's list came back empty.</span></div>;
  const coin = coinName(s.baseCoin);
  const cap = capOf(s.openInterestCapUSD);
  const coinCap = capOf(s.openInterestCap);
  const every = intervalOf(s.fundingInterval);
  const funding = bandOf(s.maxFundingRate, s.minFundingRate?.replace(/^-/, ''));
  return (
    <section className="lim-sec" aria-label="Leverage and margin">
      <div className="lim-pick">
        <div className="lim-pick__sel">
          <FxSelect value={s.name} options={options} onChange={onMarket} label="Market" searchable searchPlaceholder="Search markets" triggerClassName="algo-msel" listMinWidth={240} />
          <Status s={s} />
        </div>
        <p className="lim-formula">
          <span>Initial margin = position value ÷ leverage</span>
          <span>Maintenance margin = position value × maintenance rate − deduction</span>
        </p>
      </div>

      <dl className="lim-facts">
        <Fact k="Max leverage" v={s.maxLeverage ? `${s.maxLeverage}x` : '–'} />
        <Fact k="Starting leverage" v={s.initLeverage ? `${s.initLeverage}x` : '–'} />
        <Fact k="Open interest cap" v={cap ? `$${num(cap)}` : 'None listed'} title={coinCap ? `SoDEX also lists ${num(coinCap)} ${coin}` : undefined} />
        <Fact k="Funding" v={every ? `Every ${every}` : '–'} sub={funding ? `cap ${pc(funding)}` : undefined} />
        <Fact k="Default fees" v={`${pc(pctOf(s.makerFee))} / ${pc(pctOf(s.takerFee))}`} sub="maker / taker" />
      </dl>

      <table className="lim-table lim-table--tiers">
        <thead>
          <tr><th>Tier</th><th>Position value (USDC)</th><th className="is-num">Max leverage</th><th className="is-num">Maintenance rate</th><th className="is-num">Deduction (USDC)</th></tr>
        </thead>
        <tbody>
          {tiers.map((t) => (
            <tr key={t.tier}>
              <td data-label="Tier" className="lim-tier">{t.tier}</td>
              <td data-label="Position value" className="lim-num">{num(t.from)} – {num(t.to)}</td>
              <td data-label="Max leverage" className="is-num"><b>{t.maxLeverage}x</b></td>
              <td data-label="Maintenance rate" className="is-num">{pc(t.rate)}</td>
              <td data-label="Deduction" className="is-num">{num(t.deduction)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="lim-foot">Your tier follows your position's value. Fees are SoDEX's defaults, before any volume tier, staking discount or builder fee. <a href={`${DOCS}/trading-mechanics/margin-tiers`} target="_blank" rel="noreferrer">How margin tiers work</a></p>
    </section>
  );
}

function Fact({ k, v, sub, title }: { k: string; v: string; sub?: string; title?: string }) {
  return (
    <div title={title}>
      <dt>{k}</dt>
      <dd>{v}{sub && <small>{sub}</small>}</dd>
    </div>
  );
}

/* --- Trading rules --------------------------------------------------------------------- */

function RulesTab({ perps, spot, onTiers }: { perps: readonly LimitSymbol[]; spot: readonly LimitSymbol[]; onTiers: (market: string) => void }) {
  const [engine, setEngine] = useState<'perps' | 'spot'>('perps');
  const [q, setQ] = useState('');
  const rows = (engine === 'perps' ? perps : spot).filter((s) => matches(s, q));
  return (
    <section className="lim-sec" aria-label="Trading rules">
      <div className="lbp lim-rulebar">
        <div className="lbp-bar">
          <div className="lbp-seg" role="radiogroup" aria-label="Market type">
            {(['perps', 'spot'] as const).map((e) => (
              <button key={e} type="button" role="radio" aria-checked={engine === e} className={engine === e ? 'is-on' : ''} onClick={() => setEngine(e)}>{e === 'perps' ? 'Futures' : 'Spot'}</button>
            ))}
          </div>
          <label className="lbp-search">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.800" fill="none" stroke="currentColor" strokeWidth="1.400" /><path d="m10.600 10.600 3.400 3.400" fill="none" stroke="currentColor" strokeWidth="1.400" strokeLinecap="round" /></svg>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search markets" aria-label="Search markets" spellCheck={false} />
          </label>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="ex-state"><b>No market matches</b><span>Nothing on SoDEX's {engine === 'perps' ? 'futures' : 'spot'} list goes by "{q.trim()}".</span></div>
      ) : (
        <div className="lim-scroll">
          <table className="lim-table lim-table--rules">
            <thead>
              <tr>
                <th>Market</th>
                <th className="is-num">Min size</th>
                <th className="is-num">Price step</th>
                <th className="is-num">Limit price band</th>
                <th className="is-num">Market price band</th>
                <th className="is-num">Max order size</th>
                <th className="is-num">Max order value</th>
                <th className="is-num">Min order value</th>
                <th className="is-num">Maker / taker</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => <RuleRow key={s.id} s={s} onTiers={engine === 'perps' ? onTiers : undefined} />)}
            </tbody>
          </table>
        </div>
      )}
      <p className="lim-foot">"None listed" is SoDEX's own 0 on that maximum. Prices and order values are in USDC.</p>
      <DocsNote href="/for-developers/developers/trading/api-rate-limits">
        <li><b>{num('1000')} open orders</b> per user across all spot and futures markets, by default</li>
        <li><b>60 orders a minute</b> per account from the web, <b>600 a minute and 20 a second</b> with an API key</li>
      </DocsNote>
    </section>
  );
}

function RuleRow({ s, onTiers }: { s: LimitSymbol; onTiers?: (market: string) => void }) {
  const coin = coinName(s.baseCoin);
  const size = capOf(s.maxQuantity);
  const marketSize = capOf(s.marketMaxQuantity);
  const value = capOf(s.maxNotional);
  const who = (
    <>
      <CoinIcon coin={s.baseCoin} size={18} />
      <span className="lim-who__name">{s.displayName}</span>
    </>
  );
  return (
    <tr className={isTrading(s) ? undefined : 'is-halted'}>
      <td className="lim-who">
        {onTiers ? <button type="button" className="lim-who__btn" title={`${s.displayName}: margin tiers`} onClick={() => onTiers(s.name)}>{who}</button> : <span className="lim-who__btn is-plain">{who}</span>}
        {!isTrading(s) && <Status s={s} />}
      </td>
      <td data-label="Min size" className="is-num"><span>{num(s.minQuantity)} <small>{coin}</small></span></td>
      <td data-label="Price step" className="is-num"><span>{num(s.tickSize)}<small className="lim-sub">min {num(s.minPrice)}</small></span></td>
      <td data-label="Limit price band" className="is-num">{pc(bandOf(s.buyLimitUpRatio, s.sellLimitDownRatio))}</td>
      <td data-label="Market price band" className="is-num">{pctOf(s.marketDeviationRatio) ? `±${pc(pctOf(s.marketDeviationRatio))}` : '–'}</td>
      <td data-label="Max order size" className="is-num">
        <span>
          {size ? <>{num(size)} <small>{coin}</small></> : <span className="lim-none">None listed</span>}
          {marketSize !== size && <small className="lim-sub">market {marketSize ? num(marketSize) : 'none listed'}</small>}
        </span>
      </td>
      <td data-label="Max order value" className="is-num">{value ? num(value) : <span className="lim-none">None listed</span>}</td>
      <td data-label="Min order value" className="is-num">{num(s.minNotional)}</td>
      <td data-label="Maker / taker" className="is-num">{pc(pctOf(s.makerFee))} / {pc(pctOf(s.takerFee))}</td>
    </tr>
  );
}

/* --- Collateral ------------------------------------------------------------------------ */

function CollateralTab({ read: r, rows }: { read: Read<Stamped<LimitCoin>>; rows: ReturnType<typeof collateralOf> }) {
  if (!r.data) {
    return r.error ? (
      <div className="ex-state"><b>The collateral list could not be read</b><span>{r.error}</span><button type="button" className="ex-retry" onClick={r.retry}>Try again</button></div>
    ) : <ul className="ex-rows ex-skel" aria-hidden="true">{[0, 1, 2, 3, 4].map((i) => <li key={i} className="ex-row ex-skel__row" />)}</ul>;
  }
  return (
    <section className="lim-sec" aria-label="Collateral">
      <table className="lim-table lim-table--coll">
        <thead><tr><th>Asset</th><th>Collateral ratio</th><th className="is-num">SoDEX oracle price (USD)</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.coin}>
              <td className="lim-who"><span className="lim-who__btn is-plain"><CoinIcon coin={c.coin} size={18} /><span className="lim-who__name">{c.name}</span></span></td>
              <td data-label="Collateral ratio" className="lim-ratio">
                <b>{pc(c.ratio)}</b>
                <span className="lim-bar" aria-hidden="true"><i style={{ width: `${c.share * 100}%` }} /></span>
              </td>
              <td data-label="Oracle price" className="is-num" title={c.price ?? undefined}>{c.price ? num(shortPrice(c.price)) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="lim-foot">Any coin not listed here has a ratio of 0 on SoDEX.</p>
      <DocsNote href="/trading-mechanics/multi-asset-margin">
        <li>Margin from an asset = balance × index price × collateral ratio</li>
        <li>Counts in <b>cross margin</b> only, once moved from your Spot account to your Futures account</li>
        <li><b>${num('500000')}</b> cap on an account's non-USDC collateral value, checked when a deposit comes in; a deposit over it is rejected whole</li>
        <li><b>SOSO</b> at most {num('30000')} SOSO or {num('10000')} USDC worth, whichever is smaller</li>
      </DocsNote>
    </section>
  );
}
