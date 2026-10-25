/**
 * The liquidation math against each venue's own figures, live. Run in apps/server:
 *
 *   npx tsx tools/liq-check.ts [--venues hyperliquid,tradexyz,sodex,lighter,arcus] [--wallets 120] [--drift 300]
 *
 * For each venue it reads a sample of active wallets the way the cohort books
 * do (indexer/cohortSource.ts), calibrates each account (liquidations/math.ts)
 * and counts how many of the venue's liquidation prices the model reproduces
 * to 1e-4. `--drift s` reads the same wallets again after s seconds and
 * compares the figure the book would show by then (the first read, moved by
 * the prices now) with the venue's new one, for positions whose size did not
 * change. Arcus publishes no liquidation price, so its rows say so.
 * Prints one JSON object.
 */
import { VENUES, type Venue } from '../src/valuescan/types.js';
import { hlInfo } from '../src/valuescan/hyperliquid/index.js';
import { arcusPositions, hlPositions, lighterPositions, sodexPositions, type PositionRead } from '../src/indexer/cohortSource.js';
import { LIGHTER_API, lighterPacer } from '../src/valuescan/extra/lighter.js';
import { ARCUS_API, arcusPacer } from '../src/valuescan/extra/arcus.js';
import { accountLiqs, addDrift, calibrate, emptyDrift } from '../src/valuescan/liquidations/math.js';
import { venueMarkets } from '../src/valuescan/liquidations/rules.js';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] ?? d : d;
};
const venues = arg('venues', VENUES.join(',')).split(',') as Venue[];
const per = Number(arg('wallets', '120'));
const driftS = Number(arg('drift', '0'));

async function sample(v: Venue): Promise<string[]> {
  const out = new Set<string>();
  if (v === 'hyperliquid' || v === 'tradexyz') {
    const coins = v === 'hyperliquid' ? ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'SUI', 'ENA', 'FARTCOIN', 'PUMP', 'ZEC', 'kPEPE']
      : ['xyz:XYZ100', 'xyz:TSLA', 'xyz:NVDA', 'xyz:GOLD', 'xyz:SILVER', 'xyz:HOOD', 'xyz:PLTR', 'xyz:META'];
    for (const coin of coins) {
      const t = await hlInfo.post<Array<{ users?: string[] }> | null>({ type: 'recentTrades', coin }).catch(() => null);
      for (const x of t ?? []) for (const u of x.users ?? []) out.add(u.toLowerCase());
    }
  } else if (v === 'sodex') {
    for (let page = 1; page <= 10 && out.size < per * 2; page++) {
      const j = await fetch(`https://mainnet-data.sodex.dev/api/v1/leaderboard?window_type=ALL_TIME&sort_by=volume&sort_order=desc&page=${page}&page_size=20`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()) as { data?: { items?: Array<{ wallet_address?: string }> } };
      for (const r of j.data?.items ?? []) if (r.wallet_address) out.add(r.wallet_address.toLowerCase());
    }
  } else if (v === 'lighter') {
    const j = await lighterPacer.get<{ entries?: Array<{ l1_address?: string }> }>(`${LIGHTER_API}/api/v1/pnlLeaderboard?time_window=7d&sort_by=volume&sort_dir=desc&limit=100&offset=0`);
    for (const e of j.entries ?? []) if (e.l1_address) out.add(e.l1_address);
  } else {
    const j = await arcusPacer.get<{ entries?: Array<{ address?: string }> }>(`${ARCUS_API}/v1/leaderboard?sort=volume&window=30d`, 20);
    for (const e of j.entries ?? []) if (e.address) out.add(e.address);
  }
  return [...out].slice(0, per);
}

const readOf = (v: Venue, a: string): Promise<PositionRead> =>
  v === 'hyperliquid' ? hlPositions(a)
    : v === 'tradexyz' ? hlPositions(a, 'xyz')
      : v === 'sodex' ? sodexPositions(a)
        : v === 'lighter' ? lighterPositions(a, lighterPacer)
          : arcusPositions(a, arcusPacer);

const result: Record<string, unknown> = {};
for (const v of venues) {
  const m = await venueMarkets(v, { oi: true });
  if (!m) { result[v] = { error: 'no market list' }; continue; }
  const tiersFor = (s: string) => m.tiers.get(s) ?? null;
  const wallets = await sample(v);
  let accounts = 0, positions = 0, checked = 0, matched = 0, split = 0, kept = 0;
  const misses: unknown[] = [];
  const first = new Map<string, { r: PositionRead; cal: ReturnType<typeof calibrate> }>();
  for (const a of wallets) {
    const r = await readOf(v, a).catch(() => null);
    if (!r?.liq || !r.liq.positions.length) continue;
    accounts++;
    positions += r.liq.positions.length;
    if (r.liq.split) split++;
    const cal = calibrate(r.liq, tiersFor);
    checked += cal.checked;
    matched += cal.matched;
    kept += cal.kept;
    cal.pos.forEach((p, i) => {
      if (p.fix !== undefined && !r.liq!.split && misses.length < 8) {
        const rp = r.liq!.positions[i]!;
        misses.push({ address: a, symbol: rp.symbol, szi: rp.szi, venue: rp.vliq, isolated: !!rp.isolated, split: !!r.liq!.split });
      }
    });
    first.set(a, { r, cal });
  }
  const row: Record<string, unknown> = {
    wallets: wallets.length, accounts, positions, splitAccounts: split, venueFigures: checked, reproduced: matched, keptAsRead: kept,
    share: checked ? +(matched / checked).toFixed(4) : null,
    note: v === 'arcus' ? 'Arcus gives no liquidation price: computed from its maintenanceMarginFraction' : undefined,
    misses,
  };
  result[v] = row;
  if (driftS > 0 && v !== 'arcus') {
    await new Promise((r) => setTimeout(r, driftS * 1000));
    const d = emptyDrift(Date.now());
    for (const [a, { r, cal }] of first) {
      const r2 = await readOf(v, a).catch(() => null);
      if (!r2?.liq) continue;
      const now = new Map(r2.liq.positions.map((p) => [p.symbol, p]));
      const pos = r.liq!.positions.map((p, i) => ({ symbol: p.symbol, szi: p.szi, ...cal.pos[i] }));
      const was = accountLiqs(cal.cash, pos, (s) => now.get(s)?.mark ?? null, tiersFor);
      r.liq!.positions.forEach((p, i) => {
        const q = now.get(p.symbol);
        if (!q || q.vliq === undefined) return;
        if (Math.abs(q.szi - p.szi) > 1e-9 * Math.abs(p.szi)) { d.moved++; return; }
        addDrift(d, was[i] ?? null, q.vliq ?? null, Math.abs(p.szi) * (q.vliq ?? q.mark ?? 0));
      });
    }
    row.drift = { afterSeconds: driftS, ...d };
  }
}
console.log(JSON.stringify(result, null, 2));
process.exit(0);
