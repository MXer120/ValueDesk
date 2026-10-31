/** ValueDesk's own product analytics (ops/analytics.ts): only visitors who allowed it. */
import { useState } from 'react';
import { BarChart } from '../BarChart';
import { ago, dayLabel, duration, int, pct, short } from '../format';
import { CountList, Note, PageHead, Panel, Seg, Tile, useAdmin } from '../ui';
import type { AnalyticsSummary, RecentVisit } from '../types';

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();
const country = (code: string): string => (/^[A-Z]{2}$/.test(code) ? `${regionNames?.of(code) ?? code} (${code})` : code);

export function Analytics() {
  const [days, setDays] = useState(30);
  const r = useAdmin<{ analytics: AnalyticsSummary | null; recent: RecentVisit[] }>('analytics', { days }, 60_000);
  const a = r.data?.analytics ?? null;
  const t = a?.totals;
  return (
    <>
      <PageHead title="Analytics" line="How ValueDesk is used - only visitors who allowed analytics are counted. Kept on ValueDesk's own server, no IP addresses." loaded={r}>
        <Seg label="Days shown" value={days} onChange={setDays} options={[{ value: 1, label: 'Today' }, ...[7, 30, 90, 365].map((d) => ({ value: d, label: d === 365 ? '1 year' : `${d} days` }))]} />
      </PageHead>
      {r.error && <Note kind="error">{r.error}</Note>}
      {a && t && (
        <>
          {!t.visits && <Note>No visits recorded in this range. Only visitors who allowed analytics are counted (terms popup "Accept all" or the switch on the Cookies page).</Note>}
          <div className="ad-tiles">
            <Tile label="Visitors" value={int(t.visitors)} sub={`${int(t.newVisitors)} new · ${a.returning.visitors ? pct(a.returning.returning / a.returning.visitors) : '–'} returning`} />
            <Tile label="Visits" value={int(t.visits)} sub={`${t.pagesPerVisit === null ? '–' : t.pagesPerVisit.toFixed(1)} pages each`} />
            <Tile label="Page views" value={int(t.views)} />
            <Tile label="Average visit (active time)" value={duration(t.avgVisitMs)} />
            <Tile label="Bounce (one page only)" value={pct(t.bounceRate)} />
            <Tile label="Connected wallets" value={int(t.wallets)} />
            <Tile label="On the site now" value={int(t.liveVisits)} sub="active in the last 5 min" />
          </div>
          {a.days.length > 1 && (
            <Panel title="Visitors per day">
              <BarChart title="Visitors" bars={a.days.map((d) => ({ key: d.day, label: dayLabel(d.day), value: d.visitors }))} fmt={(v) => int(v)} />
            </Panel>
          )}
          <Panel title="Pages: views and time spent">
            <table className="ad-table ad-table--compact">
              <thead><tr><th>Page</th><th className="num">Views</th><th className="num">Visitors</th><th className="num">Avg. active time</th></tr></thead>
              <tbody>
                {a.pages.map((p) => <tr key={p.path}><td className="ad-mono">{p.path}</td><td className="num">{int(p.views)}</td><td className="num">{int(p.visitors)}</td><td className="num">{duration(p.avgMs)}</td></tr>)}
                {!a.pages.length && <tr><td colSpan={4} className="ad-dim">Nothing yet.</td></tr>}
              </tbody>
            </table>
          </Panel>
          <Panel title="Most used features">
            <table className="ad-table ad-table--compact">
              <thead><tr><th>Feature</th><th className="num">Uses</th><th className="num">Visitors</th></tr></thead>
              <tbody>
                {a.features.map((f) => <tr key={f.key}><td>{f.label} <span className="ad-dim ad-mono">{f.key}</span></td><td className="num">{int(f.n)}</td><td className="num">{int(f.visitors)}</td></tr>)}
                {!a.features.length && <tr><td colSpan={3} className="ad-dim">Nothing yet.</td></tr>}
              </tbody>
            </table>
          </Panel>
          <div className="ad-grid3">
            <Panel title="Countries (visits)"><CountList rows={a.countries} label={country} /></Panel>
            <Panel title="Regions"><CountList rows={a.regions} /></Panel>
            <Panel title="Where visits come from"><CountList rows={a.sources} /></Panel>
            <Panel title="Campaigns (utm source / medium / campaign)"><CountList rows={a.campaigns} /></Panel>
            <Panel title="Landing pages"><CountList rows={a.landing} /></Panel>
            <Panel title="Devices"><CountList rows={a.devices} /></Panel>
            <Panel title="Browsers"><CountList rows={a.browsers} /></Panel>
            <Panel title="Operating systems"><CountList rows={a.os} /></Panel>
            <Panel title="Languages"><CountList rows={a.langs} /></Panel>
            <Panel title="Screens"><CountList rows={a.screens} /></Panel>
            <Panel title="Page speed (p50 / p75)">
              {a.vitals.length ? (
                <table className="ad-table ad-table--compact">
                  <tbody>{a.vitals.map((v) => <tr key={v.name}><td>{v.name}</td><td className="num">{v.name === 'CLS' ? (v.p50 / 1000).toFixed(3) : `${int(v.p50)} ms`}</td><td className="num">{v.name === 'CLS' ? (v.p75 / 1000).toFixed(3) : `${int(v.p75)} ms`}</td><td className="num ad-dim">{int(v.n)}</td></tr>)}</tbody>
                </table>
              ) : <p className="ad-dim">Nothing yet.</p>}
            </Panel>
          </div>
          <Panel title="Latest visits">
            <div className="ad-tablewrap">
              <table className="ad-table ad-table--compact">
                <thead><tr><th>Last active</th><th>Where</th><th>Device</th><th>From</th><th>Landing</th><th className="num">Pages</th><th className="num">Time</th><th>Wallet</th></tr></thead>
                <tbody>
                  {(r.data?.recent ?? []).map((v, i) => (
                    <tr key={i}>
                      <td>{ago(v.last_at)}</td>
                      <td>{v.country ? `${v.country}${v.region ? `-${v.region}` : ''}` : '–'}</td>
                      <td>{[v.device, v.browser, v.os].filter(Boolean).join(' · ') || '–'}</td>
                      <td>{v.ref ?? '(direct)'}</td>
                      <td className="ad-mono">{v.landing ?? '–'}</td>
                      <td className="num">{int(v.pages)}</td>
                      <td className="num">{duration(v.active_ms)}</td>
                      <td className="ad-mono">{v.wallet ? short(v.wallet) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}
