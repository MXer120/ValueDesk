#!/usr/bin/env node
/**
 * Refresh apps/web/seo/markets.json: SoDEX's perps markets that trade, as SoDEX lists them, for the static market
 * pages (tools/seo.mjs). Run by hand when SoDEX lists or drops a market; the build never calls SoDEX.
 *
 *   node apps/web/tools/seo-markets.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://mainnet-gw.sodex.dev/api/v1/perps/markets/symbols';
const out = fileURLToPath(new URL('../seo/markets.json', import.meta.url));

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`SoDEX answered ${res.status}`);
const body = await res.json();
const list = (body.data ?? body).filter((m) => m.status === 'TRADING' && /^[A-Z0-9]+-USD$/.test(m.name));
const markets = list
  .map((m) => ({
    name: m.name,
    base: m.baseCoin,
    maxLeverage: Number(m.maxLeverage) || null,
    minNotional: Number(m.minNotional) || null,
    tickSize: m.tickSize,
    fundingHours: Number(m.fundingInterval) ? Number(m.fundingInterval) / 3600 : null,
    makerFee: Number(m.makerFee),
    takerFee: Number(m.takerFee),
  }))
  .sort((a, b) => a.base.localeCompare(b.base));
writeFileSync(out, `${JSON.stringify({ source: SOURCE, asOf: new Date().toISOString().slice(0, 10), markets }, null, 1)}\n`);
console.log(`${markets.length} markets -> ${out}`);
