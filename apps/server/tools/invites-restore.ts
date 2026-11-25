/**
 * Put back referrals a lost link code cost (2026-11-25), on SoDEX's word only (invites/service.ts restore): SoDEX must name
 * the inviter for each wallet. Reads by default; writes with --write. On the box, with the API running (one SQLite file,
 * WAL), as the service user:
 *
 *   cd /opt/valuescan/current/apps/server
 *   sudo -n -u valuescan env VALUESCAN_INVITES_DB=/var/lib/valuescan/state/invites.db \
 *     /opt/node/current/bin/node --import tsx tools/invites-restore.ts 0xINVITER CODE 0xWALLET=2026-11-23T05:06Z … [--write]
 *
 * The time after `=` is the wallet's first visit: its fees count for the inviter from then on. VIP codes and the VIP state
 * come from the running site (/api/vs/bots/vip), as the page shows them.
 */
import type { BuilderService } from '../src/builder/service.js';
import { InviteService } from '../src/invites/service.js';
import { InviteStore } from '../src/invites/store.js';

const args = process.argv.slice(2).filter((a) => a !== '--write');
const write = process.argv.includes('--write');
const [inviter, code, ...wallets] = args;
if (!inviter || !code || !wallets.length) throw new Error('usage: invites-restore.ts 0xINVITER CODE 0xWALLET=<first visit> … [--write]');
if (!process.env.VALUESCAN_INVITES_DB) throw new Error('VALUESCAN_INVITES_DB is not set');

const SITE = process.env.VS_SITE ?? 'https://www.valuedesk.so';
const vip = ((await (await fetch(`${SITE}/api/vs/bots/vip?address=${inviter.toLowerCase()}`, { headers: { origin: SITE }, signal: AbortSignal.timeout(10_000) })).json()) as { eligible?: boolean }).eligible === true;
console.log(`inviter ${inviter} code ${code}: ${vip ? 'VIP (its code gives the VIP days)' : 'not VIP'}${write ? '' : ' - reading only, --write puts them back'}`);

// Only the store and SoDEX are asked: no ledger, no fee hooks.
const none = { setExtraPrograms() {}, setGiftPrograms() {}, setPerkBudget() {}, setVolumeFloor() {} } as unknown as BuilderService;
const svc = new InviteService(new InviteStore(), none, { isVip: (a) => vip && a === inviter.toLowerCase() });
for (const w of wallets) {
  const [address, since] = w.split('=') as [string, string | undefined];
  const at = since ? Date.parse(since) : Date.now();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !Number.isFinite(at)) throw new Error(`not a wallet and a time: ${w}`);
  const r = await svc.restore(address, inviter, code, at, !write);
  console.log(address, r.ok ? `${write ? 'RESTORED' : 'may be restored'}: from ${new Date(at).toISOString()}, welcome ${r.welcome ? 'yes' : 'no'}, VIP fee until ${r.vipUntil ? new Date(r.vipUntil).toISOString() : '-'}` : `REFUSED: ${r.why}`);
}
svc.store.close();
