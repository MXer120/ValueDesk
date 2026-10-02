#!/usr/bin/env node
/**
 * Is this wallet's SoDEX account ready to be Valuescan's BUILDER - and what are
 * the VITE_BUILDER_* lines for it?
 *
 *   node apps/web/tools/check-builder.mjs <walletAddress> [--testnet]
 *        [--fee-perps <n>] [--fee-spot <n>] [--max <n>] [--required] [--json]
 *
 * READ-ONLY. It sends three GET requests to SoDEX's public gateway and nothing
 * else: no wallet, no key, no signature, no POST. (The only request helper in
 * this file refuses any method but GET, and any host but SoDEX's two gateways.)
 *
 * What it checks (docs/BUILDER-CODES.md, and
 * https://sodex.com/documentation/for-developers/developers/trading/builder-codes-in-trading):
 *   - the account exists; its PRIMARY account id is the builder id
 *     (GET /api/v1/user/{address}/subaccounts -> data.primaryAccountID);
 *   - it holds at least 100 vUSDC in Spot AND at least 100 vUSDC in Perps
 *     (GET /api/v1/{spot|perps}/accounts/{address}/balances?accountID=). SoDEX
 *     checks this whenever a user approves - or clears - a fee for the builder.
 *
 * Fees are integers in TENTHS OF A BASIS POINT (10 = 1 bp = 0.01 %): perps
 * 0..200, spot 0..2000 (charged on sells only), the approved maximum 0..2000.
 * Without --fee-* it prints 50 (5 bp) as a PLACEHOLDER: choose your own.
 *
 * Exit code: 0 eligible, 1 not eligible (or no such account), 2 usage / network.
 */

const GATEWAY = { mainnet: 'https://mainnet-gw.sodex.dev', testnet: 'https://testnet-gw.sodex.dev' };
const MIN_USDC = 100;
const CAP = { perps: 200, spot: 2000, max: 2000 };

const USAGE = `usage: node apps/web/tools/check-builder.mjs <walletAddress> [--testnet]
         [--fee-perps <0..200>] [--fee-spot <0..2000>] [--max <0..2000>] [--required] [--json]

Read-only: three GET requests to SoDEX's public gateway. Fees are tenths of a basis point (10 = 1 bp).`;

function parseArgs(argv) {
  const out = { address: null, network: 'mainnet', feePerps: null, feeSpot: null, max: null, required: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (name, cap) => {
      const v = argv[++i];
      const n = Number(v);
      if (v === undefined || !Number.isInteger(n) || n < 0 || n > cap) throw new Error(`${name} must be a whole number 0..${cap} (tenths of a basis point)`);
      return n;
    };
    if (a === '--testnet') out.network = 'testnet';
    else if (a === '--mainnet') out.network = 'mainnet';
    else if (a === '--required') out.required = true;
    else if (a === '--json') out.json = true;
    else if (a === '--fee-perps') out.feePerps = num('--fee-perps', CAP.perps);
    else if (a === '--fee-spot') out.feeSpot = num('--fee-spot', CAP.spot);
    else if (a === '--max') out.max = num('--max', CAP.max);
    else if (a === '-h' || a === '--help') throw new Error('');
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (out.address === null) out.address = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!out.address) throw new Error('a wallet address is required');
  if (!/^0x[0-9a-fA-F]{40}$/.test(out.address)) throw new Error(`not a wallet address: ${out.address}`);
  return out;
}

/** The ONLY network access in this file: a GET to one of SoDEX's two gateways. */
async function get(network, path) {
  const origin = GATEWAY[network];
  if (!origin) throw new Error(`unknown network ${network}`);
  if (!path.startsWith('/api/v1/')) throw new Error(`refusing to read ${path}`);
  const res = await fetch(origin + path, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path}: HTTP ${res.status}, not JSON: ${text.slice(0, 120)}`);
  }
  // `code === 0` is SoDEX's only success signal.
  if (!res.ok || body?.code !== 0) {
    const err = new Error(`${path}: ${body?.error ?? body?.message ?? `HTTP ${res.status}`}`);
    err.notFound = /user not found|account not found/i.test(String(body?.error ?? body?.message ?? ''));
    throw err;
  }
  return body.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The vUSDC row of a balances answer ({balances: [...]} or a bare list), or null. */
function usdcRow(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.balances) ? data.balances : [];
  return list.find((b) => /^v?USDC$/i.test(String(b?.coin ?? b?.a ?? ''))) ?? null;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e.message) console.error(`${e.message}\n`);
    console.error(USAGE);
    return 2;
  }
  const { address, network } = args;
  const say = args.json ? () => {} : (line = '') => console.log(line);
  say(`SoDEX ${network} - ${GATEWAY[network]} (read-only)`);
  say(`wallet            ${address}`);

  let builderId = 0;
  try {
    const sub = await get(network, `/api/v1/user/${address}/subaccounts`);
    builderId = Number(sub?.primaryAccountID) || 0;
  } catch (e) {
    if (!e.notFound) {
      console.error(`could not read the account: ${e.message}`);
      return 2;
    }
  }
  if (!builderId) {
    say('account           none - SoDEX has never seen a deposit from this wallet');
    say();
    say('NOT ELIGIBLE: activate the account first (a first deposit of USDC or SOSO opens it), then hold');
    say(`at least ${MIN_USDC} vUSDC in Spot and ${MIN_USDC} vUSDC in Perps.`);
    if (args.json) console.log(JSON.stringify({ network, address, builderId: null, eligible: false, reason: 'no account' }));
    return 1;
  }
  say(`builder id        ${builderId}   (the account's primary account id)`);

  const held = {};
  for (const engine of ['spot', 'perps']) {
    await sleep(300);
    try {
      const row = usdcRow(await get(network, `/api/v1/${engine}/accounts/${address}/balances?accountID=${builderId}`));
      // Spot `total` includes funds locked in open orders; Perps `total` is the wallet balance.
      held[engine] = { total: num(row?.total ?? row?.t ?? row?.wb), locked: num(row?.locked ?? row?.l) };
    } catch (e) {
      console.error(`could not read the ${engine} balance: ${e.message}`);
      return 2;
    }
  }
  const enough = (e) => held[e].total >= MIN_USDC;
  const line = (e) =>
    `${e === 'spot' ? 'Spot  vUSDC      ' : 'Perps vUSDC      '} ${held[e].total}${held[e].locked ? ` (of which ${held[e].locked} locked in open orders)` : ''}   ${
      enough(e) ? `ok (>= ${MIN_USDC})` : `NOT ENOUGH - needs ${MIN_USDC}, short by ${+(MIN_USDC - held[e].total).toFixed(6)}`
    }`;
  say(line('spot'));
  say(line('perps'));
  const eligible = enough('spot') && enough('perps');

  const feePerps = args.feePerps ?? 50;
  const feeSpot = args.feeSpot ?? 50;
  const max = args.max ?? Math.max(feePerps, feeSpot);
  if (max < Math.max(feePerps, feeSpot)) {
    console.error('--max is below the fee it has to cover');
    return 2;
  }
  const pct = (n) => `${+(n / 1000).toFixed(3)}%`;
  const env = [
    `VITE_BUILDER_ID=${builderId}`,
    `VITE_BUILDER_FEE_PERPS=${feePerps}`,
    `VITE_BUILDER_FEE_SPOT=${feeSpot}`,
    `VITE_BUILDER_MAX_FEE=${max}`,
    ...(args.required ? ['VITE_BUILDER_REQUIRED=1'] : []),
  ];

  if (args.json) {
    console.log(JSON.stringify({ network, address, builderId, spot: held.spot, perps: held.perps, eligible, env }));
    return eligible ? 0 : 1;
  }
  say();
  if (eligible) {
    say('ELIGIBLE: users can approve a builder fee for this account.');
    if (held.spot.locked && held.spot.total - held.spot.locked < MIN_USDC) {
      say(`note: only ${+(held.spot.total - held.spot.locked).toFixed(6)} vUSDC of the Spot balance is free - keep ${MIN_USDC} out of open orders to be safe.`);
    }
  } else {
    say(`NOT ELIGIBLE YET: SoDEX refuses approvals (and revocations) for a builder below ${MIN_USDC} vUSDC in either engine.`);
    say('Top the account up (Deposit, then Transfer between Spot and Perps) and run this again.');
  }
  say();
  say(`Lines for apps/web/.env.local${network === 'testnet' ? ' (a TESTNET build: also VITE_SODEX_NETWORK=testnet)' : ''}:`);
  say();
  for (const l of env) say(`  ${l}`);
  say();
  say(`  perps ${pct(feePerps)} per fill (buys and sells), spot ${pct(feeSpot)} per fill (sells only), approved maximum ${pct(max)}`);
  if (args.feePerps === null && args.feeSpot === null) {
    say('  The fee values above are PLACEHOLDERS (5 bp). Set your own with --fee-perps / --fee-spot / --max');
    say('  (tenths of a basis point: 10 = 1 bp = 0.01 %; perps at most 200, spot at most 2000).');
  }
  if (!args.required) say('  Add VITE_BUILDER_REQUIRED=1 (or pass --required) to make the approval a condition of trading here.');
  say('  Keep the balances above the minimum: if the builder falls below it, new approvals AND revocations fail.');
  return eligible ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e?.message ?? String(e));
    process.exitCode = 2;
  },
);
