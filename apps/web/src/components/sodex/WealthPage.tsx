/**
 * Wealth (/wealth, /wealth/<fund>): SoDEX's funds, in the order of its own page. The wallet's portfolio
 * beside the featured yield, the three product groups, every fund in a table, and one fund's detail with
 * its price chart. Prices, returns and APYs are printed as SoDEX gives them and a dash where it gives
 * none. `clob` funds link to the spot market. A vault's subscribe and redeem are not built: they show as
 * coming, and nothing here signs.
 */
import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Card, Group, Row } from '../portfolio/parts';
import { CoinIcon } from '../CoinIcon';
import { EmptyState, NoWallet } from '../EmptyState';
import { SeriesChart } from '../datachart/SeriesChart';
import { usePolled } from '../explore/cohorts/parts';
import { Fact } from '../Points';
import { DASH, fmt, fmtPct, fmtUsd, signClass } from '../../format';
import { useMask } from '../../privacy';
import { isLight } from '../../theme';
import { SODEX_SITE } from '../../sodexProgrammes';
import type { Eip1193Provider } from '../../wallet';
import {
  GROUPS, GROUP_LABEL, GROUP_LINE, PNL_RANGES, PRICE_RANGES, fetchFund, fetchFundDetails, fetchFunds, fetchMaintenance, fetchMarkets,
  fetchPnl, fetchPnlHistory, fetchPositions, fetchPriceHistory, fundIdFromPath, isEmptyHolding, isVault, joinFunds, leadReturn, numOrNull,
  ratePct, seriesOf, sortRows, tradeHref, yieldBasisLabel,
  type PnlPosition, type PnlRange, type PriceRange, type ProductGroup, type WealthMaintenance, type WealthPnl, type WealthRow,
} from '../../wealth';
import { Pill, ProgrammeHero, ProgrammePage, ReadFailed, SegSwitch, SkelRows, SkelTiles, Tile, Tiles, fmtDate, fmtWhen } from './parts';

const pct = (v: unknown): string => (numOrNull(v) === null ? DASH : fmtPct(numOrNull(v) as number, 2));
const pctCls = (v: unknown): string => {
  const n = numOrNull(v);
  return n === null ? 'pf-dim' : n > 0 ? 'pf-pos-text' : n < 0 ? 'pf-neg-text' : '';
};
const price = (v: unknown): string => {
  const n = numOrNull(v);
  return n === null ? DASH : fmtUsd(n, n < 10 ? 4 : 2);
};
const pnlCls = (v: unknown): string => signClass(numOrNull(v) ?? 0);
const signedUsd = (v: unknown): string => {
  const n = numOrNull(v);
  if (n === null) return DASH;
  return `${n > 0 ? '+' : ''}${fmtUsd(n, 2)}`;
};

/* --- the current fund is the URL ---------------------------------------------------------------- */

function useFundRoute(): [string | null, (id: string | null) => void] {
  const [fund, setFund] = useState<string | null>(() => fundIdFromPath(window.location.pathname));
  useEffect(() => {
    const on = () => setFund(fundIdFromPath(window.location.pathname));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const open = useCallback((id: string | null) => {
    window.history.pushState(null, '', id ? `/wealth/${encodeURIComponent(id)}` : '/wealth');
    setFund(id);
    window.scrollTo?.({ top: 0 });
  }, []);
  return [fund, open];
}

/** A link that stays a link for a middle click, and moves in place for a plain one. */
const inPlace = (go: () => void) => (e: MouseEvent) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  go();
};

export function WealthPage({ address }: { address: string | null; provider: Eip1193Provider | null }) {
  const [fundId, openFund] = useFundRoute();
  const funds = usePolled('wealth-funds', () => fetchFunds(), 60_000);
  const quotes = usePolled('wealth-markets', () => fetchMarkets(), 60_000);
  const maint = usePolled<WealthMaintenance>('wealth-maintenance', (signal) => fetchMaintenance(signal), 30_000);
  const rows = useMemo(
    () => (funds.data || quotes.data ? sortRows(joinFunds(funds.data ?? [], quotes.data ?? [])) : null),
    [funds.data, quotes.data],
  );
  const down = maint.data?.state === 'maintenance';

  return (
    <ProgrammePage label="Wealth">
      {down && (
        <div className="sdx-banner" role="status">
          <Pill tone="warn" dot>Maintenance</Pill>
          <span>{maint.data?.message || 'SoDEX has Wealth in maintenance. Figures may be behind and links to trade are held.'}</span>
        </div>
      )}
      {fundId ? (
        <FundDetail fundId={fundId} row={rows?.find((r) => r.fundId === fundId) ?? null} address={address} maintenance={down} onBack={() => openFund(null)} />
      ) : (
        <Overview
          rows={rows}
          failed={(funds.error && quotes.error) ? funds.error : null}
          onRetry={() => { funds.retry(); quotes.retry(); }}
          address={address}
          maintenance={down}
          onOpen={openFund}
        />
      )}
    </ProgrammePage>
  );
}

/* --- the overview -------------------------------------------------------------------------------- */

function Overview({ rows, failed, onRetry, address, maintenance, onOpen }: {
  rows: WealthRow[] | null;
  failed: string | null;
  onRetry: () => void;
  address: string | null;
  maintenance: boolean;
  onOpen: (id: string) => void;
}) {
  const [group, setGroup] = useState<ProductGroup | 'all'>('all');
  const featured = rows?.find((r) => r.fundId === 'Morpho-Earn') ?? null;
  return (
    <>
      <ProgrammeHero
        title="Wealth"
        line="Tokenised funds, vaults and on-chain yield."
        aside={<a className="pf-btn" href={SODEX_SITE.wealth} target="_blank" rel="noopener noreferrer">Open on SoDEX</a>}
      />
      <div className="sdx-duo sdx-duo--wealth">
        <Portfolio address={address} rows={rows} onOpen={onOpen} />
        <Featured row={featured} onOpen={onOpen} />
      </div>

      {failed && !rows ? <ReadFailed what="The funds" error={failed} onRetry={onRetry} /> : !rows ? (
        <>
          <SkelTiles tiles={3} />
          <SkelRows rows={6} />
        </>
      ) : (
        <>
          <section className="sdx-groups" aria-label="Product groups">
            {GROUPS.map((g) => <GroupCard key={g} group={g} rows={rows.filter((r) => r.group === g)} maintenance={maintenance} onOpen={onOpen} />)}
          </section>
          <Card
            title="All funds"
            action={(
              <SegSwitch
                value={group}
                onChange={setGroup}
                label="Group"
                options={[{ v: 'all', label: 'All' }, ...GROUPS.map((g) => ({ v: g, label: GROUP_LABEL[g] }))]}
              />
            )}
          >
            <FundTable rows={group === 'all' ? rows : rows.filter((r) => r.group === group)} onOpen={onOpen} />
          </Card>
        </>
      )}
    </>
  );
}

function Featured({ row, onOpen }: { row: WealthRow | null; onOpen: (id: string) => void }) {
  const q = row?.quote;
  const basis = yieldBasisLabel(q?.yieldBasis);
  return (
    <Card title={row?.name ?? 'USDC Earn'} action={<Pill tone="info">Variable yield</Pill>}>
      {!row ? <SkelRows rows={2} height={56} /> : (
        <div className="sdx-featured">
          <div className="sdx-featured__rate">
            <b className={pctCls(q?.apy7d)}>{pct(q?.apy7d)}</b>
            <span>7D APY</span>
            {basis && <Pill title={q?.yieldBasis}>{basis}</Pill>}
          </div>
          <dl className="sdx-featured__more">
            <div><dt>24H APY</dt><dd>{pct(q?.apy24h)}</dd></div>
            <div><dt>1M APY</dt><dd>{pct(q?.apy1M)}</dd></div>
            <div><dt>Share price</dt><dd>{price(q?.price)}</dd></div>
          </dl>
          <a className="pf-btn" href={`/wealth/${encodeURIComponent(row.fundId)}`} onClick={inPlace(() => onOpen(row.fundId))}>View</a>
        </div>
      )}
    </Card>
  );
}

function FundMark({ row, size = 28 }: { row: WealthRow; size?: number }) {
  return <CoinIcon coin={row.fundId === 'Morpho-Earn' ? 'USDC' : (row.coin ?? row.fundId)} size={size} />;
}

function GroupCard({ group, rows, maintenance, onOpen }: { group: ProductGroup; rows: WealthRow[]; maintenance: boolean; onOpen: (id: string) => void }) {
  return (
    <Card title={GROUP_LABEL[group]} action={<span className="pf-unit">{GROUP_LINE[group]}</span>}>
      <ul className="sdx-funds">
        {rows.map((r) => {
          const lead = leadReturn(r);
          return (
            <li key={r.fundId}>
              <a className="sdx-fund" href={`/wealth/${encodeURIComponent(r.fundId)}`} onClick={inPlace(() => onOpen(r.fundId))}>
                <FundMark row={r} />
                <span className="sdx-fund__who">
                  <b>{r.name}</b>
                  <small>{lead?.label ?? DASH}</small>
                </span>
                <span className={`sdx-fund__ret ${lead ? pctCls(lead.value) : 'pf-dim'}`}>{lead ? pct(lead.value) : DASH}</span>
                {maintenance && <Pill tone="warn">Held</Pill>}
              </a>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function FundTable({ rows, onOpen }: { rows: WealthRow[]; onOpen: (id: string) => void }) {
  return (
    <div className="sdx-tablewrap">
      <table className="sdx-table">
        <thead>
          <tr>
            <th>Fund</th>
            <th className="sdx-opt">Group</th>
            <th className="num">Price</th>
            <th className="num">24H</th>
            <th className="num sdx-opt">1M</th>
            <th className="num sdx-opt">1Y</th>
            <th className="num sdx-opt">Inception</th>
            <th className="num">7D APY</th>
            <th className="num sdx-opt">1M APY</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const q = r.quote;
            const basis = yieldBasisLabel(q?.yieldBasis);
            return (
              <tr key={r.fundId} onClick={() => onOpen(r.fundId)}>
                <td>
                  <a className="sdx-table__who" href={`/wealth/${encodeURIComponent(r.fundId)}`} onClick={(e) => { e.stopPropagation(); inPlace(() => onOpen(r.fundId))(e); }}>
                    <FundMark row={r} size={22} />
                    <span>
                      <b>{r.name}</b>
                      <small>{q?.symbol ?? r.coin ?? r.fundId}</small>
                    </span>
                  </a>
                </td>
                <td className="sdx-opt"><Pill>{GROUP_LABEL[r.group]}</Pill></td>
                <td className="num">{price(q?.price)}</td>
                <td className={`num ${pctCls(q?.roi24h)}`}>{pct(q?.roi24h)}</td>
                <td className={`num sdx-opt ${pctCls(q?.roi1M)}`}>{pct(q?.roi1M)}</td>
                <td className={`num sdx-opt ${pctCls(q?.roi1Y)}`}>{pct(q?.roi1Y)}</td>
                <td className={`num sdx-opt ${pctCls(q?.roiInception)}`}>{pct(q?.roiInception)}</td>
                <td className={`num ${pctCls(q?.apy7d)}`} title={basis ?? undefined}>
                  {pct(q?.apy7d)}
                  {basis && <small className="sdx-table__basis">{basis}</small>}
                </td>
                <td className={`num sdx-opt ${pctCls(q?.apy1M)}`}>{pct(q?.apy1M)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* --- the wallet's holdings ----------------------------------------------------------------------- */

function usePortfolio(address: string | null) {
  const key = address ? address.toLowerCase() : null;
  const pnl = usePolled(key ? `wealth-pnl:${key}` : null, () => fetchPnl(address as string), 60_000);
  const positions = usePolled(key ? `wealth-pos:${key}` : null, () => fetchPositions(address as string), 60_000);
  const details = usePolled(key ? `wealth-det:${key}` : null, () => fetchFundDetails(address as string), 120_000);
  return { pnl, positions, details };
}

function Portfolio({ address, rows, onOpen }: { address: string | null; rows: WealthRow[] | null; onOpen: (id: string) => void }) {
  const { pnl, positions, details } = usePortfolio(address);
  const mask = useMask('funds');
  const maskPnl = useMask('pnl');
  const [range, setRange] = useState<PnlRange>('1M');
  const key = address?.toLowerCase();
  const history = usePolled(key ? `wealth-hist:${key}:${range}` : null, () => fetchPnlHistory(address as string, range), 300_000);

  if (!address) {
    return <Card title="Your portfolio"><NoWallet line="Connect a wallet to see your holdings and PnL." compact /></Card>;
  }
  if (pnl.error && !pnl.data) {
    return <Card title="Your portfolio"><ReadFailed what="Your holdings" error={pnl.error} onRetry={pnl.retry} /></Card>;
  }
  if (!pnl.data) return <Card title="Your portfolio"><SkelRows rows={3} /></Card>;

  const p = pnl.data;
  const pending = numOrNull(positions.data?.summary?.processingCost) ?? 0;
  const proceeds = numOrNull(positions.data?.summary?.pendingProceeds) ?? 0;
  const series = seriesOf(history.data?.points ?? [], (x) => x.pnl);
  return (
    <Card
      title="Your portfolio"
      action={p.complete === false || (p.bridgeStatus && p.bridgeStatus !== 'ready') ? <Pill tone="warn" title={`bridge: ${p.bridgeStatus ?? DASH}`}>Partial</Pill> : undefined}
    >
      {isEmptyHolding(p) ? (
        <EmptyState icon="coins" title="Nothing held yet" line="This wallet holds no Wealth product." compact />
      ) : (
        <>
          <div className="sdx-portfolio__top">
            <div>
              <span className="sdx-tile__label">Total value</span>
              <b className="sdx-portfolio__value">{mask(numOrNull(p.totalValue) === null ? DASH : fmtUsd(p.totalValue, 2))}</b>
            </div>
            <dl className="sdx-featured__more">
              <div><dt>PnL</dt><dd className={pnlCls(p.totalPnl)}>{maskPnl(signedUsd(p.totalPnl))}</dd></div>
              <div><dt>24H</dt><dd className={pnlCls(p.totalPnl24h)}>{maskPnl(signedUsd(p.totalPnl24h))}</dd></div>
              <div><dt>Unrealised</dt><dd className={pnlCls(p.totalUnrealizedPnl)}>{maskPnl(signedUsd(p.totalUnrealizedPnl))}</dd></div>
              <div><dt>Realised</dt><dd className={pnlCls(p.totalRealizedPnl)}>{maskPnl(signedUsd(p.totalRealizedPnl))}</dd></div>
            </dl>
          </div>
          {(pending > 0 || proceeds > 0 || (numOrNull(p.inFlightValue) ?? 0) > 0) && (
            <Group title="In flight">
              {pending > 0 && <Row label="Processing" value={fmtUsd(pending, 2)} />}
              {proceeds > 0 && <Row label="Pending proceeds" value={fmtUsd(proceeds, 2)} />}
              {(numOrNull(p.inFlightValue) ?? 0) > 0 && <Row label="In-flight value" value={fmtUsd(p.inFlightValue, 2)} />}
            </Group>
          )}
          <Holdings pnl={p} rows={rows} onOpen={onOpen} />
          {series.length > 1 && (
            <div className="sdx-chartblock">
              <div className="sdx-chartblock__head">
                <span className="pf-h pf-h--sub">PnL</span>
                <SegSwitch value={range} onChange={setRange} label="Range" options={PNL_RANGES.map((v) => ({ v, label: v }))} />
              </div>
              <SeriesChart height={160} series={[{ key: 'pnl', kind: 'line', color: '#00b481', points: series, format: (v) => fmtUsd(v, 0), title: 'PnL' }]} />
            </div>
          )}
          {!!details.data?.entries.length && (
            <Group title="Activity">
              {details.data.entries.slice(0, 5).map((e, i) => (
                <Row
                  key={e.entryId ?? i}
                  label={<>{e.kind ?? DASH} · {rows?.find((r) => r.fundId === e.fundId)?.name ?? e.fundId}</>}
                  value={<>{numOrNull(e.cost ?? e.proceeds) === null ? DASH : fmtUsd(e.cost ?? e.proceeds, 2)} <Pill>{e.status ?? DASH}</Pill></>}
                  hint={e.at ? fmtWhen(Date.parse(e.at)) : undefined}
                />
              ))}
            </Group>
          )}
        </>
      )}
    </Card>
  );
}

function Holdings({ pnl, rows, onOpen }: { pnl: WealthPnl; rows: WealthRow[] | null; onOpen: (id: string) => void }) {
  const mask = useMask('funds');
  const maskPnl = useMask('pnl');
  if (!pnl.positions.length) return null;
  const nameOf = (p: PnlPosition) => rows?.find((r) => r.fundId === p.fundId)?.name ?? p.fundId;
  return (
    <ul className="sdx-funds">
      {pnl.positions.map((p) => (
        <li key={`${p.fundId}:${p.source ?? ''}`}>
          <a className="sdx-fund" href={`/wealth/${encodeURIComponent(p.fundId)}`} onClick={inPlace(() => onOpen(p.fundId))}>
            <CoinIcon coin={rows?.find((r) => r.fundId === p.fundId)?.coin ?? p.fundId} size={24} />
            <span className="sdx-fund__who">
              <b>{nameOf(p)}</b>
              <small>{mask(numOrNull(p.shares) === null ? DASH : `${fmt(p.shares, 4)} shares`)}{p.source ? ` · ${p.source}` : ''}</small>
            </span>
            <span className="sdx-fund__stack">
              <b>{mask(numOrNull(p.marketValue) === null ? DASH : fmtUsd(p.marketValue, 2))}</b>
              <small className={pnlCls(p.unrealizedPnl)}>{maskPnl(signedUsd(p.unrealizedPnl))}</small>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/* --- one fund ------------------------------------------------------------------------------------ */

function FundDetail({ fundId, row, address, maintenance, onBack }: { fundId: string; row: WealthRow | null; address: string | null; maintenance: boolean; onBack: () => void }) {
  const fund = usePolled(`wealth-fund:${fundId}`, () => fetchFund(fundId), 120_000);
  const [range, setRange] = useState<PriceRange>('1Y');
  const history = usePolled(`wealth-hist:${fundId}:${range}`, () => fetchPriceHistory(fundId, range), 300_000);
  const series = useMemo(() => seriesOf(history.data?.points ?? [], (p) => p.close), [history.data]);
  const f = fund.data ?? row?.fund ?? null;
  const q = row?.quote ?? null;
  const title = row?.name ?? f?.name ?? fundId;
  const basis = yieldBasisLabel(q?.yieldBasis);
  const trade = tradeHref(f);
  const c = f?.chainConfig;
  const sub = f?.subscription;

  if (fund.error && !fund.data && !row) {
    return (
      <>
        <BackLink onBack={onBack} />
        <ReadFailed what={`The fund ${fundId}`} error={fund.error} onRetry={fund.retry} />
      </>
    );
  }

  return (
    <>
      <BackLink onBack={onBack} />
      <ProgrammeHero
        title={title}
        line={f?.name && f.name !== title ? f.name : (q?.symbol ?? fundId)}
        pills={(
          <>
            {row && <Pill>{GROUP_LABEL[row.group]}</Pill>}
            {f?.fundStatus && <Pill tone={f.fundStatus === 'live' ? 'live' : 'warn'} dot>{f.fundStatus}</Pill>}
            {c?.paused && <Pill tone="warn" dot>Paused</Pill>}
            {q?.marketStatus && <Pill title="Market status">{q.marketStatus.replace(/_/g, ' ').toLowerCase()}</Pill>}
          </>
        )}
        aside={<Actions trade={trade} vault={isVault(f)} symbol={f?.spot?.displayName ?? null} maintenance={maintenance} />}
      />

      <Tiles>
        <Tile label="Price" value={price(q?.price)} sub={q?.asOf ? `as of ${fmtWhen(Date.parse(q.asOf))}` : undefined} />
        <Tile label="24H" value={pct(q?.roi24h)} cls={pctCls(q?.roi24h)} />
        <Tile label="1Y" value={pct(q?.roi1Y)} cls={pctCls(q?.roi1Y)} />
        <Tile label="7D APY" value={pct(q?.apy7d)} cls={pctCls(q?.apy7d)} sub={basis ?? undefined} title={q?.yieldBasis} />
      </Tiles>

      <Card title="Price" action={<SegSwitch value={range} onChange={setRange} label="Range" options={PRICE_RANGES.map((v) => ({ v, label: v }))} />}>
        {history.error && !history.data ? (
          <ReadFailed what="The price history" error={history.error} onRetry={history.retry} />
        ) : !history.data ? (
          <SkelRows rows={1} height={260} />
        ) : series.length < 2 ? (
          <EmptyState icon="chart" title="No price history" line="SoDEX has no history for this fund in this range." compact />
        ) : (
          <SeriesChart height={280} series={[{ key: 'close', kind: 'line', color: isLight() ? '#141414' : '#f7f7f7', points: series, format: (v) => fmtUsd(v, 2), title: 'Close' }]} />
        )}
      </Card>

      <div className="sdx-trio">
        <Card title="Returns">
          <Group title="As given">
            <PctFact label="24H" v={q?.roi24h} />
            <PctFact label="1M" v={q?.roi1M} />
            <PctFact label="YTD" v={q?.roiYtd} />
            <PctFact label="1Y" v={q?.roi1Y} />
            <PctFact label="3Y" v={q?.roi3Y} />
            <PctFact label="Since inception" v={q?.roiInception} />
          </Group>
        </Card>
        <Card title="Yield" action={basis ? <Pill title={q?.yieldBasis}>{basis}</Pill> : undefined}>
          <Group title="Annualised">
            <PctFact label="24H APY" v={q?.apy24h} />
            <PctFact label="7D APY" v={q?.apy7d} />
            <PctFact label="1M APY" v={q?.apy1M} />
            <Fact label="Dividend yield" value={numOrNull(q?.dividendYield) === null ? DASH : `${fmt(q?.dividendYield, 2)}%`} cls={numOrNull(q?.dividendYield) === null ? 'pf-dim' : undefined} />
          </Group>
        </Card>
        <Card title="About">
          <Group title="The fund">
            <AboutRows fund={f} q={q} c={c} sub={sub} />
          </Group>
        </Card>
      </div>

      <MyPosition address={address} fundId={fundId} />
    </>
  );
}

function AboutRows({ fund: f, q, c, sub }: { fund: WealthRow['fund']; q: WealthRow['quote']; c: NonNullable<WealthRow['fund']>['chainConfig']; sub: NonNullable<WealthRow['fund']>['subscription'] }) {
  const lines: Array<[string, ReactNode]> = [];
  const push = (label: string, value: ReactNode | null | undefined) => { if (value !== null && value !== undefined && value !== '') lines.push([label, value]); };
  push('Issuer', f?.issuerName);
  push('Share', f?.share?.coin);
  push('Spot market', f?.spot?.displayName);
  push('NAV', numOrNull(f?.nav) === null ? null : price(f?.nav));
  push('AUM', numOrNull(f?.aum) === null ? null : fmtUsd(f?.aum, 0));
  push('Day range', numOrNull(q?.dayLow) === null ? null : `${price(q?.dayLow)} – ${price(q?.dayHigh)}`);
  push('Inception', f?.inceptionDate ? fmtDate(Date.parse(f.inceptionDate)) : null);
  push('Min. subscription', numOrNull(sub?.minimumSubscribeAmount ?? c?.minDeposit) === null ? null : fmtUsd(sub?.minimumSubscribeAmount ?? c?.minDeposit, 0));
  push('Total subscribed', numOrNull(sub?.totalSubscribed) === null ? null : fmtUsd(sub?.totalSubscribed, 0));
  push('Subscribe by', sub?.subscribeDeadline ? fmtDate(sub.subscribeDeadline * 1000) : null);
  const mgmt = ratePct(c?.mgmtFeeRate);
  const perf = ratePct(c?.perfFeeRate);
  push('Management fee', mgmt === null ? null : `${fmt(mgmt, 2)}%`);
  push('Performance fee', perf === null ? null : `${fmt(perf, 2)}%`);
  if (!lines.length) return <Fact label="Details" value={DASH} cls="pf-dim" />;
  return <>{lines.map(([label, value]) => <Fact key={label} label={label} value={value} />)}</>;
}

const PctFact = ({ label, v }: { label: string; v: unknown }) => <Fact label={label} value={pct(v)} cls={pctCls(v)} />;

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <a className="sdx-back" href="/wealth" onClick={inPlace(onBack)}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3.500 5.500 8 10 12.500" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      All funds
    </a>
  );
}

/** A `clob` fund trades on the spot market; a vault's subscribe and redeem are shown as coming, not offered. */
function Actions({ trade, vault, symbol, maintenance }: { trade: string | null; vault: boolean; symbol: string | null; maintenance: boolean }) {
  if (trade) {
    return maintenance
      ? <span className="pf-btn pf-btn--primary sdx-btn-off" aria-disabled="true">Trade held</span>
      : <a className="pf-btn pf-btn--primary" href={trade}>Trade {symbol ?? ''}</a>;
  }
  if (!vault) return null;
  return (
    <div className="sdx-coming">
      <Pill tone="info">Coming</Pill>
      <span className="pf-btn sdx-btn-off" aria-disabled="true">Subscribe</span>
      <span className="pf-btn sdx-btn-off" aria-disabled="true">Redeem</span>
      <a className="pf-btn" href={SODEX_SITE.wealth} target="_blank" rel="noopener noreferrer">Open on SoDEX</a>
    </div>
  );
}

function MyPosition({ address, fundId }: { address: string | null; fundId: string }) {
  const key = address?.toLowerCase();
  const pnl = usePolled(key ? `wealth-pnl:${key}` : null, () => fetchPnl(address as string), 60_000);
  const mask = useMask('funds');
  const maskPnl = useMask('pnl');
  const p = pnl.data?.positions.find((x) => x.fundId === fundId);
  if (!address || !p) return null;
  return (
    <Card title="Your position">
      <Group title={p.source ?? 'Holding'}>
        <Row label="Shares" value={numOrNull(p.shares) === null ? DASH : fmt(p.shares, 4)} />
        <Row label="Average cost" value={price(p.avgCostWithAirdrop)} hint="SoDEX's average cost, airdrops included." />
        <Row label="Value" value={mask(numOrNull(p.marketValue) === null ? DASH : fmtUsd(p.marketValue, 2))} />
        <Row label="Unrealised PnL" privacy="pnl" value={maskPnl(signedUsd(p.unrealizedPnl))} cls={pnlCls(p.unrealizedPnl)} />
        <Row label="24H PnL" privacy="pnl" value={maskPnl(signedUsd(p.pnl24h))} cls={pnlCls(p.pnl24h)} />
      </Group>
    </Card>
  );
}
