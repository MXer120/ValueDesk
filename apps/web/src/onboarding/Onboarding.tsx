/**
 * The first-signup flow (model.ts says who sees it): a username, top traders to track, the main
 * features one per screen, every major feature at a glance, and dark or light as the last choice.
 *
 * A page of its own over the app, not a dialog. Everything on it is real: the trader table is the
 * leaderboard's own answer and Track writes the same watchlist as the search palette; the feature
 * screens' pictures are captures of the app (tools/capture-onboarding.mjs); what is not open to
 * everyone yet says so on its tile.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { BrandMark } from '../components/BrandMark';
import { Avatar, Spark, useTraderPeek } from '../components/copy/TraderCard';
import { PlatformSelect } from '../components/PlatformSelect';
import { VenueLogo } from '../components/VenueLogo';
import { LB_VENUES } from '../components/leaderboard/lbState';
import { LS_WATCHLIST, readList, readTraderRefs, traderKey, writeList, type TraderRef } from '../components/palette/model';
import { DASH, fmtUsd, shortAddr } from '../format';
import { useAsync } from '../hooks';
import { setTheme, useTheme, type Theme } from '../theme';
import { VENUE_LABEL, vsApi, type TraderRow, type Venue } from '../vsApi';
import { WalletError, type Eip1193Provider } from '../wallet';
import { USERNAME_MAX, usernameProblem, usernameProblemText } from '@sign/profiles/claim';
import { WATCHLIST_EVENT, stepsOf, writeProgress, type Mode, type Step } from './model';
import { ProfileError, checkName, claimUsername, useUsername } from './profile';

/* ------------------------------------------------------------------ the frame ----- */

export function Onboarding({ mode, startAt, address, provider, onEnd }: {
  mode: Mode;
  startAt: Step | null;
  address: string;
  provider: Eip1193Provider | null;
  onEnd: (finished: boolean) => void;
}) {
  const username = useUsername(address);
  /* The list is fixed when the flow opens, so taking the name on the first step does not renumber the rest. */
  const [steps] = useState<readonly Step[]>(() => stepsOf(mode, mode !== 'username' && !!username && startAt !== 'username'));
  const [index, setIndex] = useState(() => Math.max(0, startAt ? steps.indexOf(startAt) : 0));
  const step = steps[index]!;
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode === 'signup') writeProgress(address, { step, closed: false });
    root.current?.scrollTo({ top: 0 });
    root.current?.querySelector<HTMLElement>('[data-onb-first]')?.focus({ preventScroll: true });
  }, [address, mode, step]);

  /* Nothing behind it scrolls while it is up, and the app's toasts wait (the wallet's "connected", the indexing card). */
  useEffect(() => {
    const body = document.body.style;
    const before = body.overflow;
    body.overflow = 'hidden';
    document.documentElement.classList.add('onb-open');
    return () => {
      body.overflow = before;
      document.documentElement.classList.remove('onb-open');
    };
  }, []);

  const next = useCallback(() => {
    if (index >= steps.length - 1) onEnd(true);
    else setIndex(index + 1);
  }, [index, steps.length, onEnd]);
  const back = index > 0 ? () => setIndex(index - 1) : null;

  /* The next feature's pictures are in by the time it is asked for. */
  useEffect(() => { preloadAround(step); }, [step]);

  return (
    <div className="onb" ref={root} role="dialog" aria-modal="true" aria-label="Getting started" data-step={step}>
      <header className="onb__bar">
        <div className="onb__lead">
          {back
            ? <button type="button" className="onb__back" onClick={back} aria-label="Back"><Chevron /></button>
            : <span className="onb__brand"><BrandMark size={22} /><span>ValueDesk</span></span>}
        </div>
        {steps.length > 1 && (
          <ol className="onb__steps" aria-label={`Step ${index + 1} of ${steps.length}`}>
            {steps.map((s, i) => <li key={s} className={i < index ? 'is-done' : i === index ? 'is-on' : ''} />)}
          </ol>
        )}
        <div className="onb__trail">
          <button type="button" className="onb__skip" onClick={() => onEnd(false)}>{mode === 'signup' ? 'Skip' : 'Close'}</button>
        </div>
      </header>
      <main className="onb__main">
        <div key={step} className="onb__view">
          {step === 'username' && <UsernameStep address={address} provider={provider} onDone={next} />}
          {step === 'traders' && <TradersStep onNext={next} />}
          {(step === 'copy' || step === 'heatmap' || step === 'flow') && <FeatureStep feature={step} onNext={next} />}
          {step === 'overview' && <OverviewStep onNext={next} />}
          {step === 'theme' && <ThemeStep onNext={next} />}
        </div>
      </main>
    </div>
  );
}

const Chevron = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
);

function Head({ title, line }: { title: string; line: ReactNode }) {
  return (
    <div className="onb__head">
      <h1 tabIndex={-1} data-onb-first>{title}</h1>
      <p>{line}</p>
    </div>
  );
}

/* -------------------------------------------------------------- 1: the username ----- */

type Check = { at: 'idle' | 'checking' | 'free' } | { at: 'no'; why: string };

function UsernameStep({ address, provider, onDone }: { address: string; provider: Eip1193Provider | null; onDone: () => void }) {
  const have = useUsername(address);
  const [name, setName] = useState('');
  const [check, setCheck] = useState<Check>({ at: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hint = useId();

  /* The rules at once, the server's "taken" a moment after the last key. */
  useEffect(() => {
    setError(null);
    if (!name) { setCheck({ at: 'idle' }); return; }
    const problem = usernameProblem(name);
    if (problem) { setCheck({ at: 'no', why: usernameProblemText(problem) }); return; }
    setCheck({ at: 'checking' });
    const stop = new AbortController();
    const t = setTimeout(() => {
      checkName(name, stop.signal).then(
        (r) => setCheck(r.available ? { at: 'free' } : { at: 'no', why: r.reason ?? 'This username is taken.' }),
        (e) => { if (!stop.signal.aborted) setCheck({ at: 'no', why: e instanceof Error ? e.message : 'The check did not answer. Try again.' }); },
      );
    }, 260);
    return () => { clearTimeout(t); stop.abort(); };
  }, [name]);

  const ready = check.at === 'free' && !busy && !!provider;
  const take = async () => {
    if (!ready || !provider) return;
    setBusy(true);
    setError(null);
    try {
      await claimUsername(provider, address, name);
      onDone();
    } catch (e) {
      if (e instanceof ProfileError && e.code === 'has-name') { onDone(); return; }
      if (e instanceof ProfileError && e.code === 'taken') setCheck({ at: 'no', why: 'This username was just taken.' });
      else setError(e instanceof WalletError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /* This wallet has one already (taken in another tab): nothing to ask. */
  if (have) {
    return (
      <div className="onb-narrow">
        <Head title={`You are ${have}`} line="This wallet already has its username. It can't be changed." />
        <button type="button" className="fx-cta fx-cta--lg" onClick={onDone}>Continue</button>
      </div>
    );
  }

  return (
    <form className="onb-narrow" onSubmit={(e) => { e.preventDefault(); void take(); }}>
      <Head title="Set your username" line="It stands for this wallet on ValueDesk. You can't change it later." />
      <input
        className={`fx-input onb-input${check.at === 'no' ? ' is-bad' : ''}`}
        value={name}
        onChange={(e) => setName(e.target.value.trim())}
        placeholder="Your username…"
        aria-label="Your username"
        aria-describedby={hint}
        aria-invalid={check.at === 'no'}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={USERNAME_MAX + 1}
        data-onb-first
      />
      <p id={hint} className={`onb-hint is-${error ? 'no' : check.at}`} role="status">
        <i aria-hidden="true" />
        {error ?? (
          check.at === 'no' ? check.why
            : check.at === 'free' ? 'Available'
            : check.at === 'checking' ? 'Checking…'
            : `3 to ${USERNAME_MAX} letters, numbers or _`
        )}
      </p>
      <button type="submit" className="fx-cta fx-cta--lg" disabled={!ready}>{busy ? 'Confirm in your wallet…' : 'Continue'}</button>
      <p className="onb-foot">One free signature, never a transaction.</p>
    </form>
  );
}

/* ---------------------------------------------------------- 2: top traders to track ----- */

function useWatchlist(): { watched: ReadonlySet<string>; toggle: (t: { venue: Venue; address: string }) => void } {
  const [list, setList] = useState<TraderRef[]>(() => readTraderRefs(readList<unknown>(LS_WATCHLIST)));
  const toggle = useCallback((t: { venue: Venue; address: string }) => {
    setList((l) => {
      const k = traderKey(t);
      const next = l.some((x) => traderKey(x) === k)
        ? l.filter((x) => traderKey(x) !== k)
        : [{ venue: t.venue, address: t.address.toLowerCase(), at: Date.now() }, ...l].slice(0, 50);
      writeList(LS_WATCHLIST, next);
      window.dispatchEvent(new Event(WATCHLIST_EVENT));
      return next;
    });
  }, []);
  return { watched: useMemo(() => new Set(list.map(traderKey)), [list]), toggle };
}

const TargetIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="5" /><path d="M8 1.5V4M8 12v2.5M1.5 8H4M12 8h2.5" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
);

function TraderLine({ row, watched, onToggle }: { row: TraderRow; watched: boolean; onToggle: () => void }) {
  const { ref, peek, loading } = useTraderPeek(row, '30d');
  const who = shortAddr(row.address);
  const pnl = row.pnl?.['30d'];
  return (
    <div className="onb-tr" role="row" ref={ref}>
      <span className="onb-tr__who" role="cell">
        <Avatar address={row.address} size={28} />
        <b>{who}</b>
        <span className="onb-tr__venues">{(row.venues?.length ? row.venues : [row.venue]).map((v) => <VenueLogo key={v} venue={v} size={14} />)}</span>
      </span>
      <span className="onb-tr__eq" role="cell">
        <span>{row.accountValue != null ? fmtUsd(row.accountValue, 0) : DASH}</span>
        <Spark values={peek?.spark ?? null} loading={loading} className="onb-tr__spark" />
      </span>
      <span className={`onb-tr__pnl ${pnl != null && pnl < 0 ? 'neg' : 'pos'}`} role="cell">
        {pnl == null ? DASH : `${pnl >= 0 ? '+' : '−'}${fmtUsd(Math.abs(pnl), 0)}`}
      </span>
      <span className="onb-tr__act" role="cell">
        <button type="button" className={`onb-track${watched ? ' is-on' : ''}`} aria-pressed={watched} onClick={onToggle} aria-label={`${watched ? 'Stop tracking' : 'Track'} ${who}`}>
          {watched ? <CheckIcon /> : <TargetIcon />}
          <span>{watched ? 'Tracking' : 'Track'}</span>
        </button>
      </span>
    </div>
  );
}

function TradersStep({ onNext }: { onNext: () => void }) {
  const [venues, setVenues] = useState<Venue[]>([...LB_VENUES]);
  const all = venues.length === LB_VENUES.length;
  const { data, error, loading, refresh } = useAsync(
    () => vsApi.leaderboard({ ...(all ? {} : { venues: venues.join(',') }), view: 'net', window: '30d', sort: 'pnl', side: 'top', limit: 10, minTrades: 2 }),
    [venues.join(',')],
  );
  const rows = data?.rows ?? [];
  const { watched, toggle } = useWatchlist();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <div className="onb-wide">
      <Head title="Track top traders" line="The biggest earners of the last 30 days, live from the leaderboard. Keep them on your watchlist and copy any of them later." />
      <div className="onb-table" role="table" aria-label="Top traders by 30-day PnL">
        <div className="onb-tr onb-tr--head" role="row">
          <span className="onb-tr__who" role="columnheader">Trader</span>
          <span className="onb-tr__eq" role="columnheader">Equity</span>
          <span className="onb-tr__pnl" role="columnheader">30D PnL</span>
          <span className="onb-tr__act" role="columnheader">
            <PlatformSelect options={LB_VENUES} value={venues} onChange={setVenues} align="end" label="Platforms" className="onb-venues" />
          </span>
        </div>
        {rows.map((r) => (
          <TraderLine key={`${r.venue}:${r.address}`} row={r} watched={watched.has(traderKey(r))} onToggle={() => toggle(r)} />
        ))}
        {!rows.length && loading && Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="onb-tr onb-tr--skeleton" aria-hidden="true"><i /><i /><i /><i /></div>
        ))}
        {!rows.length && !loading && (
          <div className="onb-empty">
            <b>{error ? 'The leaderboard did not answer' : 'No traders on this platform yet'}</b>
            {error && <button type="button" className="onb-track" onClick={() => refresh()}>Try again</button>}
          </div>
        )}
      </div>
      <p className="onb-foot onb-foot--left">
        Your watchlist is in search: press <kbd>{mac ? '⌘' : 'Ctrl'}</kbd> <kbd>K</kbd> any time. {VENUE_LABEL.sodex} and Hyperliquid traders can be copied from the Copy page.
      </p>
      <div className="onb-cta"><button type="button" className="fx-cta fx-cta--lg" onClick={onNext}>Continue</button></div>
    </div>
  );
}

/* ---------------------------------------------------------- 3: the main features ----- */

type FeatureId = 'copy' | 'heatmap' | 'flow';

const FEATURES: Record<FeatureId, { title: string; line: string; alt: { main: string; back: string; front: string } }> = {
  copy: {
    title: 'Copy the best traders',
    line: 'Follow a trader, or trade against one. Every trade lands in your own SoDEX account, within the limits you set.',
    alt: {
      main: 'The Copy page: trader cards with 30-day PnL, equity and a score',
      back: 'A trader list with PnL and win rate',
      front: 'The copy setup window: how much, how fast and an expected PnL chart',
    },
  },
  heatmap: {
    title: 'See where liquidations sit',
    line: 'Every tracked position mapped to the price it gets liquidated at, live, down to the wallets behind a level.',
    alt: {
      main: 'The liquidation heatmap for a market: levels by price over time',
      back: 'The levels now, per price, as a profile',
      front: 'Longs and shorts at risk near the current price',
    },
  },
  flow: {
    title: 'Know who traded every candle',
    line: 'Click a candle and read the wallets behind it: who bought, who sold, how much, on every timeframe.',
    alt: {
      main: 'A price chart with the Who traded panel beside it',
      back: 'Wallets on one candle, sorted by size',
      front: 'The top wallets of the picked candle',
    },
  },
};

const picture = (id: string, part: 'main' | 'back' | 'front', theme: Theme): string => `/onboarding/${id}-${part}-${theme}.webp`;

/* Each picture is fetched once, the first time the flow comes near it. */
const preloaded = new Set<string>();
function preloadAround(step: Step): void {
  const order: FeatureId[] = ['copy', 'heatmap', 'flow'];
  const want = step === 'traders' ? order.slice(0, 1) : step === 'copy' ? order.slice(1, 2) : step === 'heatmap' ? order.slice(2) : [];
  const theme: Theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  for (const id of want) {
    for (const part of ['main', 'back', 'front'] as const) {
      const src = picture(id, part, theme);
      if (preloaded.has(src)) continue;
      preloaded.add(src);
      const img = new Image();
      img.src = src;
    }
  }
}

function FeatureStep({ feature, onNext }: { feature: FeatureId; onNext: () => void }) {
  const f = FEATURES[feature];
  const theme = useTheme();
  return (
    <div className="onb-feature">
      <Head title={f.title} line={f.line} />
      <button type="button" className="onb-go" onClick={onNext}>Continue</button>
      <div className={`onb-stage onb-stage--${feature}`}>
        <img className="onb-stage__back" src={picture(feature, 'back', theme)} alt={f.alt.back} />
        <img className="onb-stage__main" src={picture(feature, 'main', theme)} alt={f.alt.main} />
        <img className="onb-stage__front" src={picture(feature, 'front', theme)} alt={f.alt.front} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- 4: every major feature ----- */

const Ic = ({ d }: { d: ReactNode }) => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

/** What is on the site today. A tile says when it is not open to everyone yet. */
const MAJORS: ReadonlyArray<{ title: string; line: string; pill?: string; icon: ReactNode }> = [
  { title: 'Trade', line: 'Perpetuals and spot on SoDEX, on a layout you arrange.', icon: <><path d="M6 3v14M14 3v14" /><rect x="4" y="6" width="4" height="7" rx="1" /><rect x="12" y="5" width="4" height="6" rx="1" /></> },
  { title: 'Copy trading', line: 'Copy or counter a trader into your own account, with your limits.', icon: <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /></> },
  { title: 'Leaderboard', line: 'Top traders across SoDEX, Hyperliquid, trade.xyz, Lighter and Arcus.', icon: <path d="M4 17V9m6 8V4m6 13v-6" /> },
  { title: 'Explore', line: 'Markets, funding rates and what wallet cohorts are holding.', icon: <><circle cx="10" cy="10" r="7" /><path d="m13 7-1.8 4.2L7 13l1.8-4.2Z" /></> },
  { title: 'Liquidation heatmap', line: 'Where open positions get liquidated, live and back in time.', icon: <><rect x="3" y="3" width="14" height="14" rx="2" /><path d="M3 8h14M3 13h14M8 3v14M13 3v14" /></> },
  { title: 'Who traded', line: 'The wallets behind any candle, on every timeframe.', icon: <><circle cx="8" cy="7" r="3" /><path d="M2.5 17c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5M13.5 4.2a3 3 0 0 1 0 5.6M15 12.8c1.4.6 2.2 2 2.5 4.2" /></> },
  { title: 'Scan', line: 'Look up any wallet across five venues: positions, fills and PnL.', icon: <><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.8 3.8" /></> },
  { title: 'Portfolio', line: 'Balances, open positions, PnL and your full history.', icon: <><path d="M3 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M13 11h4M3 8h14" /></> },
  { title: 'Terminals', line: 'Arrange panels into layouts of your own and switch between them.', icon: <><rect x="3" y="3" width="6" height="14" rx="1.5" /><rect x="11" y="3" width="6" height="6" rx="1.5" /><rect x="11" y="11" width="6" height="6" rx="1.5" /></> },
  { title: 'News and calendar', line: 'Market news, the economic calendar with results, and the Fed live.', icon: <><rect x="3" y="4" width="14" height="13" rx="2" /><path d="M3 8h14M7 2.5v3M13 2.5v3" /></> },
  { title: 'Algo orders', line: 'TWAP, VWAP, chase and more, previewed before they run.', pill: 'Practice', icon: <><path d="M3 15c3 0 3-8 6-8s3 5 5 5 2-4 3-6" /></> },
  { title: 'Bots', line: 'Automated market-making and grid strategies.', pill: 'Coming soon', icon: <><rect x="4" y="7" width="12" height="9" rx="2" /><path d="M10 7V4M8 11v1M12 11v1" /></> },
];

function OverviewStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="onb-wide onb-wide--xl">
      <Head title="Everything in one terminal" line="The whole desk, one rail away. Every page reads the same live data." />
      <ul className="onb-grid">
        {MAJORS.map((m) => (
          <li key={m.title} className="onb-tile">
            <span className="onb-tile__ic"><Ic d={m.icon} /></span>
            <b>{m.title}{m.pill && <em>{m.pill}</em>}</b>
            <span>{m.line}</span>
          </li>
        ))}
      </ul>
      <div className="onb-cta"><button type="button" className="fx-cta fx-cta--lg" onClick={onNext}>Continue</button></div>
    </div>
  );
}

/* --------------------------------------------------------------- 5: dark or light ----- */

function ThemeStep({ onNext }: { onNext: () => void }) {
  const theme = useTheme();
  const options: Array<{ id: Theme; label: string }> = [{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }];
  const onKey = (e: KeyboardEvent) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      setTheme(theme === 'dark' ? 'light' : 'dark');
    }
  };
  return (
    <div className="onb-wide">
      <Head title="Dark or light?" line="Pick how the terminal looks. You can change it any time in Settings." />
      <div className="onb-themes" role="radiogroup" aria-label="Theme" onKeyDown={onKey}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={theme === o.id}
            tabIndex={theme === o.id ? 0 : -1}
            className={`onb-theme${theme === o.id ? ' is-on' : ''}`}
            onClick={() => setTheme(o.id)}
            data-onb-first={theme === o.id ? '' : undefined}
          >
            <img src={`/onboarding/terminal-${o.id}.webp`} alt={`The trading terminal in the ${o.label.toLowerCase()} theme`} />
            <span className="onb-theme__label">
              <i aria-hidden="true">{theme === o.id && <CheckIcon />}</i>
              {o.label}
            </span>
          </button>
        ))}
      </div>
      <div className="onb-cta"><button type="button" className="fx-cta fx-cta--lg" onClick={onNext}>Start trading</button></div>
    </div>
  );
}

