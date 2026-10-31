/** ValueDesk's own product analytics (ops/analytics.ts): only visitors who allowed it. */
import { useState } from 'react';
import { BarChart } from '../BarChart';
import { ago, dayLabel, duration, int, pct, short } from '../format';
import { CountList, Empty, Figure, Figures, Note, Page, Section, Seg, useAdmin } from '../ui';
import type { AnalyticsSummary, RecentVisit } from '../types';

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();
const country = (code: string): string => (/^[A-Z]{2}$/.test(code) ? `${regionNames?.of(code) ?? code}` : code === '(none)' ? 'Unknown' : code);

export function Analytics() {
  const [days, setDays] = useState(30);
  const r = useAdmin<{ analytics: AnalyticsSummary | null; recent: RecentVisit[] }>('analytics', { days }, 60_000);
  const a = r.data?.analytics ?? null;
  const t = a?.totals;
  return (
    <Page
      title={t ? `${int(t.visitors)} visitor${t.visitors === 1 ? '' : 's'}` : 'Analytics'}
      line="How ValueDesk is used. Only visitors who allowed analytics are counted; kept on ValueDesk's own server, without IP addresses."
      tone={t && t.visits ? 'pos' : 'unknown'}
      loaded={r}
      wide
      tools={<Seg label="Days shown" value={days} onChange={setDays} options={[{ value: 1, label: 'Today' }, ...[7, 30, 90, 365].map((d) => ({ value: d, label: d === 365 ? '1 year' : `${d} days` }))]} />}
    >
      {r.error && <Section><Note kind="error">{r.error}</Note></Section>}
      {a && t && (
        <>
          {!t.visits && (
            <Section>
              <Empty>No visit counted in this range yet. Visitors are counted from the moment they allow analytics: with "Accept all" when they accept the terms, or with the prompt the site shows everyone who accepted the terms before analytics existed.</Empty>
            </Section>
          )}
          <Section>
            <Figures>
              <Figure label="Visitors" value={int(t.visitors)} sub={`${int(t.newVisitors)} new · ${a.returning.visitors ? pct(a.returning.returning / a.returning.visitors) : '–'} returning`} />
              <Figure label="Visits" value={int(t.visits)} sub={`${t.pagesPerVisit === null ? '–' : t.pagesPerVisit.toFixed(1)} pages each · bounce ${pct(t.bounceRate)}`} />
              <Figure label="Average visit" value={duration(t.avgVisitMs)} sub="active time" />
              <Figure label="On the site now" value={int(t.liveVisits)} sub={`${int(t.wallets)} connected wallets in range`} />
            </Figures>
          </Section>
          {a.days.length > 1 && (
            <Section title="Visitors per day">
              <BarChart title="Visitors" bars={a.days.map((d) => ({ key: d.day, label: dayLabel(d.day), value: d.visitors }))} fmt={(v) => int(v)} />
            </Section>
          )}
          <Section title="Pages: views and time spent" flush>
            <div className="dv-sheet">
              <table className="dv-table">
                <thead><tr><th>Page</th><th className="right">Views</th><th className="right">Visitors</th><th className="right">Average active time</th></tr></thead>
                <tbody>{a.pages.map((p) => <tr key={p.path}><td className="dv-mono">{p.path}</td><td className="right">{int(p.views)}</td><td className="right">{int(p.visitors)}</td><td className="right">{duration(p.avgMs)}</td></tr>)}</tbody>
              </table>
              {!a.pages.length && <div className="dv-sheet__none"><Empty>No page view yet.</Empty></div>}
            </div>
          </Section>
          <Section title="Most used features" flush>
            <div className="dv-sheet">
              <table className="dv-table">
                <thead><tr><th>Feature</th><th className="right">Uses</th><th className="right">Visitors</th></tr></thead>
                <tbody>{a.features.map((f) => <tr key={f.key}><td>{f.label} <span className="dv-quiet dv-mono">{f.key}</span></td><td className="right">{int(f.n)}</td><td className="right">{int(f.visitors)}</td></tr>)}</tbody>
              </table>
              {!a.features.length && <div className="dv-sheet__none"><Empty>No feature used yet.</Empty></div>}
            </div>
          </Section>
          <Section title="Where visitors are, and where they come from">
            <div className="dv-grid">
              <div><h3 className="dv-h3">Countries</h3><CountList rows={a.countries} label={country} /></div>
              <div><h3 className="dv-h3">Regions</h3><CountList rows={a.regions} /></div>
              <div><h3 className="dv-h3">Sources</h3><CountList rows={a.sources} /></div>
              <div><h3 className="dv-h3">Campaigns</h3><CountList rows={a.campaigns} /></div>
              <div><h3 className="dv-h3">Landing pages</h3><CountList rows={a.landing} /></div>
              <div><h3 className="dv-h3">Languages</h3><CountList rows={a.langs} /></div>
            </div>
          </Section>
          <Section title="Devices">
            <div className="dv-grid">
              <div><h3 className="dv-h3">Type</h3><CountList rows={a.devices} /></div>
              <div><h3 className="dv-h3">Browsers</h3><CountList rows={a.browsers} /></div>
              <div><h3 className="dv-h3">Systems</h3><CountList rows={a.os} /></div>
              <div><h3 className="dv-h3">Screens</h3><CountList rows={a.screens} /></div>
              <div>
                <h3 className="dv-h3">Page speed (median · 75th percentile)</h3>
                {a.vitals.length ? (
                  <ul className="dv-counts">
                    {a.vitals.map((v) => (
                      <li key={v.name}>
                        <span className="dv-counts__k">{v.name}</span>
                        <span className="dv-counts__bar" />
                        <span className="dv-counts__n">{v.name === 'CLS' ? `${(v.p50 / 1000).toFixed(3)} · ${(v.p75 / 1000).toFixed(3)}` : `${int(v.p50)} · ${int(v.p75)} ms`}</span>
                      </li>
                    ))}
                  </ul>
                ) : <Empty>Nothing yet.</Empty>}
              </div>
            </div>
          </Section>
          <Section title="Latest visits" flush>
            <div className="dv-sheet">
              <table className="dv-table">
                <thead><tr><th>Last active</th><th>Where</th><th>Device</th><th>From</th><th>Landing</th><th className="right">Pages</th><th className="right">Time</th><th>Wallet</th></tr></thead>
                <tbody>
                  {(r.data?.recent ?? []).map((v, i) => (
                    <tr key={i}>
                      <td>{ago(v.last_at)}</td>
                      <td>{v.country ? `${country(v.country)}${v.region ? ` · ${v.region}` : ''}` : 'Unknown'}</td>
                      <td>{[v.device, v.browser, v.os].filter(Boolean).join(' · ') || '–'}</td>
                      <td>{v.ref ?? 'Direct'}</td>
                      <td className="dv-mono">{v.landing ?? '–'}</td>
                      <td className="right">{int(v.pages)}</td>
                      <td className="right">{duration(v.active_ms)}</td>
                      <td className="dv-mono">{v.wallet ? short(v.wallet) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!(r.data?.recent ?? []).length && <div className="dv-sheet__none"><Empty>No visit yet.</Empty></div>}
            </div>
          </Section>
        </>
      )}
    </Page>
  );
}
