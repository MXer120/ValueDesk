// Readers that overlap without a gap keep the index's WAL from starting over (11 GB an hour while catching up, 2026-11-25), and
// every page read looks through all of it. Over 2 GB: a TRUNCATE checkpoint that waits up to 3 s for readers, over 6 GB 15 s,
// over 20 GB 120 s. Writes wait that long; nothing is lost. Every 2 min (valuescan-walguard.timer).
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
const F = process.env.VALUESCAN_INDEX_DB || '/var/lib/valuescan/index/valuescan-index.db';
let gb = 0;
try { gb = statSync(`${F}-wal`).size / 1e9; } catch { /* no WAL */ }
if (gb > 2) {
  const d = new DatabaseSync(F);
  d.exec('PRAGMA wal_autocheckpoint=0;PRAGMA synchronous=NORMAL;PRAGMA busy_timeout=0');
  // The copying first, with no lock held: only the last few frames are left to the checkpoint that waits.
  const p = d.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
  if (p.log - p.checkpointed < 20000 || gb > 20) {
    d.exec(`PRAGMA busy_timeout=${gb > 20 ? 120000 : gb > 6 ? 15000 : 3000}`);
    const t = Date.now();
    const r = d.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    console.log(gb.toFixed(1), 'GB', JSON.stringify(r), Date.now() - t, 'ms');
  } else console.log(gb.toFixed(1), 'GB, behind', p.log - p.checkpointed);
  d.close();
}
