/**
 * Bots & servers (owner 2026-11-08: "an overview over that, e.g. usage of our infrastructure + bot volume across all
 * valuedesk users"): each executor's load against its caps (live bots of 20, wallets on the account socket of 10,
 * SoDEX's per-IP weight budget), and the bots' volume, PnL and fees across every wallet, real and practice apart.
 * Server 1 reads GET /internal/stats from each executor (routes/admin.ts liveExecutorStats), every 30 s.
 */
import { ago, int, pct } from '../format';
import { Empty, Figure, Figures, Note, Page, Section, useAdmin } from '../ui';

interface Totals { volume: number; volume24h: number; netPnl: number; tradeFees: number; builderFees: number; fills: number }
interface Stats {
  at: number;
  tier: 'standard' | 'vip';
  location: string;
  liveBots: number;
  maxLiveBots: number;
  practiceBots: number;
  pausedBots: number;
  closingBots: number;
  botWallets: number;
  algos: number;
  copies: number;
  socket: { followed: number; polled: number; max: number } | null;
  budget: { used: number; perMinute: number; cooldownMs: number };
  real: Totals;
  practice: Totals;
  markets: Array<{ symbol: string; live: number; volume: number; volume24h: number }>;
  vipMoves: Array<{ direction: 'up' | 'down'; state: string; outcome: string | null; at: number }>;
}
interface Executor { name: string; ok: boolean; stats: Stats | null }

const money = (v: number, digits = 0): string => `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const big = (v: number): string => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e4 ? `$${(v / 1e3).toFixed(1)}K` : money(v, Math.abs(v) >= 100 ? 0 : 2));
const load = (n: number, cap: number): 'warn' | 'neg' | undefined => (cap > 0 && n / cap >= 0.95 ? 'neg' : cap > 0 && n / cap >= 0.75 ? 'warn' : undefined);

export function Infra() {
  const r = useAdmin<{ executors: Executor[] }>('infra', {}, 30_000);
  const xs = r.data?.executors ?? [];
  const up = xs.filter((x) => x.ok && x.stats);
  const sum = (f: (s: Stats) => number) => up.reduce((t, x) => t + f(x.stats!), 0);
  const live = sum((s) => s.liveBots);
  const cap = sum((s) => s.maxLiveBots);
  const down = xs.filter((x) => !x.ok);
  return (
    <Page
      title={`${int(live)} live bot${live === 1 ? '' : 's'} of ${int(cap)}`}
      line="What runs on each executor against its caps, SoDEX's budget per IP, and what every user's bots traded. Read from the executors every 30 s."
      tone={down.length ? 'warn' : up.length ? 'pos' : 'unknown'}
      loaded={r}
    >
      {r.error && <Section><Note kind="error">{r.error}</Note></Section>}
      {down.length > 0 && <Section><Note kind="warn">{down.map((x) => x.name).join(', ')} did not answer: its figures are missing below.</Note></Section>}
      <Section title="All users, real bots">
        <Figures>
          <Figure label="Volume, 24 h" value={big(sum((s) => s.real.volume24h))} />
          <Figure label="Volume, all time" value={big(sum((s) => s.real.volume))} sub={`${int(sum((s) => s.real.fills))} fills`} />
          <Figure label="Users' net PnL" value={big(sum((s) => s.real.netPnl))} tone={sum((s) => s.real.netPnl) < 0 ? 'neg' : 'pos'} sub="after every fee, open positions at the mark" />
          <Figure label="Our bot fees" value={big(sum((s) => s.real.builderFees))} sub={`SoDEX fees ${big(sum((s) => s.real.tradeFees))}`} />
          <Figure label="Practice volume" value={big(sum((s) => s.practice.volume))} sub={`${int(sum((s) => s.practiceBots))} running`} />
        </Figures>
      </Section>
      {up.map(({ name, stats: s }) => (
        <Section key={name} title={name} aside={<span className="dv-quiet">{s!.location} · read {ago(s!.at)}</span>}>
          <Figures>
            <Figure label="Live bots" value={`${int(s!.liveBots)} / ${int(s!.maxLiveBots)}`} tone={load(s!.liveBots, s!.maxLiveBots)} sub={`${int(s!.botWallets)} wallets · ${int(s!.pausedBots)} paused · ${int(s!.closingBots)} closing`} />
            <Figure label="Account socket" value={s!.socket ? `${int(s!.socket.followed)} / ${int(s!.socket.max)}` : '–'} tone={s!.socket ? load(s!.socket.followed, s!.socket.max) : undefined} sub={s!.socket ? `${int(s!.socket.polled)} wallets read by REST` : undefined} />
            <Figure label="SoDEX weight / min" value={`${int(s!.budget.used)} / ${int(s!.budget.perMinute)}`} tone={load(s!.budget.used, s!.budget.perMinute)} sub={s!.budget.cooldownMs > 0 ? `cooling down ${Math.ceil(s!.budget.cooldownMs / 1000)} s` : pct(s!.budget.used / Math.max(1, s!.budget.perMinute), 0)} />
            <Figure label="Copies · algo orders" value={`${int(s!.copies)} · ${int(s!.algos)}`} />
            <Figure label="Volume, 24 h" value={big(s!.real.volume24h)} sub={`all time ${big(s!.real.volume)}`} />
          </Figures>
          {s!.markets.length ? (
            <table className="dv-table">
              <thead><tr><th>Market</th><th className="num">Live bots</th><th className="num">Volume 24 h</th><th className="num">Volume, all time</th></tr></thead>
              <tbody>
                {s!.markets.map((m) => (
                  <tr key={m.symbol}><td>{m.symbol}</td><td className="num">{int(m.live)}</td><td className="num">{big(m.volume24h)}</td><td className="num">{big(m.volume)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>No real bot has traded here yet.</Empty>}
          {s!.vipMoves.length > 0 && (
            <p className="dv-quiet">VIP moves, 7 days: {s!.vipMoves.map((v) => `${v.direction === 'down' ? 'back' : 'up'} ${v.outcome ?? v.state} (${ago(v.at)})`).join(' · ')}</p>
          )}
        </Section>
      ))}
      {!xs.length && !r.loading && !r.error && <Section><Empty>No executor answered this page.</Empty></Section>}
    </Page>
  );
}
