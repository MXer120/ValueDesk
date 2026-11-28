/**
 * Every fund on the Wealth page, the way the Desk version shows them (owner 2026-11-28: "all funds element ... should
 * look like desk versions there with the "preview" on the right"): the list by shelf with each fund's 30-day spark and
 * lead figure on the left, the picked fund's chart, figures, channel and times on the right. The parts and their look
 * are the Desk version's own (sodex/wealth/parts.tsx, data.ts, wealth.css); the ways in and out are ValueDesk's, all in
 * the app: Trade on the order book, Invest and Redeem in the page's sheets, USDC Earn's own sheet, Recurring Buy.
 * On a phone the list opens the fund in a sheet.
 */
import { useState } from 'react';
import { Modal } from '../Modal';
import { Button, Panel, Segmented, Shell, ShellHeader, Skeleton } from '../bots/kit/kit';
import { useMediaQuery } from '../../hooks';
import type { FundShelf } from '../../trading/wealth';
import { useNow } from '../sodex/parts';
import { SHELVES, pctText, useFundViews, val, type FundView } from '../sodex/wealth/data';
import { FundDetail, FundMark, RowSpark, Signed, type WealthCtx } from '../sodex/wealth/parts';
import { openWealth } from './WealthHero';
import { openPath } from '../../nav';
import { WEALTH_PATH } from './wealthRoute';
import type { WealthState } from './useWealth';
import '../bots/kit/kit.css';
import '../bots/botsPages.css';
import '../sodex/wealth/wealth.css';
import './wealthHero.css';

type ShelfPick = 'All' | FundShelf;
const SHELF_SHORT: Readonly<Record<FundShelf, string>> = { 'Stable Earn': 'Earn', 'Curated ETF': 'ETFs', Specialty: 'Specialty' };

/**
 * The fund's ways in and out, on ValueDesk, and its full page (owner 2026-11-28: "a full info page for every asset").
 * Closed: no way in; the channel pill says why.
 */
export function FundActs({ v, onOpenMarket, recurring, details = true }: { v: FundView; onOpenMarket: (symbol: string, engine: 'spot') => void; recurring: ReadonlySet<string>; details?: boolean }) {
  // SoDEX does not offer it now (trading/listing.ts): no way in; what is held can still go out.
  const soon = !!v.fund.comingSoon;
  const a = soon && !v.holding ? null : v.action;
  const held = !!v.holding;
  const earn = v.fund.fundType === 'bridged_vault' && !soon;
  return (
    <div className="wv-detail__acts">
      {details && <Button size="md" variant="secondary" className="wv-wide" icon="info" onClick={() => openPath(WEALTH_PATH.fund(v.id))}>Details</Button>}
      {soon && <Button size="md" variant="secondary" className="wv-wide" disabled title={v.fund.comingSoon}>Coming soon</Button>}
      {earn && <Button size="md" variant="primary" className="wv-wide" onClick={() => openWealth({ kind: 'earn', side: 'buy' })}>Subscribe</Button>}
      {earn && held && <Button size="md" variant="secondary" className="wv-wide" onClick={() => openWealth({ kind: 'earn', side: 'sell' })}>Redeem</Button>}
      {/* sodex.com's words: an order-book fund is bought and sold, a vault, USDC Earn or an SSI index subscribed and redeemed. */}
      {a?.kind === 'trade' && !soon && <Button size="md" variant="primary" className="wv-wide" onClick={() => onOpenMarket(a.symbol, 'spot')}>Buy</Button>}
      {a?.kind === 'trade' && held && <Button size="md" variant="secondary" className="wv-wide" onClick={() => onOpenMarket(a.symbol, 'spot')}>Sell</Button>}
      {(a?.kind === 'batch' || a?.kind === 'rfq') && !soon && <Button size="md" variant="primary" className="wv-wide" onClick={() => openWealth({ kind: 'vault', fundId: v.id, side: 'buy' })}>Subscribe</Button>}
      {(a?.kind === 'batch' || a?.kind === 'rfq') && held && <Button size="md" variant="secondary" className="wv-wide" onClick={() => openWealth({ kind: 'vault', fundId: v.id, side: 'sell' })}>Redeem</Button>}
      {recurring.has(v.id) && !soon && <Button size="md" variant="secondary" className="wv-wide" onClick={() => openWealth({ kind: 'recurring', fundId: v.id })}>Recurring Buy</Button>}
    </div>
  );
}

function FundList({ views, sel, onPick }: { views: FundView[] | null; sel: string | null; onPick: (id: string) => void }) {
  const [shelf, setShelf] = useState<ShelfPick>('All');
  const groups = SHELVES.map((s) => ({ s, funds: (views ?? []).filter((v) => v.shelf === s && (shelf === 'All' || shelf === s)) })).filter((g) => g.funds.length > 0);
  return (
    <Shell className="wv-list">
      <ShellHeader
        title="All funds"
        subtitle={views ? `${views.length} on SoDEX Wealth` : 'Reading'}
        aside={<Segmented size="sm" label="Shelf" value={shelf} onChange={setShelf} options={[{ value: 'All', label: 'All' }, ...SHELVES.map((s) => ({ value: s, label: SHELF_SHORT[s] }))]} />}
      />
      <Panel className="wv-list__p">
        {!views ? [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="wv-list__bone" />) : groups.map((g) => (
          <div key={g.s} role="group" aria-label={g.s}>
            <p className="wv-list__g">{g.s}<span>{g.funds.length}</span></p>
            {g.funds.map((v) => {
              const roi = v.head.kind === 'roi';
              const d = val(v.quote?.roi24h);
              return (
                <button key={v.id} type="button" className={`wv-li${sel === v.id ? ' is-on' : ''}`} aria-current={sel === v.id || undefined} onClick={() => onPick(v.id)}>
                  <FundMark v={v} size={34} />
                  <span className="wv-li__t"><b>{v.name}</b><small>{v.ticker}{v.holding ? <i className="wv-li__held" title="You hold this"> · yours</i> : null}</small></span>
                  <RowSpark v={v} w={64} h={26} />
                  <span className="wv-li__n">
                    <Signed v={roi ? v.head.value : null}><b>{pctText(v.head.value, roi)}</b></Signed>
                    <small>{v.head.short}{d !== null && <> · <Signed v={d}>{pctText(d)}</Signed></>}</small>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </Panel>
    </Shell>
  );
}

export function FundDesk({ w, address, refreshToken, onOpenMarket, recurring }: {
  w: WealthState;
  address: string | null;
  refreshToken: number;
  onOpenMarket: (symbol: string, engine: 'spot') => void;
  /** The funds SoDEX's recurring-buy contract takes. */
  recurring: ReadonlySet<string>;
}) {
  const views = useFundViews(w);
  const now = useNow(15_000);
  const narrow = useMediaQuery('(max-width: 900px)');
  const [pick, setPick] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const selected = views ? (views.find((v) => v.id === pick) ?? views.find((v) => v.holding) ?? views[0] ?? null) : null;
  const sheetView = views?.find((v) => v.id === sheet) ?? null;
  // The Desk parts' context: its own sheet opener goes to the page's sheets (WealthTab listens).
  const ctx: WealthCtx = { address, refreshToken, onOpenMarket, onSheet: (t) => openWealth({ kind: 'vault', fundId: t.fund.fundId, side: t.side }) };
  return (
    <section className="tf wv wh-desk" aria-label="All funds">
      <div className="wv-desk">
        <FundList views={views} sel={narrow ? null : selected?.id ?? null} onPick={(id) => (narrow ? setSheet(id) : setPick(id))} />
        {!narrow && (
          <Shell className="wv-pane">
            <Panel className="wv-pane__p">
              {selected ? (
                <>
                  <FundDetail key={selected.id} v={selected} ctx={ctx} now={now} chartHeight={260} actions={false} asOf={false} />
                  <FundActs v={selected} onOpenMarket={onOpenMarket} recurring={recurring} />
                </>
              ) : <Skeleton className="wv-pane__bone" />}
            </Panel>
          </Shell>
        )}
      </div>
      {narrow && (
        <Modal
          open={!!sheetView}
          title={sheetView ? <span className="wv-sheet__title"><FundMark v={sheetView} size={28} />{sheetView.name}</span> : ''}
          onClose={() => setSheet(null)}
          size="lg"
          sheet
          className="tf wv-modal"
          footer={sheetView ? <FundActs v={sheetView} onOpenMarket={(s, e) => { setSheet(null); onOpenMarket(s, e); }} recurring={recurring} /> : undefined}
        >
          {sheetView && <FundDetail v={sheetView} ctx={ctx} now={now} head={false} chartHeight={220} actions={false} asOf={false} />}
        </Modal>
      )}
    </section>
  );
}
