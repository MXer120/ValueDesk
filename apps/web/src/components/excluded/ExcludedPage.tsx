/**
 * Excluded wallets (More > Excluded wallets, /excluded): every wallet left out of the cohorts and
 * the liquidation heatmap (server internalWallets.ts, /api/vs/excluded), why, where, and what it
 * holds now - nothing is left out unsaid (owner 2026-10-31).
 *
 * Laid out as the status page is (status/status.css: one card on a page, a toned hero, rows that
 * open): a hero with what this is and when it was read; four figures (wallets, notional left out,
 * by kind, where); the app's own platform dropdown (PlatformSelect) and switch (the leaderboard's
 * lbp-seg) - no controls of the page's own; then one row per entry, largest first, the kind a dot
 * and a word (never a coloured row edge: owner 2026-10-31). A delta-neutral pair is ONE row - its two accounts only mean something
 * together (they cancel out: the row says by how much) - and opens to both books side by side.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { VENUE_LABEL, vsApi, type ExcludedWallet, type Venue } from '../../vsApi';
import { shortAddr } from '../../format';
import { CoinIcon } from '../CoinIcon';
import { VenueLogo } from '../VenueLogo';
import { fmtUsdShort } from '../explore/model';
import { usePolled } from '../explore/cohorts/parts';
import { Modal } from '../Modal';
import { PlatformSelect } from '../PlatformSelect';
import './excluded.css';

type Kind = ExcludedWallet['kind'];
const KINDS: readonly Kind[] = ['internal', 'hedged', 'mirror'];
const KIND_LABEL: Record<Kind, string> = { internal: 'Venue account', hedged: 'Hedged desk', mirror: 'Delta-neutral pair' };
const KIND_PLURAL: Record<Kind, string> = { internal: 'Venue accounts', hedged: 'Hedged desks', mirror: 'Delta-neutral pairs' };
const KIND_SHORT: Record<Kind, string> = { internal: 'venue', hedged: 'hedged', mirror: 'delta-neutral' };
const KIND_HINT: Record<Kind, string> = {
  internal: "The venue's own accounts: one book split across two, not a trade.",
  hedged: 'Desks that only hedge what they hold elsewhere: no view on the market.',
  mirror: 'Two accounts holding exact opposites of each other: together they hold nothing.',
};

/** One row: a wallet, or a pair of twins shown as one. */
interface Entry {
  key: string;
  kind: Kind;
  venue: Venue;
  wallets: ExcludedWallet[];
  long: number;
  short: number;
}

const gross = (e: Entry) => e.long + e.short;

/** Twins (`twin`) become one entry; everything else its own. Largest first. */
function entriesOf(rows: readonly ExcludedWallet[]): Entry[] {
  const by = new Map(rows.map((w) => [`${w.venue}|${w.address}`, w]));
  const done = new Set<string>();
  const out: Entry[] = [];
  for (const w of rows) {
    const k = `${w.venue}|${w.address}`;
    if (done.has(k)) continue;
    done.add(k);
    const t = w.twin ? by.get(`${w.venue}|${w.twin}`) : undefined;
    if (t) done.add(`${t.venue}|${t.address}`);
    const ws = t ? [w, t] : [w];
    out.push({ key: k, kind: w.kind, venue: w.venue, wallets: ws, long: ws.reduce((a, x) => a + x.long, 0), short: ws.reduce((a, x) => a + x.short, 0) });
  }
  return out.sort((a, b) => gross(b) - gross(a));
}

/** What a pair still holds once its two books are added: per coin, then summed (the "cancels to"). */
function pairNet(e: Entry): number {
  const net = new Map<string, number>();
  for (const w of e.wallets) for (const c of w.coins) net.set(c.coin, (net.get(c.coin) ?? 0) + c.usd);
  let n = 0;
  for (const v of net.values()) n += Math.abs(v);
  return n;
}

const signed = (v: number) => `${v < 0 ? '−' : '+'}${fmtUsdShort(Math.abs(v))}`;

/** The page under More (/excluded). */
export function ExcludedPage() {
  return (
    <main className="ex">
      <article className="ex-card"><ExcludedView hero /></article>
    </main>
  );
}

/** The button beside Positions known on Cohorts: the same view in a dialog. */
export function ExcludedButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="coh-excl" onClick={() => setOpen(true)} title="Wallets left out of the cohorts and the liquidation heatmap, and why">
        Excluded wallets
      </button>
      <Modal open={open} title="Excluded wallets" size="lg" onClose={() => setOpen(false)}>
        <div className="ex-in-modal">
          <p className="ex-hero__line">{LEAD}</p>
          <ExcludedView on={open} />
        </div>
      </Modal>
    </>
  );
}

const LEAD = "Accounts left out of every cohort and the liquidation heatmap because they hold no view on the market. Their open interest is also taken off the venue's, so coverage still compares like with like.";

/** The figures, filters and rows; `hero` adds the page's headline. Read while `on`. */
function ExcludedView({ on = true, hero = false }: { on?: boolean; hero?: boolean }) {
  const r = usePolled(on ? 'excluded' : null, (signal) => vsApi.excluded(signal));
  const rows = useMemo(() => r.data?.wallets ?? [], [r.data]);
  const all = useMemo(() => entriesOf(rows), [rows]);
  const venues = useMemo(() => [...new Set(all.map((e) => e.venue))], [all]);
  const [kind, setKind] = useState<Kind | 'all'>('all');
  // The platforms picked (null: every one listed).
  const [picked, setPicked] = useState<Venue[] | null>(null);
  const chosen = picked ?? venues;
  const [open, setOpen] = useState<string | null>(null);
  const shown = all.filter((e) => (kind === 'all' || e.kind === kind) && chosen.includes(e.venue));
  const notional = rows.reduce((a, w) => a + w.long + w.short, 0);
  const read = rows.filter((w) => w.at !== null).length;
  const at = rows.reduce((a, w) => Math.max(a, w.at ?? 0), 0);

  return (
    <div className="ex-view" aria-busy={r.loading}>
        {hero && <header className="ex-hero">
          <svg className="ex-hero__icon" viewBox="0 0 20 20" width="34" height="34" aria-hidden="true">
            <circle cx="10" cy="10" r="8.4" />
            <path d="M5.2 14.8 14.8 5.2" />
          </svg>
          <div className="ex-hero__text">
            <h1 className="ex-hero__title">Excluded wallets</h1>
            <p className="ex-hero__line">{LEAD}</p>
          </div>
          <span className="ex-updated">{at > 0 ? `Updated ${new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
        </header>}

        {r.error && !r.data ? (
          <div className="ex-state">
            <b>The list could not be read</b>
            <span>{r.error}</span>
            <button type="button" className="ex-retry" onClick={r.retry}>Try again</button>
          </div>
        ) : !r.data ? (
          <Skeleton />
        ) : (
          <>
            <section className="ex-stats" aria-label="Summary">
              <Stat label="Wallets" value={String(rows.length)} sub={`${all.length} entries · ${venues.length} venues`} />
              <Stat
                label="Notional left out"
                value={read ? fmtUsdShort(notional) : '–'}
                sub={read === rows.length ? 'long + short, at the marks' : read ? `${read} of ${rows.length} wallets read so far` : 'reading their positions…'}
              />
              <Stat
                label="By kind"
                value={
                  <span className="ex-kinds">
                    {KINDS.filter((k) => rows.some((w) => w.kind === k)).map((k) => (
                      <span key={k} className={`ex-kindn is-${k}`}><i aria-hidden="true" />{rows.filter((w) => w.kind === k).length}</span>
                    ))}
                  </span>
                }
                sub={KINDS.filter((k) => rows.some((w) => w.kind === k)).map((k) => KIND_SHORT[k]).join(' · ')}
              />
              <Stat label="Excluded from" value={<span className="ex-from"><From what="cohorts" /><From what="heatmap" /></span>} sub="every wallet listed here" />
            </section>

            {/* The app's own controls: the platform dropdown and the leaderboard's switch. */}
            <div className="lbp ex-bar">
              <div className="lbp-bar">
                <div className="lbp-seg" role="radiogroup" aria-label="Kind">
                  {(['all', ...KINDS] as const).filter((k) => k === 'all' || all.some((e) => e.kind === k)).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}>
                      {k === 'all' ? 'All' : KIND_PLURAL[k]}
                    </button>
                  ))}
                </div>
                <PlatformSelect options={venues} value={chosen} onChange={(v) => setPicked(v.length === venues.length ? null : v)} align="end" className="ex-platforms" />
              </div>
            </div>

            {kind !== 'all' && <p className="ex-hint">{KIND_HINT[kind]}</p>}

            {shown.length === 0 ? (
              <div className="ex-state"><b>Nothing here</b><span>No excluded wallet matches this kind and these venues.</span></div>
            ) : (
              <ul className="ex-rows">
                {shown.map((e) => (
                  <Row key={e.key} e={e} open={open === e.key} onToggle={() => setOpen((o) => (o === e.key ? null : e.key))} />
                ))}
              </ul>
            )}
          </>
        )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub: string }) {
  return (
    <div className="ex-stat">
      <span className="ex-stat__label">{label}</span>
      <span className="ex-stat__value">{value}</span>
      <span className="ex-stat__sub">{sub}</span>
    </div>
  );
}

function From({ what }: { what: 'cohorts' | 'heatmap' }) {
  return (
    <span className="ex-chip" title={what === 'cohorts' ? 'Not counted in any cohort' : 'No liquidation level on the heatmap'}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        {what === 'cohorts'
          ? <><circle cx="5.5" cy="6" r="2.2" /><circle cx="10.8" cy="6" r="2.2" /><path d="M1.8 13c.6-2.2 2-3.2 3.7-3.2s3.1 1 3.7 3.2M8.6 13c.4-1.6 1.3-2.6 2.2-2.9 1.7-.5 3 .7 3.4 2.9" /></>
          : <><rect x="2" y="2.5" width="12" height="11" rx="1.6" /><path d="M2 6.5h12M2 9.5h12M6 2.5v11M10 2.5v11" /></>}
      </svg>
      {what === 'cohorts' ? 'Cohorts' : 'Heatmap'}
    </span>
  );
}

/** Long and short as one bar: green from the left, red from the right, sized to the larger. */
function Split({ long, short }: { long: number; short: number }) {
  const g = long + short || 1;
  return (
    <span className="ex-split" aria-label={`Long ${fmtUsdShort(long)}, short ${fmtUsdShort(short)}`}>
      <span className="ex-split__nums"><b className="is-long">{fmtUsdShort(long)}</b><b className="is-short">{fmtUsdShort(short)}</b></span>
      <span className="ex-split__bar"><i className="is-long" style={{ width: `${(long / g) * 100}%` }} /><i className="is-short" style={{ width: `${(short / g) * 100}%` }} /></span>
    </span>
  );
}

function Row({ e, open, onToggle }: { e: Entry; open: boolean; onToggle: () => void }) {
  const pair = e.wallets.length === 2;
  const [a, b] = e.wallets;
  const title = pair ? (e.kind === 'mirror' ? `${VENUE_LABEL[e.venue]} delta-neutral pair` : (a!.label ?? '').replace(/\s*\((long|short)\)$/i, '')) : a!.label ?? shortAddr(a!.address);
  const net = pair ? pairNet(e) : 0;
  // A book not read yet (just after the API starts, or a wallet the index has not reached): said, never $0.
  const unread = e.wallets.every((w) => w.at === null);
  return (
    <li className={`ex-row is-${e.kind}${open ? ' is-open' : ''}`}>
      <button type="button" className="ex-row__bar" aria-expanded={open} onClick={onToggle}>
        <VenueLogo venue={e.venue} size={22} className="ex-row__logo" />
        <span className="ex-row__who">
          <b>{title}</b>
          <small>
            {VENUE_LABEL[e.venue]} · {pair ? <>{shortAddr(a!.address)} <span aria-hidden="true">⇄</span> {shortAddr(b!.address)}</> : shortAddr(a!.address)}
          </small>
        </span>
        <span className={`ex-kind is-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
        <span className="ex-row__exp">
          {unread ? (
            <span className="ex-unread">Positions not read yet</span>
          ) : pair ? (
            <span className="ex-pairnet" title="What the two books still hold once added together">
              <span><b>{fmtUsdShort(gross(e) / 2)}</b> a side</span>
              <small>cancels to {fmtUsdShort(net)} ({((net / (gross(e) / 2 || 1)) * 100).toFixed(1)}%)</small>
            </span>
          ) : (
            <Split long={e.long} short={e.short} />
          )}
        </span>
        <svg className="ex-row__chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="ex-row__body">
          <p className="ex-why">{pair && e.kind === 'mirror'
            ? `Each account holds the exact opposite of the other, about ${fmtUsdShort(gross(e) / 2)} a side: together the two hold ${fmtUsdShort(net)}, nothing that is a view on the market.`
            : a!.why}</p>
          <div className={`ex-books${pair ? ' is-pair' : ''}`}>
            {e.wallets.map((w) => <Book key={w.address} w={w} />)}
          </div>
          <p className="ex-meta">
            Excluded since {a!.since} · from <From what="cohorts" /> <From what="heatmap" />
          </p>
        </div>
      )}
    </li>
  );
}

function Book({ w }: { w: ExcludedWallet }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(w.address).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }, () => {});
  return (
    <div className="ex-book">
      <div className="ex-book__head">
        <span className="ex-addr">{shortAddr(w.address)}</span>
        <button type="button" className="ex-copy" onClick={copy} title="Copy the address">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <dl className="ex-figs">
        <div><dt>Equity</dt><dd>{w.equity === null ? '–' : fmtUsdShort(w.equity)}</dd></div>
        <div><dt>Long</dt><dd className="is-long">{w.at === null ? '–' : fmtUsdShort(w.long)}</dd></div>
        <div><dt>Short</dt><dd className="is-short">{w.at === null ? '–' : fmtUsdShort(w.short)}</dd></div>
      </dl>
      {w.coins.length > 0 ? (
        <ul className="ex-coins" aria-label="Largest positions">
          {w.coins.slice(0, 6).map((c) => (
            <li key={c.coin} className={c.usd < 0 ? 'is-short' : 'is-long'}>
              <CoinIcon coin={c.coin} size={14} />
              <span>{c.coin}</span>
              <b>{signed(c.usd)}</b>
            </li>
          ))}
        </ul>
      ) : <p className="ex-none">{w.at === null ? 'Its book has not been read yet.' : 'No open positions.'}</p>}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="ex-skel" aria-hidden="true">
      <div className="ex-stats">{[0, 1, 2, 3].map((i) => <div key={i} className="ex-stat ex-skel__block" />)}</div>
      <ul className="ex-rows">{[0, 1, 2, 3, 4].map((i) => <li key={i} className="ex-row ex-skel__row" />)}</ul>
    </div>
  );
}
