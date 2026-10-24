/**
 * The news button's settings (a right-click on it; Chart.tsx): news on or
 * off, whose news - this coin's, macro and economy, or all of crypto - which
 * kinds of story, each with its icon, and the economic calendar's releases.
 * The button itself only switches news on and off.
 */
import { CoinIcon } from '../components/CoinIcon';
import { PoweredBy } from '../components/news/PoweredBy';
import { CHART_ICONS, NEWS_ICONS } from './chartIcons';
import { NEWS_KINDS, NEWS_KIND_LABEL, type ChartShow, type NewsKind, type NewsScope } from './chartMarks';

export interface NewsSettingsProps {
  show: ChartShow;
  /** The chart's coin as the news names it (BTC); '' when there is none. */
  coin: string;
  onChange: (patch: Partial<ChartShow>) => void;
}

export function NewsSettings({ show, coin, onChange }: NewsSettingsProps) {
  const scopes: Array<{ id: NewsScope; label: string; hint: string; icon: JSX.Element }> = [
    { id: 'coin', label: coin ? `${coin} only` : 'This coin', hint: `Stories about ${coin || 'the coin on this chart'}`, icon: coin ? <CoinIcon coin={coin} size={16} /> : NEWS_ICONS.news },
    { id: 'macro', label: 'Macro & economy', hint: 'Rates, inflation, markets, policy', icon: NEWS_ICONS.macro },
    { id: 'all', label: 'All of crypto', hint: 'Every coin, the latest first', icon: CHART_ICONS.news },
  ];
  const toggleKind = (k: NewsKind) => {
    const on = show.newsKinds.includes(k);
    // Never none: the last one stays.
    if (on && show.newsKinds.length === 1) return;
    onChange({ newsKinds: on ? show.newsKinds.filter((x) => x !== k) : NEWS_KINDS.filter((x) => x === k || show.newsKinds.includes(x)) });
  };

  return (
    <div className="kc-newsset">
      <label className="kc-newsset__switch">
        <span>News on the chart</span>
        <input type="checkbox" role="switch" checked={show.news} onChange={(e) => onChange({ news: e.target.checked })} />
      </label>

      <div className="kc-menu-label">From</div>
      <div className="kc-newsset__scopes" role="radiogroup" aria-label="Whose news">
        {scopes.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={show.newsScope === s.id}
            className={`kc-newsset__scope${show.newsScope === s.id ? ' on' : ''}`}
            disabled={s.id === 'coin' && !coin}
            onClick={() => onChange({ newsScope: s.id, news: true })}
          >
            <span className="kc-newsset__ico">{s.icon}</span>
            <span className="kc-newsset__txt">
              <span>{s.label}</span>
              <span className="kc-newsset__hint">{s.hint}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="kc-menu-label">Show</div>
      <div className="kc-newsset__kinds" role="group" aria-label="Kinds of story">
        {NEWS_KINDS.map((k) => {
          const on = show.newsKinds.includes(k);
          return (
            <button key={k} type="button" aria-pressed={on} className={`kc-newsset__kind${on ? ' on' : ''}`} onClick={() => toggleKind(k)} title={on ? `Hide ${NEWS_KIND_LABEL[k].toLowerCase()}` : `Show ${NEWS_KIND_LABEL[k].toLowerCase()}`}>
              {NEWS_ICONS[k]}
              {NEWS_KIND_LABEL[k]}
            </button>
          );
        })}
      </div>
      <div className="kc-menu-label">Economic calendar</div>
      <label className="kc-newsset__cal">
        <span className="kc-newsset__ico">{NEWS_ICONS.event}</span>
        <span className="kc-newsset__txt">
          <span>Releases on the chart</span>
          <span className="kc-newsset__hint">Fed meetings, CPI, jobs, GDP, PCE - the coming ones right of the last candle</span>
        </span>
        <input type="checkbox" role="switch" checked={show.calendar} onChange={(e) => onChange({ calendar: e.target.checked })} />
      </label>
      <label className={`kc-newsset__minor${show.calendar ? '' : ' is-off'}`}>
        <input type="checkbox" checked={show.calendarMinor} disabled={!show.calendar} onChange={(e) => onChange({ calendarMinor: e.target.checked })} />
        Minor releases too (PMIs, housing)
      </label>
      <p className="kc-newsset__src">
        <PoweredBy more />
      </p>
    </div>
  );
}
