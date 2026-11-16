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
import { REFERRAL_CODE } from '../../onboarding/referral';
import { Difficulty, EarnMore, MySquadBoost, SeasonCard, SoPointsCard, ThisWeek, WeekTable, WeeklyPoints } from './SoPointsMine';
import { useSoPointsV2 } from './soPointsV2';
import { Pill, ProgrammeHero, ProgrammePage, SkelRows, Tile, Tiles, fmtLeft, fmtWhen, useNow } from './parts';

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

export function SoPointsPage({ address, provider }: { address: string | null; provider: Eip1193Provider | null }) {
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
            <SeasonCard week={w} code={REFERRAL_CODE} settled={c.publicSettled} />
          </div>
          {v2.error && <p className="pf-note" role="alert">Some of your SoPoints could not be read: {v2.error}</p>}
          <div className="sdx-duo spm-charts">
            <ThisWeek s={v2} week={w} />
            <MySquadBoost s={v2} cfg={c.boost} />
          </div>
          <EarnMore s={v2} cfg={c.boost} weights={c.weights} pool={w?.weekPoolPoints ?? null}>
            <BoostedMarkets c={c} />
          </EarnMore>
          <div className="sdx-duo spm-charts">
            <WeeklyPoints s={v2} />
            <Difficulty s={v2} pool={w?.weekPoolPoints ?? null} />
          </div>
          <WeekTable s={v2} />
          {import.meta.env.DEV && <ChartLab s={v2} pool={w?.weekPoolPoints ?? null} />}
        </>
      ) : (
        <>
          <SeasonCard week={w} code={REFERRAL_CODE} settled={c.publicSettled} />
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
  return (
    <Card title="Squad boost" action={b ? <span className="pf-unit">up to +{b.maxTotalBonusPct}%</span> : undefined}>
      {!c.publicSettled ? <SkelRows rows={3} height={36} /> : !b ? <p className="pf-note">{DASH}</p> : (
        <>
          <ol className="sdx-ladder">
            {b.tiers.map((t) => (
              <li key={t.threshold} className="sdx-ladder__step">
                <b>+{t.bonusPct}%</b>
                <span>{fmtEnergy(t.threshold)}</span>
              </li>
            ))}
          </ol>
          <Group title="How it counts">
            <Fact label="Energy" value="$1 of volume = 1" />
            <Fact label="Window" value={`Last ${b.windowRounds} weeks`} />
            <Fact label="Your boost" value="Both squads added" hint="The squad you joined plus the squad you built." />
            <Fact label="Early bird" value={`+${b.earlyBirdBonusPct}%, ${b.earlyBirdRounds} rounds`} />
          </Group>
        </>
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
  const label = c.signingIn ? 'Check your wallet…' : c.signInError ? 'Try again' : 'Show my SoPoints';
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
        disabled={!c.address || !c.provider || c.signingIn}
        title={c.address && !c.provider ? 'Reconnect your wallet to sign.' : undefined}
        onClick={() => { void c.signIn(); }}
      >
        {label}
      </button>
    </section>
  );
}
