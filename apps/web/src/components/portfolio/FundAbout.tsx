/**
 * What SoDEX publishes about a fund, on its page (FundPage.tsx), through ValueDesk's relay (server
 * routes/wealthInfo.ts): SoDEX's own text in the page's language (English where SoDEX has none), the underlying and
 * its figures, a vault's issuer, launch, fees and minimums, the underlying ETF's holdings, SoDEX's questions and
 * answers, USDC Earn's rules. SoDEX's text is shown as SoDEX wrote it, so the page's translation layer leaves it be
 * (data-no-i18n); ValueDesk's own labels around it translate as usual.
 */
import { useEffect, useState } from 'react';
import { EmptyState, Icon, Panel, Shell, ShellHeader, Skeleton, StatusPill } from '../bots/kit/kit';
import { useLanguage } from '../../i18n/store';
import type { FundView } from '../sodex/wealth/data';
import { CoinIcon } from '../CoinIcon';

export interface FundInfo {
  fundId: string;
  lang: string;
  version: number | null;
  name: string | null;
  market: 'US' | 'CN' | null;
  underlying: { symbol: string | null; fullSymbol: string | null; name: string | null; currency: string | null } | null;
  headline: { title: string | null; subtitle: string | null; points: string[] } | null;
  features: string[];
  about: { title: string | null; body: string[] } | null;
  faq: Array<{ q: string; a: string[]; links: Array<{ label: string; href: string }> }>;
  curator: string | null;
  social: Array<{ type: string; url: string; name: string | null }>;
  holdings: { source: 'live' | 'sodex' | 'chain'; asOf: string | null; total: number | null; stale: boolean; rows: Array<{ name: string; ticker: string | null; weight: number }>; unpriced?: string[] } | null;
  holdingsNote?: string | null;
  underlyingQuote: { since: string | null; marketCap: number | null; high52w: number | null; low52w: number | null; currency: string | null; kind: string | null; pe: number | null } | null;
  vault: { issuer: string | null; launched: string | null; managementFee: number | null; performanceFee: number | null; minDeposit: string | null; minRedeemShares: string | null } | null;
  earn: { minIn: string | null; minOut: string | null; vaultName: string | null; shareToken: string | null; crossChain: string | null; risk: string | null; subscription: string[]; redemption: string[] } | null;
}

const cache = new Map<string, { at: number; p: Promise<FundInfo | null> }>();
/**
 * The logo a holding shows: its ticker, except an option leg (its underlying ETF), the cash lines (USD) and Alphabet's
 * second class (GOOG reads as GOOGL). CoinIcon resolves it from the app's own logo sets; none is fetched at runtime.
 */
export function holdingLogo(ticker: string | null, name: string): string {
  const t = (ticker ?? '').trim().toUpperCase();
  const opt = /^\d?(QQQ|SPY|IWM|DIA)\s/.exec(t) ?? /^(QQQ|SPY|IWM|DIA) \d/.exec(name.toUpperCase());
  if (opt) return opt[1]!;
  if (!t || /^CASH|^FGXXX$|MONEY MARKET|GOV(ERNMENT)? OBLI/i.test(`${t} ${name}`)) return 'USD';
  if (t === 'GOOG') return 'GOOGL';
  return t;
}

export function readInfo(fundId: string, lang: string): Promise<FundInfo | null> {
  const key = `${fundId}|${lang}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p;
  const p = fetch(`/api/vs/wealth/info?fund=${encodeURIComponent(fundId)}&lang=${encodeURIComponent(lang)}`, { signal: AbortSignal.timeout(15_000) })
    .then(async (r) => {
      if (r.status === 404) return null;
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; info?: FundInfo; error?: string };
      if (!r.ok || !b.ok || !b.info) throw new Error(b.error || `SoDEX's fund details answered ${r.status}.`);
      return b.info;
    });
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}

export function useFundInfo(fundId: string): { info: FundInfo | null | undefined; error: string | null } {
  const lang = useLanguage();
  const key = `${fundId}|${lang}`;
  const [s, setS] = useState<{ key: string; info: FundInfo | null | undefined; error: string | null }>({ key: '', info: undefined, error: null });
  useEffect(() => {
    let off = false;
    readInfo(fundId, lang).then((info) => { if (!off) setS({ key, info, error: null }); }, (e: Error) => { if (!off) setS({ key, info: null, error: e.message }); });
    return () => { off = true; };
  }, [fundId, lang, key]);
  return s.key === key ? { info: s.info, error: s.error } : { info: undefined, error: null };
}

const big = (n: number, cur: string | null): string => {
  const sym = cur === 'USD' || !cur ? '$' : '';
  const unit = !cur || cur === 'USD' ? '' : ` ${cur}`;
  return n >= 1e12 ? `${sym}${(n / 1e12).toFixed(2)}T${unit}` : n >= 1e9 ? `${sym}${(n / 1e9).toFixed(1)}B${unit}` : n >= 1e6 ? `${sym}${(n / 1e6).toFixed(1)}M${unit}` : `${sym}${Math.round(n).toLocaleString()}${unit}`;
};
const day = (iso: string | null): string | null => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null);
const feePct = (f: number | null): string | null => (f === null ? null : `${(f * 100).toFixed(f * 100 < 1 ? 2 : 1).replace(/\.0+$/, '')}%`);

export function FundAbout({ v }: { v: FundView }) {
  const { info, error } = useFundInfo(v.id);
  if (info === undefined) {
    return (
      <Shell className="wp-sec">
        <ShellHeader title="About" subtitle="From SoDEX" />
        <Panel className="wp-sec__p"><Skeleton className="wp-bone wp-bone--row" /><Skeleton className="wp-bone wp-bone--row" /></Panel>
      </Shell>
    );
  }
  if (!info) {
    return (
      <Shell className="wp-sec">
        <ShellHeader title="About" subtitle="From SoDEX" />
        <Panel className="wp-sec__p">
          <EmptyState compact tone={error ? 'error' : undefined} icon={error ? 'warning' : 'info'} title={error ? 'SoDEX’s description did not load' : 'SoDEX publishes no description for this fund'} description={error ?? undefined} />
        </Panel>
      </Shell>
    );
  }
  const u = info.underlying;
  const q = info.underlyingQuote;
  const facts: Array<[string, string]> = [];
  if (u?.name) facts.push(['Underlying', `${u.name}${u.fullSymbol ? ` (${u.fullSymbol})` : ''}`]);
  if (info.market) facts.push(['Market', info.market === 'US' ? 'United States' : 'China']);
  if (q?.since) facts.push([q.kind === 'etf' ? 'Underlying ETF since' : 'Underlying listed since', day(q.since)!]);
  if (q?.marketCap) facts.push([q.kind === 'etf' ? 'Underlying fund size' : 'Market value', big(q.marketCap, q.currency)]);
  if (q?.low52w && q?.high52w) facts.push(['52-week range', `${q.low52w.toLocaleString(undefined, { maximumFractionDigits: 2 })} – ${q.high52w.toLocaleString(undefined, { maximumFractionDigits: 2 })}${q.currency && q.currency !== 'USD' ? ` ${q.currency}` : ''}`]);
  if (q?.pe) facts.push(['Price / earnings', q.pe.toFixed(1)]);
  if (info.vault?.issuer) facts.push(['Issuer', info.vault.issuer]);
  else if (info.curator) facts.push(['Curator', info.curator]);
  if (info.vault?.launched) facts.push(['Launched', day(info.vault.launched)!]);
  if (feePct(info.vault?.managementFee ?? null)) facts.push(['Management fee, on chain', `${feePct(info.vault!.managementFee)} a year`]);
  if (info.vault?.performanceFee !== undefined && info.vault?.performanceFee !== null) facts.push(['Performance fee, on chain', feePct(info.vault.performanceFee)!]);
  if (info.vault?.minDeposit) facts.push(['Least to invest', `${info.vault.minDeposit} USDC`]);
  if (info.earn?.minIn) facts.push(['Least to invest', `${info.earn.minIn} USDC`]);
  if (info.earn?.minOut) facts.push(['Least to redeem', `${info.earn.minOut} soUSDC`]);
  if (info.earn?.vaultName) facts.push(['Vault', info.earn.vaultName]);
  const h = info.holdings;
  return (
    <>
      <Shell className="wp-sec">
        <ShellHeader title={info.about?.title ? `About ${info.about.title}` : 'About'} subtitle="From SoDEX" />
        <Panel className="wp-sec__p wp-about">
          {info.headline?.title && (
            <div className="wp-about__head" data-no-i18n="">
              <b>{info.headline.title}</b>
              {info.headline.subtitle && <span>{info.headline.subtitle}</span>}
              {info.headline.points.length > 0 && <span className="wp-about__pts">{info.headline.points.map((p) => <StatusPill key={p} tone="neutral" size="sm" icon="check">{p}</StatusPill>)}</span>}
            </div>
          )}
          {info.about && <div className="wp-about__body" data-no-i18n="">{info.about.body.map((p, i) => <p key={i}>{p}</p>)}</div>}
          {info.features.length > 0 && (
            <ul className="wp-about__feat" data-no-i18n="">
              {info.features.map((f, i) => <li key={i}><Icon name="check" size={14} /><span>{f}</span></li>)}
            </ul>
          )}
          {facts.length > 0 && (
            <dl className="wp-about__facts">
              {facts.map(([k, x]) => <div key={k}><dt>{k}</dt><dd data-no-i18n="">{x}</dd></div>)}
            </dl>
          )}
          {info.earn && (info.earn.subscription.length > 0 || info.earn.crossChain) && (
            <div className="wp-about__steps" data-no-i18n="">
              {info.earn.subscription.length > 0 && <ol>{info.earn.subscription.map((s, i) => <li key={i}>{s}</li>)}</ol>}
              {info.earn.crossChain && <p>{info.earn.crossChain}</p>}
              {info.earn.shareToken && <p>{info.earn.shareToken}</p>}
            </div>
          )}
          {info.earn?.risk && <p className="wp-about__risk" data-no-i18n="">{info.earn.risk}</p>}
          {info.social.length > 0 && (
            <div className="wp-about__links">
              {info.social.map((s) => (
                <a key={s.url} className="tf-btn is-quiet is-sm" href={s.url} target="_blank" rel="noopener noreferrer"><Icon name="share" size={13} />{s.name ?? (s.type === 'telegram' ? 'Telegram' : s.type === 'x' || s.type === 'twitter' ? 'X' : 'Link')}</a>
              ))}
            </div>
          )}
        </Panel>
      </Shell>

      {h && h.rows.length > 0 && (
        <Shell className="wp-sec">
          <ShellHeader
            title="Holdings"
            subtitle={h.source === 'chain'
              ? `${h.rows.length} in the token’s basket, from its own contract, at SoDEX’s prices`
              : h.source === 'live'
              ? `${h.total && h.total > Math.min(15, h.rows.length) ? `Top ${Math.min(15, h.rows.length)} of ${h.total}` : `${h.rows.length}`} of the underlying fund${h.asOf ? `, as of ${day(h.asOf)}` : ''}`
              : 'As SoDEX lists them'}
          />
          <Panel className="wp-sec__p wp-hold">
            {h.rows.slice(0, 15).map((r, i) => (
              <div key={`${r.ticker ?? r.name}${i}`} className="wp-hold__r">
                <span className="wp-hold__i">{i + 1}</span>
                <CoinIcon coin={holdingLogo(r.ticker, r.name)} size={20} />
                <span className="wp-hold__n" data-no-i18n=""><b>{r.name}</b>{r.ticker && r.ticker !== r.name && <small>{r.ticker}</small>}</span>
                <span className="wp-hold__w"><b>{`${(r.weight * 100).toFixed(r.weight >= 0.1 ? 1 : 2)}%`}</b><i style={{ width: `${Math.min(100, (r.weight / h.rows[0]!.weight) * 100)}%` }} aria-hidden="true" /></span>
              </div>
            ))}
            {h.stale && <p className="wp-note">These holdings are more than a week old: the data source has not updated them since.</p>}
            {h.unpriced && h.unpriced.length > 0 && <p className="wp-note">{`Not priced on SoDEX: ${h.unpriced.join(', ')}. The weights are of the rest of the basket.`}</p>}
          </Panel>
        </Shell>
      )}

      {!h && info.holdingsNote && (
        <Shell className="wp-sec">
          <ShellHeader title="Holdings" />
          <Panel className="wp-sec__p"><p className="wp-note" data-no-i18n="">{info.holdingsNote}</p></Panel>
        </Shell>
      )}

      {info.faq.length > 0 && (
        <Shell className="wp-sec">
          <ShellHeader title="Questions" subtitle="SoDEX’s answers" />
          <Panel className="wp-sec__p wp-faq">
            {info.faq.map((f, i) => (
              <details key={i} className="wp-faq__i">
                <summary data-no-i18n=""><span>{f.q}</span><Icon name="down" size={14} /></summary>
                <div className="wp-faq__a" data-no-i18n="">
                  {f.a.map((p, k) => <p key={k}>{p}</p>)}
                  {f.links.length > 0 && <p className="wp-faq__links">{f.links.map((l) => <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a>)}</p>}
                </div>
              </details>
            ))}
          </Panel>
        </Shell>
      )}
    </>
  );
}
