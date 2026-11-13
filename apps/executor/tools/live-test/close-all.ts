/**
 * Close every open position (and cancel every resting order) on the live-test wallet, reduce-only.
 *   node --import tsx apps/executor/tools/live-test/close-all.ts --env <.env.live> [--go] [--key <expired key name>]
 * Without --go it lists what it would close.
 */
import { existsSync, readFileSync } from 'node:fs';
import { hexToBytes } from '../../../../packages/sodex-core/src/index.ts';
import { egress } from '../../src/net.ts';
import { readEnvText } from './allParts.ts';
import { flatten } from './cleanup.ts';
import { SodexReads, SodexWallet } from './exchange.ts';

const i = process.argv.indexOf('--env');
const envFile = i > 0 ? process.argv[i + 1]! : '';
if (!existsSync(envFile)) throw new Error('--env <path to .env.live> is needed');
const env = readEnvText(readFileSync(envFile, 'utf8'));
const h = (env.LIVE_FOLLOWER_KEY ?? '').trim().replace(/^0x/i, '');
if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('LIVE_FOLLOWER_KEY must be a private key');
const reads = new SodexReads(egress(null).fetch);
const w = new SodexWallet('follower', hexToBytes(`0x${h}`), reads);
await w.load();
const st = (await reads.state(w.address)) as Record<string, unknown> | null;
const pos = ((st?.P ?? []) as Array<Record<string, unknown>>).filter((p) => Number(p.sz) !== 0);
console.log(`wallet ${w.address.slice(0, 6)}…: ${pos.length} open positions`);
for (const p of pos) console.log(`  ${p.s} size ${p.sz} entry ${p.ep}`);
if (!process.argv.includes('--go') || !pos.length) process.exit(0);
// --key <name>: reuse an expired key name when the account has no free API-key slot (registering a name replaces it)
await w.ownKey(process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1]! : 'vs-close-all');
const r = await flatten([w], pos.map((p) => String(p.s)));
console.log(JSON.stringify(r).slice(0, 600));
const after = ((((await reads.state(w.address)) as Record<string, unknown> | null)?.P ?? []) as Array<Record<string, unknown>>).filter((p) => Number(p.sz) !== 0);
console.log(`after: ${after.length} open positions${after.map((p) => ` ${p.s} ${p.sz}`).join('')}`);
