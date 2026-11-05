/**
 * Trading limits & conditions (More > Trading limits, /limits; owner 2026-11-05, layout 2026-11-06):
 * SoDEX's rules for every market, read straight from its own feeds while the page is on screen.
 *
 * WHAT IS ON HERE IS WHAT SODEX PUBLISHES, AS IT PUBLISHES IT (model.ts). Nothing is worked out or
 * filled in. A maximum SoDEX leaves at "0" reads "None listed". A rule only SoDEX's documentation
 * states, with no feed behind it, is worded as such with the date it was read (DOCS_READ). When a
 * read fails the page keeps what it has and says it stopped updating, so an old figure never passes
 * for a live one.
 *
 * Laid out after the owner's reference: a title, an underlined tab row, each table a large rounded
 * panel with two-line values and notes under it. The app's own controls: the tab bar (.tabbar), the
 * switch and search (lbp-seg, lbp-search), the market dropdown (FxSelect), the pager (st-pager). On a
 * phone each table row becomes a block of label + value.
 *
 * Left out because SoDEX does not publish them: the reference's Leverage & Limit tab, Max Number of
 * Open Orders (per market), Price Protection, Insurance Clearance Fee, Maximum Transfer-in (per asset),
 * Auto Exchange (SoDEX has none) and the asset Type filter.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { gwGet } from '../../exchange/sodexGateway';
import { fmtDecimalString } from '../../numStyle';
import { CoinIcon } from '../CoinIcon';
import { usePolled, type Read } from '../explore/cohorts/parts';
import { FxSelect, type FxOption } from '../funds/ui';
import { bandOf, bracketsOf, capOf, coinName, collateralOf, intervalOf, isTrading, matches, ordered, pctOf, placeSearch, ratioPair, readPlace, shortPrice, type CollateralRow, type LimitCoin, type LimitSymbol, type LimitsTab } from './model';
import '../excluded/excluded.css';
import '../../status/status.css';
import './limits.css';

/** Market rules change rarely and the list is SoDEX's largest public read; prices move. */
const SYMBOLS_MS = 30_000;
const COINS_MS = 15_000;
const ASSETS_PER_PAGE = 10;
/** When SoDEX's documentation was last read for the rules worded as coming from it. */
const DOCS_READ = '2026-11-05';
const DOCS = 'https://docs.sodex.com';

const TABS: ReadonlyArray<readonly [LimitsTab, string]> = [['leverage', 'Leverage & margin'], ['collateral', 'Multi-asset margin'], ['rules', 'Trading rules']];

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
  const reads: Read<Stamped<unknown>>[] = [perps, spot, coins];

  return (
    <main className="lim">
      <header className="lim-head">
        <h1>Trading limits &amp; conditions</h1>
        <Live reads={reads} />
      </header>

      <div className="tabbar lim-tabs" role="tablist" aria-label="Section">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setPlace((p) => ({ ...p, tab: id }))}>{label}</button>
        ))}
      </div>

      {!perps.data && perps.error ? (
        <div className="lim-panel ex-state">
          <b>SoDEX's market data could not be read</b>
          <span>{perps.error}</span>
          <button type="button" className="ex-retry" onClick={perps.retry}>Try again</button>
        </div>
      ) : !perps.data ? (
        <div className="lim-panel lim-skel" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="ex-skel__row" />)}</div>
      ) : (
        <>
          {tab === 'leverage' && <LeverageTab rows={perpRows} market={market} onMarket={(m) => setPlace((p) => ({ ...p, market: m }))} />}
          {tab === 'collateral' && <CollateralTab read={coins} rows={collateral} />}
          {tab === 'rules' && <RulesTab perps={perpRows} spot={spotRows} onTiers={(m) => setPlace({ tab: 'leverage', market: m })} />}
        </>
      )}
    </main>
  );
}

/** Live, or stopped: the oldest of the three reads, so "updated" never flatters. */
function Live({ reads }: { reads: Read<Stamped<unknown>>[] }) {
  const ats = reads.flatMap((r) => (r.data ? [r.data.at] : []));
  if (!ats.length) return null;
  const failing = reads.some((r) => r.error);
  const at = Math.min(...ats);
  return (
    <span className={`lim-live${failing ? ' is-off' : ''}`} title={failing ? 'A read from SoDEX failed. These are the last figures it sent.' : 'Read from SoDEX while this page is on screen'}>
      <i aria-hidden="true" />
      {failing ? `Not updating · last read ${clock(at)}` : `Live from SoDEX · updated ${clock(at)}`}
    </span>
  );
}

const Halted = ({ s }: { s: LimitSymbol }) => (isTrading(s) ? null : (
  <span className="lim-status"><i aria-hidden="true" />{s.status === 'HALT' ? 'Halted' : s.status}</span>
));

/** A column head SoDEX defines: the dashed underline says there is more on hover. */
const Hint = ({ title, children }: { title: string; children: ReactNode }) => <span className="lim-hint" title={title}>{children}</span>;

/** Two values of one column on two lines, as the reference sets them. */
const Two = ({ first, second, unit }: { first: string; second: string; unit?: string }) => (
  <span className="lim-two">
    <span>{first}</span>
    <span>/ {second}{unit ? <> <small>{unit}</small></> : null}</span>
  </span>
);

const DocsLink = ({ href, children }: { href: string; children: ReactNode }) => <a href={`${DOCS}${href}`} target="_blank" rel="noreferrer">{children}</a>;

/* --- Leverage & margin ------------------------------------------------------------------- */

function LeverageTab({ rows, market, onMarket }: { rows: readonly LimitSymbol[]; market: string | null; onMarket: (m: string) => void }) {
  const s = rows.find((r) => r.name === market) ?? rows[0];
  const options: FxOption[] = useMemo(() => rows.map((r) => ({ value: r.name, label: r.displayName, icon: r.baseCoin, hint: r.maxLeverage ? `${r.maxLeverage}x` : undefined })), [rows]);
  const tiers = useMemo(() => bracketsOf(s?.marginTiers), [s]);
  if (!s) return <div className="lim-panel ex-state"><b>No futures market listed</b><span>SoDEX's list came back empty.</span></div>;
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
          <Halted s={s} />
        </div>
        <p className="lim-formula">
          <span>Initial margin = position value ÷ leverage</span>
          <span>Maintenance margin = position value × maintenance margin rate − maintenance deduction</span>
        </p>
      </div>

      <div className="lim-panel">
        <div className="lim-scroll">
          <table className="lim-table lim-table--tiers">
            <thead>
              <tr>
                <th>Tier</th>
                <th><Hint title="The value of your position, in USDC. Each tier starts where the one below it ends.">Position bracket (value in USDC)</Hint></th>
                <th><Hint title="The most leverage allowed in this tier">Max leverage</Hint></th>
                <th><Hint title="SoDEX's maintenance margin rate for this tier">Maintenance margin rate</Hint></th>
                <th><Hint title="SoDEX's maintenance deduction for this tier, taken off in the formula above">Maintenance deduction (USDC)</Hint></th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t.tier}>
                  <td data-label="Tier">{t.tier}</td>
                  <td data-label="Position bracket">{num(t.from)} – {num(t.to)}</td>
                  <td data-label="Max leverage">{t.maxLeverage}x</td>
                  <td data-label="Maintenance rate">{pc(t.rate)}</td>
                  <td data-label="Deduction">{num(t.deduction)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ul className="lim-notes">
        <li title={coinCap ? `SoDEX also lists an open interest cap of ${num(coinCap)} ${coin}` : undefined}>
          {s.displayName}: starting leverage {s.initLeverage ? `${s.initLeverage}x` : '–'}, open interest cap {cap ? `$${num(cap)}` : 'none listed'}{every ? `, funding every ${every}` : ''}{funding ? ` with a cap of ${pc(funding)}` : ''}, default fees {pc(pctOf(s.makerFee))} maker and {pc(pctOf(s.takerFee))} taker.
        </li>
        <li>Default fees are before any volume tier, staking discount or builder fee.</li>
        <li>Formulas from SoDEX's docs, read {DOCS_READ}: <DocsLink href="/trading-mechanics/margin-tiers">Margin Tiers</DocsLink>, <DocsLink href="/trading-mechanics/margining">Margining</DocsLink>.</li>
      </ul>
    </section>
  );
}

/* --- Trading rules --------------------------------------------------------------------- */

function RulesTab({ perps, spot, onTiers }: { perps: readonly LimitSymbol[]; spot: readonly LimitSymbol[]; onTiers: (market: string) => void }) {
  const [engine, setEngine] = useState<'perps' | 'spot'>('perps');
  const [q, setQ] = useState('');
  const rows = (engine === 'perps' ? perps : spot).filter((s) => matches(s, q));
  return (
    <section className="lim-sec" aria-label="Trading rules">
      <div className="lim-intro">
        <p>
          By default a user can hold {num('1000')} open orders across all spot and futures markets, and place {num('60')} orders a minute from the web, or {num('600')} a minute and {num('20')} a second with an API key. From <DocsLink href="/for-developers/developers/trading/api-rate-limits">SoDEX's docs</DocsLink>, read {DOCS_READ}, not live.
        </p>
        <div className="lbp lim-rulebar">
          <div className="lbp-seg" role="radiogroup" aria-label="Market type">
            {(['perps', 'spot'] as const).map((e) => (
              <button key={e} type="button" role="radio" aria-checked={engine === e} className={engine === e ? 'is-on' : ''} onClick={() => setEngine(e)}>{e === 'perps' ? 'Futures' : 'Spot'}</button>
            ))}
          </div>
          <label className="lbp-search">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m10.6 10.6 3.4 3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search symbol" aria-label="Search symbol" spellCheck={false} />
          </label>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="lim-panel ex-state"><b>No market matches</b><span>Nothing on SoDEX's {engine === 'perps' ? 'futures' : 'spot'} list goes by "{q.trim()}".</span></div>
      ) : (
        <div className="lim-panel">
          <div className="lim-scroll">
            <table className="lim-table lim-table--rules">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th><Hint title="The smallest order size, and the step sizes move in">Min trade amount</Hint></th>
                  <th><Hint title="The lowest price an order can have, and the step prices move in">Min order price / min price movement</Hint></th>
                  <th><Hint title="SoDEX's limit order price limits, as ratios">Limit order price cap / floor ratio</Hint></th>
                  <th><Hint title="The largest order size, for market orders and for limit orders">Max market order / max limit order amount</Hint></th>
                  <th><Hint title="SoDEX's maximum order notional value">Max order value</Hint></th>
                  <th><Hint title="SoDEX's minimum order notional value">Min notional value</Hint></th>
                  <th><Hint title="SoDEX's market order price limit, as a ratio">Market order price cap / floor ratio</Hint></th>
                  <th><Hint title="SoDEX's default fee ratios, before any volume tier, staking discount or builder fee">Default maker / taker fee</Hint></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => <RuleRow key={s.id} s={s} onTiers={engine === 'perps' ? onTiers : undefined} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <ul className="lim-notes">
        <li>"None listed" is SoDEX's own 0 on that maximum.</li>
      </ul>
    </section>
  );
}

function RuleRow({ s, onTiers }: { s: LimitSymbol; onTiers?: (market: string) => void }) {
  const coin = coinName(s.baseCoin);
  const quote = s.quoteCoin ? coinName(s.quoteCoin) : undefined;
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
        <Halted s={s} />
      </td>
      <td data-label="Min trade amount"><span>{num(s.minQuantity)} <small>{coin}</small></span></td>
      <td data-label="Min price / movement"><Two first={num(s.minPrice)} second={num(s.tickSize)} unit={quote} /></td>
      <td data-label="Limit cap / floor">{pc(ratioPair(s.buyLimitUpRatio, s.sellLimitDownRatio))}</td>
      <td data-label="Max market / limit">
        {size || marketSize
          ? <Two first={marketSize ? num(marketSize) : 'None listed'} second={size ? num(size) : 'None listed'} unit={coin} />
          : <span className="lim-none">None listed</span>}
      </td>
      <td data-label="Max order value">{value ? <span>{num(value)} <small>{quote}</small></span> : <span className="lim-none">None listed</span>}</td>
      <td data-label="Min notional"><span>{num(s.minNotional)} <small>{quote}</small></span></td>
      <td data-label="Market cap / floor">{pc(pctOf(s.marketDeviationRatio))}</td>
      <td data-label="Maker / taker">{pc(pctOf(s.makerFee))} / {pc(pctOf(s.takerFee))}</td>
    </tr>
  );
}

/* --- Multi-asset margin ------------------------------------------------------------------ */

function CollateralTab({ read: r, rows }: { read: Read<Stamped<LimitCoin>>; rows: readonly CollateralRow[] }) {
  const [view, setView] = useState<'assets' | 'prices'>('assets');
  const [page, setPage] = useState(0);
  if (!r.data) {
    return r.error ? (
      <div className="lim-panel ex-state"><b>The collateral list could not be read</b><span>{r.error}</span><button type="button" className="ex-retry" onClick={r.retry}>Try again</button></div>
    ) : <div className="lim-panel lim-skel" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="ex-skel__row" />)}</div>;
  }
  const pages = Math.max(1, Math.ceil(rows.length / ASSETS_PER_PAGE));
  const at = Math.min(page, pages - 1);
  const shown = rows.slice(at * ASSETS_PER_PAGE, (at + 1) * ASSETS_PER_PAGE);
  return (
    <section className="lim-sec" aria-label="Multi-asset margin">
      <div className="lim-panel">
        <div className="lim-panel__bar lbp">
          <div className="lbp-seg" role="radiogroup" aria-label="View">
            <button type="button" role="radio" aria-checked={view === 'assets'} className={view === 'assets' ? 'is-on' : ''} onClick={() => setView('assets')}>Supported assets</button>
            <button type="button" role="radio" aria-checked={view === 'prices'} className={view === 'prices' ? 'is-on' : ''} onClick={() => setView('prices')}>Oracle prices</button>
          </div>
        </div>
        <table className="lim-table lim-table--assets">
          <thead>
            <tr>
              <th>Margin asset</th>
              {view === 'assets'
                ? <th><Hint title="SoDEX's margin ratio for this asset">Collateral ratio</Hint></th>
                : <th><Hint title="SoDEX's current oracle price of this asset, in USD">Oracle price (USD)</Hint></th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.coin}>
                <td className="lim-who"><span className="lim-who__btn is-plain"><CoinIcon coin={c.coin} size={18} /><span className="lim-who__name">{c.name}</span></span></td>
                {view === 'assets' ? (
                  <td data-label="Collateral ratio" className="lim-ratio">
                    <span>{pc(c.ratio)}</span>
                    <span className="lim-bar" aria-hidden="true"><i style={{ width: `${c.share * 100}%` }} /></span>
                  </td>
                ) : (
                  <td data-label="Oracle price" title={c.price ?? undefined}>{c.price ? num(shortPrice(c.price)) : '–'}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav className="st-pager lim-pager" aria-label="Margin assets, pages">
          <span className="st-pager__n">{at * ASSETS_PER_PAGE + 1}–{Math.min(rows.length, (at + 1) * ASSETS_PER_PAGE)} of {rows.length}</span>
          <div className="lbp-seg">
            <button type="button" aria-label="Previous" disabled={at === 0} onClick={() => setPage(at - 1)}>‹</button>
            {Array.from({ length: pages }, (_, i) => (
              <button key={i} type="button" aria-current={i === at ? 'page' : undefined} className={i === at ? 'is-on' : ''} onClick={() => setPage(i)}>{i + 1}</button>
            ))}
            <button type="button" aria-label="Next" disabled={at === pages - 1} onClick={() => setPage(at + 1)}>›</button>
          </div>
        </nav>
      )}
      <ul className="lim-notes">
        <li>Any coin not listed has a ratio of 0 on SoDEX.</li>
        <li>From <DocsLink href="/trading-mechanics/multi-asset-margin">SoDEX's docs</DocsLink>, read {DOCS_READ}, not live:</li>
        <li className="is-sub">Margin from an asset = balance × index price × collateral ratio.</li>
        <li className="is-sub">Assets count in cross margin only, once moved from your Spot account to your Futures account.</li>
        <li className="is-sub">${num('500000')} cap on an account's non-USDC collateral value, checked when a deposit comes in; a deposit over it is rejected whole.</li>
        <li className="is-sub">SOSO: at most {num('30000')} SOSO or {num('10000')} USDC worth, whichever is smaller.</li>
      </ul>
    </section>
  );
}
