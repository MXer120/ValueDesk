// Refresh the list of sanctioned wallet addresses that the executor, the API
// and the browser screen against (packages/copy-engine/src/sanctions.ts).
//
//   node scripts/update-sanctions-list.mjs            # read, verify, show the diff, write
//   node scripts/update-sanctions-list.mjs --check    # read and verify, show the diff, write nothing
//   options: --logs-rpc <url> --verify-rpc <url> --allow-shrink
//
// THE SOURCE is the one the browser asks (apps/web/src/legal/screening.ts): the
// Chainalysis sanctions oracle on Ethereum mainnet, which Chainalysis keeps in
// line with the crypto addresses on OFAC's SDN list.
//   1. Every SanctionedAddressesAdded / SanctionedAddressesRemoved event the
//      contract ever emitted (eth_getLogs, from a node that serves old logs -
//      publicnode.com wants a token for that, so another public node by default),
//      replayed in order: the addresses on the list now.
//   2. Each of them asked again, isSanctioned(address) at the latest block, of
//      the node the browser uses: the list is what the oracle answers today, and
//      an address it no longer lists is dropped.
// Nothing is written unless both steps succeed for every address, and a list
// that would lose more than 5 % of its addresses is refused unless
// --allow-shrink is given (a node answering a short history must not quietly
// empty the screen).
//
// It writes the same file twice: packages/copy-engine/src/sanctionsList.ts (the
// executor, the browser) and apps/server/src/builder/sanctionsList.ts (the API,
// which does not import the package - apps/server/test/sanctions.test.ts checks
// they agree). Commit both and release the API, the executor and the web: the
// executor never fetches the list itself, so it starts without the network.
// No dependencies, a few hundred kilobytes of traffic.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['packages/copy-engine/src/sanctionsList.ts', 'apps/server/src/builder/sanctionsList.ts'];

const ORACLE = '0x40C57923924B5c5c5455c48D93317139ADDaC8fb';
/** keccak256('SanctionedAddressesAdded(address[])') / ('SanctionedAddressesRemoved(address[])'). */
const ADDED = '0x2596d7dd6966c5673f9c06ddb0564c4f0e6d8d206ea075b83ad9ddd71a4fb927';
const REMOVED = '0x32aab684eee99db715515d1a9987a8fe33bb6341b0e35e60db7eab48a08f9a3a';
const IS_SANCTIONED = '0xdf592f7d';
/** Before the oracle was deployed (March 2022). */
const FROM_BLOCK = 14_000_000;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const LOGS_RPC = opt('--logs-rpc', 'https://rpc.mevblocker.io');
const VERIFY_RPC = opt('--verify-rpc', 'https://ethereum-rpc.publicnode.com');
const CHECK = args.includes('--check');
const ALLOW_SHRINK = args.includes('--allow-shrink');

let id = 0;
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error || !('result' in body)) throw new Error(`${method} at ${url}: ${body?.error?.message ?? `HTTP ${res.status}`}`);
  return body.result;
}

/** Logs from..to, halving the range when the node refuses one this long. */
async function logs(from, to, depth = 0) {
  try {
    return await rpc(LOGS_RPC, 'eth_getLogs', [{ address: ORACLE, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [[ADDED, REMOVED]] }]);
  } catch (e) {
    if (to - from < 2_000 || depth > 14) throw e;
    const mid = Math.floor((from + to) / 2);
    return [...(await logs(from, mid, depth + 1)), ...(await logs(mid + 1, to, depth + 1))];
  }
}

/** An ABI-encoded address[] (the events' only, unindexed, argument). */
function addressesOf(data) {
  const hex = data.replace(/^0x/, '');
  const word = (i) => hex.slice(i * 64, i * 64 + 64);
  const offset = Number(BigInt(`0x${word(0)}`)) / 32;
  const n = Number(BigInt(`0x${word(offset)}`));
  const out = [];
  for (let i = 0; i < n; i++) out.push(`0x${word(offset + 1 + i).slice(24)}`.toLowerCase());
  if (out.some((a) => !/^0x[0-9a-f]{40}$/.test(a))) throw new Error('an event carried something that is not an address');
  return out;
}

const latest = Number(BigInt(await rpc(VERIFY_RPC, 'eth_blockNumber', [])));
const events = await logs(FROM_BLOCK, latest);
events.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
const listed = new Set();
for (const ev of events) {
  if (ev.removed) continue;
  const topic = ev.topics?.[0];
  for (const a of addressesOf(ev.data)) topic === ADDED ? listed.add(a) : listed.delete(a);
}
if (listed.size === 0) throw new Error('the oracle\'s history came back empty: nothing written');

// Ask the oracle about each, at the latest block, as the browser does.
const confirmed = [];
const dropped = [];
for (const a of [...listed].sort()) {
  const r = await rpc(VERIFY_RPC, 'eth_call', [{ to: ORACLE, data: `${IS_SANCTIONED}${a.slice(2).padStart(64, '0')}` }, 'latest']);
  if (typeof r !== 'string' || !/^0x[0-9a-f]{64}$/i.test(r)) throw new Error(`the oracle answered nonsense for ${a}: nothing written`);
  (BigInt(r) === 1n ? confirmed : dropped).push(a);
}
const lastEvent = events.length ? Number(BigInt(events[events.length - 1].blockNumber)) : null;

const target = join(ROOT, TARGETS[0]);
const before = (() => {
  try {
    return new Set([...readFileSync(target, 'utf8').matchAll(/'(0x[0-9a-f]{40})'/g)].map((m) => m[1]));
  } catch {
    return new Set();
  }
})();
const added = confirmed.filter((a) => !before.has(a));
const removed = [...before].filter((a) => !confirmed.includes(a));
console.log(`oracle events: ${events.length} (last at block ${lastEvent}); listed: ${listed.size}; confirmed now: ${confirmed.length}; dropped by the oracle: ${dropped.length}`);
console.log(`against the file: +${added.length} -${removed.length}`);
for (const a of added) console.log(`  + ${a}`);
for (const a of removed) console.log(`  - ${a}`);
if (before.size > 0 && confirmed.length < before.size * 0.95 && !ALLOW_SHRINK) {
  console.error(`refused: the list would shrink from ${before.size} to ${confirmed.length} addresses. Check the source; --allow-shrink writes it anyway.`);
  process.exit(1);
}
if (CHECK) process.exit(0);

const today = new Date().toISOString().slice(0, 10);
const lines = [];
for (let i = 0; i < confirmed.length; i += 3) lines.push(`  ${confirmed.slice(i, i + 3).map((a) => `'${a}'`).join(', ')},`);
const text = `/**
 * GENERATED by scripts/update-sanctions-list.mjs - do not edit by hand; run the
 * script (it explains the source and how the list is checked).
 *
 * The wallet addresses the Chainalysis sanctions oracle on Ethereum mainnet
 * (${ORACLE}) lists - its mirror of the crypto
 * addresses on OFAC's SDN list - lower case. The same file is in
 * packages/copy-engine/src and apps/server/src/builder (a test checks).
 */
export const SANCTIONS_LIST_META = {
  source: 'chainalysis-oracle:${ORACLE.toLowerCase()}',
  /** The day the list was read. */
  updatedAt: '${today}',
  /** The block it was read at, and the block of the oracle's latest change. */
  block: ${latest},
  lastChangeBlock: ${lastEvent},
  count: ${confirmed.length},
} as const;

export const SANCTIONED_ADDRESSES: readonly string[] = [
${lines.join('\n')}
];
`;
for (const t of TARGETS) writeFileSync(join(ROOT, t), text);
console.log(`written: ${TARGETS.join(', ')} (${confirmed.length} addresses, block ${latest})`);
