/**
 * Dev only: the referral routes (routes/invites.ts) on 127.0.0.1:18797 for localhost:5180, which reads production's API
 * (VALUETRADE_DEV_API=prod) where referrals are not released yet. The Vite dev server sends /api/vs/invites here while
 * this answers (apps/web/vite.config.ts devInvites); everything else still goes to production.
 *
 * The real code: SoDEX's own answers for codes, a signed join checked as on the server, the welcome and credits, VIP codes
 * included. What a laptop has not got is the builder ledger, so volume and paid fees are empty here; whether a wallet is
 * VIP is asked of production's /api/vs/bots/vip. State lives in the OS temp folder (VS_INVITES_DEV_DB to move it).
 *
 *   npm --prefix apps/server run invites-dev        (or the launch config "invites-dev")
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import Fastify from 'fastify';
import { BuilderService } from '../src/builder/service.js';
import type { VerifierIo } from '../src/builder/verifier.js';
import { inviteRoutes } from '../src/routes/invites.js';
import { InviteService } from '../src/invites/service.js';
import { InviteStore } from '../src/invites/store.js';

const PORT = Number(process.env.VS_INVITES_DEV_PORT ?? 18797);
const PROD = 'https://www.valuedesk.so';
const dir = join(tmpdir(), 'valuedesk-invites-dev');
mkdirSync(dir, { recursive: true });

const log = { info: () => {}, warn: (o: object, m: string) => console.warn(`[invites-dev] ${m}`, JSON.stringify(o)), error: (o: object, m: string) => console.error(`[invites-dev] ${m}`, JSON.stringify(o)) };
// No tiers file: the ledger stays closed (a laptop has none), every fee question answers "no data".
const builder = new BuilderService({ tiersPath: join(dir, 'no-tiers.json'), keyPath: join(dir, 'no-key'), dbPath: join(dir, 'builder.db'), chainId: 286623, io: {} as VerifierIo, log, verify: false });
builder.load();

/** VIP as production shows it, asked once a minute per wallet. */
const vip = new Map<string, { yes: boolean; at: number }>();
async function askVip(address: string): Promise<void> {
  const a = address.toLowerCase();
  const had = vip.get(a);
  if (had && Date.now() - had.at < 60_000) return;
  try {
    const r = await fetch(`${PROD}/api/vs/bots/vip?address=${a}`, { headers: { origin: PROD }, signal: AbortSignal.timeout(6_000) });
    const j = (await r.json()) as { eligible?: boolean };
    vip.set(a, { yes: j.eligible === true, at: Date.now() });
  } catch {
    vip.set(a, { yes: had?.yes ?? false, at: Date.now() });
  }
}

const service = new InviteService(new InviteStore(process.env.VS_INVITES_DEV_DB?.trim() || join(dir, 'invites.db')), builder, {
  isVip: (a) => vip.get(a.toLowerCase())?.yes === true,
  log,
});

const app = Fastify({ logger: false });
// The page's read of a wallet: production says first whether it is VIP.
app.addHook('onRequest', async (req) => {
  const m = /^\/api\/vs\/invites\/me\?address=(0x[0-9a-fA-F]{40})/.exec(req.url);
  if (m) await askVip(m[1]!);
});
await app.register(inviteRoutes, { service, builder, keep: true });
await app.listen({ host: '127.0.0.1', port: PORT });
console.log(`[invites-dev] referral routes on http://127.0.0.1:${PORT} (state in ${dir})`);
