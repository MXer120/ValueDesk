/**
 * Prints SoDEX's internal pair's open interest and 1002 + 23342's volume per day (valuedesk/sodex/mmDaily.ts), every
 * 15th day, and 1002 + 23342's open interest now, to check the SoPoints difficulty inputs by hand.
 *   npx tsx tools/mmDaily-check.ts [2026-09-01]
 */
import { mmDaily } from '../src/valuedesk/sodex/mmDaily.js';

const from = Date.parse(`${process.argv[2] ?? '2026-09-01'}T00:00:00Z`);
const r = await mmDaily(from);
for (const [i, d] of r.days.entries()) {
  if (i % 15 !== 0 && i !== r.days.length - 1) continue;
  console.log(d.date, d.internalOi === null ? 'oi null' : `oi $${(d.internalOi / 1e6).toFixed(1)}M`, d.volume === null ? 'vol null' : `vol $${(d.volume / 1e6).toFixed(1)}M`);
}
console.log('1002 + 23342 open interest now:', r.takersOiNow === null ? 'null' : `$${(r.takersOiNow / 1e6).toFixed(2)}M`);
process.exit(0);
