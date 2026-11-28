/**
 * SoPoints (/points): SoDEX's points programme, laid out in the order of its own page. The week and its
 * countdown, the boosted markets, the squad boost, the wallet's part, how points are earned, then the
 * tier ladder, the wallet's standing and the rules.
 *
 * The wallet's balance, weeks and squad need SoDEX's token, so they sit behind SODEX_SIGNIN_LIVE. The
 * panels themselves (components/Points.tsx) are the ones built for that; with the switch off the wallet's
 * estimate from public data (PointsEstimate.tsx) stands in for them. Every figure is the API's: the pool is the API's 1,000,000, not the
 * 900,000 in SoDEX's page text.
 */
import { CoinIcon } from '../CoinIcon';
import { Card, Group } from '../portfolio/parts';
import { Fact, POINTS_PANELS, usePointsContext, type PointsContext } from '../Points';
import { DASH, fmt } from '../../format';
import { RULES } from '../../points';
import { SODEX_POINTS_SIGNIN_LIVE, SODEX_SITE } from '../../sodexProgrammes';
import type { Eip1193Provider } from '../../wallet';
import { PointsEstimate } from './PointsEstimate';
import { ChartLab } from './ChartLab';
import { EarnMore, MySquadBoost, SeasonCard, SoPointsCard, ThisWeek, WeekTable } from './SoPointsMine';
import { DifficultyChart, PointsByWeek, PointsMix, RankByWeek, SeasonPoints } from './pointsCharts';
import { useSoPointsV2 } from './soPointsV2';
import { Stage } from './versions/points/Stage';
import { Pill, ProgrammeHero, ProgrammePage, SkelRows, Tile, Tiles, fmtLeft, fmtWhen, useNow } from './parts';
import { openConnectDialog } from '../account/connect';
import { useAccountPending } from '../account/actions';
import { useWalletSnapshot } from '../account/useWallet';
import { warmWalletModal } from '../../walletconnect';

/** The panels of components/Points.tsx, on the page instead of in a movable grid. */
const panel = (id: string, c: PointsContext) => {
  const p = POINTS_PANELS.find((x) => x.id === id);
  return p ? p.render(c, 'lg') : null;
};

const fmtEnergy = (raw: string): string => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DASH;
  return n >= 1_000_000 ? `$${fmt(n / 1_000_000, n % 1_000_000 ? 1 : 0)}M` : `$${fmt(n / 1000, 0)}K`;
};

/*
 * The page is the Stage version since 2026-11-27 (owner: "make stage version the new original"; versions/points/
 * Stage.tsx), with no versions switch (owner the same day: "remove the versions switch at the bottom"). On localhost
 * only, `localStorage['vs.dev.sopoints.sample'] = 'on'` draws it on made-up figures (versions/points/sample.ts) to check
 * the layout; a build drops that branch.
 */
const devSample = (): boolean => {
  if (!import.meta.env.DEV) return false;
  try { const x = localStorage.getItem('vs.dev.sopoints.sample'); return x === 'on' || x === 'film'; } catch { return false; }
};

export function SoPointsPage({ address, provider }: { address: string | null; provider: Eip1193Provider | null }) {
  return <Stage address={address} provider={provider} sample={devSample()} />;
}

/** The page before Stage, no longer shown anywhere; kept until the owner says it can go. */
export function SoPointsOriginal({ address, provider }: { address: string | null; provider: Eip1193Provider | null }) {
  const c = usePointsContext(address, provider);
  const now = useNow();
  const w = c.week;
  const ends = w ? w.nextWeekStartTime * 1000 : null;
  const pays = w ? w.distributionTime * 1000 : null;
  const mine = SODEX_POINTS_SIGNIN_LIVE && c.tokenPresent && !!address;
  const v2 = useSoPointsV2(address, mine);

  return (
    <ProgrammePage label="SoPoints">
      <ProgrammeHero
        title="SoPoints"
        line={`${RULES.season} · up to +${c.boost?.maxTotalBonusPct ?? DASH}% with a squad`}
        pills={w && <Pill tone={w.weekStatus === 'LIVE' ? 'live' : 'quiet'} dot={w.weekStatus === 'LIVE'}>{w.weekName} · {w.weekStatus}</Pill>}
      />

      {mine ? (
        <>
          <div className="spm-top">
            <SoPointsCard s={v2} />
            <SeasonCard week={w} address={address} settled={c.publicSettled} />
          </div>
          {v2.error && <p className="pf-note" role="alert">Some of your SoPoints could not be read: {v2.error}</p>}
          <div className="sdx-duo spm-charts">
            <ThisWeek s={v2} week={w} />
            <MySquadBoost s={v2} cfg={c.boost} />
          </div>
          <div className="sdx-duo spm-charts">
            <PointsByWeek s={v2} />
            <DifficultyChart s={v2} pool={w?.weekPoolPoints ?? null} address={address} />
          </div>
          <div className="sdx-duo spm-charts">
            <SeasonPoints s={v2} />
            <RankByWeek s={v2} />
          </div>
          <div className="sdx-duo spm-charts">
            <PointsMix s={v2} />
            <BoostedMarkets c={c} />
          </div>
          <WeekTable s={v2} />
          <EarnMore s={v2} cfg={c.boost} weights={c.weights} pool={w?.weekPoolPoints ?? null} />
          {import.meta.env.DEV && <ChartLab s={v2} pool={w?.weekPoolPoints ?? null} />}
        </>
      ) : (
        <>
          <SeasonCard week={w} address={address} settled={c.publicSettled} />
          <div className="sdx-duo">
            <BoostedMarkets c={c} />
            <SquadBoost c={c} />
          </div>
          {SODEX_POINTS_SIGNIN_LIVE && <PointsSignIn c={c} />}
          <PointsEstimate c={c} />
        </>
      )}

    </ProgrammePage>
  );
}

function BoostedMarkets({ c }: { c: PointsContext }) {
  const rows = c.weights?.weights ?? [];
  return (
    <Card title="Boosted markets" action={c.weights ? <span className="pf-unit">until {fmtWhen(c.weights.round.end_ts_ms)}</span> : undefined}>
      {!c.publicSettled ? <SkelRows rows={3} height={36} /> : rows.length === 0 ? (
        <p className="pf-note">{c.weights ? 'No market is boosted this round.' : DASH}</p>
      ) : (
        <>
          <ul className="sdx-markets">
            {rows.map((m) => (
              <li key={`${m.market_type}:${m.symbol_id}`}>
                <a className="sdx-market" href={`/trade?symbol=${encodeURIComponent(m.symbol)}`} title={`Trade ${m.symbol}`}>
                  <CoinIcon coin={m.symbol} size={20} />
                  <span className="sdx-market__sym">{m.symbol}</span>
                  <b className="sdx-market__x">×{m.coefficient}</b>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function SquadBoost({ c }: { c: PointsContext }) {
  const b = c.boost;
  const steps = b ? [...b.tiers].sort((x, y) => Number(x.threshold) - Number(y.threshold)) : [];
  return (
    <Card title="Squad boost" action={b ? <span className="spm-sq__total">up to +{b.maxTotalBonusPct}%</span> : undefined}>
      {!c.publicSettled ? <SkelRows rows={3} height={36} /> : !b ? <p className="pf-note">{DASH}</p> : (
        <div className="spm-sq">
          <p className="spm-sq__sum">Every point you earn is multiplied by your squads' boost: the squad you joined <i>+</i> the squad you built.</p>
          <div className="spm-sq__track">
            {steps.map((x, k) => (
              <span key={x.threshold} className="spm-sq__step" style={{ left: `${((k + 1) / steps.length) * 100}%` }}>
                <em>+{x.bonusPct}%</em><small>{fmtEnergy(x.threshold)}</small>
              </span>
            ))}
          </div>
          <div className="spm-sq__facts">
            <span>$1 traded by a squad = 1 energy</span>
            <span>Counted over the last {b.windowRounds} weeks</span>
          </div>
        </div>
      )}
    </Card>
  );
}

const KEY = (
  <svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="7" cy="12" r="3.5" />
    <path d="m9.5 9.5 6-6M13 6l2 2M11.5 7.500l1.500 1.500" />
  </svg>
);

/**
 * Signed out: one card instead of four empty panels. What the signature is (SoDEX's own text, free, no transaction),
 * what it shows, and the one button. The relay and why it cannot move funds: server routes/pointsAuth.ts.
 */
function PointsSignIn({ c }: { c: PointsContext }) {
  /* With no wallet (or one remembered from last visit with nothing attached) the card's one button connects, in the
     app's own Connect dialog as the navbar's does - it was a disabled "Show my SoPoints", a dead end on a phone. */
  const pending = useAccountPending();
  /* A return visit: the remembered wallet is being reattached; it waits for that, as the wallet menu does. */
  const wallet = useWalletSnapshot();
  const restoring = !!c.address && !c.provider && wallet.status === 'connecting';
  const connect = !c.address || !c.provider;
  const opening = connect && (pending === 'connect' || restoring);
  const label = restoring ? 'Reconnecting wallet…' : opening ? 'Opening…' : !c.address ? 'Connect wallet' : !c.provider ? 'Reconnect wallet'
    : c.signingIn ? 'Check your wallet…' : c.signInError ? 'Try again' : 'Show my SoPoints';
  return (
    <section className="sdx-locked sdx-signin" aria-label="Your SoPoints">
      <span className="sdx-locked__icon">{KEY}</span>
      <div className="sdx-locked__text">
        <h2 className="sdx-locked__title">Your real SoPoints</h2>
        <p className="sdx-locked__line">
          {!c.address
            ? 'Connect a wallet, then sign once to read your SoPoints from SoDEX.'
            : "Sign SoDEX's own sign-in message once. It is free: no transaction, no gas, no funds move."}
        </p>
        <ul className="sdx-locked__items">
          {['Balance and tier', 'Points week by week', 'Your squads and their boost', 'Your cost per point'].map((i) => <li key={i}>{i}</li>)}
        </ul>
        {c.signInError && <p className="sdx-signin__err" role="alert">{c.signInError}</p>}
      </div>
      <button
        type="button"
        className="pf-btn pf-btn--primary sdx-locked__go"
        disabled={opening || (!connect && c.signingIn)}
        aria-busy={opening || (!connect && c.signingIn) || undefined}
        title={c.address && !c.provider ? 'Reconnect your wallet to sign.' : undefined}
        onPointerEnter={connect ? warmWalletModal : undefined}
        onFocus={connect ? warmWalletModal : undefined}
        onClick={() => { if (connect) void openConnectDialog(); else void c.signIn(); }}
      >
        {label}
      </button>
    </section>
  );
}
